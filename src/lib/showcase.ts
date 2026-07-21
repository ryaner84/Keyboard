// "Lightning Keyboards" is a showcase/photo source, not a real group-buy vendor —
// its ~548 scraped boards are someone's keyboard collection, not products you can
// join or buy. They are excluded from every group-buy listing (Keyboards Active /
// Upcoming / Past GBs and the global ⌘K search) and instead surfaced only in the
// browse-only /showcase gallery.
export const SHOWCASE_VENDORS = ["Lightning Keyboards"];

// Boards pulled for privacy/legal reasons — e.g. their scraped photos contained
// identifiable people's names. These are 404'd on the detail page and filtered
// out of every listing, search result, and the showcase grid. The underlying DB
// row may still exist (deleting it requires production DB access); this denylist
// is the code-level guarantee that the board never reaches a user again.
export const HIDDEN_SLUGS = ["gh-73956"];

export function isHiddenSlug(slug: string | null | undefined): boolean {
  return !!slug && HIDDEN_SLUGS.includes(slug);
}

// User-submitted custom collection pieces (a board/set that isn't in the
// catalog) are backed by a GroupBuy whose slug starts with this prefix. They
// belong to exactly one owner's private collection and must NEVER appear in any
// public catalog surface — browse, keyboards, released, search, timeline, home,
// or the /sets detail page.
export const CUSTOM_SLUG_PREFIX = "custom-";

export function isCustomSlug(slug: string | null | undefined): boolean {
  return !!slug && slug.startsWith(CUSTOM_SLUG_PREFIX);
}

// Standalone fragment that drops custom pieces — push into an AND array (used
// by the group-buys and search routes, which compose conditions that way).
export const notCustomWhere = {
  slug: { not: { startsWith: CUSTOM_SLUG_PREFIX } },
};

// Public-catalog visibility fragment: drops both privacy-denylisted boards and
// custom collection pieces. Spread into any groupBuy `where` whose slug isn't
// otherwise constrained (home, timeline, released). One `slug` object carries
// both conditions so a spread never collides.
export const notHiddenWhere = {
  slug: {
    not: { startsWith: CUSTOM_SLUG_PREFIX },
    ...(HIDDEN_SLUGS.length > 0 ? { notIn: HIDDEN_SLUGS } : {}),
  },
};

// Where-fragment that drops showcase-source rows (Lightning Keyboards) from a
// commerce surface, null-safe: a bare notIn would also drop rows whose
// vendorName is NULL. AND-wrapped so it composes with a where that has its own
// OR (e.g. a search clause).
export const notShowcaseWhere = {
  AND: [
    { OR: [{ vendorName: null }, { vendorName: { notIn: SHOWCASE_VENDORS } }] },
  ],
};

// True when a listing comes from a showcase-only source and must be kept out of
// the group-buy sections.
export function isShowcaseSource(
  vendorName: string | null | undefined
): boolean {
  return !!vendorName && SHOWCASE_VENDORS.includes(vendorName);
}

// The /showcase gallery is a community photo gallery — the ONLY rows that belong
// there are the showcase sources in SHOWCASE_VENDORS (Lightning Keyboards).
// Every other KEYBOARD row is real vendor / group-buy data (Oblotzky Industries,
// ClickClack, …) and belongs in the Keyboard Catalog, never the showcase.
// Spread into a groupBuy `where` to restrict a query to showcase rows only.
// `vendorName: { in }` is null-safe: a NULL or non-showcase vendorName simply
// doesn't match, so vendor and vendorless boards are both excluded.
export const showcaseOnlyWhere = { vendorName: { in: SHOWCASE_VENDORS } };

// Scraped showcase board names carry the source as a suffix, e.g.
// "Meletrix Zoom64 — Lightning Keyboards" or "...&mdash; Lightning Keyboards".
// Users shouldn't see where the photos came from, so strip that trailing
// "<separator> Lightning Keyboards" tag (and decode the common scraped HTML
// entities while we're at it) before the name is ever rendered.
export function cleanDisplayName(name: string | null | undefined): string {
  if (!name) return "";
  const decoded = name
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;/gi, "’")
    .replace(/&quot;/gi, '"');
  for (const vendor of SHOWCASE_VENDORS) {
    const stripped = decoded
      .replace(
        new RegExp(`\\s*[—–\\-|·]\\s*${vendor}\\s*$`, "i"),
        ""
      )
      .replace(new RegExp(`\\s*${vendor}\\s*$`, "i"), "");
    if (stripped !== decoded) return stripped.trim();
  }
  return decoded.trim();
}
