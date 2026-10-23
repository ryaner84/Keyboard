// The legend atlas for the 3D (beta) stage: every keytop of a board drawn
// into one canvas — the doubleshot colour plus its legend — so the keyset
// renders with a single texture. Cells are sized from the real top face in
// mm (src/lib/keycap-geometry.ts), so legends keep their real proportions on
// a 1u and on a 6.25u alike.
import { accentLegend, type KeycapColors, type PlacedKey } from "./keycap-visualizer";
import { topFace, type Cell, type Profile } from "./keycap-geometry";

export const PX_PER_MM = 10;
// Empty pixels around each cell, filled with the key's colour, so mip levels
// never blend one key's colour into its neighbour's walls.
const PAD = 6;

export interface AtlasLayout {
  width: number;
  height: number;
  cells: Cell[];
  /** Pixel rectangles [x, y, w, h], padding included. */
  rects: [number, number, number, number][];
}

export function packAtlas(keys: PlacedKey[], profile: Profile, maxWidth = 2048): AtlasLayout {
  const rects: [number, number, number, number][] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const k of keys) {
    const face = topFace(k.w, k.h, profile);
    const w = Math.ceil(face.width * PX_PER_MM) + PAD * 2;
    const h = Math.ceil(face.depth * PX_PER_MM) + PAD * 2;
    if (x + w > maxWidth) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    rects.push([x, y, w, h]);
    x += w;
    rowH = Math.max(rowH, h);
  }
  const height = 2 ** Math.ceil(Math.log2(Math.max(1, y + rowH)));
  const cells = rects.map(([rx, ry, w, h]) => ({
    u0: (rx + PAD) / maxWidth,
    u1: (rx + w - PAD) / maxWidth,
    // Canvas rows run downward; texture v runs upward.
    v0: 1 - (ry + h - PAD) / height,
    v1: 1 - (ry + PAD) / height,
  }));
  return { width: maxWidth, height, cells, rects };
}

// GMK's own legends are a Cherry/Gorton-style grotesque; a system grotesque
// is the closest thing every browser already has.
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const WEIGHT = 600;

/** Paint every keytop into `canvas` (resized to the layout). */
export function drawAtlas(canvas: HTMLCanvasElement, layout: AtlasLayout, keys: PlacedKey[], colors: KeycapColors): void {
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const fill = { a: colors.alpha, m: colors.mod, x: colors.accent };
  const ink = { a: colors.alphaLegend, m: colors.modLegend, x: accentLegend(colors) };
  ctx.textBaseline = "top";
  keys.forEach((k, i) => {
    const [x, y, w, h] = layout.rects[i];
    ctx.fillStyle = fill[k.group];
    ctx.fillRect(x, y, w, h);
    if (!k.legend) return;
    // ~4 mm cap height on a single character, the size of a GMK alpha; words
    // are set smaller and shrunk further if they would run off the cap.
    const single = Array.from(k.legend).length === 1;
    let px = (single ? 5.4 : 3.1) * PX_PER_MM;
    const margin = 1.7 * PX_PER_MM;
    const room = w - PAD * 2 - margin * 2;
    ctx.font = `${WEIGHT} ${px}px ${FONT}`;
    const width = ctx.measureText(k.legend).width;
    if (width > room) {
      px *= room / width;
      ctx.font = `${WEIGHT} ${px}px ${FONT}`;
    }
    ctx.fillStyle = ink[k.group];
    ctx.fillText(k.legend, x + PAD + margin, y + PAD + 1.3 * PX_PER_MM);
  });
}
