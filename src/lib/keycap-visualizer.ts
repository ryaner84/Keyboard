// Keycap visualizer: physical layouts, color helpers and the catalog checks the
// daily catalog routines (docs/keycap-visualizer-routine.md) rely on.

export type LayoutId = "60" | "65" | "75" | "tkl" | "full";
export type KeyGroup = "a" | "m" | "x"; // alpha, modifier, accent

// A key is [width, group, legend, height?] in key units (1u = one alpha key).
// A bare number is a horizontal gap; { gap } is a vertical gap between rows.
type KeySpec = [number, KeyGroup, string, number?];
type RowItem = KeySpec | number;
type Row = RowItem[] | { gap: number };

export interface Layout {
  label: string;
  rows: Row[];
}

export interface PlacedKey {
  x: number;
  y: number;
  w: number;
  h: number;
  group: KeyGroup;
  legend: string;
}

export interface KeycapColors {
  alpha: string;
  mod: string;
  accent: string;
  alphaLegend: string;
  modLegend: string;
}

export interface KeycapSet {
  id: string;
  name: string;
  family: "GMK" | "SP DCS";
  profile: "cherry" | "dcs";
  slug: string;
  dateAdded: string;
  colorSource: "tracker-image" | "known-colorway";
  colors: KeycapColors;
}

export interface Finish {
  name: string;
  hex: string;
}

export interface VisualizerKeyboard {
  id: string;
  name: string;
  layout: LayoutId;
  dateAdded?: string;
  finishes?: Finish[];
  /** Layout options this board ships in, default first. Omitted = defaults only (generic layouts allow every option). */
  options?: { bottom?: BottomRow[]; fRow?: FRow[] };
}

export interface DesignPack {
  id: string;
  name: string;
  description: string;
  keycap: string;
  caseHex: string;
  caseName: string;
}

const alphas = (chars: string): KeySpec[] => chars.split("").map((c) => [1, "a", c]);
const fKeys = (from: number, to: number): KeySpec[] =>
  Array.from({ length: to - from + 1 }, (_, i) => [1, (from + i) >= 5 && (from + i) <= 8 ? "a" : "m", `F${from + i}`]);
// Boards with an F-row move Esc up there, so their number row starts with ~.
const tilde: KeySpec = [1, "m", "~"];

// Layout options, named the way the collection pages (and secondhand
// listings) name them. The first value of each is the default.
export const BOTTOM_ROWS = ["WK", "WKL", "HHKB"] as const;
export const F_ROWS = ["F12", "F13"] as const;
export type BottomRow = (typeof BOTTOM_ROWS)[number];
export type FRow = (typeof F_ROWS)[number];
export interface LayoutOptions {
  bottom: BottomRow;
  fRow: FRow;
}
export const DEFAULT_OPTIONS: LayoutOptions = { bottom: "WK", fRow: "F12" };

/** Which options a form factor can take at all: HHKB is a 60% layout, and only boards with an F-row have F12/F13. */
export function availableOptions(id: LayoutId): { bottom: BottomRow[]; fRow: FRow[] } {
  return {
    bottom: id === "60" ? [...BOTTOM_ROWS] : ["WK", "WKL"],
    fRow: id === "60" || id === "65" ? [] : [...F_ROWS],
  };
}

