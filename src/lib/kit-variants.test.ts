import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NONBASE_SUBKIT_RE,
  PRODUCT_ACCESSORY_RE,
  SUBKIT_PRODUCT_RE,
  classifyVariant,
  htmlDeclaresVariantProductGroup,
  isSubkitSetName,
  offersNameEveryKit,
  pickBaseVariant,
} from "@/lib/kit-variants";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ── A set that IS a subkit ──────────────────────────────────────────────────
//
// The dcs.wiki archive catalogs accessory products as first-class sets. Every
// rule of the form "a subkit product is never the base listing" therefore has
// to know when the subkit IS the product being tracked — otherwise the only
// products that could ever match such a set are exactly the ones being thrown
// away, and the set publishes nothing at any vendor, for ever.

for (const name of [
  "DCS After School 1992 40s Kit",
  "DCS 10U Spacebars",
  "DCS Bae Addon",
  "GMK Foo Novelties",
  "GMK Bar Alphas",
]) {
  assert.ok(isSubkitSetName(name), `"${name}" is a subkit set`);
}

for (const name of [
  "GMK Dolch",
  "DCS Alchemy",
  "GMK Olivia++",
  // Plural-only, so a set legitimately named "… Alpha" still links.
  "GMK Handarbeit Alpha",
  // "extras" is deliberately absent from the vocabulary: an extras listing
  // sells the base kit (keyspresso's "[Extras] GMK Harvest" is one).
  "[Extras] GMK Harvest",
]) {
  assert.ok(!isSubkitSetName(name), `"${name}" is an ordinary set`);
}

assert.ok(!isSubkitSetName(null), "a missing set name is not a subkit set");
assert.ok(!isSubkitSetName(""), "a blank set name is not a subkit set");

// ── The pick ────────────────────────────────────────────────────────────────
//
// Saber Keebs' "DCS After School 1992 40s Kit", read from a runner on
// 2026-09-13: the $140 line is the base kit of this set and the two $10 lines
// are add-ons. Dropping the 40s variant leaves the add-ons as the only
// candidates, so the set would publish at $10 — a visibly wrong number — and
// the product-title guard above the picker instead answered NO_BASE_KIT, so it
// published at nothing. That is the vendor's ONLY listing.
const saberKeebs = [
  { title: "40s Monokit", price: 140 },
  { title: "BAE", price: 10 },
  { title: "LAE", price: 10 },
];

assert.equal(
  pickBaseVariant(saberKeebs, { allowSubkits: true })?.price,
  140,
  "on a subkit set the subkit variant IS the base kit"
);
assert.equal(
  pickBaseVariant(saberKeebs)?.price,
  10,
  "without the flag the 40s line is dropped and a $10 add-on wins — which is " +
    "why every caller has to pass the same flag"
);

// The flag widens the candidate pool; it never overrides a variant the store
// itself titles "Base", and it never re-admits an accessory.
assert.equal(
  pickBaseVariant(
    [
      { title: "Base Kit", price: 120 },
      { title: "40s Kit", price: 160 },
    ],
    { allowSubkits: true }
  )?.title,
  "Base Kit",
  "a BASE-titled variant still wins outright"
);
assert.equal(
  pickBaseVariant([{ title: "GMK Foo Deskmat", price: 35 }], { allowSubkits: true }),
  null,
  "an accessory-only listing has no base kit, subkit set or not"
);
assert.equal(
  pickBaseVariant(
    [
      { title: "Novelties", price: 45 },
      { title: "Spacebars", price: 30 },
    ],
    { allowSubkits: true }
  ),
  null,
  "the labeled standard subkits are excluded by CATEGORY, which allowSubkits " +
    "does not touch — only the unlabeled NONBASE vocabulary is re-admitted"
);
assert.equal(classifyVariant("40s Monokit"), "OTHERS", "the 40s line classifies OTHERS");

