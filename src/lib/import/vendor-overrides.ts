// KeycapLendar's per-vendor `region` field is coarse and sometimes wrong — it
// tags several Singapore/Asia stores as "America", so they end up looking like
// US vendors with expensive shipping to SG. This map corrects the region,
// country, and billing currency for vendors we know, keyed by their slug
// (slugify(vendor.name)). SG vendors matter most since SG is the primary market.
import type { Region } from "@/generated/prisma";

interface VendorOverride {
  region: Region;
  country: string;
  currency: string;
}

export const VENDOR_OVERRIDES: Record<string, VendorOverride> = {
  // Singapore
  ilumkb: { region: "SG", country: "SG", currency: "SGD" },
  ktechs: { region: "SG", country: "SG", currency: "SGD" },
  ktech: { region: "SG", country: "SG", currency: "SGD" },
  ashkeebs: { region: "SG", country: "SG", currency: "SGD" },
  monokei: { region: "SG", country: "SG", currency: "SGD" },
  "zion-studios": { region: "SG", country: "SG", currency: "SGD" },
  zionstudios: { region: "SG", country: "SG", currency: "SGD" },
  "zion-studios-sg": { region: "SG", country: "SG", currency: "SGD" },

  // Other Asia (kept distinct from SG for shipping math)
  kbdfans: { region: "ASIA", country: "CN", currency: "USD" },
  zfrontier: { region: "ASIA", country: "CN", currency: "USD" },
  swagkeys: { region: "ASIA", country: "KR", currency: "USD" },
  "swagkeys-kr": { region: "ASIA", country: "KR", currency: "USD" },
};

export function applyVendorOverride(
  slug: string,
  fallback: { region: Region; country: string; currency: string }
): { region: Region; country: string; currency: string } {
  return VENDOR_OVERRIDES[slug] ?? fallback;
}
