// DHL-based shipping estimates.
//
// Individual vendors don't publish a shipping-cost API, and most keycap stores
// quote shipping only at checkout. So we estimate shipping with a DHL Express
// model: an approximate USD rate for a ~1 kg keycap parcel on each origin→
// destination lane. These are shown to users explicitly labelled "est. via DHL".
//
// Costs are stored in USD (currency: "USD") and converted to the viewer's
// currency at render time via the exchange-rate table — so one number works for
// every user location.
import type { Region } from "@/generated/prisma";

export const DESTINATION_REGIONS: Region[] = [
  "US",
  "CA",
  "EU",
  "UK",
  "AU",
  "SG",
  "ASIA",
  "OTHER",
];

// Approximate DHL Express rates (USD) for a ~1 kg parcel, origin → destination.
// Singapore lanes are tuned most carefully since SG is the primary market.
const DHL_USD: Partial<Record<Region, Partial<Record<Region, number>>>> = {
  US: { US: 9, CA: 18, EU: 38, UK: 38, AU: 42, SG: 48, ASIA: 45, OTHER: 50 },
  CA: { CA: 9, US: 18, EU: 40, UK: 40, AU: 45, SG: 50, ASIA: 48, OTHER: 52 },
  EU: { EU: 10, UK: 16, US: 38, CA: 40, AU: 45, SG: 42, ASIA: 42, OTHER: 48 },
  UK: { UK: 9, EU: 16, US: 38, CA: 40, AU: 45, SG: 42, ASIA: 42, OTHER: 48 },
  AU: { AU: 10, SG: 30, ASIA: 32, US: 42, CA: 45, EU: 45, UK: 45, OTHER: 48 },
  SG: { SG: 6, ASIA: 18, AU: 30, US: 48, CA: 50, EU: 42, UK: 42, OTHER: 45 },
  ASIA: { ASIA: 10, SG: 18, AU: 32, US: 45, CA: 48, EU: 42, UK: 42, OTHER: 45 },
  OTHER: { OTHER: 12, SG: 45, ASIA: 45, US: 50, CA: 52, EU: 48, UK: 48, AU: 48 },
};

const DEFAULT_INTL_USD = 45;
const DEFAULT_DOMESTIC_USD = 10;

export function dhlShippingUsd(from: Region, to: Region): number {
  const v = DHL_USD[from]?.[to];
  if (v != null) return v;
  return from === to ? DEFAULT_DOMESTIC_USD : DEFAULT_INTL_USD;
}

// DHL Express transit estimate. Customs clearance pads international lanes.
export function dhlEstimatedDays(from: Region, to: Region): [number, number] {
  return from === to ? [2, 5] : [4, 10];
}

export interface ShippingZoneSeed {
  destinationRegion: Region;
  baseShippingCost: number;
  currency: string;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  shipsToRegion: boolean;
}

// Most keycap vendors ship worldwide via courier, so we seed every destination
// region as reachable. Specific exceptions can be turned off later in admin.
export function buildShippingZones(vendorRegion: Region): ShippingZoneSeed[] {
  return DESTINATION_REGIONS.map((dest) => {
    const [min, max] = dhlEstimatedDays(vendorRegion, dest);
    return {
      destinationRegion: dest,
      baseShippingCost: dhlShippingUsd(vendorRegion, dest),
      currency: "USD",
      estimatedDaysMin: min,
      estimatedDaysMax: max,
      shipsToRegion: true,
    };
  });
}
