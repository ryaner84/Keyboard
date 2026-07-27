import { DISPLAY_CURRENCIES } from "@/data/countries";

// CSV parsing + the keycap-import template. Hand-rolled on purpose: the only
// shape we need is a flat table, and the project deliberately keeps a lean
// dependency list (no csv/papaparse). Pure and dependency-free so it can be
// unit-tested with plain ts-node.

// ---------------------------------------------------------------------------
// Generic parser
// ---------------------------------------------------------------------------

// RFC4180-ish: quoted fields, "" escapes, embedded commas/newlines, CRLF, and a
// stripped UTF-8 BOM (Excel writes one and it would otherwise poison the first
// header cell). Returns raw cells; callers decide what the columns mean.
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      endField();
      i++;
      continue;
    }
    if (char === "\r") {
      // CRLF or a lone CR both end the row.
      if (input[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (char === "\n") {
      endRow();
      i++;
      continue;
    }
    field += char;
    i++;
  }
  // Trailing field/row unless the file ended exactly on a newline.
  if (field.length > 0 || row.length > 0) endRow();

  // Drop entirely blank lines (all cells empty) — common at the end of a file
  // and whenever a spreadsheet exports padding rows.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

// ---------------------------------------------------------------------------
// Keycap import template
// ---------------------------------------------------------------------------

export const KEYCAP_CONDITION_CODES = [
  "SEALED",
  "OPEN_UNUSED",
  "MOUNTED",
  "USED",
  "INCOMPLETE",
] as const;

// Accept the human labels the app itself displays, not just the codes — a
// collector copying from the UI shouldn't get a validation error.
const CONDITION_ALIASES: Record<string, string> = {
  SEALED: "SEALED",
  "OPEN / UNUSED": "OPEN_UNUSED",
  "OPENED / UNUSED": "OPEN_UNUSED",
  "OPENED/UNUSED": "OPEN_UNUSED",
  "OPEN UNUSED": "OPEN_UNUSED",
  OPENED: "OPEN_UNUSED",
  UNUSED: "OPEN_UNUSED",
  OPEN_UNUSED: "OPEN_UNUSED",
  MOUNTED: "MOUNTED",
  USED: "USED",
  INCOMPLETE: "INCOMPLETE",
};

export const KEYCAP_IMPORT_HEADERS = [
  "name",
  "kits",
  "quantity",
  "acquired_date",
  "price",
  "currency",
  "condition",
  "notes",
] as const;

// Header cells are matched loosely so "Set Name", "acquired date" and
// "Acquired_Date" all land on the right column.
const HEADER_ALIASES: Record<string, (typeof KEYCAP_IMPORT_HEADERS)[number]> = {
  name: "name",
  setname: "name",
  set: "name",
  keycapset: "name",
  kits: "kits",
  kit: "kits",
  kitsincluded: "kits",
  quantity: "quantity",
  qty: "quantity",
  acquireddate: "acquired_date",
  acquired: "acquired_date",
  date: "acquired_date",
  purchasedate: "acquired_date",
  price: "price",
  pricepaid: "price",
  totalpaid: "price",
  cost: "price",
  currency: "currency",
  condition: "condition",
  notes: "notes",
  note: "notes",
  comment: "notes",
};

function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_\-./]/g, "");
}

export interface KeycapImportRow {
  line: number; // 1-based line number in the user's file (header = 1)
  name: string;
  kits: string[];
  quantity: number;
  acquiredAt: string | null;
  price: number | null;
  currency: string | null;
  condition: string | null;
  notes: string | null;
  errors: string[]; // per-field problems; the row is still returned
}

export interface KeycapImportParseResult {
  rows: KeycapImportRow[];
  fileErrors: string[]; // problems with the file as a whole
}

// Numbers may arrive spreadsheet-mangled: "S$1,234.50", "1 234,50", "€130".
// Strip symbols/spaces, then decide which separator is decimal (the last one).
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.,-]/g, "").trim();
  if (!cleaned) return null;
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized = cleaned;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present — the rightmost is the decimal point.
    normalized =
      lastDot > lastComma
        ? cleaned.replace(/,/g, "")
        : cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    // Only commas: thousands groups (1,234 / 1,234,567) vs a decimal comma.
    normalized = /^-?\d{1,3}(,\d{3})+$/.test(cleaned)
      ? cleaned.replace(/,/g, "")
      : cleaned.replace(",", ".");
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

