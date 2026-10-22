import { LAYOUTS, accentLegend, isLight, layoutKeys, mix, type KeycapColors, type LayoutId } from "@/lib/keycap-visualizer";

const U = 40; // pixels per key unit
const PAD = 16; // case border around the keys

interface KeyboardRenderProps {
  layout: LayoutId;
  colors: KeycapColors;
  profile: "cherry" | "dcs";
  caseHex: string;
  legends?: boolean;
  shadow?: boolean;
  label?: string;
}

// Draws a keyboard as SVG so it stays sharp from a thumbnail up to the stage.
export function KeyboardRender({ layout, colors, profile, caseHex, legends = true, shadow = true, label }: KeyboardRenderProps) {
  const { keys, width, height } = layoutKeys(LAYOUTS[layout]);
  const fill = { a: colors.alpha, m: colors.mod, x: colors.accent };
  const ink = { a: colors.alphaLegend, m: colors.modLegend, x: accentLegend(colors) };
  const dcs = profile === "dcs";
  const W = width * U + PAD * 2;
  const H = height * U + PAD * 2;
  const floor = shadow ? 34 : 0;
  const lightCase = isLight(caseHex);

  return (
    <svg viewBox={`0 0 ${W} ${H + floor}`} className="w-full h-auto block" role="img" aria-label={label}>
      {shadow && (
        <>
          <defs>
            <filter id="kbv-floor" x="-20%" y="-200%" width="140%" height="500%">
              <feGaussianBlur stdDeviation="10" />
            </filter>
          </defs>
          <ellipse cx={W / 2} cy={H + 10} rx={W * 0.46} ry={14} fill="rgba(17,24,39,.28)" filter="url(#kbv-floor)" />
        </>
      )}
      <rect x={0} y={6} width={W} height={H} rx={18} fill={mix(caseHex, "black", lightCase ? 0.16 : 0.35)} />
      <rect x={0} y={0} width={W} height={H} rx={18} fill={caseHex} />
      <rect x={1.5} y={1.5} width={W - 3} height={H - 3} rx={17} fill="none" stroke={mix(caseHex, "white", lightCase ? 0.5 : 0.1)} strokeOpacity={0.5} />
      <rect x={PAD - 4} y={PAD - 4} width={width * U + 8} height={height * U + 8} rx={6} fill={mix(caseHex, "black", 0.55)} />
      {keys.map((k, i) => {
        const x = PAD + k.x * U + 1.5;
        const y = PAD + k.y * U + 1.5;
        const w = k.w * U - 3;
        const h = k.h * U - 3;
        const base = fill[k.group];
        const inset = dcs ? 4 : 5;
        const small = k.legend.length > 1;
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx={5} fill={mix(base, "black", isLight(base) ? 0.16 : 0.3)} />
            <rect x={x + inset} y={y + 2} width={w - inset * 2} height={h - (dcs ? 8 : 10)} rx={dcs ? 5 : 4} fill={base} />
            {legends && k.legend && (
              <text x={x + inset + 4} y={y + (small ? 13 : 15)} fontSize={small ? 8.5 : 11} fontWeight={600} fill={ink[k.group]} fontFamily="ui-sans-serif, system-ui, sans-serif">
                {k.legend}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