// Rows 1–4 of the alpha block, 15u wide. HHKB moves | and ~ onto the number
// row, shrinks Backspace to 1.5u, puts Control where Caps is and splits right
// Shift for Fn.
function alphaBlock(bottom: BottomRow, fRowAbove: boolean): RowItem[][] {
  if (bottom === "HHKB") {
    return [
      [[1, "x", "Esc"], ...alphas("1234567890-="), [1, "m", "|"], [1, "m", "~"]],
      [[1.5, "m", "Tab"], ...alphas("QWERTYUIOP[]"), [1.5, "m", "BS"]],
      [[1.75, "m", "Ctrl"], ...alphas("ASDFGHJKL;'"), [2.25, "x", "Enter"]],
      [[2.25, "m", "Shift"], ...alphas("ZXCVBNM,./"), [1.75, "m", "Shift"], [1, "m", "Fn"]],
    ];
  }
  return [
    [fRowAbove ? tilde : [1, "x", "Esc"], ...alphas("1234567890-="), [2, "m", "Backspace"]],
    [[1.5, "m", "Tab"], ...alphas("QWERTYUIOP[]"), [1.5, "m", "\\"]],
    [[1.75, "m", "Caps"], ...alphas("ASDFGHJKL;'"), [2.25, "x", "Enter"]],
    [[2.25, "m", "Shift"], ...alphas("ZXCVBNM,./"), [2.75, "m", "Shift"]],
  ];
}

// The 15u bottom row of a 60% (also the left of TKL and full size).
function bottom60(bottom: BottomRow): RowItem[] {
  if (bottom === "HHKB") return [1.5, [1, "m", "Alt"], [1.5, "m", "◇"], [7, "a", ""], [1.5, "m", "◇"], [1, "m", "Alt"], 1.5];
  if (bottom === "WKL") return [[1.5, "m", "Ctrl"], 1, [1.5, "m", "Alt"], [7, "a", ""], [1.5, "m", "Alt"], 1, [1.5, "m", "Ctrl"]];
  return [[1.25, "m", "Ctrl"], [1.25, "m", "Win"], [1.25, "m", "Alt"], [6.25, "a", ""], [1.25, "m", "Alt"], [1.25, "m", "Win"], [1.25, "m", "Menu"], [1.25, "m", "Ctrl"]];
}

// 65% and 75%: the 13u left of the bottom row beside the arrow cluster.
function bottom65(bottom: BottomRow): RowItem[] {
  const arrows: KeySpec[] = [[1, "x", "←"], [1, "x", "↓"], [1, "x", "→"]];
  if (bottom === "WKL") return [[1.5, "m", "Ctrl"], 1, [1.5, "m", "Alt"], [7, "a", ""], [1.5, "m", "Alt"], 0.5, ...arrows];
  return [[1.25, "m", "Ctrl"], [1.25, "m", "Win"], [1.25, "m", "Alt"], [6.25, "a", ""], [1, "m", "Alt"], [1, "m", "Fn"], [1, "m", "Ctrl"], ...arrows];
}

function sixtyFiveRows(o: LayoutOptions, fRowAbove: boolean): Row[] {
  const [r1, r2, r3] = alphaBlock("WK", fRowAbove);
  const right = fRowAbove ? ["Home", "PgUp", "PgDn"] : ["Del", "PgUp", "PgDn"];
  return [
    [...r1, [1, "m", right[0]]],
    [...r2, [1, "m", right[1]]],
    [...r3, [1, "m", right[2]]],
    [[2.25, "m", "Shift"], ...alphas("ZXCVBNM,./"), [1.75, "m", "Shift"], [1, "x", "↑"], [1, "m", "End"]],
    bottom65(o.bottom),
  ];
}

// The F-row of a 75%: F12 spaces three blocks of four; F13 fills the gaps
// with a thirteenth key, as on most 75% F13 boards.
function fRow75(f: FRow): RowItem[] {
  if (f === "F13") return [[1, "x", "Esc"], ...fKeys(1, 13), [1, "m", "Del"]];
  return [[1, "x", "Esc"], 0.5, ...fKeys(1, 4), 0.5, ...fKeys(5, 8), 0.5, ...fKeys(9, 12), 0.5, [1, "m", "Del"]];
}

