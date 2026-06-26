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

// Prisma where-fragment that drops denylisted boards. Spread into any
// groupBuy.findMany/count `where` to keep hidden boards out of that listing.
// Uses `slug: { notIn }` (not a top-level `NOT`) so it never collides with a
// where-object that already has its own conditional `NOT` clause.
export const notHiddenWhere =
  HIDDEN_SLUGS.length > 0 ? { slug: { notIn: HIDDEN_SLUGS } } : {};

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
