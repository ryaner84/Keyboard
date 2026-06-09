import type { Region } from "@/generated/prisma";

interface VendorOverride {
  region: Region;
  country: string;
  currency: string;
}

// KeycapLendar often mislabels SG/Asian vendors. Slug-keyed corrections.
export const VENDOR_OVERRIDES: Record<string, VendorOverride> = {
  ilumkb:      { region: "SG",   country: "SG", currency: "SGD" },
  ktechs:      { region: "SG",   country: "SG", currency: "SGD" },
  ktech:       { region: "SG",   country: "SG", currency: "SGD" },
  ashkeebs:    { region: "SG",   country: "SG", currency: "SGD" },
  monokei:     { region: "SG",   country: "SG", currency: "SGD" },
  kbdfans:     { region: "ASIA", country: "CN", currency: "USD" },
  zfrontier:   { region: "ASIA", country: "CN", currency: "USD" },
  cannonkeys:  { region: "US",   country: "US", currency: "USD" },
  novelkeys:   { region: "US",   country: "US", currency: "USD" },
  deskhero:    { region: "CA",   country: "CA", currency: "CAD" },
  dailyclack:  { region: "AU",   country: "AU", currency: "AUD" },
  "daily-clack": { region: "AU", country: "AU", currency: "AUD" },
  vala:        { region: "AU",   country: "AU", currency: "AUD" },
  "vala-supply": { region: "AU", country: "AU", currency: "AUD" },
  mykeyboard:  { region: "EU",   country: "DE", currency: "EUR" },
  "mykeyboard-eu": { region: "EU", country: "DE", currency: "EUR" },
  prototypist: { region: "EU",   country: "EU", currency: "EUR" },
  "proto-typist": { region: "EU", country: "EU", currency: "EUR" },
  oblotzky:    { region: "EU",   country: "DE", currency: "EUR" },
};

export function applyVendorOverride(
  slug: string,
  defaults: { region: Region; currency: string; country: string }
): { region: Region; currency: string; country: string } {
  return VENDOR_OVERRIDES[slug] ?? defaults;
}
