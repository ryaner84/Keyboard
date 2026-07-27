import {
  dedupeCanonicalScore,
  dedupeKey,
  normalizeSetName,
  stripRound,
} from "@/lib/set-name";

// Resolve a free-text keycap set name (typed by a collector into a CSV) to a
// single catalog set, plus runners-up for the review table's picker.
//
// The round-resolution rules mirror matchProduct/pickFromFamily in
// src/lib/import/discovery.ts — but those are scraper-shaped: buildSetIndex
// there SKIPS any set without a BASE kit and loads keyboards and custom pieces
// too, which would silently drop valid sets from an import. This module keeps
// the same matching semantics while scoping the index correctly to keycaps and
// returning candidates instead of a single answer.

export interface ImportSetCandidate {
  slug: string;
  name: string;
  imageUrl: string | null;
  designer: string | null;
  status: string;
  gbStart: Date | string | null;
}

export interface KeycapSetIndex {
  byFull: Map<string, ImportSetCandidate[]>;
  byBase: Map<string, ImportSetCandidate[]>;
  byDedupe: Map<string, ImportSetCandidate[]>;
}

function push(
  map: Map<string, ImportSetCandidate[]>,
  key: string,
  entry: ImportSetCandidate
) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

export function buildKeycapSetIndex(sets: ImportSetCandidate[]): KeycapSetIndex {
  const index: KeycapSetIndex = {
    byFull: new Map(),
    byBase: new Map(),
    byDedupe: new Map(),
  };
  for (const set of sets) {
    const full = normalizeSetName(set.name);
    push(index.byFull, full, set);
    push(index.byBase, stripRound(full), set);
    push(index.byDedupe, dedupeKey(set.name), set);
  }
  return index;
}

function time(value: Date | string | null): number {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

// Within one round family prefer the round that is actually selling, then the
// newest — same rule the vendor-listing matcher uses.
function rankFamily(candidates: ImportSetCandidate[]): ImportSetCandidate[] {
  return [...candidates].sort((a, b) => {
    const activeDelta =
      Number(b.status === "ACTIVE_GB") - Number(a.status === "ACTIVE_GB");
    if (activeDelta !== 0) return activeDelta;
    const startDelta = time(b.gbStart) - time(a.gbStart);
    if (startDelta !== 0) return startDelta;
    return dedupeCanonicalScore(b.name, b.slug) - dedupeCanonicalScore(a.name, a.slug);
  });
}

// Several catalog rows can describe the SAME set (gmk.net "GMK CYL X Keycaps",
// KeycapLendar "GMK X", a Geekhack thread). Collapse them so the picker offers
// distinct sets, keeping the canonical-looking row for each.
function collapseDuplicates(candidates: ImportSetCandidate[]): ImportSetCandidate[] {
  const groups = new Map<string, ImportSetCandidate[]>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const key = dedupeKey(candidate.name) || candidate.slug;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else {
      groups.set(key, [candidate]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const group = groups.get(key)!;
    return group.reduce(
      (best, candidate) =>
        dedupeCanonicalScore(candidate.name, candidate.slug) >
        dedupeCanonicalScore(best.name, best.slug)
          ? candidate
          : best,
      group[0]
    );
  });
}

export interface ResolveResult {
  match: ImportSetCandidate | null;
  candidates: ImportSetCandidate[]; // alternatives, best first, excludes `match`
  ambiguous: boolean; // a match was picked but real alternatives exist
}

const MAX_CANDIDATES = 5;

// GMK MTNU is a genuinely different profile from the default (CYL/Cherry)
// run of the same colourway — "MTNU Divinapapaya" must never resolve to
// "Divinapapaya" or vice versa. normalizeSetName deliberately strips the
// profile token (it is tuned for price matching, where the two are the same
// listing), so the family pool it produces mixes them and has to be filtered
// back apart here.
function hasMtnuProfile(name: string): boolean {
  return /\bmtnu\b/i.test(name);
}

export function resolveSetName(name: string, index: KeycapSetIndex): ResolveResult {
  const empty: ResolveResult = { match: null, candidates: [], ambiguous: false };
  const full = normalizeSetName(name);
  if (!full) return empty;

  let pool: ImportSetCandidate[] | undefined;

  if (/r\d+$/.test(full)) {
    // An explicit round ("GMK Olivia R2") is unambiguous: exact rows win, and
    // we only fall back to the family when the catalog lacks that round.
    pool = index.byFull.get(full) ?? index.byBase.get(stripRound(full));
  } else {
    // A bare name is ambiguous between the original run and the current round —
    // resolve inside the family (selling round first, then newest).
    pool = index.byBase.get(full) ?? index.byFull.get(full);
  }

  // Last resort: the looser display-identity key, which also tolerates
  // "Keyboard Kit"/"Edition"-style noise a collector may have typed.
  if (!pool || pool.length === 0) {
    const loose = dedupeKey(name);
    pool = loose ? index.byDedupe.get(loose) : undefined;
  }

  if (!pool || pool.length === 0) return empty;

  // Keep only candidates on the same profile as the query. If the collector
  // asked for an MTNU set we must not hand back the CYL run (and vice versa) —
  // they are different products. An empty result here is correct: the review
  // table then offers "pick a set" / "add as custom" rather than a wrong link.
  const wantMtnu = hasMtnuProfile(name);
  pool = pool.filter((candidate) => hasMtnuProfile(candidate.name) === wantMtnu);
  if (pool.length === 0) return empty;

  const distinct = collapseDuplicates(rankFamily(pool));
  const [match, ...rest] = distinct;
  return {
    match: match ?? null,
    candidates: rest.slice(0, MAX_CANDIDATES),
    ambiguous: rest.length > 0,
  };
}
