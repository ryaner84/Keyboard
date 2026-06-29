import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { importFromMatrixzj } from "@/lib/import/matrixzj";
import { importGmkSets } from "@/lib/import/keycaplendar";
import { refreshPrices } from "@/lib/import/prices";
import { auditPrices } from "@/lib/import/price-audit";
import { enrichImagesFromGmk } from "@/lib/import/enrich-images";
import {
  applyVendorLinkOverrides,
  processVendorSuggestions,
  ensureShippingZonesForAllVendors,
} from "@/lib/import/vendor-overrides";
import { discoverGmkProducts } from "@/lib/import/discovery";

// Vercel Hobby caps serverless functions at 60s. We stay safely under that.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const REQUEST_BUDGET_MS = 55_000;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  // skipImport=true → skip both catalog imports (useful for price-only runs)
  const skipImport = params.get("skipImport") === "true";
  // supplement=keycaplendar → also run KeycapLendar after matrixzj to fill in
  // GB dates and designers. Enabled by default; pass supplement=none to skip.
  const supplement = params.get("supplement") ?? "keycaplendar";

  try {
    const start = Date.now();

    // ── 0. Expire ended group buys (date-based, runs every day) ──────────────
    // An ACTIVE_GB whose gbEnd has passed is no longer active — move it to
    // SHIPPING so the timeline/cards stop labelling it "Active GB / Ending soon"
    // (which is exactly what stale GMK Masterpiece R2 / British Racing Green
    // were showing days after they closed). Also promote interest checks whose
    // start date has arrived. Purely date-driven; independent of any re-import.
    const nowTs = new Date();
    const expired = await prisma.groupBuy.updateMany({
      where: { status: "ACTIVE_GB", gbEnd: { lt: nowTs } },
      data: { status: "SHIPPING" },
    });
    const started = await prisma.groupBuy.updateMany({
      where: {
        status: "INTEREST_CHECK",
        gbStart: { not: null, lte: nowTs },
        OR: [{ gbEnd: null }, { gbEnd: { gte: nowTs } }],
      },
      data: { status: "ACTIVE_GB" },
    });

    // ── 1. Primary set catalog: matrixzj.github.io ──────────────────────────
    // Static GitHub Pages site — no bot protection, fetchable from serverless.
    // Discovers ALL GMK sets (authoritative community index) and adds order
    // statistics images (units sold + GB period) where available.
    const matrixzjResult = skipImport
      ? null
      : await importFromMatrixzj({
          maxRuntimeMs: Math.min(20_000, REQUEST_BUDGET_MS * 0.35),
        });

    // ── 2. Date/designer supplement: KeycapLendar ────────────────────────────
    // matrixzj doesn't expose GB start/end dates. KeycapLendar has those, so we
    // run it as a supplement (UPDATE only for sets matrixzj already created).
    const supplementResult =
      !skipImport && supplement === "keycaplendar"
        ? await importGmkSets({
            maxRuntimeMs: Math.min(15_000, REQUEST_BUDGET_MS * 0.25),
          })
        : null;

    // ── 3. Hand-curated vendor links + user suggestions ───────────────────────
    const overrides = await applyVendorLinkOverrides();
    const suggestions = await processVendorSuggestions();
    // Self-heal: vendors created outside the deploy-time backfill (e.g. by the
    // WorkSpace scraper) get their DHL shipping zones here, daily.
    const zonesSeeded = await ensureShippingZonesForAllVendors();

    // ── 4. Catalog discovery: walk vendor Shopify stores ─────────────────────
    const discovery = await discoverGmkProducts({
      vendorLimit: 6,
      maxRuntimeMs: Math.max(5_000, (REQUEST_BUDGET_MS - (Date.now() - start)) * 0.25),
    });

    // ── 5. Price scrape (time-boxed, oldest-checked-first) ───────────────────
    const remaining = REQUEST_BUDGET_MS - (Date.now() - start);
    const limitParam = params.get("limit");
    const priceResult = await refreshPrices({
      limit: limitParam ? Number(limitParam) : 1000,
      maxRuntimeMs: Math.max(5_000, remaining * 0.7),
    });

    // ── 6. Accuracy audit (DB-only, fast) ────────────────────────────────────
    const auditResult = await auditPrices({
      maxRuntimeMs: Math.max(2_000, (REQUEST_BUDGET_MS - (Date.now() - start)) * 0.4),
    });

    // ── 7. GMK.net gallery images (best-effort; gmk.net blocks serverless IPs,
    //       so real work happens in the WorkSpace Python scraper) ──────────────
    const imageResult = await enrichImagesFromGmk({
      maxRuntimeMs: Math.max(3_000, REQUEST_BUDGET_MS - (Date.now() - start)),
    });

    return NextResponse.json({
      ok: true,
      statusSweep: { expired: expired.count, started: started.count },
      matrixzj: matrixzjResult,
      supplement: supplementResult,
      overrides,
      suggestions,
      zonesSeeded,
      discovery,
      prices: priceResult,
      audit: auditResult,
      images: imageResult,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
