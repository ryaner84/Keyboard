// Kit-variant classification for the set-page price filter.
//
// The four STANDARD kit categories every vendor targets are Base, Alpha,
// Novelties, and Spacebars. Any variant that doesn't match one of those —
// 40s kits, artisans, accents, deskmats, cables, samples… — is OTHERS and is
// shown as a detailed item list instead of the vendor price table.

export interface KitVariant {
  title: string;
  price: number;
  // Present only when the store reported per-variant stock at scrape time.
  available?: boolean;
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
// Japanese keywords cover JP vendors (e.g. Yushakobo) whose variant titles
// are ベースキット / ノベルティ / スペースバー / アルファ.
export function classifyVariant(title: string): VariantCategory {
  if (/novelt|ノベルティ/i.test(title)) return "NOVELTIES";
  if (/space\s*bar|スペースバー/i.test(title)) return "SPACEBARS";
  if (/alpha|アルファ/i.test(title)) return "ALPHA";
  if (/base|ベース/i.test(title)) return "BASE";
  return "OTHERS";
}

// Accessory lines bundled onto GB listings (deskmats, artisans, deposits…) —
// never the keycap kit itself. Shared by the price pickers and the audit so
// every consumer excludes the same titles. (Moved here from prices.ts so the
// audit can apply the exact same filter the scraper applied.)
export const ADDON_VARIANT_RE =
  /(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain|coin|tray|deposit|shipping|insurance|add[\s-]?on|extra)/i;

// Accessory words safe to test against PRODUCT titles (vs variant titles):
// ADDON_VARIANT_RE's "extra"/"shipping"/"insurance" must NOT be here — a
// product legitimately titled "GMK Foo Extras" or "… Free Shipping" is a
// real base listing, while a product titled "… Deskmat" or "… Artisan" never
// is. Used by the product-title guards and catalog-discovery skip.
export const PRODUCT_ACCESSORY_RE =
  /(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain|coin|tray|deposit|add[\s-]?on)/i;

// Standard NON-BASE subkits that classifyVariant files under OTHERS because
// they aren't alphas/novelties/spacebars: numpads, 40s, accents, extensions,
// legends variants (hiragana/katakana/hangul/cyrillic/NorDe/nordic/ISO),
// icon and macro kits. Excluded from the base pool so a listing left with
// only these clears (NO_BASE_KIT) instead of storing a subkit price as the
// base — a title that also says "base" classifies BASE first and is kept
// (e.g. "Hiragana Base"). Mirror of _NONBASE_SUBKIT_RE in scraper/scrape.py.
export const NONBASE_SUBKIT_RE =
  /num(?:ber)?\s*pad|\b40s\b|forties|accents?\b|extension|hiragana|katakana|hangul|cyrillic|norde\b|nordic\b|\biso\b|\bicons?\b|\bmacro\b/i;

// THE canonical base-kit pick, used by every consumer that must agree on
// which variant is the base: the Shopify/Woo price pickers and the nightly
// price audit. Order: drop accessories; drop labeled subkits (alphas/
// novelties/spacebars and the NONBASE vocabulary); then the first variant
// titled "base" wins, else the DEAREST remaining candidate (subkits are the
// cheaper lines). Returns null when the listing has no base candidate —
// including when it carries ONLY accessories — so callers clear rather than
// store a wrong price.
export function pickBaseVariant<T extends { title: string; price: number }>(
  variants: T[]
): T | null {
  if (variants.length === 0) return null;
  const nonAddon = variants.filter((v) => !ADDON_VARIANT_RE.test(v.title));
  // Accessory-only listing (deskmats/artisans): there is no base kit here.
  // Falling back to the raw list — the old behavior — stored a deskmat price
  // as the base whenever every variant was an accessory.
  if (nonAddon.length === 0) return null;
  const basePool = nonAddon.filter((v) => {
    const category = classifyVariant(v.title);
    if (category === "BASE") return true;
    return category === "OTHERS" && !NONBASE_SUBKIT_RE.test(v.title);
  });
  if (basePool.length === 0) return null;
  const titledBase = basePool.find((v) => classifyVariant(v.title) === "BASE");
  if (titledBase) return titledBase;
  return basePool.reduce((best, v) => (v.price > best.price ? v : best));
}

// Parse the raw Json column (unknown shape at the type level) into KitVariant[].
export function parseVariants(raw: unknown): KitVariant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (v): v is { title: unknown; price: unknown } =>
        typeof v === "object" && v !== null && "title" in v && "price" in v
    )
    .map((v) => {
      const available = (v as { available?: unknown }).available;
      return {
        title: String(v.title),
        price: Number(v.price),
        ...(typeof available === "boolean" ? { available } : {}),
      };
    })
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
