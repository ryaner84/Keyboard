// One set, two rows: the identity rule a DESTRUCTIVE merge is allowed to use.
//
// gmk.net's catalog names a set "GMK CYL Mizu R2 Keycaps"; KeycapLendar names
// the same product "GMK Mizu R2". `upsert_gmk_set` matches on SLUG, so those
// became two GroupBuy rows — and `_build_set_index` in scrape.py already calls
// the second one "the orphan duplicate" while routing listings around it. The
// orphan is still published: it has its own set page, it appears in search, and
// whichever vendor links did land on it are split off the row the price
// comparison lives on.
//
// `dedupeKey` in src/lib/set-name.ts collapses that pair correctly, but it only
// ever HIDES a row. Deleting one is a different bar, so this key is deliberately
// stricter than dedupeKey in three places:
//
//   • A parenthetical is unwrapped, not dropped. dedupeKey throws away
//     "(2021)", which would merge "GMK Nautilus (2021)" into "GMK Nautilus" —
//     two different runs. CLAUDE.md already says that parenthetical carries
//     real product information; here it is identity.
//   • "+" becomes "plus" before punctuation is stripped, so "GMK Olivia++"
//     cannot collapse into "GMK Olivia".
//   • A known maker/profile token is REQUIRED on both sides, and only CYL folds
//     into GMK. A bare Geekhack title ("[GB] Dolch") names no profile and could
//     be any maker's set, so it merges with nothing.
//
// Kept as plain .mjs, like vendor-urls.mjs, because scripts/db-setup.mjs runs in
// the build before any TypeScript exists.

// Leading profile token -> the identity it contributes. CYL is a GMK profile
// spelling, not a different product ("GMK CYL Seafarer" IS "GMK Seafarer" —
// normalizeSetName has always said so). MTNU is its own profile and never
// folds into GMK. The untracked profiles are listed so that a KAT / MT3 forum
// row is never merged into a GMK row of the same colourway.
const PROFILE_IDENTITY = {
  gmk: "gmk",
  cyl: "gmk",
  mtnu: "mtnu",
  dcs: "dcs",
  sa: "sa",
  dss: "dss",
  dsa: "dsa",
  kat: "kat",
  kam: "kam",
  mt3: "mt3",
  xda: "xda",
  mda: "mda",
  oem: "oem",
};

// Forum and shop furniture: true noise, safe to drop from an identity.
const STATUS_WORDS_RE =
  /\b(group\s*buy|groupbuy|gb|ic|interest\s*check|pre[- ]?order|preorder|in[- ]?stock|extras?|live|launch(ed)?|closed|ended|shipping|shipped|sold\s*out)\b/g;

// Packaging words, not products. Deliberately shorter than dedupeKey's list:
// "special", "edition" and "keyboard" stay in, because on a destructive merge
// "GMK Foo Special Edition" being a different product from "GMK Foo" is a
// cheaper mistake to avoid than to make.
const FILLER_WORDS_RE = /\b(keycap\s*sets?|keycaps?|keysets?|kits?|cherry\s*profile)\b/g;

