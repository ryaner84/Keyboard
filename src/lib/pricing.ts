// Client-safe helpers to compute the cheapest vendor prices for a set,
// given exchange rates, the user's region and currency. No Prisma imports.
import { convertCurrency } from "./currency-utils";
import { dhlShippingUsd } from "./import/shipping";
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
    if (!vk.inStock || vk.price == null) continue;
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
export function latestUpdate(prices: ComputedVendorPrice[]): Date | null {
  let latest: number | null = null;
  for (const p of prices) {
    if (!p.priceUpdatedAt) continue;
    const t = new Date(p.priceUpdatedAt).getTime();
    if (latest == null || t > latest) latest = t;
  }
  return latest == null ? null : new Date(latest);
}
