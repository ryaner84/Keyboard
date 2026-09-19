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

// BUNDLE is a base kit sold together with extras ("Base + Novelties"). It is
// its own category rather than BASE or NOVELTIES: calling it NOVELTIES hid it
// entirely (a bundle-only listing stored no price at all — ktechs sells four
// GMK sets this way), and calling it BASE would let a dearer bundle outrank a
// real base kit in the same listing, making the stored price depend on the
// vendor's variant order.
export type VariantCategory =
  | "BASE"
  | "BUNDLE"
  | "ALPHA"
  | "NOVELTIES"
  | "SPACEBARS"
  | "OTHERS";

export const VARIANT_CATEGORIES: Array<{ value: VariantCategory; label: string }> = [
  { value: "BASE", label: "Base" },
  { value: "BUNDLE", label: "Base + extras" },
  { value: "ALPHA", label: "Alpha" },
  { value: "NOVELTIES", label: "Novelties" },
  { value: "SPACEBARS", label: "Spacebars" },
  { value: "OTHERS", label: "Others" },
];

// Order matters: more specific names first so e.g. "Alpha Kit" never falls
// through to BASE via a stray word, and "Simple Base Kit" still lands on BASE.
// Japanese keywords cover JP vendors (e.g. Yushakobo) whose variant titles
// are ベースキット / ノベルティ / スペースバー / アルファ.
// Kits a bundle can be bundled WITH — mirror of _BUNDLE_EXTRA_RE in scrape.py.
const BUNDLE_EXTRA_RE =
  /novelt|ノベルティ|space\s*bar|スペースバー|alpha|アルファ|num(?:ber)?\s*pad|\b40s\b|forties|accents?\b|extension|hiragana|katakana|hangul|cyrillic|norde\b|nordic\b|\biso\b|\bicons?\b|\bmacro\b/i;