// ── A bundle that names an extra the vocabulary did not know ────────────────
//
// Mekibo lists "[Bundle] Base + Core" (USD 200) and "[Bundle] Base + JIS Mod"
// ahead of the plain "Base Kit" (USD 145). Neither extra was in
// BUNDLE_EXTRA_RE, so both classified BASE and the first one listed won.
for (const title of ["[Bundle] Base + Core", "[Bundle] Base + JIS Mod"]) {
  assert.equal(classifyVariant(title), "BUNDLE", title);
}
assert.equal(
  pickBaseVariant([
    { title: "[Bundle] Base + Core", price: 200 },
    { title: "[Bundle] Base + Novelties", price: 180 },
    { title: "Base Kit", price: 145 },
    { title: "Core", price: 60 },
  ])?.price,
  145,
  "the plain base kit wins over a bundle listed before it"
);
assert.equal(classifyVariant("Teal & White Base"), "BASE", "a colourway joiner is still not a bundle");

// iLumKB sells "Base+Nov+Space" beside a sold-out "Base". The abbreviations
// named no known extra, so it classified BASE — and stock is read across every
// BASE variant, so the in-stock bundle showed the sold-out base as buyable.
assert.equal(classifyVariant("Base+Nov+Space"), "BUNDLE", "abbreviated extras still make a bundle");
assert.equal(classifyVariant("Space Grey Base"), "BASE", "a colourway containing 'space' is still a base");

// Neo Macro's GMK Black Snail sells no base kit: two modifier kits, a 40s kit,
// alphas, accents, a numpad and a Retro Point. The dearest unlabeled line (the
// U9 modifiers, INR 6500) used to publish as the base kit.
assert.equal(
  pickBaseVariant([
    { title: "L9 Modifier Kit", price: 6000 },
    { title: "U9 Modifier Kit", price: 6500 },
    { title: "40s Ortho linear Kit", price: 4900 },
    { title: "GMK Retro Point", price: 600 },
    { title: "Red Cyrillic Alphas", price: 9900 },
    { title: "9009 Accents Kit", price: 3000 },
    { title: "Numpad Kit", price: 2500 },
  ]),
  null,
  "modifier kits and a Retro Point are subkits, never the base"
);
assert.equal(classifyVariant("Base + Modifiers"), "BUNDLE", "a base sold with modifiers is a bundle");

// ── A bundle whose extra is a set-specific artisan kit ──────────────────────
//
// Oblotzky's GMK Botanical (probed 2026-09-30) sells "Standard Base + Hibi &
// Botanical Leaf" (EUR 159) beside the plain "Standard" base (139). "Hibi" /
// "Botanical Leaf" named no kit BUNDLE_EXTRA_RE knew and the title says no
// literal "bundle" — and because the real base is titled "Standard" (no "base"
// word → OTHERS), the "… Base + <extra>" bundle was the only variant classified
// BASE and won, publishing 159 as the base. The "+ after base" shape is the fix.
for (const title of [
  "Standard Base + Hibi & Botanical Leaf",
  "Standard Base + Hibi & Botanical Succulent",
]) {
  assert.equal(classifyVariant(title), "BUNDLE", title);
}
assert.equal(
  pickBaseVariant([
    { title: "Standard", price: 139 },
    { title: "Standard Base + Hibi & Botanical Leaf", price: 159 },
    { title: "Standard Base + Hibi & Botanical Succulent", price: 159 },
    { title: "Desert", price: 139 },
    { title: "International", price: 49 },
    { title: "Novelty", price: 29 },
    { title: "Hibi & Botanical Leaf", price: 39 },
    { title: "Deskmat Light", price: 19 },
  ])?.price,
  139,
  "the plain 'Standard' base wins over the '… Base + …' bundle"
);
// …and the bundle rule must not hand the pick to a cheap unlabelled subkit.
// proto[Typist] sells its ONLY base as "… Base Kit + UKISO" (probed
// 2026-10-01); with that classified BUNDLE, the dearest unlabelled line
// ("WASD" 15.83, "6.25u Kit" 15) was published as the base on the next pass.
assert.equal(
  pickBaseVariant([
    { title: "DCS Handarbeit - Base Kit + UKISO", price: 95 },
    { title: "DCS Handarbeit - Extension Kit", price: 44.17 },
    { title: "DCS Handarbeit - Numpad Kit", price: 35.83 },
    { title: "DCS Handarbeit - Spacebars Kit", price: 28.33 },
    { title: "DCS Handarbeit - WASD", price: 15.83 },
    { title: "DCS Handarbeit - BAE", price: 10 },
    { title: "DCS Handarbeit - 10U", price: 5.83 },
  ])?.price,
  95,
  "an unlabelled variant under half the cheapest bundle is a subkit, not the base"
);
assert.equal(
  pickBaseVariant([
    { title: "DCS Dream Alert - Base Kit + UKISO Kit", price: 105.83 },
    { title: "DCS Dream Alert - Non-Alert Kit", price: 11.67 },
    { title: "DCS Dream Alert - Macro Kit", price: 9.17 },
    { title: "DCS Dream Alert - 6.25u Kit", price: 15 },
    { title: "DCS Dream Alert - Numpad", price: 27.5 },
    { title: "DCS Dream Alert - Norde", price: 22.5 },
  ])?.price,
  105.83
);
// The '+ after base' rule must NOT catch a colourway '+' inside parentheses.
assert.equal(
  classifyVariant("Two Base（Teal + White）"),
  "BASE",
  "a '+' inside a parenthetical colourway spec is not a bundle joiner"
);

