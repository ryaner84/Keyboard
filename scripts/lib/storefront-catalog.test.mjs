import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  NON_PRODUCT_ROOT_SEGMENTS,
  catalogProductHandle,
  catalogProductTitle,
  isRootLevelProductPath,
  shopifyProductNode,
} from "./storefront-catalog.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const scrapePy = read("scraper", "scrape.py");
const pricesTs = read("src", "lib", "import", "prices.ts");
const discoveryTs = read("src", "lib", "import", "discovery.ts");

// ── The reported case, verbatim from mokbstore.com ──────────────────────────
//
// Probed from a runner on 2026-09-17 (the Vendor probe workflow):
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
// A Haravan storefront: the whole Shopify product-JSON API, the same
// `{"product": …}` wrapper, a variant the picker names "Base" on the first try
// — and two differences, both of them things this codebase keys off.
const haravanEntry = {
  id: 34220859,
  name: "Bộ keycap GMK MV T3RMINAL (Cherry profile / ABS)",
  alias: "gmk-mv-t3rminal-keycaps",
  vendor: "GMK",
  product_type: "In Stock",
  variants: [{ title: "Base", price: 3180000, available: false, inventory_quantity: 0 }],
};
assert.equal(catalogProductTitle(haravanEntry), haravanEntry.name);
assert.equal(catalogProductHandle(haravanEntry), "gmk-mv-t3rminal-keycaps");

// Shopify's own spelling keeps working, and wins when an app metafield has put
// a `name` beside it: the platform that owns the endpoint owns the spelling.
const shopifyEntry = { title: "GMK Dandy", handle: "gmk-dandy", name: "nope", alias: "nope" };
assert.equal(catalogProductTitle(shopifyEntry), "GMK Dandy");
assert.equal(catalogProductHandle(shopifyEntry), "gmk-dandy");

// A handle-less entry is dropped by every caller, so "" must not read as a name.
assert.equal(catalogProductTitle({}), "");
assert.equal(catalogProductHandle({}), "");
assert.equal(catalogProductTitle(null), "");
assert.equal(catalogProductHandle(undefined), "");
// Non-string junk from a feed is not a title either.
assert.equal(catalogProductTitle({ title: 42, name: "GMK Foo" }), "GMK Foo");

// ── One product node, two wrappings ─────────────────────────────────────────
//
// mokbstore.com answered its root-level <alias>.json wrapped on one probe and
// bare on another, same URL, same day. Betting the fix on either reading would
// have left the store silent half the time and said nothing about which half.
assert.deepEqual(shopifyProductNode({ product: haravanEntry }), haravanEntry);
assert.deepEqual(shopifyProductNode(haravanEntry), haravanEntry);
// `variants` is what identifies a product node — a password page answers 200
// with HTML for .json too, and an empty object is not a product.
assert.equal(shopifyProductNode({}), null);
assert.equal(shopifyProductNode({ product: { title: "GMK Foo" } }), null);
assert.equal(shopifyProductNode(null), null);
assert.equal(shopifyProductNode("<!doctype html>"), null);
// A variant-less product is still not one this reader may unwrap: the caller
// would read zero variants and store nothing either way, and inventing a node
// out of an arbitrary object is how a collection payload becomes a "product".
assert.equal(shopifyProductNode({ products: [haravanEntry] }), null);

// ── The root-level door, and what makes it safe ─────────────────────────────
//
// It is the ONLY way a row with no /products/ segment can reach the product
// JSON reader, and that reader is one of the few places a listing can be
// answered "gone". So the narrowness is the safety, not a convenience.
assert.ok(isRootLevelProductPath("https://mokbstore.com/gmk-mv-t3rminal-keycaps"));
assert.ok(isRootLevelProductPath("https://mokbstore.com/gb-mv-expo-gmk-cyl"));
assert.ok(isRootLevelProductPath("https://mokbstore.com/gmk-mv-expo-keycaps/"));

// Every other silent-vendor URL shape in the roster carries more than one path
// segment, so none of them can reach it. These are real rows from the
// 2026-09-17 publishing audit.
for (const url of [
  "https://rheset.mx/collections/gmk-frost-witch",
  "https://kibou.store/collections/group-buy",
  "https://sandkeys.me/product/gmk-black-snail/",
  "https://mykeyboard.eu/catalogue/category/group-buys/gmk-8008_173/",
  "https://thockeys.com/keycaps/dcs-alchemy/",
  "https://www.keyclack.com/product/group-buy-gmk-muted/",
  "http://www.zfrontier.com/app/mch/1xmjEGd2dQml",
  "https://yakk.shop/product-category/gmk-thinkcaps/",
]) {
  assert.equal(isRootLevelProductPath(url), false, `${url} is not a root-level product alias`);
}

// The storefront ROOT most of all: a removed product's hop to the front door is
// what the canonical-handle retry must never mistake for the product's new
// address — "<origin>.json" is nonsense, and asking for it would answer a live
// shop with a 404.
assert.equal(isRootLevelProductPath("https://kono.store/"), false);
assert.equal(isRootLevelProductPath("https://kono.store"), false);

