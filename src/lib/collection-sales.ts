// Collection money maths that is worth testing on its own.
//
// Extracted from src/app/collection/CollectionContent.tsx (a "use client"
// component, so nothing in it could be exercised by the ts-node suites) for the
// same reason the keycap sanitizers were: a figure an owner reads as their
// profit should not be verified only by looking at the screen.
//
// calculateCollectionSpending deliberately stays in the component — it is not
// changed by this work, and moving it would put an untested refactor in the
// path of the existing Total spent.
import { convertCurrency } from "@/lib/currency-utils";
import { normalizeImageUrl } from "@/lib/utils";
import {
  keycapPurchasePhoto,
  normalizeKeycapAcquisitions,
} from "@/lib/keycap-collection";
import type {
  CollectionCatalogItem,
  CollectionItemDetails,
  CollectionUnit,
  KeycapAcquisition,
} from "@/types";

export const EMPTY_UNIT: CollectionUnit = {
  acquiredAt: null,
  purchasePrice: null,
  purchaseCurrency: null,
  color: null,
  condition: null,
  switches: null,
  keycaps: null,
  buildDetails: null,
  notes: null,
  imageUrl: null,
  isSold: false,
  soldAt: null,
  soldPrice: null,
  soldCurrency: null,
};

// Expand a collection record into per-build rows. Build 1 lives on the record's
// top-level fields; builds 2..N come from the `units` array. Always returns
// exactly `quantity` builds, padding with blanks if details are missing.
export function assembleBuilds(c: CollectionItemDetails): CollectionUnit[] {
  const qty = Math.max(1, c.quantity || 1);
  const first: CollectionUnit = {
    acquiredAt: c.acquiredAt,
    purchasePrice: c.purchasePrice,
    purchaseCurrency: c.purchaseCurrency,
    color: c.color,
    condition: c.condition,
    switches: c.switches,
    keycaps: c.keycaps,
    buildDetails: c.buildDetails,
    notes: c.notes,
    imageUrl: c.customImageUrl,
    isSold: c.isSold === true,
    soldAt: c.soldAt ?? null,
    soldPrice: c.soldPrice ?? null,
    soldCurrency: c.soldCurrency ?? null,
  };
  const extra = Array.isArray(c.units)
    ? c.units.map((unit) => ({
        ...unit,
        // Records saved before per-build pricing used one shared purchase
        // record. Carry it into legacy extra builds until the owner edits them.
        acquiredAt:
          unit.acquiredAt === undefined ? c.acquiredAt : unit.acquiredAt,
        purchasePrice:
          unit.purchasePrice === undefined
            ? c.purchasePrice
            : unit.purchasePrice,
        purchaseCurrency:
          unit.purchaseCurrency === undefined
            ? c.purchaseCurrency
            : unit.purchaseCurrency,
      }))
    : [];
  const builds = [first, ...extra].slice(0, qty);
  while (builds.length < qty) builds.push({ ...EMPTY_UNIT });
  return builds;
}

// ── Realised profit and loss ────────────────────────────────────────────────
// Computed SEPARATELY from calculateCollectionSpending, never folded into it.
// "Total spent" is a historical ledger — selling something does not un-spend
// the money — so the sold units still count there, and this answers the
// different question: of the units you actually sold, did you come out ahead?
//
// Only REALISED results. A piece you still own has no gain or loss until it
// sells; guessing at market value would be a different (and much shakier)
// feature.
//
// Each result compares a unit's SALE price with that same unit's PURCHASE
// price. Comparing against the whole record's spend would credit a sold build
// with money spent on builds you kept.

export interface SaleResult {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  isKeycap: boolean;
  unitLabel: string;
  soldAt: string | null;
  // Both converted to the viewer's currency. cost is null when the purchase
  // price was never recorded — such a sale still counts toward Recovered but
  // cannot produce a gain or loss, since there is nothing to compare against.
  cost: number | null;
  recovered: number;
  net: number | null;
  returnPercent: number | null;
  converted: boolean;
}

export interface SalesMonth {
  key: string;
  label: string;
  shortLabel: string;
  net: number;
  recovered: number;
  sales: number;
}

