import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestProduct } from "@/lib/kit-variants";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ── A storefront's own TEST product ─────────────────────────────────────────
//
// Oblotzky publishes "TEST PRODUCT DO NOT BUY" (handle `test-product-do-not-buy`)
// priced over the keyboard floor, so nothing about its SHAPE said it was not
// for sale: it cleared both of importKeyboardVendor's filters (a brand
// blocklist and a price floor) and became `obl-test-product-do-not-buy`, a live
// listing on /keyboards/active.
//
// It is the most-reported item on the site — eight LISTING_FLAG reports between
// 2026-06-23 and 2026-09-13 — and not one of them could ever heal, because the
// import UPSERTS by slug: a row deleted by hand is recreated the same night
// from the same catalog entry. Refusing it at the import is the only fix that
// ends it; the db-setup purge only clears what was already written.

for (const product of [
  { title: "TEST PRODUCT DO NOT BUY", handle: "test-product-do-not-buy" },
  { title: "Test Product", handle: "test-product" },
  { title: "Some Board", handle: "test-product-do-not-buy" },
  { title: "DO NOT BUY", handle: "do-not-buy" },
  { title: "placeholder", handle: "placeholder" },
  { title: "Dummy Product", handle: "dummy-product" },
  { title: "Sample product", handle: "sample-product" },
  { title: "test listing", handle: "test-listing" },
  { title: "test", handle: "whatever" },
  { title: "Whatever", handle: "test" },
]) {
  assert.ok(
    isTestProduct(product),
    `"${product.title}" / "${product.handle}" is a test product`
  );
}

// ── The filter DELETES a listing, so a false positive hides a real group buy ──
//
// Matching is on PHRASES, never on a bare "test" substring: these are real
// keyboard names that contain the letters t-e-s-t, and dropping one of them
// would silently un-publish a genuine group buy with nothing to flag it.

for (const product of [
  { title: "Testudo", handle: "testudo" },
  { title: "Protest 65", handle: "protest-65" },
  { title: "Contest TKL", handle: "contest-tkl" },
  { title: "Latest Edition Keyboard", handle: "latest-edition-keyboard" },
  { title: "Bauer Lite", handle: "bauer-lite" },
  { title: "Mode Sonnet", handle: "mode-sonnet" },
  { title: "QK80", handle: "qk80" },
]) {
  assert.ok(
    !isTestProduct(product),
    `"${product.title}" is a real product, not a test product`
  );
}

// Empty / missing fields must not throw and must not match.
assert.ok(!isTestProduct({ title: "", handle: "" }));
assert.ok(
  !isTestProduct({ title: undefined as unknown as string, handle: undefined as unknown as string })
);

// ── The marker list is written twice ────────────────────────────────────────
//
// keyboard-vendors.ts stops the row being WRITTEN; db-setup.mjs purges what was
// already written. A marker in one half and not the other means either a test
// product the import refuses but the database keeps for ever, or a row the
// purge deletes every deploy and the next import puts straight back.

const ts = read("src/lib/import/keyboard-vendors.ts");
const kitVariants = read("src/lib/kit-variants.ts");
const dbSetup = read("scripts/db-setup.mjs");

const tsMarkers = (kitVariants.match(/TEST_PRODUCT_MARKERS = \[([\s\S]*?)\]/)?.[1] ?? "")
  .split("\n")
  .map((l) => l.match(/"([^"]+)"/)?.[1])
  .filter((m): m is string => Boolean(m))
  .sort();

assert.ok(tsMarkers.length >= 8, "TEST_PRODUCT_MARKERS parsed from the TS half");

const purge = dbSetup.match(/async function purgeTestProductListings[\s\S]*?\n}/)?.[0] ?? "";
assert.ok(purge, "db-setup carries purgeTestProductListings");

for (const marker of tsMarkers) {
  assert.ok(
    purge.includes(marker),
    `db-setup's purge knows the "${marker}" marker (the two halves must agree)`
  );
}

// The purge must delete children before the parent — TrackerItem cascades on
// GroupBuy, and a Kit/VendorKit left behind is a listing with no set.
const orderOf = (needle: string) => purge.indexOf(needle);
assert.ok(
  orderOf('"VendorKit"') < orderOf('DELETE FROM public."Kit"'),
  "the purge deletes VendorKit rows before Kit rows"
);
assert.ok(
  orderOf('DELETE FROM public."Kit"') < orderOf('DELETE FROM public."GroupBuy"'),
  "the purge deletes Kit rows before the GroupBuy row"
);

// Both halves must refuse a bare "test" as a substring rule. A purge that
// matched it would delete every Testudo/Protest board on the next deploy.
assert.ok(
  !/~\*\s*'.*\|test\|/.test(purge),
  "the purge does not match a bare 'test' alternative"
);

// The purge is wired into BOTH db-setup entry points — a purge defined but
// never called is the shape this whole fix exists to end.
const callSites = dbSetup.match(/await purgeTestProductListings\(client\)/g) ?? [];
assert.equal(callSites.length, 2, "purgeTestProductListings runs from both db-setup paths");

// ── The import actually consults the filter ─────────────────────────────────
assert.ok(
  /function isBlockedProduct[\s\S]*?isTestProduct\(product\)/.test(ts),
  "isBlockedProduct asks isTestProduct"
);

console.log("keyboard-vendors tests passed");
