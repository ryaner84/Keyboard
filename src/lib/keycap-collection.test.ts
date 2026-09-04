import assert from "node:assert/strict";
import {
  createKeycapAcquisition,
  keycapKitLabel,
  normalizeKeycapAcquisitions,
} from "@/lib/keycap-collection";
import type { CollectionItemDetails, KeycapAcquisition } from "@/types";

const baseDetails: CollectionItemDetails = {
  isTracking: true,
  inCollection: true,
  isPublic: false,
  acquiredAt: "2026-06-01T00:00:00.000Z",
  condition: null,
  purchasePrice: 180,
  purchaseCurrency: "USD",
  showPurchasePrice: false,
  switches: null,
  keycaps: null,
  plateType: null,
  mountType: null,
  buildDetails: null,
  notes: "Legacy purchase",
  displayOrder: 0,
  color: null,
  quantity: 2,
  customImageUrl: null,
  units: null,
  hiddenBuilds: null,
  keycapAcquisitions: null,
};

// A purchase as it would have been stored before per-purchase visibility
// existed: no showPurchasePrice / showSoldStatus keys at all.
function createKeycapAcquisitionWithoutFlags(): KeycapAcquisition {
  const purchase = createKeycapAcquisition("SGD") as unknown as Record<string, unknown>;
  delete purchase.showPurchasePrice;
  delete purchase.showSoldStatus;
  return purchase as unknown as KeycapAcquisition;
}

const legacy = normalizeKeycapAcquisitions(baseDetails, "SGD");
assert.equal(legacy.length, 1);
assert.equal(legacy[0].quantity, 2);
assert.equal(legacy[0].purchasePrice, 180);
assert.equal(legacy[0].purchaseCurrency, "USD");
assert.equal(legacy[0].notes, "Legacy purchase");

const purchase = createKeycapAcquisition("SGD");
purchase.kits = [
  { kitId: "base", name: "Base", type: "Base kit" },
  { kitId: null, name: "Novelties", type: "Custom kit" },
];
purchase.photoSource = "CUSTOM";
purchase.imageUrl = "data:image/jpeg;base64,/9j/2Q==";
purchase.pairing = {
  kind: "collection",
  keyboardSlug: "tgr-jane-v2-me",
  buildIndex: 1,
  showPublic: true,
};
const normalized = normalizeKeycapAcquisitions(
  { ...baseDetails, keycapAcquisitions: [purchase] },
  "SGD"
);
assert.equal(normalized.length, 1);
assert.equal(keycapKitLabel(normalized[0]), "Base · Novelties");
assert.equal(normalized[0].photoSource, "CUSTOM");
assert.deepEqual(normalized[0].pairing, purchase.pairing);

// ── Sale record ─────────────────────────────────────────────────────────────
// Sold is per PURCHASE: a set bought twice can have one lot flipped and the
// other kept.
const fresh = createKeycapAcquisition("SGD");
assert.equal(fresh.isSold, false);
assert.equal(fresh.soldAt, null);
assert.equal(fresh.soldPrice, null);
assert.equal(fresh.soldCurrency, null);

const soldPurchase = createKeycapAcquisition("SGD");
soldPurchase.isSold = true;
soldPurchase.soldAt = "2026-03-14";
soldPurchase.soldPrice = 210;
// Sold in a different currency from the one it was bought in — routine, and
// the reason soldCurrency exists separately from purchaseCurrency.
soldPurchase.soldCurrency = "USD";
const [roundTripped] = normalizeKeycapAcquisitions(
  { ...baseDetails, keycapAcquisitions: [soldPurchase] },
  "SGD"
);
assert.equal(roundTripped.isSold, true);
assert.equal(roundTripped.soldAt, "2026-03-14");
assert.equal(roundTripped.soldPrice, 210);
assert.equal(roundTripped.soldCurrency, "USD");
assert.equal(roundTripped.purchaseCurrency, "SGD");