// Identity of a set name, or null when the name cannot safely take part in a
// merge. Returns { profile, key } — both must match for two rows to be one set.
export function setMergeIdentity(name) {
  let s = String(name ?? "").toLowerCase();
  // Unwrap rather than delete: "(2021)" and "(R2)" are identity, "[GB]" is not
  // (STATUS_WORDS_RE takes care of that once it is no longer inside brackets).
  s = s.replace(/[[\]()]/g, " ");
  s = s.replace(/\|.*$/, " "); // "… | designed by X"
  s = s.replace(/\+/g, " plus ").replace(/&/g, " and ");
  s = s.replace(STATUS_WORDS_RE, " ");
  s = s.replace(/\bround\s*(\d+)\b/g, "r$1");
  s = s.replace(FILLER_WORDS_RE, " ");
  s = s.replace(/['’]/g, "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return null;

  const tokens = s.split(" ");
  // Consume the LEADING run of profile tokens ("gmk", "gmk cyl", "gmk mtnu").
  // The most specific one wins, so "GMK MTNU Foo" is an MTNU set and never
  // merges with "GMK Foo".
  let profile = "";
  let i = 0;
  while (i < tokens.length && PROFILE_IDENTITY[tokens[i]] !== undefined) {
    const identity = PROFILE_IDENTITY[tokens[i]];
    if (identity !== "gmk" || profile === "") profile = identity;
    i++;
  }
  if (!profile) return null;

  const key = tokens.slice(i).join(" ");
  if (!key) return null;
  return { profile, key };
}

// Which of two rows for one set keeps its id and slug.
//
// The slug decides it, which is not the obvious answer — the row with the most
// listings or the most collection entries looks like the one to keep. It isn't:
// the merge MOVES both, so neither is lost by picking the other row, and the
// only entries that cannot move (an owner who added both rows) are the same
// pair either way. What genuinely cannot be moved is the slug. It is the URL
// people share, and it is what `VendorSuggestion`, the frozen-slug lists and
// `BLOCKED_VENDOR_SET_PAIRS` all name — so the canonical spelling has to be the
// one that survives.
//
// Every tie is broken deterministically so a deploy cannot pick differently
// from the last one and shuffle a slug back and forth.
export function slugQuality(slug) {
  const s = String(slug ?? "");
  let score = 0;
  if (s.startsWith("gh-")) score -= 60; // a forum topic id, not a name
  if (s.startsWith("custom-")) score -= 20;
  if (/-keycaps?$/.test(s)) score -= 25; // gmk.net's divergent spelling
  if (/(^|-)cyl-/.test(s)) score -= 25;
  return score - s.length * 0.05;
}

function pickSurvivor(rows) {
  return [...rows].sort(
    (a, b) =>
      slugQuality(b.slug) - slugQuality(a.slug) ||
      (b.vendorLinks ?? 0) - (a.vendorLinks ?? 0) ||
      (b.trackerItems ?? 0) - (a.trackerItems ?? 0) ||
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
      String(a.slug).localeCompare(String(b.slug))
  )[0];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Rows in, merges out. Each merge is { keep, drop: [...], profile, key }.
// `skipped` names the groups this pass refused, so a duplicate that needs a
// person is reported rather than silently left looking handled.
//
// KEYCAPS only. Keyboards carry deliberately-separate rows for editions of one
// family — "TGR Jane v2 OG" / "CE" / "ME" are three products and db-setup
// creates them on purpose — so a name-shaped merge has no business there.
export function planSetMerges(rows, opts = {}) {
  // Two rows whose group buys ran a year apart are far more likely to be
  // different rounds that lost their round suffix than one set written twice.
  const maxGapDays = opts.maxRoundGapDays ?? 180;

  const groups = new Map();
  for (const row of rows) {
    if ((row.productType ?? "KEYCAPS") !== "KEYCAPS") continue;
    const identity = setMergeIdentity(row.name);
    if (!identity) continue;
    const groupKey = `${identity.profile}::${identity.key}`;
    const group = groups.get(groupKey);
    if (group) group.rows.push(row);
    else groups.set(groupKey, { ...identity, rows: [row] });
  }

  const merges = [];
  const skipped = [];
  for (const [, group] of groups) {
    if (group.rows.length < 2) continue;

    const dated = group.rows
      .map((r) => (r.gbStart ? new Date(r.gbStart).getTime() : null))
      .filter((t) => t !== null && !Number.isNaN(t));
    if (dated.length > 1 && Math.max(...dated) - Math.min(...dated) > maxGapDays * DAY_MS) {
      skipped.push({
        ...group,
        reason: `group buys start more than ${maxGapDays} days apart — probably different rounds`,
      });
      continue;
    }

    const keep = pickSurvivor(group.rows);
    merges.push({
      profile: group.profile,
      key: group.key,
      keep,
      drop: group.rows.filter((r) => r.id !== keep.id),
    });
  }

  // Stable output so the deploy log reads the same way twice.
  merges.sort((a, b) => a.keep.slug.localeCompare(b.keep.slug));
  skipped.sort((a, b) => `${a.profile}${a.key}`.localeCompare(`${b.profile}${b.key}`));
  return { merges, skipped };
}
