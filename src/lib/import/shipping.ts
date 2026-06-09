// DHL Express shipping estimates used when a vendor has no manual shipping data.
// Rates are approximate USD costs for a ~1 kg keycap parcel.
import type { Region } from "@/generated/prisma";

export const ALL_REGIONS: Region[] = ["US", "CA", "EU", "UK", "AU", "SG", "ASIA", "OTHER"];

const DHL_USD: Record<Region, Record<Region, number>> = {
  US:    { US: 9,  CA: 18, EU: 38, UK: 38, AU: 42, SG: 48, ASIA: 45, OTHER: 50 },
  CA:    { US: 18, CA: 12, EU: 42, UK: 42, AU: 48, SG: 52, ASIA: 50, OTHER: 55 },
  EU:    { US: 35, CA: 38, EU: 12, UK: 15, AU: 42, SG: 38, ASIA: 38, OTHER: 45 },
  UK:    { US: 35, CA: 38, EU: 15, UK:  8, AU: 42, SG: 42, ASIA: 40, OTHER: 45 },
  AU:    { US: 40, CA: 42, EU: 42, UK: 42, AU:  8, SG: 30, ASIA: 35, OTHER: 45 },
  SG:    { US: 48, CA: 50, EU: 42, UK: 42, AU: 30, SG:  6, ASIA: 18, OTHER: 45 },
  ASIA:  { US: 45, CA: 48, EU: 38, UK: 40, AU: 35, SG: 18, ASIA: 12, OTHER: 40 },
  OTHER: { US: 48, CA: 50, EU: 42, UK: 45, AU: 45, SG: 42, ASIA: 38, OTHER: 35 },
};

// DHL Express typical transit days from origin region
const DHL_DAYS: Record<Region, { min: number; max: number }> = {
  US:    { min: 2, max: 5  },
  CA:    { min: 3, max: 7  },
  EU:    { min: 3, max: 7  },
  UK:    { min: 3, max: 7  },
  AU:    { min: 5, max: 10 },
  SG:    { min: 1, max: 4  },
  ASIA:  { min: 4, max: 8  },
  OTHER: { min: 5, max: 14 },
};

export interface ShippingZoneSeed {
  destinationRegion: Region;
  baseShippingCost: number;
  currency: string;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  shipsToRegion: boolean;
}

export function buildShippingZones(vendorRegion: Region): ShippingZoneSeed[] {
  const days = DHL_DAYS[vendorRegion];
  return ALL_REGIONS.map((dest) => {
    const isDomestic = dest === vendorRegion;
    return {
      destinationRegion: dest,
      baseShippingCost: DHL_USD[vendorRegion][dest],
      currency: "USD",
      estimatedDaysMin: isDomestic ? Math.max(1, days.min - 1) : days.min,
      estimatedDaysMax: isDomestic ? Math.ceil(days.max / 2) : days.max,
      shipsToRegion: true,
    };
  });
}
