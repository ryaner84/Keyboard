// A set that IS a subkit must still be priceable.
//
// The dcs.wiki archive catalogs subkits as first-class sets — "DCS After School
// 1992 40s kit", "DCS 10U Spacebars", "DCS Bae Addon" — and a store sells each
// as ONE product whose base offering is, necessarily, a subkit-named variant.
// Every subkit rule in the price path exists to stop "GMK Foo Novelties" being
// priced as GMK Foo's base kit, and each of them fires on these sets too, where
// it is exactly wrong.
//
// The consequence is not a mis-priced row, it is a missing one: the guards
// answer NO_BASE_KIT, which clears the price, and an unpriced row is hidden
// outright on a RELEASED set. Saber Keebs — a Signature Plastics specialist
// whose catalogue is these DCS subkit sets — therefore published NOTHING at
// all, and the publishing audit named it "1 listing linked, none priced", which
// reads as a pricing backlog and sends the owner to refresh-prices: the one
// pass the guard guarantees can never fix it.
//
// This suite pins the exception at every level it has to hold, in both halves.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSubkitSetName, pickBaseVariant, SUBKIT_PRODUCT_RE } from "@/lib/kit-variants";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ── Which SETS are subkit products ──────────────────────────────────────────
// Asked of the set name, never the product title: both say "40s", and only the
// tracked set knows whether the 40s kit is the whole product or an add-on.

for (const name of [
  "DCS After School 1992 40s kit",
  "DCS 10U Spacebars",
  "DCS Bae Addon",
  "DCS LAE Addon",
  "GMK Foo Novelties",
]) {
  assert.ok(isSubkitSetName(name), `"${name}" is a subkit set`);
}

for (const name of [
  "GMK Dolch",
  "DCS Dolch",
  "GMK CYL Mizu R2",
  // Singular "Alpha" is a colourway, not an alphas kit — the plural-only rule.
  "GMK Alpha",
]) {
  assert.ok(!isSubkitSetName(name), `"${name}" is a whole set, not a subkit`);
}

assert.ok(!isSubkitSetName(null), "a missing set name is not a subkit set");
assert.ok(!isSubkitSetName(""), "a blank set name is not a subkit set");

// ── The picker ──────────────────────────────────────────────────────────────
// Saber Keebs' actual page, as the probe read it from a runner.

const saberKeebs = [
  { title: "40s Monokit", price: 140 },
  { title: "BAE", price: 10 },
  { title: "LAE", price: 10 },
];

assert.equal(
  pickBaseVariant(saberKeebs, true)?.price,
  140,
  "a subkit set's own kind of kit IS its base kit"
);
assert.equal(
  pickBaseVariant(saberKeebs)?.price,
  10,
  "without the flag the 40s variant is dropped and the $10 add-on wins — " +
    "the behaviour this exception exists to prevent, kept here so the " +
    "default stays unchanged for every ordinary set"
);

// The flag widens the base pool; it must not promote an accessory or a labeled
// standard subkit, which are wrong for a subkit set too.
assert.equal(
  pickBaseVariant(
    [
      { title: "40s Monokit", price: 140 },
      { title: "Deskmat", price: 300 },
    ],
    true
  )?.title,
  "40s Monokit",
  "accessories are excluded whether or not subkits are allowed"
);
assert.equal(
  pickBaseVariant([{ title: "Deskmat", price: 300 }], true),
  null,
  "an accessory-only listing still has no base kit"
);
assert.equal(
  pickBaseVariant(
    [
      { title: "Base", price: 120 },
      { title: "40s", price: 40 },
    ],
    true
  )?.title,
  "Base",
  "a variant actually titled Base still wins outright"
);

// ── The guards above the picker ─────────────────────────────────────────────
// This is where the bug lived. `allow_subkits` reached choose_kit_variant in
// scrape.py and stopped there: shopify_price's product-title guard runs FIRST
// and returned NO_BASE_KIT, so the exception below it was unreachable on the
// Shopify path — which is where these products are. The TS half never had the
// parameter at all.

