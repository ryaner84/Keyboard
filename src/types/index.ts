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
