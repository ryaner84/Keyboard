// Client-safe helpers to compute the cheapest vendor prices for a set,
// given exchange rates, the user's region and currency. No Prisma imports.
import { convertCurrency } from "./currency-utils";
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
    if (!vk.inStock || vk.price == null || vk.currency == null) continue;
    const zone = vk.vendor.shippingZones.find((z) => z.destinationRegion === region);
    if (!zone || !zone.shipsToRegion) continue;

    const kitLocal = convertCurrency(vk.price, vk.currency, currency, rates);
    const shipLocal = convertCurrency(zone.baseShippingCost, zone.currency, currency, rates);
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
