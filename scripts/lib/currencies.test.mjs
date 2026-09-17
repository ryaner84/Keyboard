import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CURRENCIES,
  SUPPORTED_CURRENCY_CODES,
  currenciesSeedSql,
  currencyHomeCountry,
  isSupportedCurrency,
} from "./currencies.mjs";
import { KIT_BOUNDS } from "./kit-bounds.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const pricesTs = read("src", "lib", "import", "prices.ts");
const scrapePy = read("scraper", "scrape.py");
const dbSetup = read("scripts", "db-setup.mjs");
const seedTs = read("prisma", "seed.ts");

// ── The reported case, verbatim from mechaland.id ───────────────────────────
//
// Probed from a runner on 2026-09-15 (the Vendor probe workflow):
//
//   === PROBE https://mechaland.id/products/instock-gmk-black-snail
//     SHOPIFY   | …/instock-gmk-black-snail.json — 200, 6 variant(s)
//     SHOP CCY  | IDR (/meta.json)
//     JSON-LD   | Organization, ProductGroup, Brand, Product, Offer
//     VERDICT   | READABLE — a price parser path exists
//     VARIANT   | title="Base"     | price=1390000.00
//     VARIANT   | title="Alpha"    | price=659000.00
//     VARIANT   | title="Spacebar" | price=339000.00
//
// A live Indonesian Shopify store: 200, full product JSON, a base variant
// titled "Base" that the picker names on the first try, and a shop currency of
// IDR. IDR was in none of the five places the currency list was written, so
// both of mechaland's readable listings answered PRICE_REFUSED on every
// six-hourly run — an unpriced row is hidden outright on a RELEASED set, so the
// vendor published NOTHING, and the publishing audit could only say "widen the
// window or add the currency".
assert.ok(isSupportedCurrency("IDR"), "IDR is a currency the site can price in");
assert.ok(KIT_BOUNDS.IDR, "IDR needs a plausibility window — a 16,500:1 currency most of all");
assert.ok(
  1_390_000 > KIT_BOUNDS.IDR.min && 1_390_000 <= KIT_BOUNDS.IDR.max,
  "mechaland's Rp 1,390,000 base kit (≈ USD 84) must fall inside the window"
);
assert.ok(
  2_440_000 <= KIT_BOUNDS.IDR.max,
  "mechaland's Rp 2,440,000 GMK Nerve base kit (≈ USD 148) must fall inside the window"
);
// The window is still a window: a whole keyboard in rupiah is what it rejects.
assert.ok(20_000_000 > KIT_BOUNDS.IDR.max, "an Rp 20m parse error is still refused");

// ── And again, one store later, for a shop that was unreadable twice ───────
//
// mokbstore.com (Mokb Store, VN) quotes VND: its GMK MV Expo base kit is
// 3,060,000 and its MV T3RMINAL base 3,180,000 (≈ USD 116 and 121 at 26,300).
// Registering the code was necessary and not sufficient — the store is a
// Haravan shop whose product JSON no parser path was reaching either (see
// scripts/lib/storefront-catalog.mjs) — which is the general shape of a vendor
// that publishes nothing: every rule between the store and the set page has to
// let it through, and each of them is silent on its own.
assert.ok(isSupportedCurrency("VND"), "VND is a currency the site can price in");
assert.ok(KIT_BOUNDS.VND, "VND needs a plausibility window — a 26,000:1 currency most of all");
assert.ok(
  3_180_000 > KIT_BOUNDS.VND.min && 3_180_000 <= KIT_BOUNDS.VND.max,
  "mokbstore's ₫3,180,000 base kit (≈ USD 121) must fall inside the window"
);
assert.ok(30_000_000 > KIT_BOUNDS.VND.max, "a ₫30m parse error is still refused");
assert.equal(currencyHomeCountry("VND"), "VN");

