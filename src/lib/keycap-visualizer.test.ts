import assert from "node:assert/strict";
import keycapData from "@/data/keycap-visualizer/keycaps.json";
import keyboardData from "@/data/keycap-visualizer/keyboards.json";
import packData from "@/data/keycap-visualizer/packs.json";
import backlog from "@/data/keycap-visualizer/keyboard-backlog.json";
import {
  LAYOUTS,
  accentLegend,
  availableOptions,
  buildLayout,
  catalogProblems,
  layoutKeys,
  placeKeys,
  type DesignPack,
  type KeycapSet,
  type LayoutId,
  type VisualizerKeyboard,
} from "./keycap-visualizer";
import { PITCH, keysetArrays, rowsFor, topFace } from "./keycap-geometry";
import { packAtlas } from "./legend-atlas";

const catalog = {
  keycaps: keycapData.keycaps as KeycapSet[],
  keyboards: keyboardData.keyboards as VisualizerKeyboard[],
  generic: keyboardData.generic as VisualizerKeyboard[],
  genericFinishes: keyboardData.genericFinishes,
  packs: packData.packs as DesignPack[],
};

// --- The shipped catalog is what the daily routines edit, so it must stay valid ---
assert.deepEqual(catalogProblems(catalog), [], "the shipped visualizer catalog has no problems");
assert.ok(catalog.keycaps.every((k) => k.family === "GMK" || k.family === "SP DCS"), "only GMK and SP DCS sets");
for (const b of backlog.queue) {
  assert.ok(b.layout in LAYOUTS, `backlog keyboard "${b.name}" uses a supported layout`);
  assert.ok(!catalog.keyboards.some((k) => k.name === b.name), `backlog keyboard "${b.name}" is not already in the catalog`);
}

