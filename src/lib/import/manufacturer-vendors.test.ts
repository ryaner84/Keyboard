import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANUFACTURER_STOREFRONT_SLUGS,
  MANUFACTURER_URL_HOSTS,
  MANUFACTURER_VENDOR_SLUGS,
  NOT_MANUFACTURER_LISTING,
  NOT_MANUFACTURER_VENDOR,
  PURCHASABLE_VENDOR_KIT_WHERE,
  isManufacturerListingUrl,
} from "@/lib/import/manufacturer-vendors";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ── The registry itself ─────────────────────────────────────────────────────

assert.deepEqual(
  [...MANUFACTURER_VENDOR_SLUGS],
  ["gmk", "dcs-wiki"],
  "both catalog sources must be registered"
);

assert.ok(
  isManufacturerListingUrl("https://www.gmk.net/shop/en/gmk-dolch/gmk10108"),
  "gmk.net is a catalog URL"
);
assert.ok(isManufacturerListingUrl("https://dcs.wiki/archive/dcs-dolch"), "dcs.wiki is a catalog URL");
assert.ok(
  isManufacturerListingUrl("HTTPS://DCS.WIKI/Archive/DCS-Dolch"),
  "host matching is case-insensitive — an import may store any spelling"
);
assert.ok(!isManufacturerListingUrl("https://cannonkeys.com/products/gmk-dolch"), "a store is not a catalog");
assert.ok(!isManufacturerListingUrl(null), "a NULL productUrl is not a catalog URL");
assert.ok(!isManufacturerListingUrl(""), "a blank productUrl is not a catalog URL");

// ── The price-queue filter ──────────────────────────────────────────────────
// Both halves must be present. Slug alone misses a gmk.net row filed under a
// store's vendor id; URL alone misses a manufacturer row whose productUrl was
// rewritten by an import.

assert.deepEqual(
  NOT_MANUFACTURER_LISTING.vendor,
  { slug: { notIn: ["gmk", "dcs-wiki"] } },
  "the price queue must refuse every manufacturer slug, not just gmk"
);
assert.deepEqual(
  NOT_MANUFACTURER_LISTING.NOT,
  { OR: [{ productUrl: { contains: "gmk.net" } }, { productUrl: { contains: "dcs.wiki" } }] },
  "the price queue must refuse every manufacturer host"
);

// ── The site filter ─────────────────────────────────────────────────────────

const purchasableOr = PURCHASABLE_VENDOR_KIT_WHERE.OR;
assert.ok(Array.isArray(purchasableOr), "the site filter is an OR of escape hatches");

// A NULL productUrl (a manually-priced row) must survive. Without this branch
// SQL three-valued logic drops it: `NULL NOT LIKE '%gmk.net%'` is NULL, not
// true — which would silently unpublish every hand-entered price on the site.
assert.ok(
  purchasableOr.some((clause) => JSON.stringify(clause) === JSON.stringify({ productUrl: null })),
  "manually-priced rows (NULL productUrl) must stay visible"
);

// gmk-direct is a real shop that happens to live on gmk.net.
assert.deepEqual([...MANUFACTURER_STOREFRONT_SLUGS], ["gmk-direct"]);
assert.ok(
  purchasableOr.some(
    (clause) => JSON.stringify(clause) === JSON.stringify({ vendor: { slug: { in: ["gmk-direct"] } } })
  ),
  "gmk-direct's Warehouse Finds listings must stay purchasable"
);

assert.deepEqual(
  NOT_MANUFACTURER_VENDOR,
  { slug: { notIn: ["gmk", "dcs-wiki"] } },
  "the discovery rotation must refuse every manufacturer slug"
);

// ── Agreement with the Python scraper ───────────────────────────────────────
// Discovery and pricing are written twice — scrape.py is the nightly that
// actually crawls, the TS copy is the Vercel cron. A registry that exists on
// one side only is exactly how dcs.wiki ended up in the TS price queue while
// Python had already excluded it.

const scraper = read("scraper/scrape.py");

// Pull every capture of `re` out of `text`, ES5-safely (the test tsconfig
// predates matchAll's iterator).
function captures(re: RegExp, text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

const pySlugs = /MANUFACTURER_VENDOR_SLUGS\s*=\s*\(([^)]*)\)/.exec(scraper);
assert.ok(pySlugs, "scrape.py must keep MANUFACTURER_VENDOR_SLUGS");
assert.deepEqual(
  captures(/"([^"]+)"/g, pySlugs[1]),
  [...MANUFACTURER_VENDOR_SLUGS],
  "scrape.py and manufacturer-vendors.ts must list the same manufacturer slugs"
);

const pyPatterns = /MANUFACTURER_URL_PATTERNS\s*=\s*\(([^)]*)\)/.exec(scraper);
assert.ok(pyPatterns, "scrape.py must keep MANUFACTURER_URL_PATTERNS");
assert.deepEqual(
  captures(/"%([^%"]+)%"/g, pyPatterns[1]),
  [...MANUFACTURER_URL_HOSTS],
  "scrape.py and manufacturer-vendors.ts must match the same manufacturer hosts"
);

// ── Every call site goes through the registry ───────────────────────────────
// A hand-written `slug: { not: "gmk" }` is how this diverged the first time:
// it reads as correct and silently excludes only one of the two sources.

const callSites: Array<[string, string]> = [
  ["src/lib/import/prices.ts", "NOT_MANUFACTURER_LISTING"],
  ["src/lib/import/discovery.ts", "NOT_MANUFACTURER_VENDOR"],
  ["src/app/sets/[slug]/page.tsx", "PURCHASABLE_VENDOR_KIT_WHERE"],
  ["src/app/api/group-buys/[slug]/route.ts", "PURCHASABLE_VENDOR_KIT_WHERE"],
];

for (const [file, symbol] of callSites) {
  const source = read(file);
  assert.ok(
    source.includes(symbol),
    `${file} must filter manufacturer rows through ${symbol}, not a local literal`
  );
  assert.ok(
    !/slug:\s*\{\s*not:\s*"gmk"\s*\}/.test(source),
    `${file} still filters on the bare slug "gmk" — dcs-wiki would slip through`
  );
  assert.ok(
    !/productUrl:\s*\{\s*contains:\s*"gmk\.net"\s*\}/.test(source),
    `${file} still filters on the bare host "gmk.net" — dcs.wiki would slip through`
  );
}

// The price fetcher's own guard: a JSON-LD reader pointed at an archive page
// can return a number, and a number is all it takes for a wiki to be published
// as a set's cheapest vendor.
const prices = read("src/lib/import/prices.ts");
assert.ok(
  /if \(isManufacturerListingUrl\(productUrl\)\) return null;/.test(prices),
  "fetchVendorPrice must refuse every manufacturer host before fetching"
);

console.log("manufacturer-vendors: all assertions passed");
