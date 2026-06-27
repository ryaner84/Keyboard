// Geekhack / vendor group-buy descriptions are scraped as one flattened wall of
// prose, but they almost always contain the exact facts a keyboard collector
// wants — the regional VENDOR list, the group-buy DATES + ETA, the hardware
// SPECS, and the per-colourway PRICING — written as "Label: value" runs. This
// parser pulls those out so the set page can present them as structured key
// info instead of a giant paragraph. It is intentionally conservative: it only
// emits a field when it confidently matches a known label, and returns empty
// sections otherwise (the page then just shows the raw description).

export interface DetailRow {
  label: string;
  value: string;
}

export interface VendorRow {
  region: string; // friendly region name, e.g. "United States"
  name: string; // vendor/store name as written, e.g. "CannonKeys"
}

export interface EditionRow {
  name: string; // colourway / edition name, e.g. "Alta Dolch"
  price: string; // price as written, e.g. "$399"
}

export interface KeyboardDetails {
  timeline: DetailRow[]; // IC / Group buy window / ETA
  vendors: VendorRow[]; // regional vendor list
  specs: DetailRow[]; // layout, mount, angle, PCB, weight, plate…
  editions: EditionRow[]; // colourway → price
}

// Region spelling → friendly label. Covers BOTH the code form ("US: CannonKeys")
// and the full-name form ("United States - CannonKeys" / "America - Divinikey")
// that GB posts use interchangeably. Ambiguous two-letter English fragments
// (IN/ID/SA/NA/MY/OR) are intentionally omitted as codes — the full names are
// kept — so we don't mis-read prose; a marker only counts when a ":" or "-"
// separator follows it anyway.
const REGION_LEXICON: Record<string, string> = {
  "united states": "United States", usa: "United States", "u.s.a": "United States",
  "u.s.": "United States", us: "United States", america: "United States",
  "north america": "North America",
  "united kingdom": "United Kingdom", uk: "United Kingdom", "u.k.": "United Kingdom",
  britain: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom",
  europe: "Europe", eu: "Europe", eur: "Europe", "european union": "Europe",
  canada: "Canada", ca: "Canada", can: "Canada",
  australia: "Australia", au: "Australia", aus: "Australia",
  oceania: "Oceania", oce: "Oceania", anz: "Oceania",
  "new zealand": "New Zealand", nz: "New Zealand",
  china: "China", cn: "China", "mainland china": "China", prc: "China",
  "hong kong": "Hong Kong", hk: "Hong Kong", taiwan: "Taiwan", tw: "Taiwan",
  japan: "Japan", jp: "Japan", jpn: "Japan",
  korea: "Korea", "south korea": "Korea", kr: "Korea", kor: "Korea",
  singapore: "Singapore", sg: "Singapore", sgp: "Singapore",
  malaysia: "Malaysia", thailand: "Thailand", th: "Thailand", tha: "Thailand",
  indonesia: "Indonesia", philippines: "Philippines", ph: "Philippines",
  vietnam: "Vietnam", "viet nam": "Vietnam", vn: "Vietnam", india: "India",
  "southeast asia": "Southeast Asia", "se asia": "Southeast Asia", sea: "Southeast Asia",
  asia: "Asia", international: "International", intl: "International", int: "International",
  worldwide: "International", global: "International", "rest of world": "International",
  row: "International", "other regions": "International",
  mena: "MENA", "middle east": "MENA", "latin america": "Latin America",
  latam: "Latin America", "south america": "South America",
};
// Marker alternation, longest spelling first so "United Kingdom" beats "UK".
const REGION_MARKERS = Object.keys(REGION_LEXICON)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

// Sentence-starters that mark the end of a vendor list and the start of prose.
const VENDOR_PROSE_BREAK =
  /\s+(?:Due\s+to|Please\b|Therefore|Thanks\b|Thank\s+you|Hello\b|Note:|There\s+may|If\s+you\b|For\s+the\b|Kindly|We\s+will|We\s+have|Our\s|Each\s+vendor)/i;

