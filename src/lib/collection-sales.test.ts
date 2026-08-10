import assert from "node:assert/strict";
import { calculateCollectionSales } from "@/lib/collection-sales";
import type { CollectionCatalogItem, CollectionItemDetails } from "@/types";

// Rates are "units of X per 1 USD", matching convertCurrency's contract.
const RATES: Record<string, number> = { USD: 1, SGD: 1.3, EUR: 0.9 };

const BASE_COLLECTION: CollectionItemDetails = {
  isTracking: false,
  inCollection: true,
  isPublic: false,
  acquiredAt: null,
  condition: null,
  purchasePrice: null,
  purchaseCurrency: null,
  showPurchasePrice: false,
  switches: null,
  keycaps: null,
  buildDetails: null,
  notes: null,
  displayOrder: 0,
  color: null,
  quantity: 1,
  customImageUrl: null,
  units: null,
  hiddenBuilds: null,
  keycapAcquisitions: null,
};

function keyboard(
  slug: string,
  collection: Partial<CollectionItemDetails>
): CollectionCatalogItem {
  return {
    slug,
    name: slug,
    productType: "KEYBOARD",
    imageUrl: null,
    kits: [],
    collection: { ...BASE_COLLECTION, ...collection },
  } as unknown as CollectionCatalogItem;
}

// ── Only sold units count ───────────────────────────────────────────────────
const nothingSold = calculateCollectionSales(
  [keyboard("kept", { purchasePrice: 300, purchaseCurrency: "USD" })],
  "USD",
  RATES
);
assert.equal(nothingSold.soldUnits, 0);
assert.equal(nothingSold.recovered, 0);
assert.equal(nothingSold.net, 0);
assert.equal(nothingSold.results.length, 0);

// ── A simple gain ───────────────────────────────────────────────────────────
const gain = calculateCollectionSales(
  [
    keyboard("flipped", {
      purchasePrice: 300,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 420,
      soldCurrency: "USD",
      soldAt: "2026-05-10",
    }),
  ],
  "USD",
  RATES
);
assert.equal(gain.soldUnits, 1);
assert.equal(gain.recovered, 420);
assert.equal(gain.costOfSold, 300);
assert.equal(gain.net, 120);
assert.equal(gain.returnPercent, 40);
assert.equal(gain.results[0].net, 120);

// ── A loss reports as a loss, not an absolute value ─────────────────────────
const loss = calculateCollectionSales(
  [
    keyboard("underwater", {
      purchasePrice: 500,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 400,
      soldCurrency: "USD",
    }),
  ],
  "USD",
  RATES
);
assert.equal(loss.net, -100);
assert.equal(loss.returnPercent, -20);

// ── Cost comes from the SOLD unit, not the whole record ─────────────────────
// Two builds, only the second sold. Crediting the sale against both builds'
// spend would invent a loss out of a break-even sale.
const twoBuilds = calculateCollectionSales(
  [
    keyboard("pair", {
      quantity: 2,
      purchasePrice: 300,
      purchaseCurrency: "USD",
      units: [
        {
          acquiredAt: null,
          purchasePrice: 250,
          purchaseCurrency: "USD",
          color: null,
          condition: null,
          switches: null,
          keycaps: null,
          buildDetails: null,
          notes: null,
          imageUrl: null,
          isSold: true,
          soldPrice: 250,
          soldCurrency: "USD",
          soldAt: null,
        },
      ],
    }),
  ],
  "USD",
  RATES
);
assert.equal(twoBuilds.soldUnits, 1, "the kept build must not count as sold");
assert.equal(twoBuilds.costOfSold, 250, "only the sold build's cost");
assert.equal(twoBuilds.net, 0, "a break-even sale is break-even");

// ── Cross-currency: bought USD, sold SGD, viewed in USD ─────────────────────
const crossCurrency = calculateCollectionSales(
  [
    keyboard("crossfx", {
      purchasePrice: 100,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 130,
      soldCurrency: "SGD",
    }),
  ],
  "USD",
  RATES
);
assert.equal(crossCurrency.recovered, 100, "SGD 130 at 1.3/USD is USD 100");
assert.equal(crossCurrency.net, 0);

// ── A sale with no purchase price still counts as money back ────────────────
const noCost = calculateCollectionSales(
  [
    keyboard("giftedboard", {
      purchasePrice: null,
      isSold: true,
      soldPrice: 200,
      soldCurrency: "USD",
    }),
  ],
  "USD",
  RATES
);
assert.equal(noCost.recovered, 200);
assert.equal(noCost.costOfSold, 0);
assert.equal(noCost.missingCost, 1);
assert.equal(noCost.results[0].net, null, "no cost means no verdict, not a gain");
assert.equal(noCost.results[0].returnPercent, null);

// ── Sold but no sale price: flagged, never silently counted as zero ─────────
const noPrice = calculateCollectionSales(
  [keyboard("unpriced", { purchasePrice: 100, isSold: true })],
  "USD",
  RATES
);
assert.equal(noPrice.soldUnits, 1);
assert.equal(noPrice.missingSalePrice, 1);
assert.equal(noPrice.recovered, 0);
assert.equal(
  noPrice.costOfSold,
  0,
  "an unpriced sale must not drag the cost side down on its own"
);

// ── An unconvertible currency is reported, not guessed ──────────────────────
const noRate = calculateCollectionSales(
  [
    keyboard("exotic", {
      purchasePrice: 100,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 5000,
      soldCurrency: "ZZZ",
    }),
  ],
  "USD",
  RATES
);
assert.equal(noRate.unconvertedCount, 1);
assert.equal(noRate.recovered, 0);

// ── Ranking: best first, losses after, no-verdict last ──────────────────────
const ranked = calculateCollectionSales(
  [
    keyboard("small-gain", {
      purchasePrice: 100,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 120,
      soldCurrency: "USD",
    }),
    keyboard("big-gain", {
      purchasePrice: 100,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 400,
      soldCurrency: "USD",
    }),
    keyboard("no-cost", {
      isSold: true,
      soldPrice: 999,
      soldCurrency: "USD",
    }),
    keyboard("a-loss", {
      purchasePrice: 300,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 100,
      soldCurrency: "USD",
    }),
  ],
  "USD",
  RATES
);
assert.deepEqual(
  ranked.results.map((result) => result.slug),
  ["big-gain", "small-gain", "a-loss", "no-cost"]
);
assert.equal(ranked.net, 20 + 300 - 200);

// ── The monthly trend keys off the SALE date, not the purchase date ─────────
const now = new Date();
const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const charted = calculateCollectionSales(
  [
    keyboard("charted", {
      acquiredAt: "2020-01-01",
      purchasePrice: 100,
      purchaseCurrency: "USD",
      isSold: true,
      soldPrice: 150,
      soldCurrency: "USD",
      soldAt: now.toISOString(),
    }),
  ],
  "USD",
  RATES
);
const month = charted.months.find((entry) => entry.key === thisMonth);
assert.ok(month, "the current month is always in the 12-month window");
assert.equal(month.net, 50);
assert.equal(month.sales, 1);
// The 2020 purchase date must not have put anything in a 2020 bucket.
assert.equal(charted.months.filter((entry) => entry.sales > 0).length, 1);

console.log("collection sales P/L checks passed");
