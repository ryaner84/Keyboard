import assert from "node:assert/strict";
import { planSetMerges, setMergeIdentity, slugQuality } from "./set-merge.mjs";

// ── The reported case ───────────────────────────────────────────────────────
// gmk.net's catalog row and KeycapLendar's row for one set. "CYL" and
// "Keycaps" are the extra description words that kept them apart.
assert.deepEqual(setMergeIdentity("GMK CYL Mizu R2 Keycaps"), {
  profile: "gmk",
  key: "mizu r2",
});
assert.deepEqual(setMergeIdentity("GMK Mizu R2"), { profile: "gmk", key: "mizu r2" });
assert.deepEqual(setMergeIdentity("[GB] GMK Mizu R2 | Group Buy Closed"), {
  profile: "gmk",
  key: "mizu r2",
});
assert.deepEqual(setMergeIdentity("GMK Mizu R2 Keycap Set"), {
  profile: "gmk",
  key: "mizu r2",
});
assert.deepEqual(
  setMergeIdentity("GMK CYL Kitsune Keycaps"),
  setMergeIdentity("GMK Kitsune"),
  "the duplicate _build_set_index already calls an orphan"
);
// "kits?" must not eat the "Kits" inside "Kitsune" — the boundary has to end
// the token, which is the same guard normalizeSetName spells out.
assert.equal(setMergeIdentity("GMK Kitsune").key, "kitsune");

// ── Round is identity ───────────────────────────────────────────────────────
assert.notDeepEqual(setMergeIdentity("GMK Bento"), setMergeIdentity("GMK Bento R2"));
assert.deepEqual(setMergeIdentity("GMK Bento Round 2"), setMergeIdentity("GMK Bento R2"));
assert.deepEqual(
  setMergeIdentity("GMK Bento (R2)"),
  setMergeIdentity("GMK Bento R2"),
  "a parenthetical round still names the round"
);

// ── Stricter than dedupeKey, on purpose ─────────────────────────────────────
// dedupeKey drops every parenthetical, which would merge two different runs.
assert.notDeepEqual(
  setMergeIdentity("GMK Nautilus (2021)"),
  setMergeIdentity("GMK Nautilus"),
  "the year is product information, not furniture"
);
// "+" survives as a token rather than vanishing with the punctuation.
assert.notDeepEqual(
  setMergeIdentity("GMK Olivia++"),
  setMergeIdentity("GMK Olivia"),
  "Olivia++ is a different set from Olivia"
);
// Words dedupeKey treats as filler stay in: a wrong delete costs more than a
// duplicate left standing.
assert.notDeepEqual(
  setMergeIdentity("GMK Foo Special Edition"),
  setMergeIdentity("GMK Foo")
);

// ── Profile is the manufacturer boundary ────────────────────────────────────
assert.notDeepEqual(
  setMergeIdentity("DCS Dolch"),
  setMergeIdentity("GMK Dolch"),
  "Signature Plastics and GMK are different products"
);
assert.notDeepEqual(
  setMergeIdentity("GMK MTNU Divinapapaya"),
  setMergeIdentity("GMK Divinapapaya"),
  "MTNU is its own profile; CYL is not"
);
assert.deepEqual(setMergeIdentity("MTNU Electronic Control"), {
  profile: "mtnu",
  key: "electronic control",
});
assert.notDeepEqual(setMergeIdentity("KAT Milkshake"), setMergeIdentity("GMK Milkshake"));
// No profile token at all: could be anyone's set, so it merges with nothing.
assert.equal(setMergeIdentity("[GB] Dolch"), null);
assert.equal(setMergeIdentity("GMK"), null, "a profile with no colourway is not a set");
assert.equal(setMergeIdentity(""), null);
assert.equal(setMergeIdentity(null), null);

// ── slugQuality: which URL survives ─────────────────────────────────────────
assert.ok(slugQuality("gmk-mizu-r2") > slugQuality("gmk-cyl-mizu-r2-keycaps"));
assert.ok(slugQuality("gmk-mizu-r2") > slugQuality("gh-117742"));

// ── planSetMerges ───────────────────────────────────────────────────────────
function row(over) {
  return {
    id: over.slug,
    slug: over.slug,
    name: over.name,
    productType: "KEYCAPS",
    createdAt: "2024-01-01",
    vendorLinks: 0,
    trackerItems: 0,
    ...over,
  };
}

