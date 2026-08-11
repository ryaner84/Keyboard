import type {
  CollectionItemDetails,
  KeycapAcquisition,
  KeycapKitSelection,
  KeycapPairing,
} from "@/types";

export const KEYCAP_CONDITION_LABELS: Record<string, string> = {
  SEALED: "Sealed",
  OPEN_UNUSED: "Opened / unused",
  MOUNTED: "Mounted",
  USED: "Used",
  INCOMPLETE: "Incomplete",
};

function clientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `keycap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createKeycapAcquisition(
  currency = "USD"
): KeycapAcquisition {
  return {
    id: clientId(),
    kits: [{ kitId: null, name: "Set / kits not specified", type: "" }],
    quantity: 1,
    acquiredAt: null,
    purchasePrice: null,
    purchaseCurrency: currency || "USD",
    condition: null,
    imageUrl: null,
    photoSource: "CATALOG",
    notes: null,
    isPublic: true,
    pairing: null,
    isSold: false,
    soldAt: null,
    soldPrice: null,
    soldCurrency: null,
    showPurchasePrice: false,
    showSoldStatus: false,
  };
}

function safeText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || null;
}

function normalizeKits(value: unknown): KeycapKitSelection[] {
  if (!Array.isArray(value)) return [];
  const kits = value
    .slice(0, 12)
    .map((kit) => {
      const data = (kit ?? {}) as Record<string, unknown>;
      const name = safeText(data.name, 80);
      if (!name) return null;
      return {
        kitId: safeText(data.kitId, 120),
        name,
        type: safeText(data.type, 50) || "",
      };
    })
    .filter((kit): kit is KeycapKitSelection => Boolean(kit));
  return kits.length > 0
    ? kits
    : [{ kitId: null, name: "Set / kits not specified", type: "" }];
}

function normalizePairing(value: unknown): KeycapPairing {
  const pairing = (value ?? {}) as Record<string, unknown>;
  if (pairing.kind === "collection") {
    const keyboardSlug = safeText(pairing.keyboardSlug, 160);
    const buildIndex = Number(pairing.buildIndex);
    if (keyboardSlug && Number.isInteger(buildIndex) && buildIndex >= 0) {
      return {
        kind: "collection",
        keyboardSlug,
        buildIndex,
        showPublic: pairing.showPublic === true,
      };
    }
  }
  if (pairing.kind === "free_text") {
    const label = safeText(pairing.label, 120);
    if (label) {
      return { kind: "free_text", label, showPublic: pairing.showPublic === true };
    }
  }
  return null;
}

function normalizeOne(
  value: unknown,
  fallbackCurrency: string,
  // The record-wide values, used only when a purchase has never had its own
  // set. Without this, every existing keycap set would silently flip to
  // "prices private" the first time it was read after this shipped.
  inherited: { showPurchasePrice: boolean; showSoldStatus: boolean } = {
    showPurchasePrice: false,
    showSoldStatus: false,
  }
): KeycapAcquisition | null {
  const data = (value ?? {}) as Record<string, unknown>;
  const id = safeText(data.id, 100) || clientId();
  const quantity = Math.max(1, Math.min(99, Number(data.quantity) || 1));
  const purchasePrice =
    data.purchasePrice === null || data.purchasePrice === ""
      ? null
      : Number.isFinite(Number(data.purchasePrice))
        ? Number(data.purchasePrice)
        : null;
  return {
    id,
    kits: normalizeKits(data.kits),
    quantity,
    acquiredAt: safeText(data.acquiredAt, 80),
    purchasePrice,
    purchaseCurrency:
      safeText(data.purchaseCurrency, 8)?.toUpperCase() || fallbackCurrency || null,
    condition: safeText(data.condition, 30)?.toUpperCase() as KeycapAcquisition["condition"],
    imageUrl: safeText(data.imageUrl, 2_000_000),
    photoSource: data.photoSource === "CUSTOM" ? "CUSTOM" : "CATALOG",
    notes: safeText(data.notes, 1000),
    isPublic: data.isPublic !== false,
    pairing: normalizePairing(data.pairing),
    // Client-side normalisation, so unlike the server sanitizers this coerces
    // rather than throws — a malformed stored value must not break rendering
    // the collection.
    isSold: data.isSold === true,
    soldAt: safeText(data.soldAt, 80),
    soldPrice:
      data.soldPrice === null || data.soldPrice === ""
        ? null
        : Number.isFinite(Number(data.soldPrice))
          ? Number(data.soldPrice)
          : null,
    soldCurrency: safeText(data.soldCurrency, 8)?.toUpperCase() || null,
    showPurchasePrice:
      typeof data.showPurchasePrice === "boolean"
        ? data.showPurchasePrice
        : inherited.showPurchasePrice,
    showSoldStatus:
      typeof data.showSoldStatus === "boolean"
        ? data.showSoldStatus
        : inherited.showSoldStatus,
  };
}

// Older keycap collection records used the keyboard-shaped top-level fields.
// Read them as a single purchase until the collector next saves the item.
export function normalizeKeycapAcquisitions(
  details: CollectionItemDetails,
  fallbackCurrency = "USD"
): KeycapAcquisition[] {
  const inherited = {
    showPurchasePrice: details.showPurchasePrice === true,
    showSoldStatus: details.showSoldStatus === true,
  };
  if (Array.isArray(details.keycapAcquisitions) && details.keycapAcquisitions.length > 0) {
    return details.keycapAcquisitions
      .slice(0, 50)
      .map((item) => normalizeOne(item, fallbackCurrency, inherited))
      .filter((item): item is KeycapAcquisition => Boolean(item));
  }

  const legacy = createKeycapAcquisition(details.purchaseCurrency || fallbackCurrency);
  return [
    {
      ...legacy,
      id: "legacy-keycap-purchase",
      quantity: Math.max(1, details.quantity || 1),
      acquiredAt: details.acquiredAt,
      purchasePrice: details.purchasePrice,
      purchaseCurrency: details.purchaseCurrency || fallbackCurrency || null,
      condition: null,
      imageUrl: details.customImageUrl,
      photoSource: details.customImageUrl ? "CUSTOM" : "CATALOG",
      notes: details.notes,
      isPublic: true,
      // A sale recorded against the legacy top-level columns must ride along,
      // or it would vanish the moment the collector next opened the editor.
      isSold: details.isSold === true,
      soldAt: details.soldAt ?? null,
      soldPrice: details.soldPrice ?? null,
      soldCurrency: details.soldCurrency ?? null,
      ...inherited,
    },
  ];
}

export function keycapPurchasePhoto(
  acquisition: KeycapAcquisition,
  fallback: string | null
) {
  return acquisition.photoSource === "CUSTOM" && acquisition.imageUrl
    ? acquisition.imageUrl
    : fallback;
}

export function keycapKitLabel(acquisition: KeycapAcquisition) {
  return acquisition.kits.map((kit) => kit.name).filter(Boolean).join(" · ");
}
