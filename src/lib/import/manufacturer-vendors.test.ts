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
  isManufacturerStorefrontSlug,
  isUnpriceableManufacturerListing,
} from "@/lib/import/manufacturer-vendors";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ── The registry itself ─────────────────────────────────────────────────────

assert.deepEqual(
  [...MANUFACTURER_VENDOR_SLUGS],
  ["gmk", "dcs-wiki", "sxm-designs"],
  "every non-store catalog source must be registered"
);

// A designer's portfolio is the same shape as a manufacturer's catalog: a host
// that carries set pages and sells nothing. sxmdesigns.com has no price on any
// page, so a row pointing at it can only ever answer NO_PRODUCT_DATA.
assert.ok(
  isManufacturerListingUrl("https://sxmdesigns.com/gmk-kitsune/"),
  "sxmdesigns.com is a portfolio URL, not a listing"
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

// ── May this row be priced? ─────────────────────────────────────────────────
// The question is about the row, not the URL: a catalog host is a refusal for
// every vendor EXCEPT the manufacturer's own shop, which sells from it.

assert.ok(isManufacturerStorefrontSlug("gmk-direct"), "gmk-direct is the manufacturer's own shop");
assert.ok(!isManufacturerStorefrontSlug("gmk"), "the catalog marker is not a shop");
assert.ok(!isManufacturerStorefrontSlug(null), "a missing slug is not the storefront");

assert.ok(
  isUnpriceableManufacturerListing("https://www.gmk.net/shop/en/gmk-dolch/gmk10108", "cannonkeys"),
  "a store row parked on gmk.net is still a catalog reference"
);
assert.ok(
  isUnpriceableManufacturerListing("https://dcs.wiki/archive/dcs-dolch", "dcs-wiki"),
  "the archive marker is never priced"
);
assert.ok(
  !isUnpriceableManufacturerListing(
    "https://www.gmk.net/shop/en/gmk-warehouse-finds/fptk1339",
    "gmk-direct"
  ),
  "gmk-direct's Warehouse Finds listings must be priceable — unpriced hides them on released sets"
);
assert.ok(
  isUnpriceableManufacturerListing("https://www.gmk.net/shop/en/gmk-dolch/gmk10108"),
  "with no vendor in hand the refusal stays the default"
);
assert.ok(
  !isUnpriceableManufacturerListing("https://cannonkeys.com/products/gmk-dolch", "cannonkeys"),
  "an ordinary store listing is priceable"
);

// ── The price-queue filter ──────────────────────────────────────────────────
// Both halves must be present. Slug alone misses a gmk.net row filed under a
// store's vendor id; URL alone misses a manufacturer row whose productUrl was
// rewritten by an import.

assert.deepEqual(
  NOT_MANUFACTURER_LISTING.vendor,
  { slug: { notIn: [...MANUFACTURER_VENDOR_SLUGS] } },
  "the price queue must refuse every manufacturer slug, not just gmk"
);
assert.deepEqual(
  NOT_MANUFACTURER_LISTING.NOT,
  {
    AND: [
      { vendor: { slug: { notIn: [...MANUFACTURER_STOREFRONT_SLUGS] } } },
      { OR: MANUFACTURER_URL_HOSTS.map((host) => ({ productUrl: { contains: host } })) },
    ],
  },
  "the price queue must refuse every manufacturer host, except on the manufacturer's own shop"
);

// The filter is SPREAD into refreshPrices' `where`, which sets its own `OR`
// (the priceSource guard) and its own `AND` (the staleness cadence). A clause
// added here under either name would be silently overwritten by them: the
// filter would still typecheck, still read correctly, and stop excluding
// anything at all — putting all 135 dcs.wiki rows back at the front of a
// time-boxed queue with nothing failing loudly.
assert.deepEqual(
  Object.keys(NOT_MANUFACTURER_LISTING).sort(),
  ["NOT", "vendor"],
  "the price-queue filter may only use keys refreshPrices' where does not also set"
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
  { slug: { notIn: [...MANUFACTURER_VENDOR_SLUGS] } },
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

const pyStorefronts = /MANUFACTURER_STOREFRONT_SLUGS\s*=\s*\(([^)]*)\)/.exec(scraper);
assert.ok(pyStorefronts, "scrape.py must keep MANUFACTURER_STOREFRONT_SLUGS");
assert.deepEqual(
  captures(/"([^"]+)"/g, pyStorefronts[1]),
  [...MANUFACTURER_STOREFRONT_SLUGS],
  "scrape.py and manufacturer-vendors.ts must excuse the same storefronts"
);

