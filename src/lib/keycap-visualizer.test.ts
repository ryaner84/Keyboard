import assert from "node:assert/strict";
import keycapData from "@/data/keycap-visualizer/keycaps.json";
import keyboardData from "@/data/keycap-visualizer/keyboards.json";
import packData from "@/data/keycap-visualizer/packs.json";
import backlog from "@/data/keycap-visualizer/keyboard-backlog.json";
import {
  LAYOUTS,
  accentLegend,
  catalogProblems,
  layoutKeys,
  type DesignPack,
  type KeycapSet,
  type LayoutId,
  type VisualizerKeyboard,
} from "./keycap-visualizer";

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

// --- Layouts: every row of a board lines up to the same width ---
const expectedWidth: Record<LayoutId, number> = { "60": 15, "65": 16, "75": 16, tkl: 18.25, full: 22.5 };
for (const id of Object.keys(LAYOUTS) as LayoutId[]) {
  const { keys, width } = layoutKeys(LAYOUTS[id]);
  assert.equal(width, expectedWidth[id], `${id} is ${expectedWidth[id]}u wide`);
  const rows = new Map<number, number>();
  for (const k of keys) rows.set(k.y, Math.max(rows.get(k.y) ?? 0, k.x + k.w));
  rows.forEach((end, y) => assert.ok(end <= width, `${id} row at y=${y} fits inside the case`));
  assert.equal(keys.filter((k) => k.legend === "Esc").length, 1, `${id} has exactly one Esc`);
}

// --- Accent legends pick the most readable set color ---
assert.equal(
  accentLegend({ alpha: "#E8E2DE", mod: "#2B2828", accent: "#E3AFA0", alphaLegend: "#2B2828", modLegend: "#E3AFA0" }),
  "#2B2828",
  "pink accents on Olivia get the dark legend, not pink-on-pink"
);

console.log("keycap-visualizer checks passed");
