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
const fRow = (from: number): KeySpec[] =>
  Array.from({ length: 4 }, (_, i) => [1, from === 5 ? "a" : "m", `F${from + i}`]);
const numberRow = (): RowItem[] => [[1, "x", "Esc"], ...alphas("1234567890-="), [2, "m", "Backspace"]];
const tabRow = (): RowItem[] => [[1.5, "m", "Tab"], ...alphas("QWERTYUIOP[]"), [1.5, "m", "\\"]];
const capsRow = (): RowItem[] => [[1.75, "m", "Caps"], ...alphas("ASDFGHJKL;'"), [2.25, "x", "Enter"]];
// Boards with an F-row move Esc up there, so their number row starts with ~.
const tilde: KeySpec = [1, "m", "~"];

const sixty: Row[] = [
  numberRow(),
  tabRow(),
  capsRow(),
  [[2.25, "m", "Shift"], ...alphas("ZXCVBNM,./"), [2.75, "m", "Shift"]],
  [[1.25, "m", "Ctrl"], [1.25, "m", "Win"], [1.25, "m", "Alt"], [6.25, "a", ""], [1.25, "m", "Alt"], [1.25, "m", "Win"], [1.25, "m", "Menu"], [1.25, "m", "Ctrl"]],
];

const sixtyFive: Row[] = [
  [...numberRow(), [1, "m", "Del"]],
  [...tabRow(), [1, "m", "PgUp"]],
  [...capsRow(), [1, "m", "PgDn"]],
  [[2.25, "m", "Shift"], ...alphas("ZXCVBNM,./"), [1.75, "m", "Shift"], [1, "x", "↑"], [1, "m", "End"]],
  [[1.25, "m", "Ctrl"], [1.25, "m", "Win"], [1.25, "m", "Alt"], [6.25, "a", ""], [1, "m", "Alt"], [1, "m", "Fn"], [1, "m", "Ctrl"], [1, "x", "←"], [1, "x", "↓"], [1, "x", "→"]],
];

const seventyFive: Row[] = [
  [[1, "x", "Esc"], 0.5, ...fRow(1), 0.5, ...fRow(5), 0.5, ...fRow(9), 0.5, [1, "m", "Del"]],
  { gap: 0.25 },
  ...sixtyFive.map((row, i) => {
    const items = row as RowItem[];
    if (i > 2) return items;
    const copy = items.slice(0, -1);
    if (i === 0) copy[0] = tilde;
    return [...copy, [1, "m", ["Home", "PgUp", "PgDn"][i]] as KeySpec];
  }),
];

const navCluster: RowItem[][] = [
  [[1, "m", "Ins"], [1, "m", "Home"], [1, "m", "PgUp"]],
  [[1, "m", "Del"], [1, "m", "End"], [1, "m", "PgDn"]],
  [3],
  [1, [1, "x", "↑"], 1],
  [[1, "x", "←"], [1, "x", "↓"], [1, "x", "→"]],
];

const tklFRow: RowItem[] = [[1, "x", "Esc"], 1, ...fRow(1), 0.5, ...fRow(5), 0.5, ...fRow(9), 0.25, [1, "m", "PrtSc"], [1, "m", "ScrLk"], [1, "m", "Pause"]];
const tklMain: RowItem[][] = sixty.map((row, i) => {
  const items = row as RowItem[];
  return [...(i === 0 ? [tilde, ...items.slice(1)] : items), 0.25, ...navCluster[i]];
});

const numpad: RowItem[][] = [
  [[1, "m", "Num"], [1, "m", "/"], [1, "m", "*"], [1, "m", "-"]],
  [...alphas("789"), [1, "m", "+", 2]],
  [...alphas("456"), 1],
  [...alphas("123"), [1, "x", "Enter", 2]],
  [[2, "a", "0"], [1, "a", "."], 1],
];

export const LAYOUTS: Record<LayoutId, Layout> = {
  "60": { label: "60%", rows: sixty },
  "65": { label: "65%", rows: sixtyFive },
  "75": { label: "75%", rows: seventyFive },
  tkl: { label: "TKL", rows: [tklFRow, { gap: 0.25 }, ...tklMain] },
  full: {
    label: "Full size",
    rows: [[...tklFRow, 4.25], { gap: 0.25 }, ...tklMain.map((row, i) => [...row, 0.25, ...numpad[i]])],
  },
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