// Decode the handful of HTML entities the scrape leaves in the text.
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&deg;/gi, "°")
    .replace(/&#39;|&rsquo;|&apos;/gi, "’")
    .replace(/&quot;/gi, '"');
}

// Tokens that begin a NEW labelled field or section — used as the right-hand
// boundary when capturing a field's value out of the run-together prose.
// Note: bare "Mount" is deliberately NOT a stop token — it would truncate a
// Mounting value of "Top mount" at "Top". The specific "Mounting style" form is
// enough to bound the preceding field.
const STOP_TOKENS = [
  "Vendors?", "Group\\s*Buys?", "GB\\s*dates?", "GB", "ETA", "IC",
  "Interest\\s*Check", "Layout", "Mounting\\s*style", "Typing\\s*angle",
  "Front\\s*height", "PCB", "Built\\s*weight", "Plate\\s*options?",
  "Case\\s*material", "MOQ", "Price", "Features?",
  "Compatibility", "Colou?rways?", "Photos?", "Specs?", "Sale\\s*Info",
  "Prototype", "In\\s*the\\s*Box", "What.{0,3}s\\s+In",
];
const SECTION_BREAK = "\\[\\s*\\/?\\s*(?:top|list)\\s*\\]";
const STOP_RE = `(?:\\b(?:${STOP_TOKENS.join("|")})\\b\\s*:?|${SECTION_BREAK})`;

// Capture the value following `label:` up to the next stop token (or end).
function grab(text: string, labelPattern: string): string | null {
  const re = new RegExp(
    `\\b(?:${labelPattern})\\s*:\\s*(.+?)(?=\\s*${STOP_RE}|$)`,
    "i"
  );
  const m = text.match(re);
  if (!m) return null;
  const value = m[1].replace(/\s+/g, " ").replace(/[|•]+\s*$/, "").trim();
  // Reject captures that are obviously not a value (a stray colon, a number
  // that's really the start of a list, etc.).
  return value.length >= 1 && value.length <= 240 ? value : null;
}