// The nightly is the half with a real browser, and it is the half whose price
// queue is hand-written SQL. An exception that exists only in the TS copy would
// leave the manufacturer's shop unpriced on every night's run — the exact shape
// of #131's discovery fix, which landed in the TS half alone.
const pyPriceQueue = /def fetch_price_candidates\([\s\S]*?return cur\.fetchall\(\)/.exec(scraper);
assert.ok(pyPriceQueue, "scrape.py must keep fetch_price_candidates");
assert.ok(
  /AND \(v\.slug = ANY\(%s\) OR NOT \(vk\."productUrl" ILIKE ANY\(%s\)\)\)/.test(pyPriceQueue[0]),
  "scrape.py's price queue must excuse the manufacturer storefront from the host patterns"
);
assert.ok(
  /list\(MANUFACTURER_STOREFRONT_SLUGS\)/.test(pyPriceQueue[0]),
  "scrape.py's price queue must bind MANUFACTURER_STOREFRONT_SLUGS, not a literal"
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
  /if \(isUnpriceableManufacturerListing\(productUrl, vendorSlug\)\) return null;/.test(prices),
  "fetchVendorPrice must refuse every manufacturer host before fetching"
);
// …and the guard has to be given the vendor. Selecting only the currency makes
// it refuse gmk-direct on every row — silently, since a refusal is spelled the
// same as a page that could not be read.
assert.ok(
  /vendor: \{ select: \{ currency: true, slug: true \} \}/.test(prices),
  "the price queue must select the vendor slug fetchVendorPrice decides on"
);
// Matched across the argument list rather than on one line: the call carries a
// fourth argument now (the subkit-set flag), and pinning its FORMATTING would
// fail on a line break while saying nothing about the slug it exists to check.
assert.ok(
  /fetchVendorPrice\(\s*vk\.productUrl,\s*vk\.vendor\.currency,\s*vk\.vendor\.slug\b/.test(prices),
  "refreshOne must pass the row's vendor slug to fetchVendorPrice"
);

// ── db-setup's SQL copies of the registry ───────────────────────────────────
//
// The deploy purge is a price path too, and it was the last one still judging a
// row by its URL host alone: `v.slug = 'gmk' OR productUrl ILIKE '%gmk.net%'`
// wiped gmk-direct's 9 Warehouse Finds prices on EVERY deploy, and its matched
// half (restorePurgedPricesFromVariants) then barred those same rows from the
// one pass that could put them back. Their sets are all released, so an
// unpriced row is hidden outright: the manufacturer's own shop published
// nothing from every deploy until the next nightly run_gmk_direct. The
// TypeScript call sites above are pinned against this exact mistake; SQL was
// not, which is the only reason it survived.

const dbSetup = read("scripts/db-setup.mjs");

const sqlList = (name: string): string[] => {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(dbSetup);
  assert.ok(match, `db-setup must declare ${name}`);
  const out: string[] = [];
  const item = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = item.exec(match![1])) !== null) out.push(m[1]);
  return out;
};

// Derived from the registry, never re-listed: a hardcoded copy here was a fifth
// place the list was written and went stale the moment a third source landed.
assert.deepEqual(
  sqlList("_MANUFACTURER_STOREFRONT_SLUGS"),
  [...MANUFACTURER_STOREFRONT_SLUGS],
  "db-setup's storefront mirror must match MANUFACTURER_STOREFRONT_SLUGS"
);
assert.deepEqual(
  sqlList("_MANUFACTURER_VENDOR_SLUGS"),
  [...MANUFACTURER_VENDOR_SLUGS],
  "db-setup's catalog-slug mirror must match MANUFACTURER_VENDOR_SLUGS"
);
assert.deepEqual(
  sqlList("_MANUFACTURER_URL_PATTERNS"),
  MANUFACTURER_URL_HOSTS.map((host) => `%${host}%`),
  "db-setup's ILIKE patterns must cover every manufacturer host — a bare " +
    "'%gmk.net%' silently lets dcs.wiki and sxmdesigns.com through"
);

// The bare filter itself, in either spelling. This is the string that shipped.
assert.ok(
  !/v\.slug = 'gmk' OR vk\."productUrl" ILIKE '%gmk\.net%'/.test(dbSetup),
  "db-setup still hand-writes the bare manufacturer filter — it cannot tell " +
    "gmk-direct's rows from the gmk catalog marker's"
);
assert.ok(
  !/AND v\.slug <> 'gmk'/.test(dbSetup),
  "the restore half still hand-writes the bare slug test"
);

// Both halves must consult the storefront list, and the purge must spare
// MANUAL prices — without that guard, naming the other catalog sources would
// widen the wipe onto hand-entered numbers.
for (const fn of ["purgeMispricedListings", "restorePurgedPricesFromVariants"]) {
  const start = dbSetup.indexOf(`async function ${fn}(`);
  assert.ok(start > -1, `db-setup must still define ${fn}`);
  const body = dbSetup.slice(start, start + 2000);
  assert.ok(
    body.includes("_MANUFACTURER_STOREFRONT_SLUGS"),
    `${fn} must exempt the manufacturer's own storefront`
  );
}
const purgeStart = dbSetup.indexOf("async function purgeMispricedListings(");
assert.ok(
  /COALESCE\(vk\."priceSource", ''\) <> 'MANUAL'/.test(
    dbSetup.slice(purgeStart, purgeStart + 2000)
  ),
  "the deploy purge must never wipe a MANUAL price"
);

console.log("manufacturer-vendors: all assertions passed");
