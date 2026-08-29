import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KIT_BOUNDS, isPlausibleBaseKitPrice, kitBoundsPurgeSql } from "./kit-bounds.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── The reported case, verbatim from norbauer.co ────────────────────────────
// GET https://www.norbauer.co/products/dsa-after-school-1992-keyset.json, read
// from a GitHub runner (the store answers a datacenter IP fine):
//
//   PRODUCT | After-school 1992 | handle=dsa-after-school-1992-keyset
//   VARIANT | title="DSA" | price=230.00
//   VARIANT | title="DSS" | price=230.00
//
// Two variants, both the keyset itself at one price. The page is fetched,
// parsed and completely understood — and against the old USD ceiling of 225
// the price pass answered PRICE_REFUSED, so the row stayed unpriced, an
// unpriced row is hidden on a RELEASED set, and the vendor published nothing at
// all. Nothing the store could do would have ended that; only this number.
assert.equal(
  isPlausibleBaseKitPrice(230, "USD"),
  true,
  "norbauer.co's USD 230 keyset is a real base kit price, not a parse error"
);
assert.equal(isPlausibleBaseKitPrice(230, null), true, "unknown currency is bounded as USD");

// The ceiling is still a ceiling. A bundle total or a keyboard that slipped
// past pickBaseVariant is what it exists to reject.
assert.equal(isPlausibleBaseKitPrice(650, "USD"), false);
assert.equal(isPlausibleBaseKitPrice(KIT_BOUNDS.USD.max, "USD"), true, "the bound is inclusive");
assert.equal(isPlausibleBaseKitPrice(KIT_BOUNDS.USD.max + 0.01, "USD"), false);

// The floor is 0 in every currency ON PURPOSE: accessory products (DCS Bae
// Addon, 6u bars, 9009 Fix Kit …) are tracked as first-class sets and really do
// cost a few dollars. Only a 0/negative parse result is refused at the bottom.
for (const [code, { min }] of Object.entries(KIT_BOUNDS)) {
  assert.equal(min, 0, `${code} must keep a floor of 0 — accessory sets are real sets`);
  assert.equal(isPlausibleBaseKitPrice(0, code), false, `${code}: 0 is a parse failure`);
  assert.equal(isPlausibleBaseKitPrice(-5, code), false, `${code}: negative is a parse failure`);
  assert.equal(isPlausibleBaseKitPrice(3, code), true, `${code}: a $3 accessory set is real`);
}

// A currency with no entry is unbounded above rather than refused: we have
// never calibrated its magnitude, and hiding a live listing on a guess is the
// failure this whole file is about.
assert.equal(isPlausibleBaseKitPrice(999_999, "XXX"), true);
assert.equal(isPlausibleBaseKitPrice(0, "XXX"), false);

// ── Every currency is the same USD-equivalent ───────────────────────────────
// A window generous in USD and tight in EUR publishes a set on one storefront
// and hides it on another for no reason a reader could discover. Rates are the
// ones db-setup's ensureCurrencies seeds (units per USD); 12% either side
// absorbs the rounding to tidy numbers without admitting a real drift.
const RATES_PER_USD = {
  USD: 1, EUR: 0.92, GBP: 0.79, AUD: 1.54, CAD: 1.37, SGD: 1.35,
  JPY: 150.5, KRW: 1340, CNY: 7.24, HKD: 7.82, THB: 35.8, TWD: 32.1,
  CLP: 960, INR: 84, MYR: 4.71,
};
for (const [code, rate] of Object.entries(RATES_PER_USD)) {
  const bound = KIT_BOUNDS[code];
  assert.ok(bound, `KIT_BOUNDS must cover ${code}`);
  const inUsd = bound.max / rate;
  assert.ok(
    inUsd >= KIT_BOUNDS.USD.max * 0.88 && inUsd <= KIT_BOUNDS.USD.max * 1.12,
    `${code}'s ceiling is USD ${inUsd.toFixed(0)}, not the USD ceiling of ${KIT_BOUNDS.USD.max}`
  );
}
// ARS is deliberately outside that check — Latamkeys' currency is volatile
// enough that a pinned rate would fail this test on its own within months — but
// it must still be at least the USD equivalent, never tighter.
assert.ok(KIT_BOUNDS.ARS.max >= KIT_BOUNDS.USD.max * 1200, "ARS must stay wide, never tighter");