export interface CollectionSales {
  soldUnits: number;
  // Every convertible sale — the honest "money back" figure.
  recovered: number;
  // Purchase cost of the sold units ONLY — not the collection's total spend —
  // and only of those whose purchase price is known.
  costOfSold: number;
  // Sale proceeds of just those same comparable units. Kept separate from
  // `recovered` because `net` must be computed from MATCHED pairs: a sale with
  // no recorded purchase price would otherwise add its full amount to the
  // profit, so a £999 sale of a board with no cost on file would read as £999
  // profit when we in fact have no idea whether it made anything. Caught by
  // test rather than by anyone noticing the number was flattering.
  comparableRecovered: number;
  comparableUnits: number;
  net: number;
  returnPercent: number | null;
  // Sold units we could not fully account for, surfaced so the headline is
  // never quietly wrong.
  missingSalePrice: number;
  missingCost: number;
  unconvertedCount: number;
  months: SalesMonth[];
  results: SaleResult[];
}

export function calculateCollectionSales(
  items: CollectionCatalogItem[],
  targetCurrency: string,
  rates: Record<string, number>
): CollectionSales {
  const now = new Date();
  const months: SalesMonth[] = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - index), 1)
    );
    return {
      key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
      label: date.toLocaleDateString("en-SG", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
      shortLabel: date.toLocaleDateString("en-SG", {
        month: "short",
        timeZone: "UTC",
      }),
      net: 0,
      recovered: 0,
      sales: 0,
    };
  });
  const monthByKey = new Map(months.map((month) => [month.key, month]));

  let soldUnits = 0;
  let recovered = 0;
  let costOfSold = 0;
  let comparableRecovered = 0;
  let comparableUnits = 0;
  let missingSalePrice = 0;
  let missingCost = 0;
  let unconvertedCount = 0;
  const results: SaleResult[] = [];

  const convertible = (from: string) =>
    from === targetCurrency ||
    (Number.isFinite(rates[from]) && Number.isFinite(rates[targetCurrency]));
  const toTarget = (amount: number, from: string) =>
    from === targetCurrency
      ? amount
      : convertCurrency(amount, from, targetCurrency, rates);

  for (const item of items) {
    const isKeycap = item.productType !== "KEYBOARD";
    const units = isKeycap
      ? normalizeKeycapAcquisitions(item.collection, targetCurrency)
      : assembleBuilds(item.collection);

    units.forEach((unit, index) => {
      if (!unit.isSold) return;
      soldUnits++;

      const saleCurrency =
        unit.soldCurrency || unit.purchaseCurrency || targetCurrency;
      if (unit.soldPrice == null) {
        missingSalePrice++;
        return;
      }
      if (!convertible(saleCurrency)) {
        unconvertedCount++;
        return;
      }
      const saleAmount = toTarget(unit.soldPrice, saleCurrency);
      recovered += saleAmount;

      // The cost side is optional: a sale with no recorded purchase price
      // still counts as money back, it just cannot show a gain.
      const costCurrency = unit.purchaseCurrency || targetCurrency;
      let cost: number | null = null;
      if (unit.purchasePrice == null) {
        missingCost++;
      } else if (!convertible(costCurrency)) {
        missingCost++;
      } else {
        cost = toTarget(unit.purchasePrice, costCurrency);
        costOfSold += cost;
        comparableRecovered += saleAmount;
        comparableUnits++;
      }

      const net = cost == null ? null : saleAmount - cost;
      const keycapUnit = unit as KeycapAcquisition;
      const buildUnit = unit as CollectionUnit;
      results.push({
        id: `${item.slug}-${index}`,
        slug: item.slug,
        name: item.name,
        imageUrl: isKeycap
          ? keycapPurchasePhoto(keycapUnit, normalizeImageUrl(item.imageUrl))
          : buildUnit.imageUrl || normalizeImageUrl(item.imageUrl),
        isKeycap,
        unitLabel: isKeycap ? `Purchase ${index + 1}` : `Build ${index + 1}`,
        soldAt: unit.soldAt ? new Date(unit.soldAt).toISOString() : null,
        cost,
        recovered: saleAmount,
        net,
        returnPercent:
          net == null || cost == null || cost <= 0
            ? null
            : Math.round((net / cost) * 1000) / 10,
        converted:
          saleCurrency !== targetCurrency || costCurrency !== targetCurrency,
      });

      if (!unit.soldAt) return;
      const soldAt = new Date(unit.soldAt);
      if (Number.isNaN(soldAt.getTime())) return;
      const key = `${soldAt.getUTCFullYear()}-${String(
        soldAt.getUTCMonth() + 1
      ).padStart(2, "0")}`;
      const month = monthByKey.get(key);
      if (month) {
        month.recovered += saleAmount;
        month.sales++;
        if (net != null) month.net += net;
      }
    });
  }

  // Matched pairs only — see comparableRecovered.
  const net = comparableRecovered - costOfSold;
  // Biggest gain first, then biggest loss — the two ends are what an owner
  // actually wants to see. Results with no cost recorded sort last: they have
  // no verdict to rank.
  results.sort((a, b) => {
    if (a.net == null && b.net == null) return b.recovered - a.recovered;
    if (a.net == null) return 1;
    if (b.net == null) return -1;
    return b.net - a.net;
  });

  return {
    soldUnits,
    recovered,
    costOfSold,
    comparableRecovered,
    comparableUnits,
    net,
    returnPercent: costOfSold > 0 ? Math.round((net / costOfSold) * 1000) / 10 : null,
    missingSalePrice,
    missingCost,
    unconvertedCount,
    months,
    results,
  };
}

