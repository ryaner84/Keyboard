import assert from "node:assert/strict";
import { dedupeKey, normalizeSetName, stripRound, roundNumber } from "@/lib/set-name";

// --- normalizeSetName keeps DCS distinct from GMK -------------------------
// This is the key the vendor-listing matcher uses. It strips GMK's own default
// profile tokens (cyl/mtnu handled elsewhere) but must NOT conflate profiles.
assert.notEqual(normalizeSetName("DCS Dolch"), normalizeSetName("GMK Dolch"));
assert.equal(normalizeSetName("GMK CYL Bento Keycaps"), normalizeSetName("GMK Bento"));

// --- dedupeKey: profile is identity for keycaps, noise for keyboards -------

// KEYCAPS (keepProfile: true) — "DCS Dolch" is a Signature Plastics set and
// "GMK Dolch" is a different product. Collapsing them would merge two unrelated
// sets into one listing.
assert.notEqual(
  dedupeKey("DCS Dolch", { keepProfile: true }),
  dedupeKey("GMK Dolch", { keepProfile: true })
);
// The gmk.net and community spellings of ONE set still collapse.
assert.equal(
  dedupeKey("GMK CYL Bento Keycaps", { keepProfile: true }),
  dedupeKey("GMK Bento", { keepProfile: true })
);
// DCS spellings of one set collapse with each other.
assert.equal(
  dedupeKey("[GB] DCS Superweld", { keepProfile: true }),
  dedupeKey("DCS Superweld Keycaps", { keepProfile: true })
);
// MTNU stays distinct in both modes.
assert.notEqual(
  dedupeKey("GMK MTNU Divinapapaya", { keepProfile: true }),
  dedupeKey("GMK Divinapapaya", { keepProfile: true })
);
assert.notEqual(dedupeKey("GMK MTNU Divinapapaya"), dedupeKey("GMK Divinapapaya"));

// KEYBOARDS (default) — here "DCS Dolch" only describes the bundled caps, so the
// three spellings of one board must still collapse to a single listing.
const seal80 = [
  "Sensy Seal80 Dolch Edition Keyboard Kit",
  "SENSY Seal80 Keyboard Kit — DCS Dolch Special Edition (Group Buy)",
  "(Group Buy) Sensy Seal80 Keyboard Kit - DCS Dolch Special Edition",
].map((name) => dedupeKey(name));
assert.equal(new Set(seal80).size, 1, `Seal80 spellings should collapse: ${JSON.stringify(seal80)}`);

// Rounds are never merged, in either mode.
assert.notEqual(dedupeKey("GMK Noel"), dedupeKey("GMK Noel R2"));
assert.notEqual(
  dedupeKey("DCS Cream Cheese and Green", { keepProfile: true }),
  dedupeKey("DCS Cream Cheese and Green R3", { keepProfile: true })
);

// --- round helpers --------------------------------------------------------
assert.equal(stripRound(normalizeSetName("GMK Striker R2")), "gmk striker");
assert.equal(roundNumber(normalizeSetName("GMK Striker Round 3")), 3);
assert.equal(roundNumber(normalizeSetName("GMK Striker")), 1);

console.log("set-name profile-identity checks passed");
