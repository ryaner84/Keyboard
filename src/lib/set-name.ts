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
