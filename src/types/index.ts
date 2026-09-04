import type { GBStatus, KitType, Region } from "@/generated/prisma";

export type { GBStatus, KitType, Region };

export interface Country {
  code: string;
  name: string;
  region: Region;
  currency: string;
  flag: string;
}

export interface LocationState {
  countryCode: string;
  region: Region;
  currency: string;
  country: Country | null;
}

export interface GroupBuyWithKits {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  colorway: string | null;
  designer: string;
  status: GBStatus;
  gbStart: Date | null;
  gbEnd: Date | null;
  imageUrl: string | null;
  images: string[];
  description: string | null;
  featured: boolean;
  updatedAt?: Date | string | null;
  // Keyboard fields (null/default on keycap sets).
  productType?: string;
  layout?: string | null;
  material?: string | null;
  mountingStyle?: string | null;
  basePrice?: number | null;
  priceCurrency?: string | null;
  productUrl?: string | null;
  vendorName?: string | null;
  vendorRegion?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  sourceLastCheckedAt?: Date | string | null;
  sourceLastActivityAt?: Date | string | null;
  dataTrustLevel?: string | null;
  dataTrustReason?: string | null;
  kits: KitSummary[];
}

export interface KitSummary {
  id: string;
  name: string;
  type: KitType;
}

export interface VendorWithZones {
  id: string;
  name: string;
  slug: string;
  region: Region;
  country: string;
  currency: string;
  websiteUrl: string;
  logoUrl: string | null;
  shippingZones: ShippingZoneSummary[];
}

export interface ShippingZoneSummary {
  destinationRegion: Region;
  baseShippingCost: number;
  currency: string;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  shipsToRegion: boolean;
}

export interface VendorKitWithDetails {
  id: string;
  price: number | null;
  // Pre-discount price of the same variant `price` came from. Only ever set
  // when the vendor is actually running a markdown (compare_at > price), so a
  // non-null value always means a real saving worth showing.
  compareAtPrice?: number | null;
  currency: string | null;
  inStock: boolean;
  gbUrl: string | null;
  productUrl?: string | null;
  priceUpdatedAt?: Date | string | null;
  priceSource?: string | null;
  // Raw scraped Shopify variants ([{ title, price }]) — parse with
  // parseVariants() from "@/lib/kit-variants".
  variants?: unknown;
  notes: string | null;
  vendor: VendorWithZones;
}

// Lightweight vendor pricing attached to a kit for catalog card previews.
export interface VendorKitPreview {
  id: string;
  price: number | null;
  // See VendorKitWithDetails.compareAtPrice — set only for a real markdown.
  compareAtPrice?: number | null;
  currency: string | null;
  inStock: boolean;
  gbUrl: string | null;
  productUrl: string | null;
  priceUpdatedAt: Date | string | null;
  // Raw scraped variant list ([{ title, price }]). Untyped on purpose — the
  // shape is a store's, not ours; parseVariants() in kit-variants.ts is the
  // only sanctioned reader. Optional so callers that `select` a narrow row
  // still satisfy this type.
  variants?: unknown;
  vendor: {
    name: string;
    region: Region;
    country: string;
    currency: string;
    shippingZones: ShippingZoneSummary[];
  };
}

export interface KitWithVendors extends KitSummary {
  vendorKits: VendorKitPreview[];
}

// GroupBuy whose kits carry vendor pricing — used by catalog cards.
export interface GroupBuyWithPricing extends Omit<GroupBuyWithKits, "kits"> {
  kits: KitWithVendors[];
}

// One physical build when the owner has multiple units of the same board.
// Build 1's specs live on CollectionItemDetails directly; builds 2..N here.
export interface CollectionUnit {
  acquiredAt: Date | string | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  color: string | null;
  condition: string | null;
  switches: string | null;
  keycaps: string | null;
  plateType: string | null;
  mountType: string | null;
  buildDetails: string | null;
  notes: string | null;
  imageUrl: string | null;
  // Sale record. Selling ONE of several units is normal, so this lives per
  // build rather than per piece. isSold is its own flag because marking a unit
  // sold before you have the date or figure to hand is the common case, and
  // soldCurrency is separate from purchaseCurrency because selling in a
  // different currency from the one you bought in is routine.
  isSold?: boolean;
  soldAt?: Date | string | null;
  soldPrice?: number | null;
  soldCurrency?: string | null;
}