function parseVendors(text: string): VendorRow[] {
  // The label may be "Vendors:" or just "Vendors" before the list. Capture a
  // generous run after it, then trim where the list gives way to prose.
  const segMatch = text.match(
    new RegExp(`\\bVendors?\\s*:?\\s*(.{3,600}?)(?=\\s*${STOP_RE}|$)`, "i")
  );
  if (!segMatch) return [];
  let segment = segMatch[1].split(VENDOR_PROSE_BREAK)[0];
  segment = segment.replace(/\s+/g, " ").trim();

  // A region marker (code OR full name) followed by ":" or "-" then the vendor
  // name, which runs until the next marker or the end. Handles both
  // "US: CannonKeys" and "United States - CannonKeys" / "America - Divinikey".
  const pairRe = new RegExp(
    `\\b(${REGION_MARKERS})\\s*[:\\-–—]\\s*(.+?)(?=\\s+\\b(?:${REGION_MARKERS})\\b\\s*[:\\-–—]|$)`,
    "gi"
  );
  const out: VendorRow[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(segment)) !== null) {
    const region = REGION_LEXICON[m[1].toLowerCase()] ?? m[1];
    let name = m[2].replace(/\s+/g, " ").replace(/[,;|]+$/, "").trim();
    // A name that's really a URL isn't a usable store label — skip the pair.
    if (/^https?:\/\//i.test(name) || !name) continue;
    // Drop a trailing URL the capture swept in ("iLumkb https://…").
    name = name.replace(/\s*https?:\/\/\S+$/i, "").trim();
    if (!name || name.length > 40) continue;
    const key = `${region}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ region, name });
  }
  return out;
}

// Dates are usually short; if the capture ran into a following sentence (no
// section break to bound it), keep just the part up to the first ". ".
function tidyDate(value: string | null): string | null {
  if (!value) return null;
  const head = value.split(/\.\s+(?=[A-Za-z])/)[0].replace(/[.,;]\s*$/, "").trim();
  return head.length ? head : null;
}

// Prose date range, e.g. "The GB will be open from March 23rd to April 24th".
function extractOpenRange(text: string): string | null {
  const date = `([A-Za-z]+\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?)`;
  const re = new RegExp(
    `\\b(?:GB|group\\s*buy|sale)\\b[^.]{0,40}?\\b(?:open|live|run(?:ning|s)?|launch(?:ed|es|ing)?|start(?:s|ing)?)\\b[^.]{0,20}?\\bfrom\\s+${date}\\s*(?:to|until|through|[-–—])\\s*${date}`,
    "i"
  );
  const m = text.match(re);
  return m ? `${m[1].trim()} – ${m[2].trim()}` : null;
}

function parseTimeline(text: string): DetailRow[] {
  const rows: DetailRow[] = [];
  const ic = tidyDate(grab(text, "IC|Interest\\s*Check"));
  const gb =
    tidyDate(grab(text, "Group\\s*Buys?|GB\\s*period|GB\\s*dates?|Sale\\s*period|GB")) ??
    extractOpenRange(text);
  const eta = tidyDate(grab(text, "ETA|Estimated\\s*Ship(?:ping)?|Shipping\\s*ETA"));
  if (ic && /\d/.test(ic)) rows.push({ label: "Interest check", value: ic });
  if (gb) rows.push({ label: "Group buy", value: gb });
  if (eta) rows.push({ label: "Est. shipping", value: eta });
  return rows;
}

// Spec label → display name. Each value is captured up to the next stop token.
const SPEC_LABELS: Array<{ pattern: string; label: string }> = [
  { pattern: "Layout", label: "Layout" },
  { pattern: "Mounting\\s*style|Mount", label: "Mounting" },
  { pattern: "Typing\\s*angle", label: "Typing angle" },
  { pattern: "Front\\s*height", label: "Front height" },
  { pattern: "PCB", label: "PCB" },
  { pattern: "Built\\s*weight|Weight", label: "Weight" },
  { pattern: "Plate\\s*options?|Plate", label: "Plate" },
  { pattern: "Case\\s*material|Material", label: "Material" },
  { pattern: "MOQ", label: "MOQ" },
];

function parseSpecs(text: string): DetailRow[] {
  const rows: DetailRow[] = [];
  const seen = new Set<string>();
  for (const { pattern, label } of SPEC_LABELS) {
    if (seen.has(label)) continue;
    const value = grab(text, pattern);
    if (value) {
      rows.push({ label, value });
      seen.add(label);
    }
  }
  return rows;
}

// Leading words that are section headings, not part of an edition name.
const NOISE_WORDS = new Set([
  "sale", "info", "specs", "spec", "photos", "photo", "colourways", "colorways",
  "compatibility", "box", "vendors", "the", "and", "prototype", "pricing",
  "in", "what", "whats", "what’s", "what's", "of",
]);

function parseEditions(text: string): EditionRow[] {
  // "Alta Dolch - $399 Alta Luna - $399 … Alta Labe - $575"
  const re = /([A-Z][A-Za-z0-9][A-Za-z0-9 .'/-]{1,34}?)\s*[-–—]\s*(\$\s?[\d,]+(?:\.\d{2})?)/g;
  const out: EditionRow[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Strip any leading section-heading words the greedy capture swept in.
    const words = m[1].trim().split(/\s+/);
    while (words.length > 1 && NOISE_WORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    const name = words.join(" ").trim();
    const price = m[2].replace(/\s+/g, "");
    if (!name || NOISE_WORDS.has(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, price });
    if (out.length >= 12) break;
  }
  return out;
}

export function parseKeyboardDetails(
  description: string | null | undefined
): KeyboardDetails {
  const empty: KeyboardDetails = { timeline: [], vendors: [], specs: [], editions: [] };
  if (!description || description.length < 20) return empty;
  const text = decodeEntities(description);
  return {
    timeline: parseTimeline(text),
    vendors: parseVendors(text),
    specs: parseSpecs(text),
    editions: parseEditions(text),
  };
}

// True when the parser found anything worth rendering as structured info.
export function hasKeyboardDetails(d: KeyboardDetails): boolean {
  return (
    d.timeline.length > 0 ||
    d.vendors.length > 0 ||
    d.specs.length > 0 ||
    d.editions.length > 0
  );
}
