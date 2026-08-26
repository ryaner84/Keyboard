import type { Prisma } from "@/generated/prisma";

// Vendor rows that are MANUFACTURER/catalog markers, not stores.
//
// A `Vendor` row is not always a shop. Two of them exist only to carry a
// catalog URL so the catalog and image passes can tell which sets they have
// already visited: `gmk` → gmk.net (the manufacturer's own Shopware webshop)
// and `dcs-wiki` → dcs.wiki (the DCS archive, created by
// `ensure_dcs_vendor` in scrape.py, which documents the row as "never priced
// or displayed"). Neither serves a Shopify catalogue, neither sells anything,
// and neither may ever appear on the site as a place to buy.
//
// This is the TypeScript half of a registry that already exists in Python —
// `MANUFACTURER_VENDOR_SLUGS` / `MANUFACTURER_URL_PATTERNS` in scrape.py. The
// two halves are kept in agreement by manufacturer-vendors.test.ts, because
// the last time they diverged nothing failed loudly:
//
//   * the price queue orders by `priceUpdatedAt ASC NULLS FIRST`, so rows that
//     can never be priced sort AHEAD of every real listing and eat a
//     time-boxed run's budget before it reaches a single store;
//   * the discovery rotation crawls 6 vendors per run, so a non-store in the
//     roster costs a real store its slot — and dcs.wiki, which has no
//     products.json, falls through to the generic HTML path, where every
//     "DCS …" anchor on a wiki index page reads as a product and is written
//     back as a VendorKit (with `priceUpdatedAt: null`, straight to the front
//     of the queue again);
//   * `fetchVendorPrice` refuses gmk.net by hand, but nothing refused
//     dcs.wiki — a JSON-LD reader pointed at an archive page can return a
//     number, and a number is all it takes for a wiki to be published as the
//     cheapest vendor for a set.
//
// Whether a store publishes anything at all comes down to the price pass
// reaching its rows: unpriced listings are hidden outright on released sets,
// which is where the great majority of listings live. Anything that jumps the
// price queue therefore takes real stores off the site.
export const MANUFACTURER_VENDOR_SLUGS = ["gmk", "dcs-wiki"] as const;

// Hosts owned by those sources. Matched as a substring, exactly like the SQL
// `ILIKE '%gmk.net%'` and Prisma `contains` filters this list feeds, so a row
// pointing at www.gmk.net or dcs.wiki/archive/… is caught too.
export const MANUFACTURER_URL_HOSTS = ["gmk.net", "dcs.wiki"] as const;

// The one exception: GMK's own Warehouse Finds sale is a real, purchasable
// storefront whose listings legitimately live on gmk.net. It is a separate
// Vendor row (`gmk-direct`) from the manufacturer marker, and it stays visible
// on the site. It is still never priced — gmk.net blocks serverless IPs — so
// it publishes as an unpriced store link.
export const MANUFACTURER_STOREFRONT_SLUGS = ["gmk-direct"] as const;

/** True for a catalog/archive URL that must never be scraped for a price. */
export function isManufacturerListingUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return MANUFACTURER_URL_HOSTS.some((host) => lower.includes(host));
}

/** `productUrl` matches one of the manufacturer hosts. */
function urlIsManufacturer(): Prisma.VendorKitWhereInput[] {
  return MANUFACTURER_URL_HOSTS.map((host) => ({ productUrl: { contains: host } }));
}

// Price-queue filter. Rows reaching the queue always carry a non-blank
// productUrl, so the bare NOT is safe here — no NULL can be swallowed by SQL's
// three-valued logic.
export const NOT_MANUFACTURER_LISTING: Prisma.VendorKitWhereInput = {
  vendor: { slug: { notIn: [...MANUFACTURER_VENDOR_SLUGS] } },
  NOT: { OR: urlIsManufacturer() },
};

// Site filter: what a visitor may be shown as a place to buy.
//
// The OR keeps NULL-productUrl rows (manual prices) visible — a bare
// NOT-contains would drop them, because `NULL NOT LIKE '%gmk.net%'` is NULL,
// not true — and lets gmk-direct through on its gmk.net URLs.
export const PURCHASABLE_VENDOR_KIT_WHERE: Prisma.VendorKitWhereInput = {
  vendor: { slug: { notIn: [...MANUFACTURER_VENDOR_SLUGS] } },
  OR: [
    { vendor: { slug: { in: [...MANUFACTURER_STOREFRONT_SLUGS] } } },
    { productUrl: null },
    { NOT: { OR: urlIsManufacturer() } },
  ],
  // A link the store answers 404/410 for is not a place to buy. Sending a
  // visitor to a removed product page is worse than showing them nothing, and
  // an unpriced row is only ever rendered as a bare "go here" link anyway.
  //
  // Only `deadSince` gates this, never the `linkFailures` heuristic: a store
  // that blocks the scraper looks identical to one that closed, and hiding a
  // live listing on a hunch is the failure this codebase keeps having. A priced
  // row is likewise never hidden — the same pass that sees a 404 clears the
  // price, so "priced and dead" only means the flag outlived the price.
  // See scripts/lib/link-health.mjs.
  NOT: { AND: [{ deadSince: { not: null } }, { price: null }] },
};

// Discovery-rotation filter: asking a manufacturer/catalog source for a
// products.json burns a vendor slot on a 404 (and worse on dcs.wiki, see
// above). Mirrors _DISCOVERY_VENDOR_SQL in scrape.py.
export const NOT_MANUFACTURER_VENDOR: Prisma.VendorWhereInput = {
  slug: { notIn: [...MANUFACTURER_VENDOR_SLUGS] },
};
