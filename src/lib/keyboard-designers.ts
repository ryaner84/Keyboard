// Showcase boards are scraped with an empty `designer` field — the maker is only
// identifiable from the board name (e.g. "Meletrix Zoom64", "Keycult 2/60",
// "TGR Jane v2"). A collector browses by maker, so we derive the designer/maker
// from the name against a curated dictionary of well-known custom-keyboard
// makers. This is the "classification" layer that powers the Showcase designer
// filter without needing a schema migration or a DB backfill.
//
// Entries are matched case-insensitively on a word boundary. Where a maker is
// written several ways in the wild, list the variants as `aliases` — the first
// `canonical` is what we display and filter by. Order matters only for tie
// breaking: longer, more specific names are tried before short generic ones.

interface DesignerEntry {
  canonical: string;
  // Extra spellings/sub-brands that should map to the same canonical maker.
  aliases?: string[];
}

// Curated, intentionally conservative — every entry is a recognised maker so a
// match is high-confidence. Keep multi-word / specific names above short ones.
const DESIGNERS: DesignerEntry[] = [
  { canonical: "Rama Works", aliases: ["Rama"] },
  { canonical: "Cannonkeys", aliases: ["Cannon Keys", "Bakeneko", "Brutalist"] },
  { canonical: "Wuque Studio", aliases: ["WS", "Wuque"] },
  { canonical: "Owlab", aliases: ["Owlab Studio", "Owl"] },
  { canonical: "Mode Designs", aliases: ["Mode"] },
  { canonical: "GeonWorks", aliases: ["Geon", "Frog TKL", "Glare"] },
  { canonical: "Mechlovin", aliases: ["Mechlovin'", "Mechlovin Studio"] },
  { canonical: "Meletrix", aliases: ["Zoom65", "Zoom64", "Zoom75", "Zoom98"] },
  { canonical: "Keycult", aliases: [] },
  { canonical: "TGR", aliases: [] },
  { canonical: "Norbauer", aliases: ["Norbatouch", "Heavy-9", "Seneca"] },
  { canonical: "Salvun", aliases: [] },
  { canonical: "Mekanisk", aliases: [] },
  { canonical: "Mintlodica", aliases: [] },
  { canonical: "Sneakbox", aliases: ["AL13", "Disarray", "Ava"] },
  { canonical: "Singa", aliases: [] },
  { canonical: "Cipulot", aliases: [] },
  { canonical: "Holy", aliases: ["Holy Panda"] },
  { canonical: "Mlego", aliases: ["M0lly", "M65"] },
  { canonical: "Vega", aliases: [] },
  { canonical: "Jris", aliases: ["Jris65"] },
  { canonical: "Monokei", aliases: ["Standard", "Tomo"] },
  { canonical: "Qlavier", aliases: [] },
  { canonical: "Studio Kestra", aliases: ["Kestra"] },
  { canonical: "Hineybush", aliases: [] },
  { canonical: "Percent Studio", aliases: ["Percent", "Booster"] },
  { canonical: "KBDfans", aliases: ["KBD", "Tofu", "Tiger"] },
  { canonical: "AEGIS", aliases: [] },
  { canonical: "Smith and Rune", aliases: ["Iron165", "Iron180", "Smith & Rune"] },
  { canonical: "Bachoo", aliases: [] },
  { canonical: "Bored Studio", aliases: ["Mr Suit", "Tokyo60"] },
  { canonical: "Swagkeys", aliases: ["Swag"] },
  { canonical: "Neson Design", aliases: ["Neson", "700E", "Gravity"] },
  { canonical: "Ai03", aliases: ["Vega", "Polaris", "Andromeda"] },
  { canonical: "E8 Keyboards", aliases: ["E8"] },
  { canonical: "Graystudio", aliases: ["Gray Studio", "Space65", "Think6.5"] },
  { canonical: "Yzomandias", aliases: [] },
  { canonical: "Tetris", aliases: [] },
  { canonical: "Geonworks", aliases: [] },
  { canonical: "Wraith", aliases: [] },
  { canonical: "Lizard", aliases: [] },
  { canonical: "Matrix", aliases: ["Matrix Lab", "8XV", "Abel", "Navi"] },
  { canonical: "Maxkey", aliases: [] },
  { canonical: "Merisi", aliases: [] },
  { canonical: "Sentraq", aliases: [] },
  { canonical: "Linworks", aliases: ["Fave87", "Fave84"] },
  { canonical: "PolarKey", aliases: [] },
  { canonical: "Phase Studios", aliases: ["Phase", "Mercury"] },
  { canonical: "Geekark", aliases: [] },
  { canonical: "Kapcave", aliases: [] },
  { canonical: "Krush", aliases: ["Krush60", "Krush65"] },
  { canonical: "Unikorn", aliases: [] },
  { canonical: "ALF", aliases: ["x2", "Dolch"] },
  { canonical: "Duck", aliases: ["Eduardo", "Octagon", "Orion", "Lightsaver"] },
  { canonical: "Exclusive", aliases: ["E6", "E7", "E8"] },
  { canonical: "Leeku", aliases: ["LZ", "Cooler"] },
  { canonical: "Rart", aliases: ["Rart75", "Rartand"] },
  { canonical: "Weikav", aliases: [] },
  { canonical: "Neo", aliases: ["Neo65", "Neo70", "Neo80"] },
  { canonical: "Kbdmania", aliases: [] },
];

// Pre-compute a flat, word-boundary-anchored matcher list, longest token first
// so "Wuque Studio" wins over a hypothetical bare "Studio".
const MATCHERS: { canonical: string; token: string }[] = DESIGNERS.flatMap(
  (entry) => [
    { canonical: entry.canonical, token: entry.canonical },
    ...(entry.aliases ?? []).map((a) => ({ canonical: entry.canonical, token: a })),
  ]
).sort((a, b) => b.token.length - a.token.length);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Derive the maker/designer for a board. Prefers an explicit stored designer
// (real group buys set this); otherwise parses the name against the dictionary.
// Returns null when nothing recognised matches, so callers can bucket those as
// "Other" rather than inventing a wrong attribution.
export function deriveDesigner(
  name: string | null | undefined,
  storedDesigner?: string | null
): string | null {
  const stored = (storedDesigner ?? "").trim();
  if (stored) return stored;
  if (!name) return null;
  for (const { canonical, token } of MATCHERS) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, "i");
    if (re.test(name)) return canonical;
  }
  return null;
}

// The set of canonical designers in the dictionary, for any UI that wants the
// full controlled vocabulary rather than only those present in the data.
export const KNOWN_DESIGNERS: string[] = Array.from(
  new Set(DESIGNERS.map((d) => d.canonical))
).sort((a, b) => a.localeCompare(b));
