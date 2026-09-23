import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  TILDA_PRODUCT_LIST_PATH,
  TILDA_STORE_API_HOST,
  isTildaStorePage,
  tildaProductListUrl,
  tildaProjectCurrency,
  tildaRootZoneEndpoint,
  tildaStoreBlocks,
  tildaStoreVariants,
} from "./tilda-store.mjs";
import { SUPPORTED_CURRENCY_CODES } from "./currencies.mjs";
import { isPlausibleBaseKitPrice } from "./kit-bounds.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const scrapePy = read("scraper", "scrape.py");
const pricesTs = read("src", "lib", "import", "prices.ts");

// ── The reported case, verbatim from groupbuy.funkeys.com.ua ────────────────
//
// Probed from a runner on 2026-09-23 (the Vendor probe workflow). The page is
// 307,495 bytes of real storefront and carries NO product JSON, NO variation
// blob, NO JSON-LD and NO OpenGraph price — only this, at the end of the
// catalogue block's setup script.
const FUNKEYS_PAGE = `
<div class="t-body" data-project-currency="грн." data-project-currency-side="r"
     data-project-currency-sep="," data-project-currency-code="UAH">
<div class="js-store-grid-cont"></div>
<script>
var default_sort={default:null,in_stock:false};
var options={storepart:'244437147371',previewmode:'yes',blocksInRow:'3',
  currencySide:'r',currencyTxt:'грн.',hideFilters:false};
t_onFuncLoad('t_store_init',function() {t_store_init('287540641',options);});
</script>
`;

assert.ok(isTildaStorePage(FUNKEYS_PAGE), "the FunKeys page declares a Tilda Store block");
assert.deepEqual(tildaStoreBlocks(FUNKEYS_PAGE), [
  { recid: "287540641", storepart: "244437147371" },
]);
assert.equal(tildaProjectCurrency(FUNKEYS_PAGE), "UAH");

// Every other storefront in the roster must keep answering "not a Tilda page"
// from the HTML alone — the branch is only cheap because it costs no request.
assert.deepEqual(tildaStoreBlocks("<html><body>GMK Dandy</body></html>"), []);
assert.equal(isTildaStorePage(""), false);
assert.equal(isTildaStorePage(null), false);
assert.equal(tildaProjectCurrency("<html></html>"), null);

// ── The parameters are per-BLOCK, so they are paired by position ────────────
//
// A page can carry a second catalogue block (a "relevant products" strip). A
// mis-paired uid reads as another block's catalogue, which would price this set
// from another set's variants.
const TWO_BLOCKS = `
var options={storepart:'111111111111'};t_store_init('100000001',options);
var options={storepart:'222222222222'};t_store_init('200000002',options);
`;
assert.deepEqual(tildaStoreBlocks(TWO_BLOCKS), [
  { recid: "100000001", storepart: "111111111111" },
  { recid: "200000002", storepart: "222222222222" },
]);
// An init call with no storepart ahead of it is dropped, never paired with a
// later one.
assert.deepEqual(
  tildaStoreBlocks("t_store_init('900000009',options); var options={storepart:'333333333333'};"),
  []
);
// The same block emitted twice (Tilda re-runs the setup on some templates) is
// one block, not two requests for the same catalogue.
assert.deepEqual(tildaStoreBlocks(TWO_BLOCKS + TWO_BLOCKS).length, 2);

// ── The request spells the key differently from the page ───────────────────
//
// The options key is `storepart`; the query parameter is `storepartuid`.
// Reading the request's spelling off the page finds nothing at all, which is
// where #189's probe started.
const listUrl = tildaProductListUrl(TILDA_STORE_API_HOST, tildaStoreBlocks(FUNKEYS_PAGE)[0], 17);
assert.ok(listUrl.startsWith(`https://${TILDA_STORE_API_HOST}${TILDA_PRODUCT_LIST_PATH}?`));
const listParams = new URL(listUrl).searchParams;
assert.equal(listParams.get("storepartuid"), "244437147371");
assert.equal(listParams.get("recid"), "287540641");
assert.equal(listParams.get("c"), "17");
assert.equal(listParams.get("storepart"), null, "the page's key is not the request's key");