// ── The purge SQL is GENERATED, never restated ──────────────────────────────
// db-setup nulls any stored SCRAPED price outside this window on every deploy.
// A purge window tighter than what the price passes store wipes legitimate
// prices nightly — which is exactly what blanked released-set pricing once
// before — so the clause is built from the same table rather than typed out.
const purgeSql = kitBoundsPurgeSql();
for (const [code, { min, max }] of Object.entries(KIT_BOUNDS)) {
  assert.ok(
    purgeSql.includes(`(currency = '${code}' AND (price <= ${min} OR price > ${max}))`),
    `the purge clause must cover ${code} at exactly this window`
  );
}
assert.equal(
  purgeSql.split("OR (currency").length - 1,
  Object.keys(KIT_BOUNDS).length - 1,
  "the purge clause must cover every currency in the table and no others"
);

const dbSetup = readFileSync(join(REPO_ROOT, "scripts", "db-setup.mjs"), "utf8");
assert.ok(
  /import \{[^}]*kitBoundsPurgeSql[^}]*\} from "\.\/lib\/kit-bounds\.mjs"/.test(dbSetup),
  "db-setup must import kit-bounds.mjs rather than restate the window"
);
assert.ok(
  dbSetup.includes("${kitBoundsPurgeSql()}"),
  "db-setup's purge must interpolate the generated clause"
);
assert.ok(
  /const RESTORE_BOUNDS = KIT_BOUNDS;/.test(dbSetup),
  "db-setup's restore window must BE the purge window, not a second copy of it"
);
assert.ok(
  !/currency = 'USD' AND \(price <= 0 OR price > \d+\)/.test(dbSetup),
  "db-setup must not hand-write a per-currency bound again"
);

// ── prices.ts imports the module; it does not copy it ───────────────────────
const pricesTs = readFileSync(join(REPO_ROOT, "src", "lib", "import", "prices.ts"), "utf8");
assert.ok(
  /from "\.\.\/\.\.\/\.\.\/scripts\/lib\/kit-bounds\.mjs"/.test(pricesTs),
  "prices.ts must import kit-bounds.mjs rather than restate the window"
);
assert.ok(
  !/const KIT_BOUNDS[^=]*=\s*\{/.test(pricesTs),
  "prices.ts must not declare its own KIT_BOUNDS table again"
);
// price-audit.ts imports the check from prices.ts, so the re-export has to stay.
assert.ok(
  /export const isPlausibleBaseKitPrice/.test(pricesTs),
  "prices.ts must keep exporting isPlausibleBaseKitPrice — price-audit.ts imports it"
);

// ── scrape.py mirrors the table exactly ─────────────────────────────────────
// The price pass is written twice: run_prices in scraper/scrape.py (the nightly
// with a real browser) and refreshPrices in prices.ts (the Vercel cron and
// refresh-prices-ci). prices.ts imports this module; Python cannot, so it
// copies the numbers — and a fix to one half is only half a fix.
const scrapePy = readFileSync(join(REPO_ROOT, "scraper", "scrape.py"), "utf8");
const pyTable = scrapePy.match(/_KIT_BOUNDS = \{([\s\S]*?)\n\}/);
assert.ok(pyTable, "scrape.py must define _KIT_BOUNDS");
const pyBounds = {};
for (const m of pyTable[1].matchAll(/"([A-Z]{3})":\s*\(([\d_]+),\s*([\d_]+)\)/g)) {
  pyBounds[m[1]] = { min: Number(m[2].replace(/_/g, "")), max: Number(m[3].replace(/_/g, "")) };
}
assert.deepEqual(
  pyBounds,
  Object.fromEntries(Object.entries(KIT_BOUNDS).map(([k, v]) => [k, { min: v.min, max: v.max }])),
  "scrape.py's _KIT_BOUNDS must match kit-bounds.mjs exactly"
);

console.log("kit-bounds: all assertions passed");
