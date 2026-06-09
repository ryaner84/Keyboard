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

// Approximate DHL Express rates (USD) for a small, light keycap parcel
// (a GMK base-kit box is compact, ~0.8–1 kg actual weight — its volumetric
// weight is well under that). Vendors get heavily discounted courier rates, so
// these reflect the *discounted* price a store actually charges, not the retail
// counter rate. Calibrated against a real proto[Typist] checkout: UK → SG was
// GBP 19.76 (~USD 25). Singapore lanes are tuned most carefully (primary market).
const DHL_USD: Partial<Record<Region, Partial<Record<Region, number>>>> = {
  US: { US: 8, CA: 12, EU: 18, UK: 18, AU: 26, SG: 26, ASIA: 26, OTHER: 30 },
  CA: { CA: 8, US: 12, EU: 20, UK: 20, AU: 28, SG: 28, ASIA: 28, OTHER: 32 },
  EU: { EU: 8, UK: 10, US: 18, CA: 20, AU: 26, SG: 24, ASIA: 24, OTHER: 30 },
  UK: { UK: 7, EU: 10, US: 18, CA: 20, AU: 26, SG: 24, ASIA: 24, OTHER: 30 },
  AU: { AU: 8, SG: 18, ASIA: 20, US: 26, CA: 28, EU: 26, UK: 26, OTHER: 30 },
  SG: { SG: 5, ASIA: 12, AU: 18, US: 26, CA: 28, EU: 24, UK: 24, OTHER: 28 },
  ASIA: { ASIA: 8, SG: 12, AU: 20, US: 26, CA: 28, EU: 24, UK: 24, OTHER: 28 },
  OTHER: { OTHER: 10, SG: 28, ASIA: 26, US: 30, CA: 32, EU: 30, UK: 30, AU: 30 },
};

const DEFAULT_INTL_USD = 28;
const DEFAULT_DOMESTIC_USD = 8;

export function dhlShippingUsd(from: Region, to: Region): number {
  const v = DHL_USD[from]?.[to];
  if (v != null) return v;
  return from === to ? DEFAULT_DOMESTIC_USD : DEFAULT_INTL_USD;
}

// DHL Express transit estimate. Express courier is fast (the proto[Typist]
// quote read "DHL Worldwide 2–3 Days"); customs clearance pads it slightly.
export function dhlEstimatedDays(from: Region, to: Region): [number, number] {
  return from === to ? [1, 3] : [2, 5];
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
