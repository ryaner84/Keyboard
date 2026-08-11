import { randomUUID } from "node:crypto";
import { cleanCollectionPhoto } from "@/lib/collection-photo";
import type { KeycapAcquisition, KeycapKitSelection, KeycapPairing } from "@/types";

// Strict server-side validators for a keycap purchase record. Extracted from
// src/app/api/tracker/items/[slug]/route.ts so the item PATCH route and the CSV
// batch importer validate identically — there must be exactly one definition of
// what a stored acquisition may contain. Behaviour (including the thrown
// messages) is unchanged from the original inline implementation.
//
// These THROW on invalid input rather than coercing, so callers that process
// many records (the importer) must wrap each record to report per-row failures.

export const KEYCAP_CONDITIONS = new Set([
  "SEALED",
  "OPEN_UNUSED",
  "MOUNTED",
  "USED",
  "INCOMPLETE",
]);

export function cleanOptionalText(value: unknown, maxLength: number): string | null {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || null;
}

export function cleanUnitPrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 10_000_000) {
    throw new Error("Invalid purchase price for one of the builds");
  }
  return price;
}

export function cleanUnitCurrency(value: unknown): string | null {
  const currency = String(value ?? "").trim().toUpperCase().slice(0, 8);
  return currency || null;
}

// ── Sale record ─────────────────────────────────────────────────────────────
// A sold unit's date/price/currency. Separate from the purchase validators
// above only so the thrown message names the right field — telling someone
// their "purchase price" is invalid when they typed a sale figure sends them
// looking in the wrong place.

export function cleanSalePrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 10_000_000) {
    throw new Error("Invalid sale price for one of the builds");
  }
  return price;
}

export function cleanSaleDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid sale date for one of the builds");
  }
  return date.toISOString();
}

// The four sale fields, sanitized. Shared by the per-build (`units`) and
// per-purchase (`keycapAcquisitions`) paths so the two can never disagree
// about what a stored sale record may contain.
export function cleanSaleFields(source: unknown): {
  isSold: boolean;
  soldAt: string | null;
  soldPrice: number | null;
  soldCurrency: string | null;
} {
  const o = (source ?? {}) as Record<string, unknown>;
  return {
    isSold: o.isSold === true,
    soldAt: cleanSaleDate(o.soldAt),
    soldPrice: cleanSalePrice(o.soldPrice),
    soldCurrency: cleanUnitCurrency(o.soldCurrency),
  };
}

export function cleanIdentifier(value: unknown): string | null {
  const id = String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  return id || null;
}

export function cleanKeycapDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid acquisition date for one of the keycap purchases");
  }
  return date.toISOString();
}

export function cleanKeycapCondition(value: unknown): KeycapAcquisition["condition"] {
  const condition = String(value ?? "").trim().toUpperCase();
  if (!condition) return null;
  if (!KEYCAP_CONDITIONS.has(condition)) {
    throw new Error("Invalid keycap condition");
  }
  return condition as KeycapAcquisition["condition"];
}

export function cleanKeycapKits(
  value: unknown,
  knownKits: Map<string, { name: string; type: string }>
): KeycapKitSelection[] {
  const raw = Array.isArray(value) ? value.slice(0, 12) : [];
  const seen = new Set<string>();
  const kits = raw
    .map((kit) => {
      const source = (kit ?? {}) as Record<string, unknown>;
      const requestedId = cleanIdentifier(source.kitId);
      if (requestedId) {
        const catalogKit = knownKits.get(requestedId);
        if (!catalogKit) throw new Error("A selected kit no longer belongs to this keycap set");
        if (seen.has(`catalog:${requestedId}`)) return null;
        seen.add(`catalog:${requestedId}`);
        return { kitId: requestedId, name: catalogKit.name, type: catalogKit.type || "" };
      }
      const name = cleanOptionalText(source.name, 80);
      if (!name) return null;
      const key = `custom:${name.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        kitId: null,
        name,
        type: cleanOptionalText(source.type, 50) || "",
      };
    })
    .filter((kit): kit is KeycapKitSelection => Boolean(kit));

  return kits.length > 0
    ? kits
    : [{ kitId: null, name: "Set / kits not specified", type: "" }];
}

export function cleanKeycapPairing(value: unknown): KeycapPairing {
  if (value == null) return null;
  const source = value as Record<string, unknown>;
  if (source.kind === "collection") {
    const keyboardSlug = String(source.keyboardSlug ?? "").trim().slice(0, 160);
    const buildIndex = Number(source.buildIndex);
    if (!keyboardSlug || !Number.isInteger(buildIndex) || buildIndex < 0 || buildIndex > 98) {
      throw new Error("Choose a valid keyboard build to pair with this keycap purchase");
    }
    return {
      kind: "collection",
      keyboardSlug,
      buildIndex,
      showPublic: source.showPublic === true,
    };
  }
  if (source.kind === "free_text") {
    const label = cleanOptionalText(source.label, 120);
    if (!label) throw new Error("Enter the keyboard name for the free-text pairing");
    return { kind: "free_text", label, showPublic: source.showPublic === true };
  }
  throw new Error("Invalid keyboard pairing");
}

export function cleanKeycapAcquisition(
  value: unknown,
  knownKits: Map<string, { name: string; type: string }>
): KeycapAcquisition {
  const source = (value ?? {}) as Record<string, unknown>;
  const id = cleanIdentifier(source.id) || randomUUID();
  const kits = cleanKeycapKits(source.kits, knownKits);
  const quantity = Math.max(1, Math.min(99, Math.floor(Number(source.quantity) || 1)));
  const acquiredAt = cleanKeycapDate(source.acquiredAt);
  const purchasePrice = cleanUnitPrice(source.purchasePrice);
  const purchaseCurrency = cleanUnitCurrency(source.purchaseCurrency);
  const condition = cleanKeycapCondition(source.condition);
  const imageUrl = cleanCollectionPhoto(source.imageUrl);
  if (source.imageUrl && !imageUrl) {
    throw new Error("Invalid keycap photo");
  }
  const photoSource = source.photoSource === "CUSTOM" && imageUrl ? "CUSTOM" : "CATALOG";
  return {
    id,
    kits,
    quantity,
    acquiredAt,
    purchasePrice,
    purchaseCurrency,
    condition,
    imageUrl,
    photoSource,
    notes: cleanOptionalText(source.notes, 1000),
    isPublic: source.isPublic !== false,
    pairing: cleanKeycapPairing(source.pairing),
    ...cleanSaleFields(source),
    // Per-purchase visibility. Absent means "never set" and is preserved as
    // absent, so normalizeKeycapAcquisitions can still inherit the record-wide
    // value for a set saved before these existed.
    ...(typeof source.showPurchasePrice === "boolean"
      ? { showPurchasePrice: source.showPurchasePrice }
      : {}),
    ...(typeof source.showSoldStatus === "boolean"
      ? { showSoldStatus: source.showSoldStatus }
      : {}),
  };
}
