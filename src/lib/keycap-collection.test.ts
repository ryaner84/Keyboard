import assert from "node:assert/strict";
import {
  createKeycapAcquisition,
  keycapKitLabel,
  normalizeKeycapAcquisitions,
} from "@/lib/keycap-collection";
import type { CollectionItemDetails } from "@/types";

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

console.log("keycap collection normalization checks passed");