// An endpoint or a script is not a product alias.
assert.equal(isRootLevelProductPath("https://mokbstore.com/products.json"), false);
assert.equal(isRootLevelProductPath("http://donutcables.com/coniferous.php"), false);
assert.equal(isRootLevelProductPath("https://example.com/sitemap.xml"), false);
assert.equal(isRootLevelProductPath("not a url"), false);

// …nor is one of the storefront's own reserved roots.
for (const segment of NON_PRODUCT_ROOT_SEGMENTS) {
  assert.equal(
    isRootLevelProductPath(`https://example.com/${segment}`),
    false,
    `/${segment} is a storefront root, never a product`
  );
}

// ── Written twice: scrape.py mirrors this module ────────────────────────────
//
// The nightly is the half with a real browser, and a fix to one half is only
// half a fix — the failure this module exists to end reached BOTH discovery
// and both price passes.
for (const name of [
  "def catalog_product_title(",
  "def catalog_product_handle(",
  "def is_root_level_product_path(",
]) {
  assert.ok(scrapePy.includes(name), `scrape.py mirrors ${name.slice(4, -1)}`);
}

const pySegments = (() => {
  const block = scrapePy.match(/_NON_PRODUCT_ROOT_SEGMENTS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, "scrape.py declares _NON_PRODUCT_ROOT_SEGMENTS");
  return [...block[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
})();
assert.deepEqual(
  pySegments,
  [...NON_PRODUCT_ROOT_SEGMENTS].sort(),
  "the reserved-root lists must not drift: a segment in one half only is a " +
    "door open on one side of the site and shut on the other"
);

// ── Every caller reads the vocabulary, none re-spells it ────────────────────
//
// A hand-written `p.title` is the bug itself, and it is the kind that never
// fails loudly: the feed parses, the array is full, every title is undefined
// and nothing matches — so the store reports as "discovery has never matched a
// tracked set", which reads as "this shop stopped selling GMK".
assert.ok(
  discoveryTs.includes("catalogProductTitle(") && discoveryTs.includes("catalogProductHandle("),
  "discovery.ts reads the catalog through the shared vocabulary"
);
assert.ok(
  !/String\(p\.title\s*\?\?\s*""\)/.test(discoveryTs),
  "discovery.ts must not re-spell a catalog title as Shopify's field alone"
);
assert.ok(
  scrapePy.includes("catalog_product_title(p)") && scrapePy.includes("catalog_product_handle(p)"),
  "tracked_products_from_catalog reads the catalog through the mirrored vocabulary"
);
assert.ok(
  !/data\["product"\]\.get\("title"\)/.test(scrapePy),
  "the nightly's product-title guard must not read Shopify's field alone — " +
    "missing it does not fail loudly, it silently stops the subkit guard running"
);
assert.ok(
  /product\?\.title \?\? product\?\.name/.test(pricesTs),
  "prices.ts's product-title guard reads both spellings"
);
assert.ok(
  pricesTs.includes("shopifyProductNode(") && scrapePy.includes("shopify_product_node("),
  "both price halves unwrap the product node through the shared rule"
);

// ── The root-level door may never answer "gone" ─────────────────────────────
//
// `deadSince` is the only signal allowed to take a listing off the site
// (PURCHASABLE_VENDOR_KIT_WHERE refuses an unpriced dead row), and this door is
// a GUESS about the platform: a miss means "this store does not serve that
// endpoint", never "the store says the page is gone". Only the human product
// page may write that column, and the JSON-LD reader is what fetches it.
for (const [half, source, marker] of [
  ["prices.ts", pricesTs, /if \(rootLevelAlias\) return null;/],
  ["scrape.py", scrapePy, /if root_level_alias:\s*\n\s*return None/],
]) {
  assert.ok(marker.test(source), `${half} refuses to declare a listing gone from the root-level door`);
}
assert.ok(
  pricesTs.includes("isRootLevelProductPath(") && scrapePy.includes("is_root_level_product_path("),
  "both price halves gate the root-level door on the shared path rule"
);
// …and both ask the store what platform it is before opening it at all,
// once per origin rather than once per row.
assert.ok(
  scrapePy.includes("_SHOPIFY_COMPATIBLE_ORIGINS") &&
    scrapePy.includes("_SHOPIFY_COMPATIBLE_ORIGINS.clear()"),
  "the nightly memoizes the platform probe per origin, and clears it per RUN"
);
assert.ok(
  /if \(!\(await fetchShopifyCurrency\(productUrl\)\)\) return null;/.test(pricesTs),
  "prices.ts opens the root-level door only for an origin that answers /meta.json"
);

// ── A miss at the root-level door costs the row nothing ─────────────────────
//
// prices.ts always falls through from the Shopify reader to the JSON-LD one,
// so a miss there keeps the row's real diagnosis for free. The nightly picks
// ONE path per URL, so it has to be told — otherwise a page the JSON-LD reader
// understands would be filed UNREADABLE ("the store never answered") instead of
// NO_PRODUCT_DATA, which is the verdict that names the actual repair.
assert.ok(
  /if result is None and root_alias:\s*\n\s*result = generic_price\(/.test(scrapePy),
  "the nightly falls back to generic_price when the root-level door misses"
);

console.log(
  `storefront-catalog: ${NON_PRODUCT_ROOT_SEGMENTS.length} reserved root(s), both halves in agreement`
);