// A blank/unknown code is NOT a refusal — the caller's fallback (the vendor
// row's own currency) answers that, and refusing it here would turn every shop
// that blocks /meta.json into a silent one.
assert.ok(isSupportedCurrency(null));
assert.ok(isSupportedCurrency(undefined));
assert.ok(isSupportedCurrency(""));
assert.equal(isSupportedCurrency("XYZ"), false, "an unregistered code is refused");

// ── Every registered currency carries all four facts ────────────────────────
//
// Registering one is not one edit: without a Currency row conversion falls back
// to a rate of 1, without a home country Shopify is asked as if from the US and
// answers in USD, and without a window the price is unbounded above.
for (const code of SUPPORTED_CURRENCY_CODES) {
  const entry = CURRENCIES[code];
  assert.match(code, /^[A-Z]{3}$/, `${code} is an ISO 4217 code`);
  assert.ok(entry.name && entry.symbol, `${code} has a name and a symbol for its Currency row`);
  assert.match(entry.homeCountry, /^[A-Z]{2}$/, `${code} pins a home market`);
  assert.ok(
    typeof entry.placeholderRate === "number" && entry.placeholderRate > 0,
    `${code} has a placeholder rate at the right magnitude`
  );
  assert.ok(KIT_BOUNDS[code], `${code} has a KIT_BOUNDS window (see kit-bounds.mjs)`);
}
assert.equal(currencyHomeCountry("IDR"), "ID");
assert.equal(currencyHomeCountry("INR"), "IN", "INR's pin was missing when #162 registered it");
assert.equal(currencyHomeCountry("ARS"), "AR");
assert.equal(currencyHomeCountry("CLP"), "CL");
assert.equal(currencyHomeCountry("XYZ"), "US", "an unknown code still falls back to a market");

