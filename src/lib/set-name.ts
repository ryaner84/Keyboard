// Pure set-name helpers, shared by the vendor-catalog discovery importer and
// the set page's round-family cross-links. Extracted from
// src/lib/import/discovery.ts (which re-exports them for its callers) so the
// set page doesn't pull the whole scraper module graph into its bundle.
// Mirror of normalize_set_name / strip_round in scraper/scrape.py — keep in sync.

// Normalize a set/product name for matching: drop bracketed tags ("[GB]",
// "(Pre-order)"), sales-status words, keycap filler words; unify "Round 3"
// with "R3"; strip punctuation.
export function normalizeSetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(group\s*buy|groupbuy|gb|pre[- ]?order|in[- ]?stock|extras?|live|launch(ed)?)\b/g, " ")
    // "cyl"/"mtnu" are GMK profile tokens, not set identity: "GMK CYL Seafarer"
    // is the same set as "GMK Seafarer" (vendor outlets and gmk.net both add it).
    .replace(/\b(keycap\s*sets?|keycaps?|keysets?|cherry\s*profile|cyl|mtnu)\b/g, " ")
    .replace(/\bround\s*(\d+)\b/g, "r$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "gmk striker r2" -> "gmk striker"; names without a round tag are unchanged.
export function stripRound(normalized: string): string {
  return normalized.replace(/\s+r\d+$/, "").trim();
}

// Round number from a NORMALIZED name's trailing "rN"; a set with no round
// suffix is the original run (round 1).
export function roundNumber(normalized: string): number {
  const m = normalized.match(/\br(\d+)$/);
  return m ? Number(m[1]) : 1;
}

// Aggressive identity key for collapsing DISPLAY duplicates of one set/board
// across differently-named catalog rows — e.g. gmk.net "GMK CYL Divinapapaya
// Keycaps", KeycapLendar "GMK Divinapapaya", and the three "Sensy Seal80 … Dolch
// … Kit" spellings. Distinct from normalizeSetName, which is kept conservative
// for price matching. Round-aware, so R1 never merges with R2.
//
// Profile tokens are context-dependent, which is why `keepProfile` exists:
//   • On a KEYCAP SET the profile IS the product identity — "DCS Dolch" is a
//     Signature Plastics set and "GMK Dolch" is a different product entirely, so
//     collapsing them would merge two unrelated sets into one listing. Callers
//     dealing with keycaps must pass keepProfile: true.
//   • On a KEYBOARD the same words merely describe the bundled caps ("Seal80 —
//     DCS Dolch Special Edition"), so they are noise that must be stripped for
//     the three spellings of one board to collapse.
// "mtnu" is never stripped: GMK MTNU is always a distinct profile.
export function dedupeKey(name: string, opts?: { keepProfile?: boolean }): string {
  const base = name
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[—–]/g, " ")
    .replace(/\bround\s*(\d+)\b/g, "r$1")
    .replace(
      /\b(group\s*buy|groupbuy|gb|pre[- ]?order|in[- ]?stock|extras?|live|launch(ed)?)\b/g,
      " "
    )
    // generic filler that varies between listings of the same item
    .replace(/\b(keycap\s*sets?|keycaps?|keysets?|keyboard|kit|special|edition)\b/g, " ");

  // "gmk" and "cyl" are always dropped: "gmk" is a constant across the catalog
  // and CYL is GMK's default profile, so neither distinguishes two sets.
  const withoutConstants = base.replace(/\b(gmk|cyl|cherry\s*profile)\b/g, " ");

  return (
    opts?.keepProfile
      ? withoutConstants
      : withoutConstants.replace(/\b(dcs|oem|sa)\b/g, " ")
  )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Maker (manufacturer) ────────────────────────────────────────────────────
// Who physically makes the set, which is NOT the same as its profile:
//   • GMK Electronic Design makes Cherry-profile sets ("GMK Botanical"), plus
//     the CYL and MTNU profiles. "MTNU Electronic Control" carries no "GMK"
//     token at all, so a naive name check would miss it.
//   • Signature Plastics makes DCS — and SA, DSS and DSA, which share the maker
//     but are entirely different profiles. DCS is a sibling of SA, not a kind
//     of SA.
// Grouping by maker is what lets the browse page offer two stable pills while
// new profiles from the same factory land in the right bucket automatically.
export type KeycapMaker = "GMK" | "SP";

export const KEYCAP_MAKER_LABELS: Record<KeycapMaker, string> = {
  GMK: "GMK",
  SP: "Signature Plastics",
};

// Leading profile token -> maker. Order matters only for readability; the
// lookup is exact on the first token of the name.
const MAKER_BY_PROFILE: Record<string, KeycapMaker> = {
  gmk: "GMK",
  cyl: "GMK",
  mtnu: "GMK",
  dcs: "SP",
  sa: "SP",
  dss: "SP",
  dsa: "SP",
};

// The maker of a keycap set, or null when the name carries no known profile
// token (Geekhack threads for untracked profiles, oddly-named imports).
// Returning null rather than guessing keeps unknown sets visible under "All"
// instead of being silently filed under the wrong maker.
export function setMaker(name: string): KeycapMaker | null {
  // Drop leading "[GB]"/"(IC)" tags the same way the dedupe helpers do, so a
  // thread title resolves as well as a catalog name.
  const cleaned = (name ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return null;
  const [first] = cleaned.split(" ");
  return MAKER_BY_PROFILE[first] ?? null;
}

// Rank a catalog row within a dedupe group: higher = better representative.
// Prefers the official profile-named row (GMK CYL / MTNU, "… Keycaps"), and
// penalises Geekhack "[GB] …"/"(Group Buy) …" thread names and gh- slugs.
export function dedupeCanonicalScore(name: string, slug: string): number {
  let score = 0;
  if (/\bcyl\b/i.test(name)) score += 40;
  if (/\bmtnu\b/i.test(name)) score += 40;
  if (/keycaps?\b/i.test(name)) score += 10;
  if (/^\s*[[(]/.test(name)) score -= 60;
  if (slug.startsWith("gh-")) score -= 30;
  score -= name.length * 0.05;
  return score;
}
