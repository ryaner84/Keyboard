// What "on sale" means, written once. Client-safe: no Prisma imports, so
// SetCard can use the row predicate and the homepage/released routes can use
// the WHERE clause without the two drifting apart.
//
// A markdown is one shop cutting its OWN price (compare_at_price > price) —
// the thing a shopper recognises as a sale — as opposed to computeSavings()'s
// spread between two shops' full prices.
import { isSubkitSetName } from "./kit-variants";

// Rows where some vendor is running a markdown AND will still sell it to you.
//
// The conditions live in ONE `some` on purpose: as separate filters they
// could be satisfied by different vendor rows, so a set could qualify because
// vendor A is in stock and vendor B (sold out) is discounted. In stock is part
// of the claim rather than a separate availability filter because "on sale"
// means buyable at a markdown — a discount on a listing nobody can buy is a
// price-history footnote, not a deal.
//
// A LOCKED row is precisely "a listing nobody can buy": priceSource=LOCKED means
// the store is shut (password gate / 402 non-payment freeze, link-health.mjs),
// yet the row deliberately keeps its last `inStock=true` and `compareAtPrice`
// so it reappears when the store reopens (CLAUDE.md keeps LOCKED rows visible on
// the set page). That visibility must not extend to the deals surfaces — Neo
// Macro's closed neomacro.in was surfacing on /released?deals=1 as an in-stock
// discount. Prisma's `not` returns null-priceSource rows too, so ordinary
// scraped rows stay. PURCHASABLE_VENDOR_KIT_WHERE and the set page are
// untouched, so a LOCKED listing still shows there exactly as before.
export const ON_SALE_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: {
        some: {
          price: { not: null },
          compareAtPrice: { not: null },
          inStock: true,
          priceSource: { not: "LOCKED" },
        },
      },
    },
  },
};

export interface SaleRowLike {
  price: number | null;
  compareAtPrice?: number | null;
  inStock: boolean;
  priceSource?: string | null;
}

// The same claim as ON_SALE_FILTER, for ONE row already in hand. The badge and
// the filter must agree: when they didn't, a set qualified through a buyable
// 6% markdown and its card advertised a sold-out shop's 52% (GMK TeraDrive).
// `compareAtPrice > price` is re-checked here because the scrapers only store
// a real markdown but a hand-edited row must never render as a negative one.
export function isOnSaleRow(vk: SaleRowLike): boolean {
  return (
    vk.price != null &&
    vk.compareAtPrice != null &&
    vk.compareAtPrice > vk.price &&
    vk.inStock === true &&
    vk.priceSource !== "LOCKED"
  );
}

// The homepage rail is a teaser, not the catalogue — /released?deals=1 is the
// full list. So it is held to a collector's bar rather than the filter's:
//  - a markdown under MIN_PERCENT is noise (A$250 vs A$253 is not a sale);
//  - add-on / extension / 40s sets are dropped (isSubkitSetName): a €32
//    add-on at 35% off crowds out a full set nobody would call a deal less;
//  - so is a markdown read off an add-on LISTING (isAddonListingUrl);
//  - at most PER_VENDOR per shop, because one store running a storewide sale
//    (Mekibo held 12 of 48 on-sale sets) otherwise fills every slot.
export const HOME_SALE_MIN_PERCENT = 10;
export const HOME_SALE_PER_VENDOR = 2;
export const HOME_SALE_LIMIT = 5;

// Whether the LISTING the markdown came from is an add-on page rather than
// the set's base kit, read off its URL handle. A mislinked extras product
// ("gmk-aurora-polaris-extras", USD 45 from 75) otherwise headlines the rail
// as the set being 40% off. Rail-only on purpose: "extras" is not added to the
// shared SUBKIT vocabulary, which also drives the price pickers.
export function isAddonListingUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let handle = "";
  try {
    handle = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return false;
  }
  const words = decodeURIComponent(handle).replace(/[-_]+/g, " ");
  return isSubkitSetName(words) || /\bextras?\b/i.test(words);
}

// Accessory-only vendors whose "-extras" product pages are cables named after a
// keycap set, never that set's base kit. SwiftCables (swiftcables.net) is a
// cable maker: /products/<set>-extras is a single "Default Title" cable,
// plausibly priced (USD 39.5/45) so the base-kit picker cannot reject it, and
// "extras" is deliberately allowed as a base word — so the row keeps re-storing
// the cable price and never heals (reported on gmk-evil-dolch-r2 3× in 2026-08,
// then again on gmk-evil-dolch R1 and gmk-aurora-polaris on 2026-10-07).
// Blocking one (vendor, set) pair at a time does not hold: the SAME cable
// re-appears on a sibling set, so the block is keyed vendor-wide on the vendor
// slug + the "-extras" handle. It is scoped TWO ways so it can only ever drop a
// cable: to these vendor slugs (Switchmod's gmk-vamp-extras is a real keycap on
// a different vendor), and to the "-extras" handle (SwiftCables' one real keycap,
// gmk-mika-keycaps-1, does not match). Mirror in scripts/db-setup.mjs
// (purgeAddonOnlyVendorListings).
export const ADDON_ONLY_VENDOR_SLUGS = new Set(["swiftcables"]);

export function isBlockedVendorListing(
  vendorSlug: string | null | undefined,
  url: string | null | undefined
): boolean {
  if (!vendorSlug || !ADDON_ONLY_VENDOR_SLUGS.has(vendorSlug) || !url) return false;
  let handle = "";
  try {
    handle = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return false;
  }
  return /-extras$/i.test(decodeURIComponent(handle).replace(/[_\s]+/g, "-"));
}

export interface RankableSale<T> {
  set: T;
  name: string;
  discount: { percent: number; vendorName: string; productUrl?: string | null } | null;
}

export function rankHomeSales<T>(
  candidates: RankableSale<T>[],
  {
    minPercent = HOME_SALE_MIN_PERCENT,
    perVendor = HOME_SALE_PER_VENDOR,
    limit = HOME_SALE_LIMIT,
  }: { minPercent?: number; perVendor?: number; limit?: number } = {}
): T[] {
  const eligible = candidates
    .filter((c) => c.discount && c.discount.percent >= minPercent)
    .filter((c) => !isSubkitSetName(c.name))
    .filter((c) => !isAddonListingUrl(c.discount!.productUrl))
    // Stable tie-break on name so the rail doesn't reshuffle between
    // otherwise-identical cache fills.
    .sort(
      (a, b) =>
        b.discount!.percent - a.discount!.percent || a.name.localeCompare(b.name)
    );
  const perShop = new Map<string, number>();
  const out: T[] = [];
  for (const c of eligible) {
    const shop = c.discount!.vendorName;
    const n = perShop.get(shop) ?? 0;
    if (n >= perVendor) continue;
    perShop.set(shop, n + 1);
    out.push(c.set);
    if (out.length >= limit) break;
  }
  return out;
}