const prices = read("src/lib/import/prices.ts");
assert.ok(
  /if \(!pinnedId && !allowSubkits && productTitle\)/.test(prices),
  "the Shopify product-title guard must not fire on a subkit set — it runs " +
    "before the variants are read, so gating only the picker changes nothing"
);
assert.ok(
  /pickBaseVariant\(variants, allowSubkits\)/.test(prices),
  "the Shopify path must pass allowSubkits to the picker"
);
assert.ok(
  /pickBaseVariant\(wooVariants, allowSubkits\)/.test(prices),
  "the WooCommerce path must pass allowSubkits to the picker"
);
assert.ok(
  /fetchShopifyPrice\(productUrl, vendorCurrency, allowSubkits\)/.test(prices),
  "fetchVendorPrice must thread allowSubkits into the Shopify path"
);
assert.ok(
  /fetchJsonLdPrice\(productUrl, vendorCurrency, allowSubkits\)/.test(prices),
  "fetchVendorPrice must thread allowSubkits into the generic path"
);

// The flag is derived at the queue, from the set name, so the row must carry
// it. Omitting the select does not fail loudly — every subkit set silently
// answers NO_BASE_KIT instead, which is unpriced, which is hidden.
assert.ok(
  /kit: \{ select: \{ groupBuy: \{ select: \{ name: true \} \} \} \}/.test(prices),
  "the price queue must select the set name isSubkitSetName decides on"
);
assert.ok(
  /isSubkitSetName\(vk\.kit\?\.groupBuy\?\.name\)/.test(prices),
  "refreshOne must pass the row's set name to fetchVendorPrice"
);

// …and the nightly price audit re-picks the base and OVERWRITES the stored
// price when the two differ, so it must make the SAME pick. Without the flag it
// corrects a subkit set's real base price back down to an add-on every night
// ($140 → the $10 BAE), which is worse than the nothing these sets published
// before: a wrong number on a set page rather than a missing one.
const priceAudit = read("src/lib/import/price-audit.ts");
assert.ok(
  /isSubkitSetName\(row\.kit\?\.groupBuy\?\.name\)/.test(priceAudit),
  "the price audit must apply the same subkit exception as the price pass"
);
assert.ok(
  /kit: \{ select: \{ groupBuy: \{ select: \{ name: true \} \} \} \}/.test(priceAudit),
  "the price audit must select the set name it decides on"
);

// ── The two halves must agree ───────────────────────────────────────────────
// scrape.py is the nightly (a real browser); prices.ts is the half that runs
// four times a day in CI and again on the Vercel cron. A fix to one is half a
// fix — the reason this rule was written twice and worked in neither.

const scraper = read("scraper/scrape.py");
assert.ok(
  /if not pinned_id and not allow_subkits and product_title:/.test(scraper),
  "scrape.py's product-title guard must carry the same exception"
);
assert.ok(
  /def parse_jsonld_offer\(html: str, allow_subkits: bool = False\)/.test(scraper),
  "scrape.py's single-offer guard must be able to see the exception"
);
assert.ok(
  /parse_jsonld_offer\(html, allow_subkits=allow_subkits\)/.test(scraper),
  "generic_price must pass the exception to the single-offer guard"
);
assert.ok(
  /if name and not allow_subkits and \(/.test(scraper),
  "scrape.py's single-offer guard must not fire on a subkit set"
);

// …and the vocabulary itself is written twice. One list decides which SETS are
// subkits and which store PRODUCTS discovery may link; if the copies drift, a
// set becomes priceable in one pass and not the other.
const tsSource = SUBKIT_PRODUCT_RE.source;
const pySource = /_SUBKIT_PRODUCT_RE = re\.compile\(\s*r"([^"]+)"\s*\+ _NONBASE_SUBKIT_RE\.pattern \+ r"([^"]+)"/.exec(
  scraper
);
assert.ok(pySource, "scrape.py must still build _SUBKIT_PRODUCT_RE from the shared pieces");
assert.ok(
  tsSource.startsWith(pySource![1].replace(/\\\\/g, "\\")),
  "the two subkit-product vocabularies must start with the same prefix"
);

// discovery.ts must not declare its own copy again — it asks the SAME question
// of a store product that the price passes ask of a set name.
const discovery = read("src/lib/import/discovery.ts");
assert.ok(
  /import \{ SUBKIT_PRODUCT_RE \} from "@\/lib\/kit-variants"/.test(discovery),
  "discovery must import the shared subkit vocabulary, not re-declare it"
);
assert.ok(
  !/const SUBKIT_PRODUCT_RE = new RegExp/.test(discovery),
  "discovery must not re-declare SUBKIT_PRODUCT_RE"
);

console.log("subkit-sets: all assertions passed");
