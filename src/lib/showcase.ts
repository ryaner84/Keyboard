// "Lightning Keyboards" is a showcase/photo source, not a real group-buy vendor —
// its ~548 scraped boards are someone's keyboard collection, not products you can
// join or buy. They are excluded from every group-buy listing (Keyboards Active /
// Upcoming / Past GBs and the global ⌘K search) and instead surfaced only in the
// browse-only /showcase gallery.
export const SHOWCASE_VENDORS = ["Lightning Keyboards"];

// True when a listing comes from a showcase-only source and must be kept out of
// the group-buy sections.
export function isShowcaseSource(
  vendorName: string | null | undefined
): boolean {
  return !!vendorName && SHOWCASE_VENDORS.includes(vendorName);
}

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