// ── The owner's private money line for one unit ─────────────────────────────
// What YOU paid, what you sold it for, and the difference — for the owner's own
// collection view only. Never rendered on the public page, which has its own
// per-purchase visibility gates.
//
// This exists because the two card types disagreed: a keyboard build row showed
// "Acquired 2026 · CNY 8,588" while a keycap purchase row showed only the year,
// so an owner could not see what they paid for their own keycaps. Same helper
// now feeds both.
//
// The gain is computed in the VIEWER's currency, not by subtracting the raw
// numbers: bought in CNY and sold in USD is ordinary, and 1,249 − 8,588 would
// be meaningless. When either side cannot be converted the gain is omitted
// rather than guessed — a wrong profit figure is worse than none.
export interface UnitMoneyLine {
  paid: string | null;
  sold: string | null;
  gain: { text: string; positive: boolean } | null;
}

export function unitMoneyLine(
  unit: Pick<
    CollectionUnit,
    "purchasePrice" | "purchaseCurrency" | "isSold" | "soldPrice" | "soldCurrency"
  >,
  viewerCurrency: string,
  rates: Record<string, number>,
  format: (amount: number, currency: string) => string
): UnitMoneyLine {
  const paidCurrency = unit.purchaseCurrency || viewerCurrency;
  const saleCurrency = unit.soldCurrency || unit.purchaseCurrency || viewerCurrency;

  // Shown in the currency it was actually paid in — that is the number the
  // owner recognises from their own receipt.
  const paid =
    unit.purchasePrice != null ? format(unit.purchasePrice, paidCurrency) : null;
  const sold =
    unit.isSold && unit.soldPrice != null
      ? format(unit.soldPrice, saleCurrency)
      : null;

  let gain: UnitMoneyLine["gain"] = null;
  if (unit.isSold && unit.purchasePrice != null && unit.soldPrice != null) {
    const convertible = (from: string) =>
      from === viewerCurrency ||
      (Number.isFinite(rates[from]) && Number.isFinite(rates[viewerCurrency]));
    if (convertible(paidCurrency) && convertible(saleCurrency)) {
      const toViewer = (amount: number, from: string) =>
        from === viewerCurrency
          ? amount
          : convertCurrency(amount, from, viewerCurrency, rates);
      const delta =
        toViewer(unit.soldPrice, saleCurrency) -
        toViewer(unit.purchasePrice, paidCurrency);
      // Rounded before the zero test so a sub-cent FX residue reads as break
      // even rather than "+$0.00".
      const rounded = Math.round(delta * 100) / 100;
      gain = {
        text: `${rounded >= 0 ? "+" : "−"}${format(Math.abs(rounded), viewerCurrency)}`,
        positive: rounded >= 0,
      };
    }
  }
  return { paid, sold, gain };
}
