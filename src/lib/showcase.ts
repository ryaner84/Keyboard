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
