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
  currency: string | null;
  inStock: boolean;
  gbUrl: string | null;
  productUrl: string | null;
  priceUpdatedAt: Date | string | null;
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

export interface CollectionItemDetails {
  isTracking: boolean;
  inCollection: boolean;
  isPublic: boolean;
  acquiredAt: Date | string | null;
  condition: string | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  showPurchasePrice: boolean;
  switches: string | null;
  keycaps: string | null;
  buildDetails: string | null;
  notes: string | null;
  displayOrder: number;
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
