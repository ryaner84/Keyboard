import assert from "node:assert/strict";
import {
  buildKeycapSetIndex,
  resolveSetName,
  type ImportSetCandidate,
} from "@/lib/collection-import";

function set(
  slug: string,
  name: string,
  status = "DELIVERED",
  gbStart: string | null = null
): ImportSetCandidate {
  return { slug, name, imageUrl: null, designer: null, status, gbStart };
}

const index = buildKeycapSetIndex([
  // Olivia family: an original run and two later rounds, one currently selling.
  set("gmk-olivia", "GMK Olivia", "DELIVERED", "2019-01-01"),
  set("gmk-olivia-r2", "GMK Olivia R2", "DELIVERED", "2021-01-01"),
  set("gmk-olivia-r3", "GMK Olivia R3", "ACTIVE_GB", "2026-01-01"),
  // The same set catalogued three times under different source names.
  set("gmk-cyl-bento-keycaps", "GMK CYL Bento Keycaps", "SHIPPING", "2023-01-01"),
  set("gmk-bento", "GMK Bento", "SHIPPING", "2023-01-01"),
  set("gh-12345", "[GB] GMK Bento | Jan 2 - Feb 2", "SHIPPING", "2023-01-01"),
  // MTNU is a genuinely different profile from the plain set.
  set("gmk-divinapapaya", "GMK Divinapapaya", "SHIPPING", "2025-06-01"),
  set("gmk-mtnu-divinapapaya", "GMK MTNU Divinapapaya", "SHIPPING", "2025-06-01"),
]);

// --- explicit round wins exactly -----------------------------------------
const r2 = resolveSetName("GMK Olivia R2", index);
assert.equal(r2.match?.slug, "gmk-olivia-r2");

// "Round 2" long form normalises to the same set.
assert.equal(resolveSetName("GMK Olivia Round 2", index).match?.slug, "gmk-olivia-r2");

// --- bare name resolves within the family, preferring what's selling ------
const bare = resolveSetName("GMK Olivia", index);
assert.equal(bare.match?.slug, "gmk-olivia-r3"); // ACTIVE_GB wins
assert.ok(bare.ambiguous);
assert.ok(bare.candidates.length > 0);
// The chosen match is never repeated in the alternatives.
assert.ok(!bare.candidates.some((c) => c.slug === bare.match?.slug));

// --- duplicate source names collapse to ONE canonical candidate ----------
const bento = resolveSetName("Bento", index);
assert.equal(bento.match?.slug, "gmk-cyl-bento-keycaps"); // official CYL name preferred
// All three Bento rows are the same set, so no alternatives are offered.
assert.equal(bento.candidates.length, 0);
assert.equal(bento.ambiguous, false);

// The gmk.net spelling and the bare name resolve to the same set.
assert.equal(
  resolveSetName("GMK CYL Bento Keycaps", index).match?.slug,
  bento.match?.slug
);

// --- MTNU must NOT be merged with the plain set --------------------------
assert.equal(
  resolveSetName("GMK MTNU Divinapapaya", index).match?.slug,
  "gmk-mtnu-divinapapaya"
);
assert.equal(
  resolveSetName("GMK Divinapapaya", index).match?.slug,
  "gmk-divinapapaya"
);

// Asking for an MTNU set that isn't catalogued must NOT fall back to the
// default-profile run of the same colourway — they are different products.
const mtnuOnly = resolveSetName("GMK MTNU Bento", index);
assert.equal(mtnuOnly.match, null);
assert.deepEqual(mtnuOnly.candidates, []);

// --- no match ------------------------------------------------------------
const missing = resolveSetName("GMK Totally Made Up Set", index);
assert.equal(missing.match, null);
assert.deepEqual(missing.candidates, []);

// Blank/garbage input never matches.
assert.equal(resolveSetName("", index).match, null);
assert.equal(resolveSetName("   ", index).match, null);

console.log("collection import matcher checks passed");