// --- The checker catches what a hand edit gets wrong ---
const bad = structuredClone(catalog);
bad.keycaps.push({ ...bad.keycaps[0], colors: { ...bad.keycaps[0].colors, accent: "pink" } });
bad.packs.push({ ...bad.packs[0], id: "orphan", keycap: "gmk-does-not-exist" });
bad.keyboards.push({ id: "odd", name: "Odd", layout: "40" as LayoutId, finishes: [] });
const problems = catalogProblems(bad).join("\n");
assert.match(problems, /keycap id "gmk-olivia" is used twice/);
assert.match(problems, /tracker slug "gmk-olivia" is in the visualizer twice/);
assert.match(problems, /accent "pink" is not a #RRGGBB color/);
assert.match(problems, /pack "orphan" points at missing keycap/);
assert.match(problems, /unknown layout "40"/);
assert.match(problems, /keyboard "odd" needs at least one finish/);

// --- Layouts: every option of every board lines up to the same width ---
const expectedWidth: Record<LayoutId, number> = { "60": 15, "65": 16, "75": 16, tkl: 18.25, full: 22.5 };
for (const id of Object.keys(LAYOUTS) as LayoutId[]) {
  const opts = availableOptions(id);
  for (const bottom of opts.bottom) {
    for (const fRow of opts.fRow.length ? opts.fRow : (["F12"] as const)) {
      const name = `${id} ${bottom} ${fRow}`;
      const { keys, width } = layoutKeys(buildLayout(id, { bottom, fRow }));
      assert.equal(width, expectedWidth[id], `${name} is ${expectedWidth[id]}u wide`);
      const rows = new Map<number, number>();
      for (const k of keys) rows.set(k.y, Math.max(rows.get(k.y) ?? 0, k.x + k.w));
      rows.forEach((end, y) => assert.equal(end <= width, true, `${name} row at y=${y} fits inside the case`));
      assert.equal(keys.filter((k) => k.legend === "Esc").length, 1, `${name} has exactly one Esc`);
      if (fRow === "F13") assert.ok(keys.some((k) => k.legend === "F13"), `${name} has F13`);
      if (bottom === "WKL") assert.ok(!keys.some((k) => k.legend === "Win"), `${name} has no Win keys`);
    }
  }
}
assert.deepEqual(availableOptions("65").bottom, ["WK", "WKL"], "HHKB is a 60% layout only");
assert.deepEqual(availableOptions("60").fRow, [], "no F-row options without an F-row");
const hhkb = layoutKeys(buildLayout("60", { bottom: "HHKB" })).keys;
assert.ok(hhkb.some((k) => k.legend === "Fn") && hhkb.some((k) => k.legend === "|"), "HHKB has split shift and | on the number row");
assert.equal(layoutKeys(buildLayout("65", { bottom: "HHKB" })).keys.length, layoutKeys(buildLayout("65")).keys.length, "an option a form factor can't take falls back to the default");

// Listed boards only offer options their layout can take.
for (const b of catalog.keyboards) {
  const opts = availableOptions(b.layout);
  for (const v of b.options?.bottom ?? []) assert.ok(opts.bottom.includes(v), `${b.name}: ${v} fits a ${b.layout}`);
  for (const v of b.options?.fRow ?? []) assert.ok(opts.fRow.includes(v), `${b.name}: ${v} fits a ${b.layout}`);
}

// --- Accent legends pick the most readable set color ---
assert.equal(
  accentLegend({ alpha: "#E8E2DE", mod: "#2B2828", accent: "#E3AFA0", alphaLegend: "#2B2828", modLegend: "#E3AFA0" }),
  "#2B2828",
  "pink accents on Olivia get the dark legend, not pink-on-pink"
);

// --- Key placement follows the base kits (every catalog set's kit diagram agrees) ---
{
  const tkl = layoutKeys(buildLayout("tkl")).keys;
  const group = (legend: string) => tkl.find((k) => k.legend === legend)?.group;
  assert.deepEqual(["F1", "F4", "F9", "F12"].map(group), ["a", "a", "a", "a"], "F1–F4 and F9–F12 are alpha caps");
  assert.deepEqual(["F5", "F6", "F7", "F8"].map(group), ["m", "m", "m", "m"], "F5–F8 are mod caps");
  assert.deepEqual(["←", "↑", "↓", "→"].map(group), ["m", "m", "m", "m"], "arrows are mod caps in a base kit");
  assert.deepEqual(["Esc", "Enter"].map(group), ["x", "x"], "Esc and Enter are the accent caps");
  assert.deepEqual(["~", "\\"].map(group), ["a", "a"], "~ and the 1.5u backslash are alpha caps");
  const f13 = layoutKeys(buildLayout("75", { fRow: "F13" })).keys;
  assert.equal(f13.find((k) => k.legend === "F13")?.group, "m", "F13 is a mod cap");
  const sixtyFive = layoutKeys(buildLayout("65")).keys;
  assert.ok(sixtyFive.filter((k) => ["←", "↑", "↓", "→"].includes(k.legend)).every((k) => k.group === "m"), "65% arrows are mod caps too");

  // A set's own placement moves only the keys it names.
  const laser = placeKeys(tkl, { esc: "m", enter: "m" });
  assert.equal(laser.find((k) => k.legend === "Esc")?.group, "m", "placement moves Esc");
  assert.equal(laser.find((k) => k.legend === "F1")?.group, "a", "placement leaves the F-row alone");
  const full = placeKeys(layoutKeys(buildLayout("full")).keys, { enter: "m", arrows: "x" });
  assert.ok(full.filter((k) => k.legend === "Enter").length === 2 && full.filter((k) => k.legend === "Enter").every((k) => k.group === "m"), "numpad Enter follows Enter");
  assert.ok(full.filter((k) => ["←", "↑", "↓", "→"].includes(k.legend)).every((k) => k.group === "x"), "accent arrows (Tokyo Nights R2)");
  assert.equal(placeKeys(tkl, undefined), tkl, "no placement, no copy");

  const bad = { ...catalog, keycaps: [{ ...catalog.keycaps[0], placement: { esc: "q", spacebar: "a" } as unknown as KeycapSet["placement"] }] };
  const problems = catalogProblems(bad);
  assert.ok(problems.some((p) => /placement esc/.test(p)) && problems.some((p) => /placement "spacebar"/.test(p)), "catalog checks reject a bad placement");
}
assert.equal(
  accentLegend({ alpha: "#E6E3D6", mod: "#F2C523", accent: "#2E2D29", alphaLegend: "#2E2D29", modLegend: "#2E2D29", accentLegend: "#E6E3D6" }),
  "#E6E3D6",
  "a set's own accent legend wins over the contrast guess (Serika's beige on dark Esc)"
);

// --- 3D (beta): the geometry and the legend atlas ---
// (reduce, not Math.max(...xs): a full-size keyset is too many arguments for a spread)
const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), -Infinity);
const minOf = (xs: number[]) => xs.reduce((a, b) => Math.min(a, b), Infinity);
for (const id of Object.keys(LAYOUTS) as LayoutId[]) {
  for (const profile of ["cherry", "dcs"] as const) {
    const { keys } = layoutKeys(buildLayout(id));
    const atlas = packAtlas(keys, profile);
    const name = `${id} ${profile}`;
    assert.ok(atlas.height <= 4096 && (atlas.height & (atlas.height - 1)) === 0, `${name}: the atlas is a power of two a phone GPU takes`);
    atlas.rects.forEach(([x, y, w, h], i) => {
      assert.ok(x >= 0 && x + w <= atlas.width && y + h <= atlas.height, `${name}: cell ${i} lies inside the atlas`);
      atlas.rects.slice(0, i).forEach(([x2, y2, w2, h2]) => {
        assert.ok(x + w <= x2 || x2 + w2 <= x || y + h <= y2 || y2 + h2 <= y, `${name}: cells ${i} and another overlap`);
      });
    });
    const mesh = keysetArrays(keys, atlas.cells, profile);
    const triangles = mesh.indices.length / 3;
    assert.ok(triangles < 150_000, `${name}: ${triangles} triangles stays a single cheap draw call`);
    assert.ok(mesh.positions.every(Number.isFinite) && mesh.uvs.every((v) => v >= 0 && v <= 1), `${name}: finite positions, UVs inside the atlas`);
    assert.ok(maxOf(mesh.indices) < mesh.positions.length / 3, `${name}: every index names a vertex`);
    // Caps never cross into a neighbour's footprint.
    const xs = mesh.positions.filter((_, i) => i % 3 === 0);
    assert.ok(minOf(xs) >= 0 && maxOf(xs) <= maxOf(keys.map((k) => (k.x + k.w) * PITCH)), `${name}: caps stay on the board`);
  }
}
{
  // Rows read from the bottom up: the spacebar row and the shift row are R4,
  // the home row R3, and the number row (and an F-row above it) R1.
  const keys = layoutKeys(buildLayout("tkl")).keys;
  const rows = rowsFor(keys);
  const rowOf = (legend: string) => rows[keys.findIndex((k) => k.legend === legend)];
  assert.deepEqual(["F1", "1", "Q", "A", "Z", "Ctrl"].map(rowOf), [1, 1, 2, 3, 4, 4], "TKL rows are Cherry R1 R1 R2 R3 R4 R4");
  const sixty = layoutKeys(buildLayout("60")).keys;
  const rows60 = rowsFor(sixty);
  assert.equal(rows60[sixty.findIndex((k) => k.legend === "1")], 1, "a 60%'s number row is R1 too");
  // A cap's tallest point is its R1 back edge; R3 is the lowest.
  const one = keysetArrays(keys, keys.map(() => ({ u0: 0, v0: 0, u1: 1, v1: 1 })), "cherry");
  const ys = one.positions.filter((_, i) => i % 3 === 1);
  assert.ok(maxOf(ys) < 11 && minOf(ys) >= -0.2, "cherry caps stand 0–11 mm tall");
  assert.ok(topFace(1, 1, "cherry").width > 11 && topFace(1, 1, "cherry").width < 13, "a 1u Cherry top is ~12 mm wide");
}

console.log("keycap-visualizer checks passed");
