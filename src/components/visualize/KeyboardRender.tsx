import { useId } from "react";
import { accentLegend, buildLayout, isLight, layoutKeys, mix, placeKeys, type KeycapColors, type LayoutId, type LayoutOptions, type Placement } from "@/lib/keycap-visualizer";

const U = 40; // pixels per key unit
const SIDE = 22; // case bezel left/right
const TOP = 24; // case bezel above the keys
const BOTTOM = 30; // case bezel below the keys
const FRONT = 18; // visible height of the case's front face

interface KeyboardRenderProps {
  layout: LayoutId;
  options?: Partial<LayoutOptions>;
  colors: KeycapColors;
  placement?: Placement;
  profile: "cherry" | "dcs";
  caseHex: string;
  legends?: boolean;
  shadow?: boolean;
  /** Tilt the board back like a product shot. For the stage, not thumbnails. */
  tilt?: boolean;
  label?: string;
}

// Draws a keyboard the way a product render looks rather than as a flat
// diagram: sculpted caps (front wall, dished top, row-by-row height), a case
// with a lit chamfer and a visible front face, one case color from the edge to
// the keys (bezel and opening are the same part), and a soft studio shadow. SVG, so it stays sharp at any size.
export function KeyboardRender({ layout, options, colors, placement, profile, caseHex, legends = true, shadow = true, tilt = false, label }: KeyboardRenderProps) {
  const id = useId().replace(/:/g, "");
  const laid = layoutKeys(buildLayout(layout, options));
  const { width, height } = laid;
  const keys = placeKeys(laid.keys, placement);
  const fill = { a: colors.alpha, m: colors.mod, x: colors.accent };
  const ink = { a: colors.alphaLegend, m: colors.modLegend, x: accentLegend(colors) };
  const dcs = profile === "dcs";
  const W = width * U + SIDE * 2;
  const H = height * U + TOP + BOTTOM;
  const floor = shadow ? 40 : 4;
  const lightCase = isLight(caseHex);
  const rowOf = (y: number) => Math.round(y);

  const svg = (
    <svg viewBox={`-6 -4 ${W + 12} ${H + FRONT + floor}`} className="w-full h-auto block" role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${id}-case`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity={lightCase ? 0.14 : 0.08} />
          <stop offset="0.3" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity={lightCase ? 0.05 : 0.1} />
        </linearGradient>
        <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="1" stopColor="#000" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id={`${id}-well`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.22" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-wall`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.3" />
        </linearGradient>
        <radialGradient id={`${id}-dish`} cx="0.45" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
          <stop offset="0.7" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#000" stopOpacity="0.08" />
        </radialGradient>
        {shadow && (
          <filter id={`${id}-blur`} x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
        )}
      </defs>

      {shadow && <ellipse cx={W / 2} cy={H + FRONT + 4} rx={W * 0.5} ry={18} fill="rgba(17,24,39,.35)" filter={`url(#${id}-blur)`} />}

      {/* Case: front face, top surface, lit chamfer */}
      <rect x={0} y={FRONT} width={W} height={H} rx={18} fill={mix(caseHex, "black", lightCase ? 0.18 : 0.3)} />
      <rect x={0} y={FRONT} width={W} height={H} rx={18} fill={`url(#${id}-front)`} />
      <rect x={0} y={0} width={W} height={H} rx={18} fill={caseHex} />
      <rect x={0} y={0} width={W} height={H} rx={18} fill={`url(#${id}-case)`} />
      <rect x={1} y={1} width={W - 2} height={H - 2} rx={17} fill="none" stroke="#fff" strokeOpacity={lightCase ? 0.7 : 0.28} strokeWidth={1.5} />

      {/* Opening the keys sit in. It is the same anodized case as the bezel,
          so it keeps the case color: only a hairline edge and a short shadow
          under the top lip mark where the keys drop below it. */}
      <rect x={SIDE - 5} y={TOP - 5} width={width * U + 10} height={10} rx={4} fill={`url(#${id}-well)`} />
      <rect x={SIDE - 5} y={TOP - 5} width={width * U + 10} height={height * U + 10} rx={8} fill="none" stroke="#000" strokeOpacity={lightCase ? 0.14 : 0.35} strokeWidth={1} />

      {keys.map((k, i) => {
        const x = SIDE + k.x * U + 1.5;
        const y = TOP + k.y * U + 1.5;
        const w = k.w * U - 3;
        const h = k.h * U - 3;
        const base = fill[k.group];
        // Lower rows sit taller in a sculpted profile, so more front wall shows.
        const wall = (dcs ? 7 : 8) + Math.min(rowOf(k.y), 5) * (dcs ? 0.8 : 1.1);
        const inset = dcs ? 4 : 4.5;
        const topW = w - inset * 2;
        const topH = h - 2 - wall;
        const small = k.legend.length > 1;
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx={5} fill={mix(base, "black", isLight(base) ? 0.1 : 0.2)} />
            <rect x={x} y={y} width={w} height={h} rx={5} fill={`url(#${id}-wall)`} />
            <rect x={x + inset} y={y + 2} width={topW} height={topH} rx={dcs ? 5 : 4} fill={base} />
            <rect x={x + inset} y={y + 2} width={topW} height={topH} rx={dcs ? 5 : 4} fill={`url(#${id}-dish)`} />
            <line x1={x + inset + 3} y1={y + 2.6} x2={x + inset + topW - 3} y2={y + 2.6} stroke="#fff" strokeOpacity={0.35} strokeWidth={0.8} />
            {legends && k.legend && (
              <text x={x + inset + 4} y={y + (small ? 12.5 : 14.5)} fontSize={small ? 8.5 : 11} fontWeight={600} fill={ink[k.group]} fontFamily="ui-sans-serif, system-ui, sans-serif">
                {k.legend}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );

  if (!tilt) return svg;
  return (
    <div style={{ perspective: "1600px" }}>
      <div style={{ transform: "rotateX(24deg)", transformOrigin: "50% 100%" }}>{svg}</div>
    </div>
  );
}
