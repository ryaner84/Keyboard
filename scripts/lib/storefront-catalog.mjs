// Reading a storefront's catalog and product JSON — and the ONE place the
// vocabulary those endpoints are spelled in is written.
//
// `/products.json`, `/products/<handle>.json` and `/meta.json` are treated
// throughout this codebase as "the Shopify endpoints", and four fifths of the
// roster is Shopify, so that reads as true. It is not. Haravan and Sapo — the
// Shopify clones most Vietnamese storefronts run on — serve the SAME three
// endpoints, wrap the product in the same `{"product": …}`, and give every
// variant the same `title` / `price` / `available`. They differ in exactly two
// places, and both of them are the ones this codebase keys off:
//
//   * a product's title is `name`, not `title`, and its handle is `alias`,
//     not `handle`;
//   * the canonical product URL has no `/products/` segment at all — the store
//     links `mokbstore.com/gmk-mv-expo-keycaps` (the `/products/<alias>` form
//     answers too, but nothing on the site uses it).
//
// So a Haravan store is invisible to this site twice over, and neither failure
// says anything out loud. Discovery fetches `/products.json`, gets a 200 and a
// full product array, reads `title` off every entry, finds undefined, matches
// nothing — and because the fetch SUCCEEDED it never falls through to the HTML
// crawl, so the store is not even among the ones that path was written for. It
// has therefore never linked or relinked a single listing. And both price
// passes gate their product-JSON reader on the literal substring `/products/`,
// which the store's own URLs do not contain, so every row falls to the generic
// JSON-LD reader — and a Haravan product page carries only a BreadcrumbList,
// no `Product`, no OpenGraph price. `NO_PRODUCT_DATA`, for ever.
//
// Mokb Store is the worked example. Probed from a runner on 2026-09-17:
//
//   === PROBE https://mokbstore.com/gb-mv-t3rminal-gmk-cyl
//     CHAIN     | 301 → https://mokbstore.com/gmk-mv-t3rminal-keycaps  200
//     SHOPIFY   | …/gmk-mv-t3rminal-keycaps.json — 200, 1 variant(s)
//                 | {product:{…}} | title key "name"
//     PRODUCT   | Bộ keycap GMK MV T3RMINAL (Cherry profile / ABS)
//     VARIANT   | "Base" | price=3180000 | available=false | qty=0
//     SHOP CCY  | VND (/meta.json)
//     JSON-LD   | BreadcrumbList, ListItem
//     OG PRICE  | absent
//
// A live shop, a complete product JSON, a variant the picker names "Base" on
// the first try — and the publishing audit reporting it under "answer 200 with
// no product markup any parser path knows … teach the parser or retire it",
// which is the one verdict that names a change HERE and no amount of scraping
// can end. Its 3 listings are all it has, so the vendor published NOTHING.
//
// WRITTEN TWICE, as everything that reads a store is: `scraper/scrape.py`
// mirrors this module (Python cannot import a JS module) and
// `npm run test:storefront-catalog` fails if the two halves drift.

/**
 * A catalog/product entry's display title, whichever platform wrote it.
 *
 * Shopify says `title`, Haravan and Sapo say `name`. Shopify wins when both
 * are present: a Shopify product may carry an unrelated `name` from an app's
 * metafield, and the platform that owns the endpoint owns the spelling.
 */
export function catalogProductTitle(product) {
  if (!product || typeof product !== "object") return "";
  if (typeof product.title === "string") return product.title;
  return typeof product.name === "string" ? product.name : "";
}

/**
 * A catalog/product entry's URL handle, whichever platform wrote it.
 *
 * Shopify says `handle`, Haravan and Sapo say `alias`. Empty string for an
 * entry carrying neither, which every caller already drops — a product with no
 * handle has no URL to link.
 */
export function catalogProductHandle(product) {
  if (!product || typeof product !== "object") return "";
  if (typeof product.handle === "string") return product.handle;
  return typeof product.alias === "string" ? product.alias : "";
}

/**
 * The product node inside a Shopify-compatible `.json` response, or null.
 *
 * Shopify wraps it: `{"product": {…}}`. A clone does too on the
 * `/products/<alias>.json` form — and was observed answering the root-level
 * `<alias>.json` form BOTH ways across two probes of the same URL on the same
 * day, which is reason enough not to bet the fix on either reading. `variants`
 * is the one key every shape agrees on, so it is what identifies a product node
 * at all; a body with neither is not product JSON (a password page answers 200
 * with HTML for `.json` too).
 *
 * Unwrapping is all this does. The FIELDS inside still disagree between
 * platforms — that is what catalogProductTitle/Handle above are for.
 */
export function shopifyProductNode(data) {
  if (!data || typeof data !== "object") return null;
  const wrapped = data.product;
  if (wrapped && typeof wrapped === "object" && Array.isArray(wrapped.variants)) {
    return wrapped;
  }
  return Array.isArray(data.variants) ? data : null;
}

/**
 * Root-level paths a storefront serves that are NOT a product.
 *
 * The ones Shopify itself reserves, plus the two a clone adds. This list is
 * what keeps the root-alias rule below from claiming a store's own section
 * pages — and it is deliberately not the safety that matters, because a single
 * path segment already excludes every `/collections/x/…`, `/product/x/` and
 * `/catalogue/…/x/` link in the roster.
 */
export const NON_PRODUCT_ROOT_SEGMENTS = Object.freeze([
  "account",
  "apps",
  "blogs",
  "cart",
  "checkout",
  "collections",
  "pages",
  "password",
  "policies",
  "products",
  "search",
  "tools",
]);

const NON_PRODUCT_ROOT_SEGMENT_SET = new Set(NON_PRODUCT_ROOT_SEGMENTS);

/**
 * Is this URL a ROOT-LEVEL product alias — the shape a Shopify clone links?
 *
 * Exactly one path segment, and not one of the storefront's own reserved
 * roots. Narrow on purpose, and the narrowness is the safety: a collection
 * link (`rheset.mx/collections/gmk-frost-witch`), a WooCommerce product
 * (`sandkeys.me/product/gmk-black-snail/`) and a catalogue path
 * (`mykeyboard.eu/catalogue/category/group-buys/gmk-8008_173/`) all carry more
 * than one segment, so none of them can reach the product-JSON reader by this
 * door and be answered "gone" for a `.json` the store never served.
 *
 * It says nothing on its own about the platform — `mokbstore.com/about` passes
 * it too. The caller asks `/meta.json` for that, and treats a miss as "this
 * store does not serve that endpoint", never as a verdict on the listing.
 */
export function isRootLevelProductPath(url) {
  let pathname;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return false;
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return false;
  const [segment] = segments;
  // `/products.json`, `/sitemap.xml`, `/index.php` — an endpoint or a script,
  // never a product alias, and appending `.json` to one is nonsense.
  if (/\.[a-z0-9]{2,5}$/i.test(segment)) return false;
  return !NON_PRODUCT_ROOT_SEGMENT_SET.has(segment.toLowerCase());
}