// ── `redirectto` is a ZONE, not a URL ───────────────────────────────────────
//
// store.tildaapi.com answers a 20-byte {"redirectto":"one"} to a perfectly
// valid request. Following that as a path gives
// store.tildaapi.com/api/getproductslist/one — a 404 "Object not found in
// Storecdn", which is what a guess at the hop looks like. The app's own
// t_store__handleRootzoneRedirect swaps the endpoint host's LAST LABEL:
assert.equal(
  tildaRootZoneEndpoint('{"redirectto":"one"}', "store.tildaapi.com"),
  "store.tildaapi.one"
);
// …and takes the already-parsed body too, because the nightly's JSON client
// hands back an object.
assert.equal(tildaRootZoneEndpoint({ redirectto: "one" }, "store.tildaapi.com"), "store.tildaapi.one");
// The zone already in use is NOT a redirect — the app treats it as none, and a
// caller that retried on it would never terminate.
assert.equal(tildaRootZoneEndpoint({ redirectto: "one" }, "store.tildaapi.one"), null);
assert.equal(tildaRootZoneEndpoint({ redirectto: "COM" }, "store.tildaapi.com"), null);
// A real product list carries no redirect.
assert.equal(tildaRootZoneEndpoint({ products: [] }, "store.tildaapi.com"), null);
assert.equal(tildaRootZoneEndpoint("not json at all", "store.tildaapi.com"), null);
assert.equal(tildaRootZoneEndpoint(null, "store.tildaapi.com"), null);

// The value comes from the STORE, so only the last label of a host this module
// wrote itself may change. A price pass may follow a shop's pointer to another
// TLD of a host IT chose; it may never be sent to a host the shop names.
for (const hostile of [
  "one.attacker.example",
  "../../evil",
  "one/",
  "one:8080",
  "",
  "a",
  "verylongzonename",
  "1",
]) {
  assert.equal(
    tildaRootZoneEndpoint({ redirectto: hostile }, "store.tildaapi.com"),
    null,
    `a store may not redirect the price pass to ${JSON.stringify(hostile)}`
  );
}

// ── The catalogue, verbatim from store.tildaapi.one ─────────────────────────
//
// Probed from a runner on 2026-09-23: total 8, and the set's kits NAMED, which
// is what makes the list safe for the picker to clear a price from.
const FUNKEYS_CATALOGUE = {
  partuid: 244437147371,
  total: 8,
  products: [
    { uid: 829977319411, title: "Base", sku: "GMK-Colorchrome-Base", quantity: "0", price: "3600.0000" },
    { uid: 408429327941, title: "White Modifiers", quantity: "0", price: "2900.0000" },
    { uid: 314949185101, title: "40s kit", quantity: "0", price: "2100.0000" },
    { uid: 310572954541, title: "Accent", quantity: "0", price: "1600.0000" },
    { uid: 154894673681, title: "NorDeUK", quantity: "0", price: "1800.0000" },
    // The deskmats beside them: stock is NOT tracked, which Tilda spells as an
    // empty string rather than a number.
    { uid: 629007941621, title: "Ковры", quantity: "", price: "900.0000" },
  ],
};
const funkeysVariants = tildaStoreVariants(FUNKEYS_CATALOGUE);
assert.deepEqual(
  funkeysVariants.map((v) => v.title),
  ["Base", "White Modifiers", "40s kit", "Accent", "NorDeUK", "Ковры"]
);
assert.equal(funkeysVariants[0].price, 3600);
assert.equal(funkeysVariants[0].available, false, 'quantity "0" is a tracked product that sold out');
assert.equal(funkeysVariants[5].available, true, 'quantity "" is stock that is not tracked at all');

// Collapsing that empty string into zero would mark a whole untracked
// catalogue sold out — catalogAvailability's three-answer rule arriving
// through another platform, and on a released set the same harm as no price.
assert.equal(tildaStoreVariants({ products: [{ title: "x", price: "10", quantity: null }] })[0].available, true);
assert.equal(tildaStoreVariants({ products: [{ title: "x", price: "10" }] })[0].available, true);
assert.equal(tildaStoreVariants({ products: [{ title: "x", price: "10", quantity: "4" }] })[0].available, true);
assert.equal(tildaStoreVariants({ products: [{ title: "x", price: "10", quantity: 0 }] })[0].available, false);

// A divider or a "coming soon" placeholder is not something to price.
assert.deepEqual(tildaStoreVariants({ products: [{ title: "", price: "10" }] }), []);
assert.deepEqual(tildaStoreVariants({ products: [{ title: "Base", price: "" }] }), []);
assert.deepEqual(tildaStoreVariants({ products: [{ title: "Base", price: "0" }] }), []);
assert.deepEqual(tildaStoreVariants({ products: "nope" }), []);
assert.deepEqual(tildaStoreVariants(null), []);

// ── The rules BELOW this reader have to let the number through too ──────────
//
// A store publishes nothing until EVERY rule between it and the set page lets
// it through, and each wall is silent on its own. The shop quotes hryvnia in
// its own markup, so an unregistered UAH or an absent window would leave the
// finished reader answering PRICE_REFUSED on every run — the same
// publishes-nothing failure, one rule further down.
assert.ok(
  SUPPORTED_CURRENCY_CODES.includes("UAH"),
  "the currency FunKeys quotes must be one the Currency table can convert"
);
assert.ok(
  isPlausibleBaseKitPrice(3600, "UAH"),
  "GMK Colorchrome's base kit must fall inside the UAH window"
);

