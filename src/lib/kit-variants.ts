// Kit-variant classification for the set-page price filter.
//
// The four STANDARD kit categories every vendor targets are Base, Alpha,
// Novelties, and Spacebars. Any variant that doesn't match one of those —
// 40s kits, artisans, accents, deskmats, cables, samples… — is OTHERS and is
// shown as a detailed item list instead of the vendor price table.

export interface KitVariant {
  title: string;
  price: number;
}

export type VariantCategory = "BASE" | "ALPHA" | "NOVELTIES" | "SPACEBARS" | "OTHERS";

export const VARIANT_CATEGORIES: Array<{ value: VariantCategory; label: string }> = [
  { value: "BASE", label: "Base" },
  { value: "ALPHA", label: "Alpha" },
  { value: "NOVELTIES", label: "Novelties" },
  { value: "SPACEBARS", label: "Spacebars" },
  { value: "OTHERS", label: "Others" },
];

// Order matters: more specific names first so e.g. "Alpha Kit" never falls
// through to BASE via a stray word, and "Simple Base Kit" still lands on BASE.
export function classifyVariant(title: string): VariantCategory {
  if (/novelt/i.test(title)) return "NOVELTIES";
  if (/space\s*bar/i.test(title)) return "SPACEBARS";
  if (/alpha/i.test(title)) return "ALPHA";
  if (/base/i.test(title)) return "BASE";
  return "OTHERS";
}

// Parse the raw Json column (unknown shape at the type level) into KitVariant[].
export function parseVariants(raw: unknown): KitVariant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (v): v is { title: unknown; price: unknown } =>
        typeof v === "object" && v !== null && "title" in v && "price" in v
    )
    .map((v) => ({ title: String(v.title), price: Number(v.price) }))
    .filter((v) => v.title.length > 0 && !isNaN(v.price) && v.price > 0);
}

// All of a vendor-kit's variants belonging to one category.
export function variantsInCategory(raw: unknown, category: VariantCategory): KitVariant[] {
  return parseVariants(raw).filter((v) => classifyVariant(v.title) === category);
}

// The price a vendor charges for a given standard category (cheapest match),
// or null when the vendor doesn't carry that kit.
export function categoryPrice(raw: unknown, category: VariantCategory): number | null {
  const matches = variantsInCategory(raw, category);
  if (matches.length === 0) return null;
  return Math.min(...matches.map((v) => v.price));
}