// ── Every consumer of the pick passes the same flag ─────────────────────────
//
// pickBaseVariant has three callers and one of them WRITES: the nightly audit
// recomputes the scraper's pick and corrects the stored price to it. A caller
// that forgets the flag therefore does not merely miss a price — it undoes the
// caller that didn't, on every run.

const priceAudit = read("src/lib/import/price-audit.ts");
assert.ok(
  /allowSubkits:\s*isSubkitSetName\(/.test(priceAudit),
  "price-audit must recompute the pick with the SAME subkit flag, or it " +
    "corrects a subkit set's price back to an add-on every night"
);
assert.ok(
  /kit:\s*\{\s*select:\s*\{\s*groupBuy:\s*\{\s*select:\s*\{\s*name:\s*true/.test(priceAudit),
  "price-audit must select the set name it decides the flag from"
);

const prices = read("src/lib/import/prices.ts");
for (const [call, what] of [
  ["pickBaseVariant(variants, { allowSubkits })", "the Shopify picker"],
  ["pickBaseVariant(wooVariants, { allowSubkits })", "the WooCommerce picker"],
] as Array<[string, string]>) {
  assert.ok(prices.includes(call), `${what} must pass allowSubkits`);
}
assert.ok(
  /kit:\s*\{\s*select:\s*\{\s*groupBuy:\s*\{\s*select:\s*\{\s*name:\s*true/.test(prices),
  "the price queue must select the set name (scrape.py selects gb.name AS set_name)"
);
assert.ok(
  /isSubkitSetName\(vk\.kit\?\.groupBuy\.name\)/.test(prices),
  "refreshOne must derive allowSubkits from the row's own set"
);

// The guard that returns ABOVE the picker. Threading the flag into the picker
// alone is what scrape.py did, and it could never reach a Shopify store —
// Saber Keebs among them — because this returns first.
assert.ok(
  /if \(!pinnedId && productTitle && !allowSubkits\)/.test(prices),
  "prices.ts's product-title subkit guard must yield to allowSubkits"
);

const scrape = read("scraper/scrape.py");
assert.ok(
  /if not pinned_id and product_title and not allow_subkits:/.test(scrape),
  "scrape.py's product-title subkit guard must yield to allow_subkits too — " +
    "it returns above choose_kit_variant, so the flag never reaches Shopify " +
    "without this"
);
assert.ok(
  /choose_kit_variant\(variants, allow_subkits=allow_subkits\)/.test(scrape),
  "scrape.py's generic path must pass allow_subkits to the picker"
);
assert.ok(
  /_SUBKIT_PRODUCT_RE\.search\(vk\.get\("set_name"\) or ""\)/.test(scrape),
  "scrape.py's price queue must derive allow_subkits from the set name"
);

// ── Discovery: the guard runs AFTER matching, in both halves ────────────────
//
// Before the match there is no set, so the test is unconditional — and an
// unconditional test makes every subkit set unlinkable, because the only
// products that can match one are exactly the products it skips.

const discovery = read("src/lib/import/discovery.ts");
assert.ok(
  /if \(SUBKIT_PRODUCT_RE\.test\(product\.title\) && !match\.isSubkit\) continue;/.test(discovery),
  "discovery.ts must skip a subkit product only when the matched SET is not " +
    "itself a subkit"
);
assert.ok(
  discovery.indexOf("const match = matchProduct(product.title, index);") <
    discovery.indexOf("SUBKIT_PRODUCT_RE.test(product.title)"),
  "the guard must run after matchProduct — it needs the matched set to decide"
);
assert.ok(
  /import \{ SUBKIT_PRODUCT_RE, isSubkitSetName \} from "@\/lib\/kit-variants";/.test(discovery),
  "discovery must import the shared vocabulary rather than redeclare it"
);
assert.ok(
  !/const SUBKIT_PRODUCT_RE = new RegExp/.test(discovery),
  "a local SUBKIT_PRODUCT_RE is a fourth place the list would be written"
);
assert.ok(
  /_SUBKIT_PRODUCT_RE\.search\(product\["title"\]\) and not match\["is_subkit"\]/.test(scrape),
  "run_discovery must apply the same conditional guard"
);

// ── The two halves of the vocabulary agree ──────────────────────────────────
//
// Python cannot import the module, so it mirrors it. A drift here is silent:
// one half links a product the other refuses to price.

const pySubkit = /_SUBKIT_PRODUCT_RE = re\.compile\(\s*r"([^"]+)"\s*\+ _NONBASE_SUBKIT_RE\.pattern \+ r"([^"]+)"\s*\+ _TITLE_ACCESSORY_RE\.pattern,/.exec(
  scrape
);
assert.ok(pySubkit, "scrape.py must still build _SUBKIT_PRODUCT_RE from the two shared patterns");
assert.equal(
  `${pySubkit![1]}${NONBASE_SUBKIT_RE.source}${pySubkit![2]}${PRODUCT_ACCESSORY_RE.source}`,
  SUBKIT_PRODUCT_RE.source,
  "SUBKIT_PRODUCT_RE and _SUBKIT_PRODUCT_RE must describe the same vocabulary"
);

// ── ProductGroup detection: the price fallback's guard against publishing a
//    multi-variant page's representative price as the base kit ────────────────
//
// gmk-bent-r2 × zFrontier reverted 150→56→150 across scrapes: its two base
// colourways (150) were out of stock, so the page's OpenGraph price was the
// cheapest in-stock alternate kit (56), and whenever the Shopify product.json
// fetch was transiently blocked the JSON-LD/OpenGraph fallback stored 56 over
// the base. fetchJsonLdPrice keys off this detector to preserve the last good
// price instead. A ProductGroup is Shopify's marker for a multi-variant
// product; a single-variant product emits a plain Product.

// A ProductGroup page (bent-r2 shape) is detected.
assert.ok(
  htmlDeclaresVariantProductGroup(
    '<script type="application/ld+json">' +
      '{"@context":"https://schema.org","@type":"ProductGroup","name":"[In Stock] GMK Bento R2",' +
      '"hasVariant":[{"@type":"Product","name":"Traditional"},{"@type":"Product","name":"Salmon"}]}' +
      "</script>"
  ),
  "a Shopify ProductGroup page must be recognised as multi-variant"
);

// @type may be an array.
assert.ok(
  htmlDeclaresVariantProductGroup(
    '<script type="application/ld+json">{"@type":["ProductGroup","Thing"]}</script>'
  ),
  "an array @type containing ProductGroup counts"
);

// It may sit inside an @graph.
assert.ok(
  htmlDeclaresVariantProductGroup(
    '<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"ProductGroup"}]}</script>'
  ),
  "a ProductGroup nested in an @graph is found"
);

// A plain single-variant Product is NOT a ProductGroup — its OG price is the
// real price and the fallback must still store it.
assert.ok(
  !htmlDeclaresVariantProductGroup(
    '<script type="application/ld+json">{"@type":"Product","name":"GMK Foo Base","offers":{"@type":"Offer","price":"135.00"}}</script>'
  ),
  "a single Product page must not be treated as multi-variant"
);

// No JSON-LD at all, and malformed JSON-LD, are both simply "not a ProductGroup".
assert.ok(!htmlDeclaresVariantProductGroup("<html><body>no ld+json</body></html>"));
assert.ok(
  !htmlDeclaresVariantProductGroup(
    '<script type="application/ld+json">{ this is not json }</script>'
  ),
  "a malformed block must not throw and must not falsely match"
);

// ── What may CLEAR a price, and what may only decline to store one ──────────
//
// The same fall-through the ProductGroup guard above is about, arriving at a
// worse answer. A multi-offer page with no base-named offer is not priced by
// either reader — neither should guess — but clearing the stored price is a
// second claim, and it needs the page to have SAID there is no base kit.
// Unnamed offers say only "this reader cannot tell these kits apart", and that
// is the shape of every ordinary Shopify product page: one unnamed Offer per
// variant, read only when the richer product.json did not answer. Clearing on
// it emptied live rows, and an unpriced row is hidden outright on a released
// set — primekb.com's GMK Inukuma (Base USD 155, in stock; JSON-LD offers
// 155/50/40/35, all unnamed) left its vendor publishing nothing at all while
// the audit reported "none priced … another scrape reaches the same answer".

// Named offers ARE evidence: the page says what each kit is and none is a base.
assert.ok(
  offersNameEveryKit([{ name: "Novelties" }, { name: "Spacebars" }]),
  "a page that names its kits can say none of them is a base kit"
);
// Unnamed, or only partly named, says nothing of the kind.
const unnamedShopifyOffers: Array<{ name?: string | null; price: number }> = [
  { price: 155 },
  { price: 50 },
  { price: 40 },
  { price: 35 },
];
assert.ok(
  !offersNameEveryKit(unnamedShopifyOffers),
  "unnamed offers (the Shopify shape) are not evidence that the base kit is gone"
);
assert.ok(
  !offersNameEveryKit([{ name: "Novelties" }, {}]),
  "one named kit does not make the unnamed ones legible"
);
assert.ok(!offersNameEveryKit([{ name: "   " }]), "a blank name names nothing");
assert.ok(!offersNameEveryKit([]), "no offers at all is not evidence either");

// Both price passes must ask it. The rule is written twice — prices.ts imports
// this module, scrape.py mirrors it — and a fix to one is only half a fix.
assert.ok(
  /if \(offersNameEveryKit\(offerList\)\) sawAmbiguousAggregate = true;/.test(prices),
  "prices.ts must gate the clearing verdict on the offers naming their kits"
);
assert.ok(
  /_offers_name_every_kit\(found\)/.test(scrape),
  "scrape.py must gate the same verdict the same way"
);
// …and the nightly's answer for the ungated case must be its own sentinel:
// None there means "no product markup", which answers NO_PRODUCT_DATA — the
// verdict that asks the owner for a parser and lets the front-page "gone"
// checks judge a page they were never meant to see.
assert.ok(
  /return AMBIGUOUS_OFFERS/.test(scrape) && /offer is AMBIGUOUS_OFFERS/.test(scrape),
  "scrape.py must answer an unnamed aggregate with AMBIGUOUS_OFFERS, not None"
);

console.log("kit-variants tests passed");