export function classifyVariant(title: string): VariantCategory {
  // Checked BEFORE the subkit patterns: "Base + Novelties" would otherwise
  // match `novelt` and be filed as a novelty kit.
  //
  // A joiner alone is NOT enough. Oblotzky sells "Teal & White Base" and
  // Yushakobo "Two Baseセット（Teal + White）" — plain base kits whose COLOURWAY
  // contains "&"/"+". A bundle must also name an actual extra kit.
  if (
    /base|ベース/i.test(title) &&
    /[+&/]|\band\b|\bwith\b|\bplus\b/i.test(title) &&
    BUNDLE_EXTRA_RE.test(title)
  ) {
    return "BUNDLE";
  }
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

// A product whose RAW title names a subkit or accessory. Discovery must not
// link one as a normal set's VendorKit (normalizeSetName strips bracketed
// qualifiers, so "GMK Foo (Novelties)" collides with the set name), and the
// price pass must not price one as a normal set's base kit. "alphas" is
// plural-only so a set legitimately named "… Alpha" still links; "extras" is
// deliberately absent, because an extras listing sells the base kit.
//
// Mirror of _SUBKIT_PRODUCT_RE in scraper/scrape.py — kept here rather than in
// discovery.ts because the price pass, the price audit and both discovery
// halves all have to agree about it. test:kit-variants fails if they drift.
export const SUBKIT_PRODUCT_RE = new RegExp(
  `novelt|space\\s*bars?|\\balphas\\b|${NONBASE_SUBKIT_RE.source}|${PRODUCT_ACCESSORY_RE.source}`,
  "i"
);

/**
 * Whether the tracked SET is itself a subkit or accessory product.
 *
 * The dcs.wiki archive catalogs these as first-class sets — "DCS Bae Addon",
 * "DCS 10U Spacebars", "DCS After School 1992 40s Kit" — so every rule of the
 * form "a subkit product is never the base listing" has to know when the subkit
 * IS the product being tracked. Applied to `GroupBuy.name`, which is what
 * scrape.py's price queue selects as `set_name`.
 */
export function isSubkitSetName(setName: string | null | undefined): boolean {
  return SUBKIT_PRODUCT_RE.test(String(setName ?? ""));
}

// THE canonical base-kit pick, used by every consumer that must agree on
// which variant is the base: the Shopify/Woo price pickers and the nightly
// price audit. Order: drop accessories; drop labeled subkits (alphas/
// novelties/spacebars and the NONBASE vocabulary); then the first variant
// titled "base" wins, else the DEAREST remaining candidate (subkits are the
// cheaper lines). Returns null when the listing has no base candidate —
// including when it carries ONLY accessories — so callers clear rather than
// store a wrong price.
//
// `allowSubkits` is for a set that IS a subkit (isSubkitSetName): on such a
// listing the 40s/spacebar variant is the base kit, not something to exclude.
// Saber Keebs' "DCS After School 1992 40s Kit" is the case that found it — its
// variants are "40s Monokit" USD 140, "BAE" 10 and "LAE" 10, so dropping the
// 40s line leaves the two 10-dollar add-ons as the only candidates and the set
// would publish at 10. Every caller must pass the SAME flag: the nightly audit
// recomputes this pick and overwrites the stored price, so a caller that
// forgets it undoes the one that didn't, every night. Mirror of
// choose_kit_variant(allow_subkits=…) in scraper/scrape.py.
export function pickBaseVariant<T extends { title: string; price: number }>(
  variants: T[],
  { allowSubkits = false }: { allowSubkits?: boolean } = {}
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
    return category === "OTHERS" && (allowSubkits || !NONBASE_SUBKIT_RE.test(v.title));
  });
  const titledBase = basePool.find((v) => classifyVariant(v.title) === "BASE");
  if (titledBase) return titledBase;
  // No plain base kit on offer: fall back to the CHEAPEST bundle rather than
  // storing nothing. A bundle costs more than the base alone, so it is only
  // ever used when there is no base to be had — that keeps a dearer bundle
  // from displacing a real base kit, and keeps the pick independent of the
  // vendor's variant order.
  if (basePool.length === 0) {
    const bundles = nonAddon.filter((v) => classifyVariant(v.title) === "BUNDLE");
    if (bundles.length === 0) return null;
    return bundles.reduce((best, v) => (v.price < best.price ? v : best));
  }
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

// ── A storefront's own TEST product ─────────────────────────────────────────
//
// A test product is a real Shopify product: it has a handle, a title, images
// and a price, so nothing about its SHAPE says it is not for sale. Oblotzky
// publishes one ("TEST PRODUCT DO NOT BUY", handle `test-product-do-not-buy`)
// priced over the keyboard floor, so it cleared both of importKeyboardVendor's
// filters — a brand blocklist and a price floor — and was imported as
// `obl-test-product-do-not-buy`, a live listing on /keyboards/active.
//
// It became the most-reported item on the site: eight LISTING_FLAG reports
// between 2026-06-23 and 2026-09-13 ("this is not a real product", "this is a
// test product removed this from all listing"). Not one of them could heal.
// Deleting the row is not the repair, because the import UPSERTS by slug: the
// next nightly pass recreates it from the same catalog entry. Refusing the
// product HERE is the half that ends it; `purgeTestProductListings` in
// scripts/db-setup.mjs only clears what was already written, and the two
// marker lists must agree or a row is refused by one half and kept by the other.
//
// Matched on PHRASES, never on a bare "test" substring: a board may legitimately
// be called Testudo, Protest or Contest, and the consequence here is a DELETED
// listing rather than a hidden one, so a false positive silently drops a real
// group buy with nothing to flag it. The one bare-word case is a title or handle
// that is nothing but "test".
export const TEST_PRODUCT_MARKERS = [
  "do not buy",
  "donotbuy",
  "don't buy",
  "test product",
  "product test",
  "test listing",
  "test item",
  "dummy product",
  "sample product",
  "placeholder",
];