const basic = planSetMerges([
  row({ slug: "gmk-mizu-r2", name: "GMK Mizu R2", vendorLinks: 7 }),
  row({ slug: "gmk-cyl-mizu-r2-keycaps", name: "GMK CYL Mizu R2 Keycaps", vendorLinks: 1 }),
  row({ slug: "gmk-bento", name: "GMK Bento", vendorLinks: 3 }),
]);
assert.equal(basic.merges.length, 1, "only the duplicated set is a merge");
assert.equal(basic.merges[0].keep.slug, "gmk-mizu-r2");
assert.deepEqual(
  basic.merges[0].drop.map((r) => r.slug),
  ["gmk-cyl-mizu-r2-keycaps"]
);

// The slug decides, not the row's weight. Listings and collection entries are
// MOVED, so keeping the busier row saves nothing — while a forum topic id in
// the URL is a loss nothing can undo.
const tracked = planSetMerges([
  row({ slug: "gh-117742", name: "[GB] GMK Mizu R2", trackerItems: 4, vendorLinks: 6 }),
  row({ slug: "gmk-mizu-r2", name: "GMK Mizu R2", trackerItems: 0, vendorLinks: 0 }),
]);
assert.equal(tracked.merges[0].keep.slug, "gmk-mizu-r2");

// gmk.net's spelling loses to the canonical one for the same reason.
const bySlug = planSetMerges([
  row({ slug: "gmk-cyl-mizu-r2-keycaps", name: "GMK CYL Mizu R2 Keycaps", vendorLinks: 4 }),
  row({ slug: "gmk-mizu-r2", name: "GMK Mizu R2" }),
]);
assert.equal(bySlug.merges[0].keep.slug, "gmk-mizu-r2");

// Two slugs that read equally well fall through to the busier, then older, row.
const equalSlugs = planSetMerges([
  row({ slug: "gmk-aaa", name: "GMK Aaa", vendorLinks: 1, createdAt: "2020-01-01" }),
  row({ slug: "gmk-bbb", name: "GMK Aaa Keycaps", vendorLinks: 5, createdAt: "2024-01-01" }),
]);
assert.equal(equalSlugs.merges[0].keep.slug, "gmk-bbb");

// Three rows collapse to one merge, not two.
const triple = planSetMerges([
  row({ slug: "gmk-mizu-r2", name: "GMK Mizu R2", vendorLinks: 5 }),
  row({ slug: "gmk-cyl-mizu-r2-keycaps", name: "GMK CYL Mizu R2 Keycaps" }),
  row({ slug: "gh-1", name: "[GB] GMK Mizu R2 | GB CLOSED" }),
]);
assert.equal(triple.merges.length, 1);
assert.equal(triple.merges[0].drop.length, 2);

// Keyboards are left alone — their editions are separate rows on purpose.
assert.equal(
  planSetMerges([
    row({ slug: "a", name: "GMK Jane", productType: "KEYBOARD" }),
    row({ slug: "b", name: "GMK Jane Keycaps", productType: "KEYBOARD" }),
  ]).merges.length,
  0
);

// Group buys a year apart are reported, never merged.
const farApart = planSetMerges([
  row({ slug: "gmk-foo", name: "GMK Foo", gbStart: "2021-03-01" }),
  row({ slug: "gmk-foo-keycaps", name: "GMK Foo Keycaps", gbStart: "2024-03-01" }),
]);
assert.equal(farApart.merges.length, 0);
assert.equal(farApart.skipped.length, 1);
assert.match(farApart.skipped[0].reason, /different rounds/);

// One row with a date and one without is the normal shape (gmk.net carries no
// group-buy window) and must still merge.
assert.equal(
  planSetMerges([
    row({ slug: "gmk-foo", name: "GMK Foo", gbStart: "2021-03-01" }),
    row({ slug: "gmk-foo-keycaps", name: "GMK Foo Keycaps" }),
  ]).merges.length,
  1
);

// Deterministic: the same rows in a different order plan the same merge, so a
// deploy cannot shuffle a slug back and forth.
const forwards = planSetMerges([
  row({ slug: "gmk-a-keycaps", name: "GMK A Keycaps" }),
  row({ slug: "gmk-a", name: "GMK A" }),
]);
const backwards = planSetMerges([
  row({ slug: "gmk-a", name: "GMK A" }),
  row({ slug: "gmk-a-keycaps", name: "GMK A Keycaps" }),
]);
assert.equal(forwards.merges[0].keep.slug, backwards.merges[0].keep.slug);

console.log("set merge identity checks passed");
