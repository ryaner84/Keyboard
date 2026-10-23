// Sculpted keycap geometry for the 3D (beta) stage. Every key of a board is
// written into ONE set of flat arrays, so the whole keyset is a single draw
// call; each key's top-face UVs point at its own cell of the legend atlas
// (src/lib/legend-atlas.ts), and its walls sample that cell's border, which
// is filled with the key's colour.
//
// Pure arithmetic — no three.js import — so it runs under the test suite and
// the component turns the arrays into a BufferGeometry. Units are mm, y up,
// +z toward the typist, a key's origin at the centre of its footprint.
import type { PlacedKey } from "./keycap-visualizer";

export const PITCH = 19.05;
const BOTTOM = 18.16; // footprint of a 1u cap; the rest of the pitch is the gap
const GAP = PITCH - BOTTOM;

export type ProfileRow = 1 | 2 | 3 | 4;
export type Profile = "cherry" | "dcs";

interface ProfileSpec {
  /** Top face is this much narrower / shallower than the footprint. */
  widthDiff: number;
  depthDiff: number;
  dish: number;
  /** Total height at the top centre, per row. */
  height: Record<ProfileRow, number>;
  /** Top tilt in degrees on a FLAT board, positive = front edge higher (faces away from the typist). */
  tilt: Record<ProfileRow, number>;
}

// Cherry: heights and tilts measured off a GMK cap CAD (R1–R4), cylindrical
// dish ~0.5 mm. The home row is tilted 5° away so that, on a board with the
// usual ~6° typing angle, it ends up nearly level — which is the point of the
// profile. DCS: Signature Plastics' values as KeyV2 (rsheldiii) models them.
const PROFILES: Record<Profile, ProfileSpec> = {
  cherry: {
    widthDiff: BOTTOM - 11.85,
    depthDiff: BOTTOM - 14.64,
    dish: 0.48,
    height: { 1: 9.55, 2: 7.27, 3: 6.51, 4: 7.37 },
    tilt: { 1: -1.1, 2: 2.4, 3: 5.1, 4: 9.3 },
  },
  dcs: {
    widthDiff: 6,
    depthDiff: 4,
    dish: 0.5,
    height: { 1: 8.5, 2: 7.5, 3: 6, 4: 5.8 },
    tilt: { 1: -1, 2: 3, 3: 7, 4: 16 },
  },
};

/** Where a key's top face samples the atlas, in UV space. */
export interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface MeshArrays {
  positions: number[];
  uvs: number[];
  indices: number[];
}

/** The size of a key's top face in mm — what the legend atlas draws at. */
export function topFace(w: number, h: number, profile: Profile): { width: number; depth: number } {
  const p = PROFILES[profile];
  return { width: w * PITCH - GAP - p.widthDiff, depth: h * PITCH - GAP - p.depthDiff };
}

// A rounded-rectangle outline with the same vertex count for every ring of one
// key, so consecutive rings stitch into quads.
function ring(w: number, d: number, r: number, nx: number, nz: number, cz: number): [number, number][] {
  const pts: [number, number][] = [];
  const hw = w / 2;
  const hd = d / 2;
  r = Math.min(r, hw * 0.99, hd * 0.99);
  const corners: [number, number, number][] = [
    [hw - r, hd - r, 0],
    [-(hw - r), hd - r, 90],
    [-(hw - r), -(hd - r), 180],
    [hw - r, -(hd - r), 270],
  ];
  const ARC = 4;
  corners.forEach(([cx, cz2, a0], i) => {
    for (let k = 0; k <= ARC; k++) {
      const a = ((a0 + (90 * k) / ARC) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cz2 + r * Math.sin(a) + cz]);
    }
    const [nx2, nz2] = corners[(i + 1) % 4];
    const end = ((a0 + 90) * Math.PI) / 180;
    const sx = cx + r * Math.cos(end);
    const sz = cz2 + r * Math.sin(end);
    const ex = nx2 + r * Math.cos(end);
    const ez = nz2 + r * Math.sin(end);
    const n = i % 2 === 0 ? nx : nz; // sides 0 and 2 run along x
    for (let k = 1; k < n; k++) pts.push([sx + ((ex - sx) * k) / n, sz + ((ez - sz) * k) / n + cz]);
  });
  return pts;
}

/**
 * One sculpted cap, appended to `out` (or a fresh set of arrays). `offset` is
 * the centre of its footprint on the board.
 */
