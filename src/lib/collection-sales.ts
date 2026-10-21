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
  plateType: null,
  mountType: null,
  pcbType: null,
  layoutVariant: null,
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
    plateType: c.plateType,
    mountType: c.mountType,
    pcbType: c.pcbType,
    layoutVariant: c.layoutVariant,
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
  format: (amount: number, currency: string) => string,
  // Used for every amount on the line as soon as the line carries more than
  // one currency. Optional so existing callers and the tests keep working with
  // a single formatter.
  formatWithCode: (amount: number, currency: string) => string = format
): UnitMoneyLine {
  const paidCurrency = unit.purchaseCurrency || viewerCurrency;
  const saleCurrency = unit.soldCurrency || unit.purchaseCurrency || viewerCurrency;

  // Each figure keeps the currency it was actually paid or received in — that
  // is the number the owner recognises from their own receipt — while the gain
  // is computed in the VIEWER's currency, because subtracting across currencies
  // is meaningless. So one line can carry up to three different bases.
  //
  // When it carries more than one, the symbol alone cannot say which is which:
  // en-SG renders SGD as a bare "$" and USD as "US$", so "Paid US$124 · Sold
  // $185 · +$18" reads as three dollar amounts that do not subtract. They do —
  // US$124 is S$167 — but only the ISO code makes that legible. A single
  // currency is unambiguous on its own and keeps the compact symbol.
  const mixed =
    new Set(
      [
        unit.purchasePrice != null ? paidCurrency : null,
        unit.isSold && unit.soldPrice != null ? saleCurrency : null,
        unit.isSold && unit.purchasePrice != null && unit.soldPrice != null
          ? viewerCurrency
          : null,
      ].filter(Boolean) as string[]
    ).size > 1;
  const money = mixed ? formatWithCode : format;

  const paid =
    unit.purchasePrice != null ? money(unit.purchasePrice, paidCurrency) : null;
  const sold =
    unit.isSold && unit.soldPrice != null
      ? money(unit.soldPrice, saleCurrency)
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
        text: `${rounded >= 0 ? "+" : "−"}${money(Math.abs(rounded), viewerCurrency)}`,
        positive: rounded >= 0,
      };
    }
  }
  return { paid, sold, gain };
}

// ── Build comparison ──────────────────────────────────────────────────────
//
// The keyboard editor's Summary tab compares every unit of one board side by
// side so the owner can decide what to build next. Everything here is derived
// from the CollectionUnit drafts already in the editor — no new data — and it
// is pure so the rules below are tested rather than eyeballed.
//
// Matching is deliberately literal: trim, collapse whitespace, lower-case.
// "Alu" and "Aluminium" stay two values. That can MISS a match (a column that
// fails to collapse, a duplicate left unflagged) but it can never INVENT one,
// and a wrong "these two builds are the same" on someone's own record is the
// worse error. BuildFields writes "" when an input is cleared, so blank means
// null, "" or whitespace — never a value two cleared fields share.

export type BuildStatus = "SOLD" | "UNBUILT" | "PROJECT" | "BUILT" | "NOT_SET" | "OTHER";

// Structural config first (what makes a build "different"), then its dress.
export const COMPARE_FIELDS = [
  "plateType",
  "mountType",
  "pcbType",
  "layoutVariant",
  "switches",
  "keycaps",
] as const;
export type CompareField = (typeof COMPARE_FIELDS)[number];

export const COMPARE_FIELD_LABELS: Record<CompareField, string> = {
  plateType: "Plate",
  mountType: "Mount",
  pcbType: "PCB",
  layoutVariant: "Layout",
  switches: "Switches",
  keycaps: "Keycaps",
};

export function normSpec(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function displaySpec(value: string | null | undefined): string | null {
  const shown = (value ?? "").trim().replace(/\s+/g, " ");
  return shown || null;
}

function yearOf(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).getFullYear();
}

// Sold outranks condition — a sold unbuilt unit is gone, not a candidate. An
// empty condition is "not set", NEVER unbuilt: guessing that an unrecorded
// unit is still boxed would put it on the Up next list.
export function buildStatus(build: Pick<CollectionUnit, "isSold" | "condition">): BuildStatus {
  if (build.isSold === true) return "SOLD";
  const condition = (build.condition ?? "").trim();
  if (!condition) return "NOT_SET";
  if (condition === "UNBUILT") return "UNBUILT";
  if (condition === "PROJECT") return "PROJECT";
  if (condition === "EXCELLENT" || condition === "GOOD" || condition === "FAIR") return "BUILT";
  return "OTHER";
}

export interface BuildComparisonRow {
  index: number;
  status: BuildStatus;
  conditionCode: string | null;
  color: string | null;
  specs: Record<CompareField, string | null>;
  // Lowest-index build of a reported same-config group, set on the others.
  duplicateOf: number | null;
  // Nothing recorded at all — rendered as one "No details yet" cell.
  empty: boolean;
  paid: { amount: number; currency: string } | null;
  acquiredYear: number | null;
  soldYear: number | null;
}

export interface BuildComparison {
  rows: BuildComparisonRow[];
  tally: Record<BuildStatus, number>;
  // Unbuilt first, then project builds, each in build order. Never sold.
  upNext: number[];
  visibleFields: CompareField[];
  sharedFields: Array<{ field: CompareField; display: string }>;
  unrecordedFields: CompareField[];
  duplicateGroups: Array<{ indexes: number[]; display: string; sameSwitches: boolean }>;
  untriedPairings: Array<{ plate: string; mount: string }>;
  // More than one currency among priced rows: show ISO codes on every row,
  // because en-SG renders both SGD and USD as "$".
  paidMixed: boolean;
}