export function isTestProduct(product: { title?: string; handle?: string }): boolean {
  const title = String(product.title ?? "").toLowerCase().trim();
  const handle = String(product.handle ?? "").toLowerCase().trim();
  // Handles are hyphenated ("test-product-do-not-buy"); compare on a spaced
  // form so one marker list answers for both spellings.
  const handleText = handle.replace(/-/g, " ");
  if (title === "test" || handle === "test") return true;
  return TEST_PRODUCT_MARKERS.some(
    (marker) => title.includes(marker) || handleText.includes(marker)
  );
}

// Does a product page's JSON-LD declare a multi-variant ProductGroup?
//
// Shopify marks a product that has several variants with a schema.org
// `ProductGroup` node (its `hasVariant` array lists the variants); a
// single-variant product emits a plain `Product`. So a ProductGroup reliably
// means "this page sells several kits under one listing" — and its OpenGraph
// `product:price:amount` meta is then a single REPRESENTATIVE variant price
// (whichever variant Shopify features, typically the cheapest in stock), not
// the base kit.
//
// The price pass reads this so its JSON-LD/OpenGraph fallback (used whenever the
// richer Shopify product.json fetch is transiently blocked) can decline to store
// that representative figure over the base-kit price the variant picker already
// resolved from product.json. gmk-bent-r2 × zFrontier oscillated 150→56→150 for
// exactly this reason: the two base colourways (150) were out of stock, so the
// featured/OG price was the cheapest in-stock alternate kit (56), and a blocked
// product.json let it overwrite the base. Preserving the last good price is the
// safe direction — this never stores a number, only declines to.
export function htmlDeclaresVariantProductGroup(html: string): boolean {
  const blocks = Array.from(
    String(html ?? "").matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  );
  for (const block of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue; // malformed block — try the next one
    }
    const root = data as { "@graph"?: unknown };
    const nodes: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(root["@graph"])
        ? (root["@graph"] as unknown[])
        : [data];
    for (const node of nodes) {
      const type = (node as { "@type"?: unknown })?.["@type"];
      if (
        type === "ProductGroup" ||
        (Array.isArray(type) && type.includes("ProductGroup"))
      ) {
        return true;
      }
    }
  }
  return false;
}

// Does a multi-offer page NAME every kit it is selling?
//
// A product page whose JSON-LD carries several offers and none of them
// classifies BASE is "several kits, and I cannot tell which is the base" — the
// readers never guess a price from it, and they never should. But not storing
// a number and CLEARING the one already stored are different claims, and only
// the second needs evidence that there is no base kit on offer at all.
//
// A page whose offers are NAMED gives that evidence: it says what each kit is,
// and none of them is a base. A page whose offers are UNNAMED says nothing of
// the kind — and that is the shape of every ordinary Shopify product page,
// which emits one unnamed Offer per variant. The JSON-LD reader is only ever
// reached when the richer /products/<handle>.json did not answer (a block, a
// 5xx, a timeout), so treating that silence as "no base kit here" wiped a good
// price off a perfectly readable store every time its product JSON hiccuped.
// primekb.com is the case in hand: probed from a runner on 2026-09-19 its
// GMK Inukuma page serves a Base variant at USD 155, in stock, and four
// unnamed JSON-LD offers (155 / 50 / 40 / 35). The row was cleared to NULL,
// stamped priceSource='SCRAPED', and — its set being released, where unpriced
// rows are hidden — the vendor published nothing at all while the audit
// reported "none priced … another scrape reaches the same answer".
//
// Mirrored as _offers_name_every_kit in scraper/scrape.py; test:kit-variants
// fails if either call site stops asking.
export function offersNameEveryKit(offers: Array<{ name?: string | null }>): boolean {
  if (!Array.isArray(offers) || offers.length === 0) return false;
  return offers.every((offer) => String(offer?.name ?? "").trim() !== "");
}