export function appendKeycap(
  out: MeshArrays,
  wu: number,
  hu: number,
  row: ProfileRow,
  profile: Profile,
  cell: Cell,
  offset: [number, number] = [0, 0],
  homing = false
): MeshArrays {
  const p = PROFILES[profile];
  const bw = wu * PITCH - GAP;
  const bd = hu * PITCH - GAP;
  const { width: tw, depth: td } = topFace(wu, hu, profile);
  const H = p.height[row];
  // Positive tilt raises the front edge (+z).
  const slope = Math.tan((p.tilt[row] * Math.PI) / 180);
  const skew = -0.6; // the top sits a little toward the back of the footprint
  const nx = Math.max(4, Math.round(bw / 2.2));
  const nz = Math.max(4, Math.round(bd / 2.2));
  const halfTop = tw / 2;
  // Long caps (spacebars) are dished far more shallowly than a 1u.
  const dish = p.dish * (wu > 2.5 ? 0.35 : 1);
  const topY = (x: number, z: number) => H + slope * (z - skew) - dish * Math.max(0, 1 - (x / halfTop) ** 2);

  const rings: { pts: [number, number][]; y: (x: number, z: number) => number }[] = [];
  // Walls, eased so they bow slightly like a moulded cap.
  for (const t of [0, 0.3, 0.6, 0.85, 0.96]) {
    const e = Math.pow(t, 0.92);
    const w = bw + (tw + 0.6 - bw) * e;
    const d = bd + (td + 0.6 - bd) * e;
    rings.push({ pts: ring(w, d, 1.1 + 0.9 * e, nx, nz, skew * e), y: (x, z) => t * (topY(x, z) - 0.45) });
  }
  // A rounded top edge, then concentric rings in to the centre of the dish.
  rings.push({ pts: ring(tw + 0.25, td + 0.25, 2.05, nx, nz, skew), y: (x, z) => topY(x, z) - 0.12 });
  for (const s of [1, 0.93, 0.8, 0.62, 0.44, 0.27, 0.12, 0.02]) {
    rings.push({ pts: ring(tw * s, td * s, 2 * s, nx, nz, skew), y: topY });
  }

  const { positions, uvs, indices } = out;
  const base = positions.length / 3;
  const P = rings[0].pts.length;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const u = (x: number) => cell.u0 + (cell.u1 - cell.u0) * clamp(x / tw + 0.5);
  const v = (z: number) => cell.v1 - (cell.v1 - cell.v0) * clamp((z - skew) / td + 0.5);
  const [ox, oz] = offset;
  for (const rg of rings) {
    for (const [x, z] of rg.pts) {
      positions.push(x + ox, rg.y(x, z), z + oz);
      uvs.push(u(x), v(z));
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < P; i++) {
      const a = base + r * P + i;
      const b = base + r * P + ((i + 1) % P);
      const c = base + (r + 1) * P + i;
      const d = base + (r + 1) * P + ((i + 1) % P);
      indices.push(a, c, b, b, c, d);
    }
  }
  const centre = positions.length / 3;
  positions.push(ox, topY(0, skew), skew + oz);
  uvs.push(u(0), v(skew));
  const last = base + (rings.length - 1) * P;
  for (let i = 0; i < P; i++) indices.push(last + i, centre, last + ((i + 1) % P));

  // The homing bar on F and J: a low ridge toward the front of the dish.
  if (homing) {
    const zc = skew + td / 2 - 2.6;
    const hx = 2.6;
    const hz = 0.35;
    const lift = 0.45;
    const corners: [number, number][] = [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ];
    const b0 = positions.length / 3;
    for (const top of [false, true]) {
      for (const [x, dz] of corners) {
        const z = zc + dz;
        positions.push(x + ox, topY(x, z) + (top ? lift : -0.1), z + oz);
        uvs.push(u(0), v(skew + td * 0.45)); // a plain patch of the cap's colour, clear of the legend
      }
    }
    const quad = (a: number, b: number, c: number, d: number) => indices.push(b0 + a, b0 + b, b0 + c, b0 + a, b0 + c, b0 + d);
    quad(4, 7, 6, 5); // top
    quad(0, 1, 5, 4); // back
    quad(2, 3, 7, 6); // front
    quad(3, 0, 4, 7); // left
    quad(1, 2, 6, 5); // right
  }
  return out;
}

/**
 * Cherry/GMK row assignment from a layout: the F-row and number row are R1,
 * then R2, R3 (home), and R4 for the shift row and the bottom row. Rows are
 * read off the board from the bottom up, so a 60% and a full size agree.
 */
export function rowsFor(keys: PlacedKey[]): ProfileRow[] {
  const ys = Array.from(new Set(keys.map((k) => k.y))).sort((a, b) => b - a);
  const byIndex: ProfileRow[] = [4, 4, 3, 2, 1, 1];
  return keys.map((k) => byIndex[Math.min(ys.indexOf(k.y), byIndex.length - 1)]);
}

/** Every cap of a board in one set of arrays, footprints laid out from the top-left at (0, 0). */
export function keysetArrays(keys: PlacedKey[], cells: Cell[], profile: Profile): MeshArrays {
  const rows = rowsFor(keys);
  const out: MeshArrays = { positions: [], uvs: [], indices: [] };
  keys.forEach((k, i) => {
    const homing = k.group === "a" && (k.legend === "F" || k.legend === "J");
    appendKeycap(out, k.w, k.h, rows[i], profile, cells[i], [(k.x + k.w / 2) * PITCH, (k.y + k.h / 2) * PITCH], homing);
  });
  return out;
}
