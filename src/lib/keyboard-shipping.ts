// Rough shipping estimate for a keyboard (a ~2kg parcel, much heavier than a
// keycap set). We can't scrape every vendor's shipping table, so this is a
// deliberate heuristic in USD keyed on origin → destination continent.
// It's labelled "est." everywhere in the UI so users know it's approximate.

// Pure, client-safe — no Prisma. Converted to the user's currency at render
// time via the existing currency rates.

type Continent = "NA" | "EU" | "OC" | "AS" | "INTL";

// Map our Region codes (and a few raw vendor strings) to a coarse continent.
const REGION_CONTINENT: Record<string, Continent> = {
  US: "NA",
  CA: "NA",
  EU: "EU",
  UK: "EU",
  AU: "OC",
  NZ: "OC",
  SG: "AS",
  ASIA: "AS",
  CN: "AS",
  HK: "AS",
  JP: "AS",
  KR: "AS",
  MY: "AS",
  TH: "AS",
  TW: "AS",
};

// Flat USD estimates by shipping distance band for a ~2kg keyboard.
const DOMESTIC_USD = 15;
const SAME_CONTINENT_USD = 30;
const INTERCONTINENTAL_USD = 55;
// Used when the origin is "Global"/unknown — a middle-of-the-road guess.
const UNKNOWN_ORIGIN_USD = 45;

export interface ShippingEstimate {
  usd: number;
  // "domestic" | "regional" | "international" | "unknown" — drives the label.
  band: "domestic" | "regional" | "international" | "unknown";
}

export function estimateKeyboardShippingUSD(
  originRegion: string | null | undefined,
  destRegion: string | null | undefined
): ShippingEstimate {
  const origin = (originRegion ?? "").toUpperCase();
  const dest = (destRegion ?? "").toUpperCase();

  // Unknown / global origin — single middling estimate.
  if (!origin || origin === "GLOBAL" || !REGION_CONTINENT[origin]) {
    return { usd: UNKNOWN_ORIGIN_USD, band: "unknown" };
  }

  // Same exact region → domestic.
  if (origin === dest) {
    return { usd: DOMESTIC_USD, band: "domestic" };
  }

  const oc = REGION_CONTINENT[origin];
  const dc = REGION_CONTINENT[dest] ?? "INTL";

  if (oc === dc) {
    return { usd: SAME_CONTINENT_USD, band: "regional" };
  }
  return { usd: INTERCONTINENTAL_USD, band: "international" };
}
