import assert from "node:assert/strict";
import { calculateCollectionSales, unitMoneyLine } from "@/lib/collection-sales";
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
  plateType: null,
  mountType: null,
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
          plateType: null,
          mountType: null,
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



// ── unitMoneyLine: the owner's own private figures ──────────────────────────
// Formatter stub — the real one is formatCurrency; these tests are about which
// numbers and currencies come out, not their typography.
const fmt = (amount: number, currency: string) =>
  `${currency} ${Math.round(amount * 100) / 100}`;

// Paid only, never sold.
const held = unitMoneyLine(
  { purchasePrice: 8588, purchaseCurrency: "CNY", isSold: false, soldPrice: null, soldCurrency: null },
  "USD",
  RATES,
  fmt
);
assert.equal(held.paid, "CNY 8588", "shown in the currency actually paid");
assert.equal(held.sold, null);
assert.equal(held.gain, null, "a unit you still own has no gain");

// Sold at a profit, one currency throughout.
const profit = unitMoneyLine(
  { purchasePrice: 100, purchaseCurrency: "USD", isSold: true, soldPrice: 150, soldCurrency: "USD" },
  "USD",
  RATES,
  fmt
);
assert.equal(profit.paid, "USD 100");
assert.equal(profit.sold, "USD 150");
assert.equal(profit.gain?.text, "+USD 50");
assert.equal(profit.gain?.positive, true);

// A loss must read as a loss, not an absolute value.
const lineLoss = unitMoneyLine(
  { purchasePrice: 300, purchaseCurrency: "USD", isSold: true, soldPrice: 200, soldCurrency: "USD" },
  "USD",
  RATES,
  fmt
);
assert.equal(lineLoss.gain?.text, "−USD 100");
assert.equal(lineLoss.gain?.positive, false);

// Bought CNY, sold SGD, viewed in USD. Subtracting the raw numbers would be
// meaningless — the gain has to be computed in the viewer's currency.
const crossFx = unitMoneyLine(
  { purchasePrice: 130, purchaseCurrency: "SGD", isSold: true, soldPrice: 150, soldCurrency: "USD" },
  "USD",
  RATES,
  fmt
);
assert.equal(crossFx.paid, "SGD 130", "the paid figure keeps its own currency");
assert.equal(crossFx.sold, "USD 150");
assert.equal(crossFx.gain?.text, "+USD 50", "SGD 130 is USD 100, so the gain is USD 50");

// Sold with no sale price recorded: no sold figure, and no invented gain.
const soldUnpriced = unitMoneyLine(
  { purchasePrice: 100, purchaseCurrency: "USD", isSold: true, soldPrice: null, soldCurrency: null },
  "USD",
  RATES,
  fmt
);
assert.equal(soldUnpriced.paid, "USD 100");
assert.equal(soldUnpriced.sold, null);
assert.equal(soldUnpriced.gain, null);

// No purchase price: the sale still shows, but there is nothing to compare to.
const lineNoCost = unitMoneyLine(
  { purchasePrice: null, purchaseCurrency: null, isSold: true, soldPrice: 200, soldCurrency: "USD" },
  "USD",
  RATES,
  fmt
);
assert.equal(lineNoCost.paid, null);
assert.equal(lineNoCost.sold, "USD 200");
assert.equal(lineNoCost.gain, null, "no cost means no verdict");

// An unconvertible currency omits the gain rather than guessing one.
const lineNoRate = unitMoneyLine(
  { purchasePrice: 100, purchaseCurrency: "ZZZ", isSold: true, soldPrice: 150, soldCurrency: "USD" },
  "USD",
  RATES,
  fmt
);
assert.equal(lineNoRate.paid, "ZZZ 100", "still shown — it is the owner's own record");
assert.equal(lineNoRate.gain, null, "a wrong profit figure is worse than none");

// Break-even across currencies must not render as a rounding artefact.
const breakEven = unitMoneyLine(
  { purchasePrice: 130, purchaseCurrency: "SGD", isSold: true, soldPrice: 100, soldCurrency: "USD" },
  "USD",
  RATES,
  fmt
);
assert.equal(breakEven.gain?.text, "+USD 0");

// ── The reported case: US$124 in, S$185 out, viewed in SGD ─────────────────
// formatCurrency pins en-SG, where the LOCAL currency gets the bare symbol and
// every other one gets a prefix. With one formatter the line read
//   "Paid US$124 · Sold $185 · +$18"
// and looked like broken arithmetic: three dollar amounts that do not subtract.
// They are three different currencies — S$185 − S$167 (US$124 converted) = S$18
// — so as soon as a line mixes bases every amount on it must name its currency.
const sgd = (amount: number, currency: string) =>
  currency === "SGD"
    ? `$${Math.round(amount)}`
    : `${currency === "USD" ? "US$" : currency}${Math.round(amount)}`;
const withCode = (amount: number, currency: string) =>
  `${currency} ${Math.round(amount)}`;

const reported = unitMoneyLine(
  { purchasePrice: 124, purchaseCurrency: "USD", isSold: true, soldPrice: 185, soldCurrency: "SGD" },
  "SGD",
  { USD: 1, SGD: 1.35 },
  sgd,
  withCode
);
assert.equal(reported.paid, "USD 124", "the paid figure names its own currency");
assert.equal(reported.sold, "SGD 185", "a bare $ here would read as USD");
assert.equal(reported.gain?.text, "+SGD 18", "the gain is in the viewer's currency");
assert.equal(reported.gain?.positive, true);

// The arithmetic was never wrong — pin it so a future reader does not re-fix it.
assert.equal(Math.round(185 - 124 * 1.35), 18);

// A line in ONE currency keeps the compact symbol: nothing is ambiguous there.
const single = unitMoneyLine(
  { purchasePrice: 200, purchaseCurrency: "SGD", isSold: true, soldPrice: 250, soldCurrency: "SGD" },
  "SGD",
  { USD: 1, SGD: 1.35 },
  sgd,
  withCode
);
assert.deepEqual(
  [single.paid, single.sold, single.gain?.text],
  ["$200", "$250", "+$50"],
  "one currency throughout stays on the symbol"
);

// Paid and sold agree but the VIEWER's currency differs, so the gain is a third
// basis — still mixed, even though only two amounts carry a foreign code.
const viewerDiffers = unitMoneyLine(
  { purchasePrice: 100, purchaseCurrency: "USD", isSold: true, soldPrice: 150, soldCurrency: "USD" },
  "SGD",
  { USD: 1, SGD: 1.35 },
  sgd,
  withCode
);
assert.deepEqual(
  [viewerDiffers.paid, viewerDiffers.sold, viewerDiffers.gain?.text],
  ["USD 100", "USD 150", "+SGD 68"],
  "a gain in a currency neither figure names must say so"
);

// An unsold unit shows one amount and no gain — one currency, so no codes.
const heldOnly = unitMoneyLine(
  { purchasePrice: 99, purchaseCurrency: "USD", isSold: false, soldPrice: null, soldCurrency: null },
  "USD",
  { USD: 1, SGD: 1.35 },
  sgd,
  withCode
);
assert.equal(heldOnly.paid, "US$99");
assert.equal(heldOnly.gain, null);

// The formatter is optional: callers passing one still get a working line.
const legacy = unitMoneyLine(
  { purchasePrice: 124, purchaseCurrency: "USD", isSold: true, soldPrice: 185, soldCurrency: "SGD" },
  "SGD",
  { USD: 1, SGD: 1.35 },
  withCode
);
assert.equal(legacy.paid, "USD 124", "one formatter falls back to itself");

console.log("collection sales P/L checks passed");