// ── prices.ts DERIVES its allowlist; it no longer restates one ──────────────
//
// The hand-written literal was the fifth copy of this list, and the half that
// runs four times a day.
assert.ok(
  /import \{[\s\S]*?SUPPORTED_CURRENCY_CODES[\s\S]*?\} from "\.\.\/\.\.\/\.\.\/scripts\/lib\/currencies\.mjs"/.test(
    pricesTs
  ),
  "prices.ts must import SUPPORTED_CURRENCY_CODES from scripts/lib/currencies.mjs"
);
assert.ok(
  /const SUPPORTED_CURRENCIES = new Set<string>\(SUPPORTED_CURRENCY_CODES\)/.test(pricesTs),
  "prices.ts's SUPPORTED_CURRENCIES must BE the registry, not a copy of it"
);
assert.ok(
  !/"USD",\s*"SGD",\s*"EUR"/.test(pricesTs),
  "prices.ts must not hand-write a currency list again"
);
assert.ok(
  /currencyHomeCountry/.test(pricesTs) && !/CURRENCY_HOME_COUNTRY: Record/.test(pricesTs),
  "prices.ts's localization pin must come from the registry too"
);
// Both localization cookies must use it: the retry after a canonical-handle
// redirect re-derives the cookie, and that copy was a separate lookup.
assert.equal(
  (pricesTs.match(/localization=\$\{currencyHomeMarket\(currency\)\}/g) ?? []).length,
  2,
  "both Shopify localization cookies pin the market from the registry"
);
// The refusal names the code. Nothing in the database records WHICH currency
// was turned away — priceSource is 'REFUSED' either way — so the run log is the
// only place the next unregistered currency can announce itself.
assert.ok(
  /function noteUnregisteredCurrency/.test(pricesTs),
  "prices.ts must name the refused currency in the run log"
);
const refusalSites = pricesTs.match(/!SUPPORTED_CURRENCIES\.has\([a-zA-Z]+\)/g) ?? [];
assert.ok(refusalSites.length >= 4, `all four currency refusal sites present (${refusalSites.length})`);
assert.equal(
  (pricesTs.match(/noteUnregisteredCurrency\(/g) ?? []).length,
  refusalSites.length + 1, // + the declaration
  "every currency refusal site logs the code — a silent one is the failure this fixes"
);

// ── scrape.py mirrors the registry ──────────────────────────────────────────
//
// The price pass is written twice — run_prices (the nightly with a real
// browser) and refreshPrices (the Vercel cron and refresh-prices-ci). Python
// cannot import a JS module, so it copies; a fix to one half is half a fix.
const pySupported = scrapePy.match(/_SUPPORTED_CURRENCIES = \{([\s\S]*?)\n\}/);
assert.ok(pySupported, "scrape.py must define _SUPPORTED_CURRENCIES");
const pyCodes = [...pySupported[1].matchAll(/"([A-Z]{3})"/g)].map((m) => m[1]).sort();
assert.deepEqual(
  pyCodes,
  [...SUPPORTED_CURRENCY_CODES].sort(),
  "scrape.py's _SUPPORTED_CURRENCIES must match currencies.mjs exactly"
);

const pyHome = scrapePy.match(/_CURRENCY_HOME_COUNTRY = \{([\s\S]*?)\n\}/);
assert.ok(pyHome, "scrape.py must define _CURRENCY_HOME_COUNTRY");
const pyHomeMap = Object.fromEntries(
  [...pyHome[1].matchAll(/"([A-Z]{3})":\s*"([A-Z]{2})"/g)].map((m) => [m[1], m[2]])
);
assert.deepEqual(
  pyHomeMap,
  Object.fromEntries(SUPPORTED_CURRENCY_CODES.map((c) => [c, CURRENCIES[c].homeCountry])),
  "scrape.py's _CURRENCY_HOME_COUNTRY must match currencies.mjs exactly"
);

// Both halves must keep answering PRICE_REFUSED — never None/null, which files
// a live, readable store as one nobody could reach.
assert.ok(
  /currency not in _SUPPORTED_CURRENCIES:[\s\S]{0,200}?return PRICE_REFUSED/.test(scrapePy),
  "scrape.py refuses an unregistered currency with PRICE_REFUSED, not None"
);

// ── db-setup GENERATES the Currency table from the registry ─────────────────
//
// This insert IS what the allowlist claims to describe. While the two were
// written out separately they could disagree, and they did.
assert.ok(
  /import \{ currenciesSeedSql \} from "\.\/lib\/currencies\.mjs"/.test(dbSetup),
  "db-setup must import currenciesSeedSql"
);
assert.ok(
  /INSERT INTO public\."Currency"[\s\S]{0,200}?\$\{currenciesSeedSql\(\)\}/.test(dbSetup),
  "ensureCurrencies must be generated from the registry"
);
assert.ok(
  !/\('USD', 'US Dollar'/.test(dbSetup),
  "db-setup must not hand-write the Currency rows again"
);

const seedSql = currenciesSeedSql();
for (const code of SUPPORTED_CURRENCY_CODES) {
  assert.ok(seedSql.includes(`('${code}',`), `the generated SQL seeds ${code}`);
}
assert.equal(
  (seedSql.match(/to_timestamp\(0\)/g) ?? []).length,
  SUPPORTED_CURRENCY_CODES.length,
  "every seeded rate is stamped epoch 0 — it is a placeholder the feed overwrites"
);
// Every row is exactly one well-formed VALUES tuple. `[^']*` is what makes
// this catch an unescaped apostrophe in a name or symbol: one would end the SQL
// string early and the row would no longer match the shape.
const seedRows = seedSql.split(",\n").map((r) => r.trim());
assert.equal(seedRows.length, SUPPORTED_CURRENCY_CODES.length, "one row per registered code");
for (const row of seedRows) {
  assert.match(
    row,
    /^\('[A-Z]{3}', '[^']*', '[^']*', [\d.]+, to_timestamp\(0\)\)$/,
    `generated row is well-formed SQL: ${row}`
  );
}

// ── prisma/seed.ts mirrors it too ───────────────────────────────────────────
// ts-node runs that file as CommonJS and cannot require an ES module, so it
// keeps a literal list — which had already drifted three codes behind.
const seedCodes = [...seedTs.matchAll(/\{ code: "([A-Z]{3})"/g)].map((m) => m[1]).sort();
assert.deepEqual(
  seedCodes,
  [...SUPPORTED_CURRENCY_CODES].sort(),
  "prisma/seed.ts's CURRENCIES must match currencies.mjs exactly"
);

// ── No vendor registry may name a currency the price pass refuses ───────────
//
// This is the invariant that broke. A Vendor row's currency is the fallback in
// BOTH price passes (`currency = currency or vendor_currency`), so a row
// registered in an unregistered currency is a store whose every listing is
// refused — silently, for ever, and reading from outside exactly like a store
// nobody buys from.
const vendorCurrencies = new Set();
const roster = JSON.parse(read("src", "data", "seed", "vendors.json"));
for (const v of Array.isArray(roster) ? roster : roster.vendors) {
  if (v.currency) vendorCurrencies.add(v.currency);
}
const overrides = read("src", "lib", "import", "vendor-overrides.ts");
for (const m of overrides.matchAll(/currency:\s*"([A-Z]{3})"/g)) vendorCurrencies.add(m[1]);
// KEYBOARD_VENDORS is the other vendor registry — same rule, different half of
// the catalogue: its currency LABELS GroupBuy.basePrice.
const keyboardVendors = read("src", "lib", "import", "keyboard-vendors.ts");
for (const m of keyboardVendors.matchAll(/currency:\s*"([A-Z]{3})"/g)) vendorCurrencies.add(m[1]);
// db-setup's own corrections (backfillShipping's fixSG / fixIntl tables).
const backfill = dbSetup.match(/async function backfillShipping[\s\S]*?\n\}/)?.[0] ?? "";
assert.ok(backfill, "db-setup carries backfillShipping");
for (const m of backfill.matchAll(/'([A-Z]{3})'\)/g)) vendorCurrencies.add(m[1]);
assert.ok(vendorCurrencies.size >= 6, `collected the vendor currencies (${vendorCurrencies.size})`);
for (const code of vendorCurrencies) {
  assert.ok(
    isSupportedCurrency(code),
    `${code} is registered on a vendor row but is not in currencies.mjs — every ` +
      `listing that vendor has is refused, unpriced and hidden on released sets`
  );
}

// The store the fix was for, in the registry that decides its fallback.
assert.ok(
  /\('mechaland',\s*'ASIA',\s*'ID',\s*'IDR'\)/.test(dbSetup),
  "db-setup must correct mechaland (mechaland.id) to ASIA/ID/IDR — KeycapLendar filed it as US/USD"
);
// Three shops whose slugs differ by two letters, on three continents. Pinning
// the wrong one is how a Canadian store starts quoting rupiah.
assert.ok(
  /\('mechland'|'mech-land'/.test(backfill) === false,
  "Mech.land (CA) must not be dragged into the Indonesian correction"
);
assert.ok(/\('mecha-my',\s*'ASIA',\s*'MY',\s*'MYR'\)/.test(dbSetup), "Mecha MY stays Malaysian");

// ── The rate feed must be able to fill these in ─────────────────────────────
// REQUIRED_CODES is what currency-rates.ts refuses a partial payload over, so
// every one of them has to be a currency we actually keep a row for.
const rates = read("src", "lib", "currency-rates.ts");
const required = rates.match(/REQUIRED_CODES = \[([^\]]*)\]/)?.[1] ?? "";
const requiredCodes = [...required.matchAll(/"([A-Z]{3})"/g)].map((m) => m[1]);
assert.ok(requiredCodes.length >= 5, "parsed REQUIRED_CODES");
for (const code of requiredCodes) {
  assert.ok(isSupportedCurrency(code), `${code} is required of every feed payload and must be registered`);
}

console.log(
  `currencies: ${SUPPORTED_CURRENCY_CODES.length} registered, all four halves in agreement`
);
