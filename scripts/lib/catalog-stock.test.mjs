import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { catalogAvailability, catalogStockUpdate } from "./catalog-stock.mjs";

// ── The reported case, verbatim from ktechs.store ───────────────────────────
// GET https://ktechs.store/products.json → the GMK CYL Thunder God entry.
const KTECHS_THUNDER_GOD = {
  handle: "gmk-cyl-thunder-god",
  title: "GMK CYL Thunder God",
  tags: ["Ended"],
  variants: [
    { id: 47674956775654, title: "Base", price: "169.00", available: false },
    { id: 47674956808422, title: "Novelty", price: "42.00", available: false },
  ],
};
assert.equal(catalogAvailability(KTECHS_THUNDER_GOD), false);
assert.deepEqual(catalogStockUpdate(catalogAvailability(KTECHS_THUNDER_GOD)), {
  inStock: false,
});

// ── The shape that must NOT be read as sold out ─────────────────────────────
// ktechs.store/products/gmk-cyl-thunder-god.json — same store, same product,
// but this endpoint carries no `available` key on any variant. Treating that
// as "unavailable" would mark a store's whole catalogue sold out.
const KTECHS_PRODUCT_JSON_SHAPE = {
  handle: "gmk-cyl-thunder-god",
  variants: [
    { id: 47674956775654, title: "Base", price: "169.00", inventory_management: "shopify" },
    { id: 47674956808422, title: "Novelty", price: "42.00", inventory_management: "shopify" },
  ],
};
assert.equal(catalogAvailability(KTECHS_PRODUCT_JSON_SHAPE), null, "no report is not a no");
assert.deepEqual(
  catalogStockUpdate(catalogAvailability(KTECHS_PRODUCT_JSON_SHAPE)),
  {},
  "an unknown must leave the flag alone, not clear it"
);

// ── Partial availability is availability ────────────────────────────────────
assert.equal(
  catalogAvailability({
    variants: [
      { title: "Base", available: false },
      { title: "Novelty", available: true },
    ],
  }),
  true
);
assert.deepEqual(
  catalogStockUpdate(true),
  {},
  "never writes inStock: true — the price pass owns that direction"
);
assert.deepEqual(catalogStockUpdate(null), {}, "unknown writes nothing");
assert.deepEqual(catalogStockUpdate(false), { inStock: false });

// A mixed feed where only some variants report: the ones that do are the answer.
assert.equal(
  catalogAvailability({
    variants: [{ title: "Base", available: false }, { title: "Novelty" }],
  }),
  false
);

// ── Degenerate inputs are unknown, never false ──────────────────────────────
for (const input of [
  {},
  { variants: [] },
  { variants: null },
  { variants: "nope" },
  null,
  undefined,
]) {
  assert.equal(catalogAvailability(input), null, `unknown for ${JSON.stringify(input)}`);
  assert.deepEqual(catalogStockUpdate(catalogAvailability(input)), {});
}

// A non-boolean truthy value is not a report — a feed rendering "false" as a
// string would otherwise read as available.
assert.equal(catalogAvailability({ variants: [{ available: "false" }] }), null);
assert.equal(catalogAvailability({ variants: [{ available: 1 }] }), null);
assert.equal(catalogAvailability({ variants: [{ available: null }] }), null);

// ── Parity with the Python mirror ───────────────────────────────────────────
// scrape.py cannot import JavaScript, so catalog_availability is written twice.
// A divergence is silent at runtime and would show up only as a wrongly-hidden
// (or wrongly-offered) listing, so assert the Python copy keeps the rules that
// matter: strict `is bool` typing, and unknown returning None rather than False.
const scrapePy = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scraper", "scrape.py"),
  "utf8"
);
const pySource = scrapePy.slice(
  scrapePy.indexOf("def catalog_availability("),
  scrapePy.indexOf("def catalog_stock_update(")
);
assert.ok(pySource, "scrape.py must define catalog_availability");
assert.ok(
  /isinstance\(\s*available\s*,\s*bool\s*\)/.test(pySource),
  "the Python copy must type-check availability strictly, like the JS one — " +
    "a truthiness test would read a missing key as unavailable"
);
assert.ok(
  /return None/.test(pySource),
  "the Python copy must return None for an unreported availability, not False"
);
assert.ok(
  scrapePy.includes("def catalog_stock_update("),
  "scrape.py must define catalog_stock_update, the one-directional write rule"
);

console.log("catalog stock checks passed");