// One lot sold, one kept — the whole set must not read as sold.
const mixed = normalizeKeycapAcquisitions(
  { ...baseDetails, keycapAcquisitions: [soldPurchase, createKeycapAcquisition("SGD")] },
  "SGD"
);
assert.equal(mixed.filter((purchase) => purchase.isSold).length, 1);

// Garbage coerces rather than throwing — this runs while rendering the
// collection, so a malformed stored value must not blank the page.
const [coerced] = normalizeKeycapAcquisitions(
  {
    ...baseDetails,
    // Cast deliberately: the point is what happens when the STORED json does
    // not match the type, which is exactly what the type system cannot promise.
    keycapAcquisitions: [
      {
        ...createKeycapAcquisition("SGD"),
        isSold: "yes",
        soldPrice: "abc",
        soldCurrency: 42,
      } as unknown as KeycapAcquisition,
    ],
  },
  "SGD"
);
assert.equal(coerced.isSold, false, "only a real boolean true marks a purchase sold");
assert.equal(coerced.soldPrice, null);
assert.equal(coerced.soldCurrency, "42");

// A sale recorded against the legacy top-level columns must survive into the
// synthesised purchase, or it would vanish on the collector's next edit.
const legacySold = normalizeKeycapAcquisitions(
  {
    ...baseDetails,
    isSold: true,
    soldAt: "2026-01-05",
    soldPrice: 95,
    soldCurrency: "EUR",
  },
  "SGD"
);
assert.equal(legacySold.length, 1);
assert.equal(legacySold[0].isSold, true);
assert.equal(legacySold[0].soldPrice, 95);
assert.equal(legacySold[0].soldCurrency, "EUR");

// ── Per-purchase visibility ─────────────────────────────────────────────────
// Price and sold visibility belong to the PURCHASE for keycaps: a set bought
// twice can have one lot's figures published and the other's kept private.

// A purchase that has never had its own flags set inherits the record-wide
// value. Without this, every existing keycap set would silently flip to
// "prices private" the first time it was read after this shipped.
const inheritedOn = normalizeKeycapAcquisitions(
  {
    ...baseDetails,
    showPurchasePrice: true,
    showSoldStatus: true,
    keycapAcquisitions: [createKeycapAcquisitionWithoutFlags()],
  },
  "SGD"
);
assert.equal(inheritedOn[0].showPurchasePrice, true);
assert.equal(inheritedOn[0].showSoldStatus, true);

const inheritedOff = normalizeKeycapAcquisitions(
  {
    ...baseDetails,
    showPurchasePrice: false,
    keycapAcquisitions: [createKeycapAcquisitionWithoutFlags()],
  },
  "SGD"
);
assert.equal(inheritedOff[0].showPurchasePrice, false);

// An explicit per-purchase value always wins over the inherited one — that is
// the whole point of the setting being per purchase.
const explicitOff = createKeycapAcquisition("SGD");
explicitOff.showPurchasePrice = false;
const overridden = normalizeKeycapAcquisitions(
  { ...baseDetails, showPurchasePrice: true, keycapAcquisitions: [explicitOff] },
  "SGD"
);
assert.equal(overridden[0].showPurchasePrice, false, "explicit false beats inherited true");

// Two purchases of one set, published differently.
const shown = createKeycapAcquisition("SGD");
shown.showPurchasePrice = true;
const hidden = createKeycapAcquisition("SGD");
hidden.showPurchasePrice = false;
const mixedVisibility = normalizeKeycapAcquisitions(
  { ...baseDetails, keycapAcquisitions: [shown, hidden] },
  "SGD"
);
assert.equal(mixedVisibility[0].showPurchasePrice, true);
assert.equal(mixedVisibility[1].showPurchasePrice, false);

// The legacy single-purchase fallback inherits too.
const legacyVisible = normalizeKeycapAcquisitions(
  { ...baseDetails, showPurchasePrice: true, keycapAcquisitions: null },
  "SGD"
);
assert.equal(legacyVisible[0].showPurchasePrice, true);

console.log("keycap collection normalization checks passed");
