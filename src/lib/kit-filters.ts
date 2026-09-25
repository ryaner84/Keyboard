import { classifyVariant, parseVariants } from "./kit-variants";

// Catalog-level kit filters. These describe the kinds of kits a set offers;
// they do not change the base-kit price shown on the released-set cards.
export const KIT_FILTER_OPTIONS = [
  { value: "", label: "Any kit" },
  { value: "base", label: "Base" },
  { value: "novelties", label: "Novelties" },
  { value: "spacebars", label: "Spacebars" },
  { value: "numpad", label: "Numpad" },
  { value: "alpha", label: "Alphas" },
  { value: "iso", label: "International / ISO" },
  { value: "mac", label: "Mac" },
  { value: "other", label: "Other / add-ons" },
] as const;

export type KitFilter = Exclude<(typeof KIT_FILTER_OPTIONS)[number]["value"], "">;

const KIT_FILTER_VALUES = new Set<string>(
  KIT_FILTER_OPTIONS.map((option) => option.value).filter(Boolean)
);

const NUMPAD_RE = /num(?:ber)?\s*(?:pad|kit)|numpad/i;
const ISO_RE = /\b(?:iso|international)\b|norde(?:uk)?|nordic|\buk\s*kit\b/i;
const MAC_RE = /\bmac(?:os)?\b/i;

export function normalizeKitFilter(value: string | null | undefined): KitFilter | "" {
  const normalized = value?.toLowerCase() ?? "";
  return KIT_FILTER_VALUES.has(normalized) ? (normalized as KitFilter) : "";
}

export function kitFilterLabel(value: string): string | null {
  return KIT_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? null;
}

interface FilterableGroupBuy {
  kits: Array<{
    type: string;
    vendorKits: Array<{ variants: unknown }>;
  }>;
}

function nativeKitMatches(type: string, filter: KitFilter): boolean {
  const normalized = type.toUpperCase();
  if (filter === "alpha") return false;
  if (filter === "iso") return normalized === "ISO";
  if (filter === "other") return normalized === "ADDON";
  return normalized === filter.toUpperCase();
}

function variantMatches(title: string, filter: KitFilter): boolean {
  const standardCategory = classifyVariant(title);
  if (filter === "base") return standardCategory === "BASE";
  if (filter === "alpha") return standardCategory === "ALPHA";
  if (filter === "novelties") return standardCategory === "NOVELTIES";
  if (filter === "spacebars") return standardCategory === "SPACEBARS";
  if (filter === "numpad") return NUMPAD_RE.test(title);
  if (filter === "iso") return ISO_RE.test(title);
  if (filter === "mac") return MAC_RE.test(title);

  // "Other" intentionally catches named variants left after the recognizable
  // kit families above. Shopify's placeholder "Default Title" is not a kit.
  return (
    title.trim().length > 0 &&
    !/^default title$/i.test(title.trim()) &&
    standardCategory === "OTHERS" &&
    !NUMPAD_RE.test(title) &&
    !ISO_RE.test(title) &&
    !MAC_RE.test(title)
  );
}

// Imported catalog rows generally have one native BASE Kit. The rest of the
// available kits live in VendorKit.variants, so both sources must be checked.
export function groupBuyHasKit(groupBuy: FilterableGroupBuy, filter: KitFilter): boolean {
  return groupBuy.kits.some(
    (kit) =>
      nativeKitMatches(kit.type, filter) ||
      kit.vendorKits.some((vendorKit) =>
        parseVariants(vendorKit.variants).some((variant) =>
          variantMatches(variant.title, filter)
        )
      )
  );
}