export function compareBuilds(
  builds: CollectionUnit[],
  { fallbackCurrency = "USD" }: { fallbackCurrency?: string } = {}
): BuildComparison {
  const rows: BuildComparisonRow[] = builds.map((build, index) => {
    const status = buildStatus(build);
    const specs = Object.fromEntries(
      COMPARE_FIELDS.map((field) => [field, displaySpec(build[field])])
    ) as Record<CompareField, string | null>;
    const color = displaySpec(build.color);
    // The Build tab's currency picker shows fallbackCurrency for a null
    // currency, so the table must too or the two disagree about one price.
    const paid =
      build.purchasePrice != null && Number.isFinite(build.purchasePrice)
        ? {
            amount: build.purchasePrice,
            currency: (build.purchaseCurrency ?? "").trim().toUpperCase() || fallbackCurrency,
          }
        : null;
    return {
      index,
      status,
      conditionCode: (build.condition ?? "").trim() || null,
      color,
      specs,
      duplicateOf: null,
      empty:
        status === "NOT_SET" &&
        paid === null &&
        color === null &&
        COMPARE_FIELDS.every((field) => specs[field] === null),
      paid,
      acquiredYear: yearOf(build.acquiredAt),
      soldYear: status === "SOLD" ? yearOf(build.soldAt) : null,
    };
  });

  const tally: Record<BuildStatus, number> = {
    SOLD: 0, UNBUILT: 0, PROJECT: 0, BUILT: 0, NOT_SET: 0, OTHER: 0,
  };
  for (const row of rows) tally[row.status] += 1;

  const upNext = [
    ...rows.filter((row) => row.status === "UNBUILT").map((row) => row.index),
    ...rows.filter((row) => row.status === "PROJECT").map((row) => row.index),
  ];

  // A field is SHARED when every build (sold included — hiding a sold unit's
  // different value would lose information) records the same value, and
  // UNRECORDED when no build records it. Both leave the table: a column of
  // identical values or of dashes compares nothing.
  const sharedFields: BuildComparison["sharedFields"] = [];
  const unrecordedFields: CompareField[] = [];
  const visibleFields: CompareField[] = [];
  for (const field of COMPARE_FIELDS) {
    const values = builds.map((build) => normSpec(build[field]));
    if (values.every((value) => value === "")) unrecordedFields.push(field);
    else if (values.every((value) => value !== "" && value === values[0]))
      sharedFields.push({ field, display: rows[0].specs[field] as string });
    else visibleFields.push(field);
  }

  // Same structural config: plate, mount AND PCB must all be recorded (a blank
  // never matches a blank), layout joins the key with blank matching only
  // blank. Sold builds are out of the rotation, so they are skipped. A group
  // made only of unbuilt units is not reported — three sealed boxes with the
  // stock plate noted are the same by definition, not a decision.
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    if (row.status === "SOLD") continue;
    const build = builds[row.index];
    const plate = normSpec(build.plateType);
    const mount = normSpec(build.mountType);
    const pcb = normSpec(build.pcbType);
    if (!plate || !mount || !pcb) continue;
    const key = [plate, mount, pcb, normSpec(build.layoutVariant)].join("|");
    groups.set(key, [...(groups.get(key) ?? []), row.index]);
  }
  const duplicateGroups: BuildComparison["duplicateGroups"] = [];
  Array.from(groups.values()).forEach((indexes) => {
    if (indexes.length < 2) return;
    if (indexes.every((i) => rows[i].status === "UNBUILT")) return;
    const lead = rows[indexes[0]].specs;
    const switches = indexes.map((i) => normSpec(builds[i].switches));
    duplicateGroups.push({
      indexes,
      display: [lead.plateType, lead.mountType, lead.pcbType, lead.layoutVariant]
        .filter(Boolean)
        .join(" · "),
      sameSwitches: switches[0] !== "" && switches.every((value) => value === switches[0]),
    });
    for (const i of indexes.slice(1)) rows[i].duplicateOf = indexes[0];
  });
  duplicateGroups.sort((a, b) => a.indexes[0] - b.indexes[0]);

  // Plate × mount pairings this board has never carried, from its OWN history
  // only (sold and unbuilt units count as done/planned). Never from the
  // generic suggestion lists: those know nothing about what this case takes.
  const plates: Array<{ key: string; display: string }> = [];
  const mounts: Array<{ key: string; display: string }> = [];
  const done = new Set<string>();
  for (const row of rows) {
    const build = builds[row.index];
    const plate = normSpec(build.plateType);
    const mount = normSpec(build.mountType);
    if (!plate || !mount) continue;
    if (!plates.some((p) => p.key === plate)) plates.push({ key: plate, display: row.specs.plateType as string });
    if (!mounts.some((m) => m.key === mount)) mounts.push({ key: mount, display: row.specs.mountType as string });
    done.add(`${plate}|${mount}`);
  }
  const untriedPairings: BuildComparison["untriedPairings"] = [];
  for (const plate of plates)
    for (const mount of mounts)
      if (!done.has(`${plate.key}|${mount.key}`))
        untriedPairings.push({ plate: plate.display, mount: mount.display });

  const currencies = new Set(rows.flatMap((row) => (row.paid ? [row.paid.currency] : [])));

  return {
    rows,
    tally,
    upNext,
    visibleFields,
    sharedFields,
    unrecordedFields,
    duplicateGroups,
    untriedPairings,
    paidMixed: currencies.size > 1,
  };
}