// Dates: ISO is trusted. Slash/dot forms are only accepted when unambiguous —
// 15/03/2024 is clearly D/M, but 03/04/2024 could be either, and silently
// guessing would write a wrong acquisition date into someone's ledger.
function parseImportDate(raw: string): { value: string | null; error?: string } {
  const text = raw.trim();
  if (!text) return { value: null };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (
      date.getUTCFullYear() !== Number(y) ||
      date.getUTCMonth() !== Number(m) - 1 ||
      date.getUTCDate() !== Number(d)
    ) {
      return { value: null, error: `Invalid date "${text}"` };
    }
    return { value: date.toISOString() };
  }

  const parts = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(text);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    const year = Number(parts[3]);
    let day: number;
    let month: number;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else {
      return {
        value: null,
        error: `Ambiguous date "${text}" — use YYYY-MM-DD`,
      };
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return { value: null, error: `Invalid date "${text}"` };
    }
    return { value: date.toISOString() };
  }

  const fallback = new Date(text);
  if (Number.isNaN(fallback.getTime())) {
    return { value: null, error: `Invalid date "${text}" — use YYYY-MM-DD` };
  }
  return { value: fallback.toISOString() };
}

const CURRENCY_CODES = new Set(DISPLAY_CURRENCIES.map((currency) => currency.code));

export function parseKeycapImportCsv(text: string): KeycapImportParseResult {
  const table = parseCsv(text);
  if (table.length === 0) {
    return { rows: [], fileErrors: ["That file is empty."] };
  }

  const header = table[0].map(headerKey);
  const columns = header.map((cell) => HEADER_ALIASES[cell] ?? null);
  if (!columns.includes("name")) {
    return {
      rows: [],
      fileErrors: [
        'No "name" column found. Download the template and keep its header row.',
      ],
    };
  }

  const cellFor = (
    cells: string[],
    column: (typeof KEYCAP_IMPORT_HEADERS)[number]
  ): string => {
    const index = columns.indexOf(column);
    return index >= 0 ? (cells[index] ?? "").trim() : "";
  };

  const rows: KeycapImportRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const errors: string[] = [];
    const name = cellFor(cells, "name");
    if (!name) {
      // A row with no set name can't be imported at all — report and keep going.
      errors.push("Missing set name");
    }

    const kits = cellFor(cells, "kits")
      .split(/[,;|]/)
      .map((kit) => kit.trim())
      .filter(Boolean)
      .filter((kit, index, all) => all.indexOf(kit) === index)
      .slice(0, 12);

    const quantityRaw = cellFor(cells, "quantity");
    let quantity = 1;
    if (quantityRaw) {
      const parsed = parseNumber(quantityRaw);
      if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > 99) {
        errors.push(`Quantity must be a whole number 1-99 (got "${quantityRaw}")`);
      } else {
        quantity = parsed;
      }
    }

    const dateRaw = cellFor(cells, "acquired_date");
    const parsedDate = parseImportDate(dateRaw);
    if (parsedDate.error) errors.push(parsedDate.error);

    const priceRaw = cellFor(cells, "price");
    let price: number | null = null;
    if (priceRaw) {
      const parsed = parseNumber(priceRaw);
      if (parsed === null || parsed < 0 || parsed > 10_000_000) {
        errors.push(`Invalid price "${priceRaw}"`);
      } else {
        price = parsed;
      }
    }

    const currencyRaw = cellFor(cells, "currency");
    let currency: string | null = null;
    if (currencyRaw) {
      const code = currencyRaw.toUpperCase();
      if (!CURRENCY_CODES.has(code)) {
        errors.push(`Unknown currency "${currencyRaw}"`);
      } else {
        currency = code;
      }
    }

    const conditionRaw = cellFor(cells, "condition");
    let condition: string | null = null;
    if (conditionRaw) {
      const mapped = CONDITION_ALIASES[conditionRaw.trim().toUpperCase()];
      if (!mapped) {
        errors.push(
          `Unknown condition "${conditionRaw}" — use ${KEYCAP_CONDITION_CODES.join(", ")}`
        );
      } else {
        condition = mapped;
      }
    }

    const notes = cellFor(cells, "notes").slice(0, 1000) || null;

    rows.push({
      line: i + 1,
      name,
      kits,
      quantity,
      acquiredAt: parsedDate.value,
      price,
      currency,
      condition,
      notes,
      errors,
    });
  }

  return { rows, fileErrors: [] };
}

// The downloadable starter file. Only `name` is required; the sample rows show
// a fully-populated row, a partial one, and a name-only one so the optionality
// is obvious without reading any docs.
export function buildKeycapTemplateCsv(): string {
  return toCsv([
    [...KEYCAP_IMPORT_HEADERS],
    [
      "GMK Olivia R2",
      "Base, Novelties",
      "1",
      "2024-03-15",
      "145",
      "USD",
      "SEALED",
      "Bought from a friend",
    ],
    ["GMK Bento", "Base", "1", "2023-11-02", "130", "SGD", "MOUNTED", ""],
    ["GMK Botanical", "", "", "", "", "", "", ""],
  ]);
}
