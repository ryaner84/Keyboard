import { prisma } from "@/lib/prisma";
import { categoryPrice } from "@/lib/kit-variants";
import { isPlausibleBaseKitPrice } from "./prices";

// Nightly accuracy check over every stored scraped price. Two invariants:
//
//   1. The stored price must be the BASE-kit variant price. If the scraped
//      variants list contains a BASE-classified variant whose price differs
//      from what's stored (legacy data from the old cheapest-variant scraper),
//      correct it in place — no re-scrape needed.
//   2. The stored price must be plausible for a GMK base kit. Implausible
//      prices are nulled and re-queued (priceUpdatedAt = NULL puts them at the
//      front of the next scrape run) — showing no price beats showing a wrong one.
//
// MANUAL prices are never touched.

const DEFAULT_MAX_RUNTIME_MS = 10_000;

export interface AuditOptions {
  maxRuntimeMs?: number;
}

export interface AuditResult {
  checked: number;
  corrected: number; // price fixed to the BASE variant from stored variants
  purged: number; // implausible price nulled + re-queued for scraping
  stoppedEarly: boolean;
}

export async function auditPrices(opts: AuditOptions = {}): Promise<AuditResult> {
  const { maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS } = opts;
  const start = Date.now();

  const rows = await prisma.vendorKit.findMany({
    where: {
      priceSource: "SCRAPED",
      price: { not: null },
      kit: { type: "BASE" },
    },
    select: { id: true, price: true, currency: true, variants: true, productUrl: true },
  });

  const result: AuditResult = {
    checked: rows.length,
    corrected: 0,
    purged: 0,
    stoppedEarly: false,
  };

  for (const row of rows) {
    if (Date.now() - start > maxRuntimeMs) {
      result.stoppedEarly = true;
      break;
    }

    // What the price SHOULD be: the cheapest BASE-classified variant if the
    // listing has one, otherwise whatever is stored (single-kit listings have
    // a lone "Default Title" variant that classifies as OTHERS). Vendor links
    // that pin an exact variant (?variant=<id>) are ground truth — the scraper
    // already stored that variant's price, so don't second-guess it here.
    const isPinned = !!row.productUrl && /[?&]variant=/.test(row.productUrl);
    const basePrice = isPinned ? null : categoryPrice(row.variants, "BASE");
    const target = basePrice ?? (row.price as number);

    if (!isPlausibleBaseKitPrice(target, row.currency)) {
      await prisma.vendorKit.update({
        where: { id: row.id },
        data: { price: null, priceUpdatedAt: null },
      });
      result.purged++;
    } else if (Math.abs(target - (row.price as number)) > 0.001) {
      await prisma.vendorKit.update({
        where: { id: row.id },
        data: { price: target },
      });
      result.corrected++;
    }
  }

  return result;
}
