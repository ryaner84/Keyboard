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
// … Kit" spellings. Distinct from normalizeSetName (kept conservative for price
// matching): this also drops edition/kit filler and the CYL/DCS profile tokens,
// but deliberately KEEPS "mtnu" — GMK MTNU is a genuinely different profile, so
// "MTNU X" must NOT merge with "X". Round-aware, so R1 never merges with R2.
export function dedupeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[—–]/g, " ")
    .replace(/\bround\s*(\d+)\b/g, "r$1")
    .replace(
      /\b(group\s*buy|groupbuy|gb|pre[- ]?order|in[- ]?stock|extras?|live|launch(ed)?)\b/g,
      " "
    )
    // generic filler that varies between listings of the same item
    .replace(/\b(keycap\s*sets?|keycaps?|keysets?|keyboard|kit|special|edition)\b/g, " ")
    // strippable profile / brand tokens — CYL/DCS/OEM/SA describe caps and are
    // interchangeable defaults; "gmk" is constant. "mtnu" is intentionally NOT here.
    .replace(/\b(gmk|cyl|dcs|oem|sa|cherry\s*profile)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