// The 18.25u F-row of TKL and full size, cluster keys included.
function fRowTkl(f: FRow): RowItem[] {
  const cluster: RowItem[] = [0.25, [1, "m", "PrtSc"], [1, "m", "ScrLk"], [1, "m", "Pause"]];
  if (f === "F13") return [[1, "x", "Esc"], 0.25, ...fKeys(1, 4), 0.25, ...fKeys(5, 8), 0.25, ...fKeys(9, 12), 0.25, ...fKeys(13, 13), ...cluster];
  return [[1, "x", "Esc"], 1, ...fKeys(1, 4), 0.5, ...fKeys(5, 8), 0.5, ...fKeys(9, 12), ...cluster];
}

const navCluster: RowItem[][] = [
  [[1, "m", "Ins"], [1, "m", "Home"], [1, "m", "PgUp"]],
  [[1, "m", "Del"], [1, "m", "End"], [1, "m", "PgDn"]],
  [3],
  [1, [1, "x", "↑"], 1],
  [[1, "x", "←"], [1, "x", "↓"], [1, "x", "→"]],
];

const numpad: RowItem[][] = [
  [[1, "m", "Num"], [1, "m", "/"], [1, "m", "*"], [1, "m", "-"]],
  [...alphas("789"), [1, "m", "+", 2]],
  [...alphas("456"), 1],
  [...alphas("123"), [1, "x", "Enter", 2]],
  [[2, "a", "0"], [1, "a", "."], 1],
];

function tklMain(o: LayoutOptions): RowItem[][] {
  return [...alphaBlock("WK", true), bottom60(o.bottom)].map((row, i) => [...row, 0.25, ...navCluster[i]]);
}

const LABELS: Record<LayoutId, string> = { "60": "60%", "65": "65%", "75": "75%", tkl: "TKL", full: "Full size" };

/** The keys of a form factor with the given options. Options a form factor can't take fall back to the default. */
export function buildLayout(id: LayoutId, options: Partial<LayoutOptions> = {}): Layout {
  const allowed = availableOptions(id);
  const o: LayoutOptions = {
    bottom: allowed.bottom.includes(options.bottom as BottomRow) ? (options.bottom as BottomRow) : "WK",
    fRow: allowed.fRow.includes(options.fRow as FRow) ? (options.fRow as FRow) : "F12",
  };
  const label = LABELS[id];
  switch (id) {
    case "60":
      return { label, rows: [...alphaBlock(o.bottom, false), bottom60(o.bottom)] };
    case "65":
      return { label, rows: sixtyFiveRows(o, false) };
    case "75":
      return { label, rows: [fRow75(o.fRow), { gap: 0.25 }, ...sixtyFiveRows(o, true)] };
    case "tkl":
      return { label, rows: [fRowTkl(o.fRow), { gap: 0.25 }, ...tklMain(o)] };
    case "full":
      return { label, rows: [[...fRowTkl(o.fRow), 4.25], { gap: 0.25 }, ...tklMain(o).map((row, i) => [...row, 0.25, ...numpad[i]])] };
  }
}

/** Default-option layouts, for labels and anything that doesn't care about options. */
export const LAYOUTS: Record<LayoutId, Layout> = {
  "60": buildLayout("60"),
  "65": buildLayout("65"),
  "75": buildLayout("75"),
  tkl: buildLayout("tkl"),
  full: buildLayout("full"),
};

export function layoutKeys(layout: Layout): { keys: PlacedKey[]; width: number; height: number } {
  const keys: PlacedKey[] = [];
  let y = 0;
  let width = 0;
  for (const row of layout.rows) {
    if (!Array.isArray(row)) {
      y += row.gap;
      continue;
    }
    let x = 0;
    for (const item of row) {
      if (typeof item === "number") {
        x += item;
        continue;
      }
      const [w, group, legend, h = 1] = item;
      keys.push({ x, y, w, h, group, legend });
      x += w;
    }
    width = Math.max(width, x);
    y += 1;
  }
  return { keys, width, height: y };
}

// ---------- Colors ----------