// ── Written twice: scrape.py mirrors this module ────────────────────────────
//
// The nightly is the half with a real browser, and the price pass is written
// twice — a fix to one half is only half a fix.
for (const name of [
  "def tilda_store_blocks(",
  "def is_tilda_store_page(",
  "def tilda_project_currency(",
  "def tilda_product_list_url(",
  "def tilda_rootzone_endpoint(",
  "def tilda_store_variants(",
  "def tilda_store_price(",
]) {
  assert.ok(scrapePy.includes(name), `scrape.py mirrors ${name.slice(4, -1)}`);
}
assert.ok(
  scrapePy.includes(`TILDA_STORE_API_HOST = "${TILDA_STORE_API_HOST}"`) &&
    scrapePy.includes(`TILDA_PRODUCT_LIST_PATH = "${TILDA_PRODUCT_LIST_PATH}"`),
  "the endpoint must not drift: the two halves have to ask the same API"
);
assert.ok(
  scrapePy.includes('"storepartuid": str(block.get("storepart"'),
  "the nightly sends the page's `storepart` under the request's `storepartuid`"
);

// ── Both price halves ask, and neither re-spells the rules ──────────────────
assert.ok(
  pricesTs.includes("fetchTildaStorePrice(") && scrapePy.includes("tilda_store_price("),
  "both price halves read a Tilda Store"
);
for (const [half, source] of [
  ["prices.ts", pricesTs],
  ["scrape.py", scrapePy.slice(scrapePy.indexOf("def generic_price("))],
]) {
  assert.ok(
    !/t_store_init/.test(source),
    `${half} must not re-spell the block parameters — they are written once`
  );
  assert.ok(
    !/redirectto/.test(source),
    `${half} must not read the hop itself: it is a ZONE, and a caller that ` +
      "treats it as a URL fetches a 404 from Tilda's CDN"
  );
}
assert.ok(
  pricesTs.includes("tildaRootZoneEndpoint(") && scrapePy.includes("tilda_rootzone_endpoint("),
  "both halves follow the hop through the shared rule"
);

// The hop is followed at most ONCE in each half. A server answering
// `redirectto` for ever would otherwise be an unbounded loop inside a pass
// that is time-boxed and whose budget live listings compete for.
assert.ok(
  /for \(let attempt = 0; attempt < 2[^)]*\)/.test(pricesTs),
  "prices.ts bounds the root-zone retry"
);
assert.ok(scrapePy.includes("for _ in range(2):"), "scrape.py bounds the root-zone retry");

// ── A miss here may never take a listing off the site ───────────────────────
//
// `deadSince` is the only signal allowed to hide a listing, and a 404 from
// Tilda's API is the API declining — not the STORE saying this page is gone.
const tildaReaderTs = pricesTs.slice(
  pricesTs.indexOf("async function fetchTildaStorePrice("),
  pricesTs.indexOf("// Product markup as JSON-LD for SEO")
);
assert.ok(tildaReaderTs.length > 0, "the prices.ts reader is where this test thinks it is");
assert.ok(
  !/DEAD_LINK/.test(tildaReaderTs),
  "the Tilda reader must never answer DEAD_LINK"
);
const tildaReaderPy = scrapePy.slice(
  scrapePy.indexOf("def tilda_store_price("),
  scrapePy.indexOf("def catalog_availability(")
);
assert.ok(tildaReaderPy.length > 0, "the scrape.py reader is where this test thinks it is");
assert.ok(!/DEAD_LINK/.test(tildaReaderPy), "the nightly's Tilda reader must never answer DEAD_LINK");

// …and a Tilda page whose API said nothing this run must not fall through to
// NO_PRODUCT_DATA, which would hand it to the front-page "gone" checks and ask
// the owner for a parser that already exists. Each half needs its own way to
// say "not a Tilda page" apart from "a Tilda page answered nothing".
assert.ok(
  /if \(tilda !== undefined\) return tilda;/.test(pricesTs),
  "prices.ts returns every Tilda outcome, the transient null included"
);
assert.ok(
  scrapePy.includes("_TILDA_NOT_A_STORE") &&
    scrapePy.includes("if tilda is not _TILDA_NOT_A_STORE:"),
  "scrape.py tells 'not a Tilda page' from 'a Tilda page answered nothing'"
);

// ── The shop's own currency outranks the vendor row's guess ─────────────────
//
// Tilda writes it on the page wrapper. KeycapLendar filed an Indonesian store
// as US/USD once; the row's currency is a guess, the page's is a statement.
assert.ok(
  /tildaProjectCurrency\(html\) \?\? vendorCurrency/.test(pricesTs),
  "prices.ts prefers the page's own currency"
);
assert.ok(
  scrapePy.includes("tilda_project_currency(html) or vendor_currency"),
  "scrape.py prefers the page's own currency"
);

console.log("tilda-store: all assertions passed");
