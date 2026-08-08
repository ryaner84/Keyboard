// Client-safe helpers to compute the cheapest vendor prices for a set,
// given exchange rates, the user's region and currency. No Prisma imports.
import { convertCurrency } from "./currency-utils";
import { dhlShippingUsd } from "./import/shipping";
import { classifyVariant, parseVariants } from "./kit-variants";
import type {
  KitWithVendors,
  GroupBuyWithPricing,
  ComputedVendorPrice,
  ExchangeRates,
  Region,
} from "@/types";

export function baseKit(set: GroupBuyWithPricing): KitWithVendors | undefined {
  return set.kits.find((k) => k.type === "BASE") ?? set.kits[0];
}

// Return vendor prices that are priced, in stock, and ship to the region,
// converted to the user's currency (kit + shipping), sorted cheapest-first.
export function computeCheapest(
  set: GroupBuyWithPricing,
  region: Region,
  currency: string,
  rates: ExchangeRates
): ComputedVendorPrice[] {
  const kit = baseKit(set);
  if (!kit) return [];

  const results: ComputedVendorPrice[] = [];
  for (const vk of kit.vendorKits ?? []) {
    // A stale price remains useful on the set page, but only a listing whose
    // selected/base variant is currently available can rank as a buy option.
    if (vk.price == null || !vk.inStock) continue;
    // A scraped price without a stored currency is still priced in the
    // vendor's own store currency — don't drop it.
    const kitCurrency = vk.currency ?? vk.vendor.currency ?? "USD";
    // Only an EXPLICIT "doesn't ship here" zone excludes a vendor. A missing
    // zone row (vendor created between deploy-time backfills) falls back to
    // the DHL lane estimate — otherwise every priced kit of that vendor
    // silently disappears and the card reads "no prices yet".
    const zone = vk.vendor.shippingZones.find((z) => z.destinationRegion === region);
    if (zone && !zone.shipsToRegion) continue;

    const kitLocal = convertCurrency(vk.price, kitCurrency, currency, rates);
    const shipLocal = zone
      ? convertCurrency(zone.baseShippingCost, zone.currency, currency, rates)
      : convertCurrency(dhlShippingUsd(vk.vendor.region, region), "USD", currency, rates);
    results.push({
      vendorName: vk.vendor.name,
      totalLocal: kitLocal + shipLocal,
      priceUpdatedAt: vk.priceUpdatedAt,
      gbUrl: vk.gbUrl,
    });
  }

  results.sort((a, b) => a.totalLocal - b.totalLocal);
  return results;
}

// The bargain-hunter signal: how much buying from the cheapest vendor saves
// versus the priciest one carrying the same set. Spreads under 5% are noise
// (FX rounding, near-identical MSRP) — only meaningful gaps get surfaced.
export interface Savings {
  amount: number; // saved in the user's currency, cheapest vs priciest
  percent: number; // 0–100
  vsVendor: string; // the priciest vendor's name
}

export function computeSavings(allPrices: ComputedVendorPrice[]): Savings | null {
  if (allPrices.length < 2) return null;
  const cheapest = allPrices[0];
  const priciest = allPrices[allPrices.length - 1];
  const amount = priciest.totalLocal - cheapest.totalLocal;
  if (priciest.totalLocal <= 0) return null;
  const percent = Math.round((amount / priciest.totalLocal) * 100);
  if (percent < 5) return null;
  return { amount, percent, vsVendor: priciest.vendorName };
}

// Most recent priceUpdatedAt across a set's vendor prices.
// The best markdown any vendor is running on a set's base kit, or null when
// nobody is discounting it.
//
// Distinct from computeSavings(), which measures the SPREAD between vendors —
// two shops charging different full prices. A markdown is one shop cutting its
// own price, which is the thing a shopper recognises as "on sale".
export function bestDiscount(
  set: GroupBuyWithPricing
): { was: number; now: number; percent: number; currency: string | null } | null {
  const base = baseKit(set);
  if (!base) return null;
  let best: { was: number; now: number; percent: number; currency: string | null } | null = null;
  for (const vk of base.vendorKits ?? []) {
    const now = vk.price;
    const was = vk.compareAtPrice;
    // Guard the ordering here too: the scrapers only store a real markdown, but
    // a hand-edited row must never render as a negative discount.
    if (now == null || was == null || was <= now) continue;
    const percent = Math.round((1 - now / was) * 100);
    if (percent <= 0) continue;
    if (!best || percent > best.percent) {
      best = { was, now, percent, currency: vk.currency ?? null };
    }
  }
  return best;
}

// The cheapest "base + extras" bundle any vendor lists for a set, or null when
// nobody sells one.
//
// Bundles are not a Kit row — KitType has no BUNDLE member — they live inside a
// vendor listing's scraped `variants` JSON ("Base + Novelties"). That is why
// this reads the raw variant list rather than a column, and why the bargain
// page's bundle filter has to post-filter in JS instead of in SQL.
export function bestBundle(
  set: GroupBuyWithPricing
): { title: string; price: number; currency: string | null; vendorName: string } | null {
  const base = baseKit(set);
  if (!base) return null;
  let best: { title: string; price: number; currency: string | null; vendorName: string } | null =
    null;
  for (const vk of base.vendorKits ?? []) {
    if (!vk.inStock) continue;
    for (const v of parseVariants(vk.variants)) {
      if (classifyVariant(v.title) !== "BUNDLE") continue;
      // A per-variant `available: false` is a store telling us this exact
      // bundle is gone; only an unreported stock state is treated as in stock.
      if (v.available === false) continue;
      if (!best || v.price < best.price) {
        best = {
          title: v.title,
          price: v.price,
          currency: vk.currency ?? vk.vendor.currency ?? null,
          vendorName: vk.vendor.name,
        };
      }
    }
  }
  return best;
}

export function latestUpdate(prices: ComputedVendorPrice[]): Date | null {
  let latest: number | null = null;
  for (const p of prices) {
    if (!p.priceUpdatedAt) continue;
    const t = new Date(p.priceUpdatedAt).getTime();
    if (latest == null || t > latest) latest = t;
  }
  return latest == null ? null : new Date(latest);
}