export const HEX = /^#[0-9A-Fa-f]{6}$/;

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export function luma(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export const isLight = (hex: string) => luma(hex) > 150;

/** Blend a color toward white or black by `amount` (0–1). */
export function mix(hex: string, target: "white" | "black", amount: number): string {
  const t = target === "white" ? 255 : 0;
  const [r, g, b] = channels(hex).map((v) => Math.round(v + (t - v) * amount));
  return `rgb(${r},${g},${b})`;
}

/** Accent keys have no legend color of their own, so borrow whichever set color reads best on them. */
export function accentLegend(c: KeycapColors): string {
  const bg = luma(c.accent);
  return [c.modLegend, c.alphaLegend, c.mod, c.alpha].reduce((best, x) =>
    Math.abs(luma(x) - bg) > Math.abs(luma(best) - bg) ? x : best
  );
}

// ---------- Catalog checks ----------

/** Every problem in the catalog, as readable sentences. Empty means valid. */
export function catalogProblems(catalog: {
  keycaps: KeycapSet[];
  keyboards: VisualizerKeyboard[];
  generic: VisualizerKeyboard[];
  genericFinishes: Finish[];
  packs: DesignPack[];
}): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const unique = (kind: string, id: string) => {
    if (seen.has(`${kind}:${id}`)) problems.push(`${kind} id "${id}" is used twice`);
    seen.add(`${kind}:${id}`);
  };
  const date = /^\d{4}-\d{2}-\d{2}$/;

  for (const k of catalog.keycaps) {
    unique("keycap", k.id);
    if (!k.name || !k.slug) problems.push(`keycap "${k.id}" needs a name and a tracker slug`);
    if (k.family === "GMK" && k.profile !== "cherry") problems.push(`keycap "${k.id}": GMK sets use the cherry profile`);
    if (k.family === "SP DCS" && k.profile !== "dcs") problems.push(`keycap "${k.id}": SP DCS sets use the dcs profile`);
    if (!["GMK", "SP DCS"].includes(k.family)) problems.push(`keycap "${k.id}": family must be GMK or SP DCS`);
    if (!date.test(k.dateAdded)) problems.push(`keycap "${k.id}": dateAdded must be YYYY-MM-DD`);
    for (const [part, hex] of Object.entries(k.colors ?? {})) {
      if (!HEX.test(hex)) problems.push(`keycap "${k.id}": ${part} "${hex}" is not a #RRGGBB color`);
    }
    for (const part of ["alpha", "mod", "accent", "alphaLegend", "modLegend"] as const) {
      if (!k.colors?.[part]) problems.push(`keycap "${k.id}" is missing the ${part} color`);
    }
  }
  const slugs = catalog.keycaps.map((k) => k.slug);
  for (const s of slugs.filter((s, i) => slugs.indexOf(s) !== i)) problems.push(`tracker slug "${s}" is in the visualizer twice`);

  for (const b of [...catalog.keyboards, ...catalog.generic]) {
    unique("keyboard", b.id);
    if (!(b.layout in LAYOUTS)) problems.push(`keyboard "${b.id}": unknown layout "${b.layout}"`);
  }
  for (const b of catalog.keyboards) {
    if (!b.finishes?.length) problems.push(`keyboard "${b.id}" needs at least one finish`);
    if (b.dateAdded && !date.test(b.dateAdded)) problems.push(`keyboard "${b.id}": dateAdded must be YYYY-MM-DD`);
    for (const f of b.finishes ?? []) if (!HEX.test(f.hex)) problems.push(`keyboard "${b.id}": finish "${f.name}" has a bad color`);
  }
  for (const f of catalog.genericFinishes) if (!HEX.test(f.hex)) problems.push(`generic finish "${f.name}" has a bad color`);

  const keycapIds = new Set(catalog.keycaps.map((k) => k.id));
  for (const p of catalog.packs) {
    unique("pack", p.id);
    if (!keycapIds.has(p.keycap)) problems.push(`pack "${p.id}" points at missing keycap "${p.keycap}"`);
    if (!HEX.test(p.caseHex)) problems.push(`pack "${p.id}" has a bad case color`);
  }
  return problems;
}