export type KeycapCondition =
  | "SEALED"
  | "OPEN_UNUSED"
  | "MOUNTED"
  | "USED"
  | "INCOMPLETE";

export interface KeycapKitSelection {
  // Catalog kit id when this is a known kit; null means collector-entered kit.
  kitId: string | null;
  name: string;
  type: string;
}

export type KeycapPairing =
  | {
      kind: "collection";
      keyboardSlug: string;
      buildIndex: number;
      showPublic: boolean;
    }
  | {
      kind: "free_text";
      label: string;
      showPublic: boolean;
    }
  | null;

// A keycap set can be bought more than once, with a different kit mix, price,
// date, condition, photo, and keyboard pairing each time. The price is the
// total paid for this purchase, never a per-kit multiplication.
export interface KeycapAcquisition {
  id: string;
  kits: KeycapKitSelection[];
  quantity: number;
  acquiredAt: Date | string | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  condition: KeycapCondition | null;
  imageUrl: string | null;
  photoSource: "CATALOG" | "CUSTOM";
  notes: string | null;
  isPublic: boolean;
  pairing: KeycapPairing;
  // Sale record, per PURCHASE — a set bought twice can have one lot sold and
  // the other kept. Same shape and reasoning as CollectionUnit's.
  isSold?: boolean;
  soldAt?: Date | string | null;
  soldPrice?: number | null;
  soldCurrency?: string | null;
  // Visibility is PER PURCHASE for keycaps: a set bought twice can have one
  // lot's figures published and the other's kept private. Keyboards keep one
  // record-wide switch instead (see CollectionItemDetails), because a build is
  // a unit of the same purchase decision rather than a separate transaction.
  //
  // Undefined means "never set" — normalizeKeycapAcquisitions falls back to the
  // record-wide value so existing sets keep the visibility they already had.
  showPurchasePrice?: boolean;
  showSoldStatus?: boolean;
}

export interface CollectionItemDetails {
  isTracking: boolean;
  inCollection: boolean;
  isPublic: boolean;
  acquiredAt: Date | string | null;
  condition: string | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  showPurchasePrice: boolean;
  // Build 1's sale record (builds 2..N carry theirs in `units`).
  isSold?: boolean;
  soldAt?: Date | string | null;
  soldPrice?: number | null;
  soldCurrency?: string | null;
  // Piece-level. Off by default: with it off a visitor cannot tell the piece
  // was sold. The sale AMOUNT additionally requires showPurchasePrice, so
  // enabling this can never leak a figure kept private.
  showSoldStatus?: boolean;
  switches: string | null;
  keycaps: string | null;
  plateType: string | null;
  mountType: string | null;
  buildDetails: string | null;
  notes: string | null;
  displayOrder: number;
  color: string | null;
  quantity: number;
  // Owner's own photo for build 1 (overrides the catalog image).
  customImageUrl: string | null;
  // Extra builds (2..N) when quantity > 1.
  units: CollectionUnit[] | null;
  // 0-based build indexes excluded from the public collection page.
  hiddenBuilds?: number[] | null;
  // Per-purchase keycap records. Keyboard entries leave this empty.
  keycapAcquisitions?: KeycapAcquisition[] | null;
}

export interface CollectionCatalogItem extends GroupBuyWithPricing {
  collection: CollectionItemDetails;
}

export interface CollectionProfile {
  email: string;
  alertsEnabled: boolean;
  displayName: string | null;
  collectionTitle: string | null;
  collectionBio: string | null;
  collectionPublished: boolean;
  collectionSlug: string | null;
}

// A single computed vendor price for the user's region/currency.
export interface ComputedVendorPrice {
  vendorName: string;
  totalLocal: number;
  priceUpdatedAt: Date | string | null;
  gbUrl: string | null;
}

export interface BrowseFilters {
  statuses: GBStatus[];
  search: string;
  sortBy: "date-desc" | "date-asc" | "name" | "price-asc" | "price-desc";
  regionFilter: Region | "ALL";
}

export interface ExchangeRates {
  [code: string]: number;
}

export interface PriceResult {
  kitPriceUSD: number;
  shippingUSD: number | null;
  totalUSD: number;
  kitPriceLocal: number;
  shippingLocal: number | null;
  totalLocal: number;
  shipsToRegion: boolean;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}
