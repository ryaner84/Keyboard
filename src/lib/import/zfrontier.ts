// zFrontier (z客) calendar scraper — keyboards category only.
//
// zFrontier is a Chinese keyboard/keycap community platform. Their calendar
// at /app/calendar shows upcoming and ongoing GBs filtered by category:
//   键盘 (keyboard) · 键帽 (keycap) · 轴体 (switch) · 其它 (other)
//
// Strategy (tried in order, first success wins):
//   1. Internal REST API — most likely endpoint patterns based on the SPA structure.
//   2. SSR page parse — look for window.__INITIAL_STATE__ or JSON script tags.
//
// All product names may be in Chinese or mixed CJK+Latin; we store them as-is.
// The $300 USD minimum price guard (shared with keyboard-vendors.ts) keeps
// accessories and cheap items from polluting the keyboard GB list.

import { prisma } from "@/lib/prisma";
import type { GBStatus } from "@/generated/prisma";

const BASE = "https://www.zfrontier.com";
const FETCH_TIMEOUT_MS = 12_000;
const KEYBOARD_MIN_PRICE_USD = 300;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/html, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.zfrontier.com/",
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: { ...HEADERS, Accept: "application/json" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: { ...HEADERS, Accept: "text/html,*/*" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Data types (zFrontier calendar item, field names inferred from SPA) ──────

interface ZFItem {
  id?: number | string;
  title?: string;
  name?: string;
  // Status labels may be Chinese ("众筹中"=active, "IC阶段"=IC, "已结束"=ended)
  // or English tags depending on the endpoint.
  status?: string | number;
  state?: string;
  tag?: string;
  tags?: string[];
  // Price — may be CNY, USD, or absent
  price?: number | string;
  currency?: string;
  // Dates
  start_time?: string;
  end_time?: string;
  gb_start?: string;
  gb_end?: string;
  startTime?: string;
  endTime?: string;
  // Images
  cover?: string;
  image?: string;
  thumb?: string;
  images?: string[];
  // URL / identifier
  url?: string;
  slug?: string;
  handle?: string;
  link?: string;
}

interface ZFListResponse {
  data?: ZFItem[] | { list?: ZFItem[]; items?: ZFItem[] };
  list?: ZFItem[];
  items?: ZFItem[];
  result?: ZFItem[] | { list?: ZFItem[]; items?: ZFItem[] };
  code?: number;
}

// ── Status mapping ────────────────────────────────────────────────────────────

// Chinese status strings from zFrontier calendar
const STATUS_MAP: Record<string, GBStatus> = {
  // Chinese
  "众筹中": "ACTIVE_GB",
  "团购中": "ACTIVE_GB",
  "进行中": "ACTIVE_GB",
  "预售中": "ACTIVE_GB",
  "IC阶段": "INTEREST_CHECK",
  "IC中": "INTEREST_CHECK",
  "已结束": "DELIVERED",
  "已完成": "DELIVERED",
  "发货中": "SHIPPING",
  "运输中": "SHIPPING",
  "已发货": "SHIPPING",
  "现货": "IN_STOCK",
  // English equivalents some endpoints may return
  "active": "ACTIVE_GB",
  "group_buy": "ACTIVE_GB",
  "gb": "ACTIVE_GB",
  "ic": "INTEREST_CHECK",
  "interest_check": "INTEREST_CHECK",
  "shipping": "SHIPPING",
  "delivered": "DELIVERED",
  "in_stock": "IN_STOCK",
};

function mapStatus(raw?: string | number): GBStatus {
  if (!raw) return "ACTIVE_GB";
  const s = String(raw).trim();
  return STATUS_MAP[s] ?? STATUS_MAP[s.toLowerCase()] ?? "ACTIVE_GB";
}

// ── Price parsing ─────────────────────────────────────────────────────────────

function parsePrice(raw?: number | string): number | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

// ── Extract items from various response shapes ────────────────────────────────

function extractItems(body: ZFListResponse | ZFItem[]): ZFItem[] {
  if (Array.isArray(body)) return body;
  const candidates = [
    body.data,
    body.list,
    body.items,
    body.result,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === "object") {
      const inner = (c as { list?: ZFItem[]; items?: ZFItem[] }).list ?? (c as { items?: ZFItem[] }).items;
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

// ── Parse SSR page for embedded JSON state ────────────────────────────────────

function parseSSR(html: string): ZFItem[] {
  // Try window.__INITIAL_STATE__ (Vue SSR pattern)
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      // Look for calendar/flow data anywhere in the state tree
      const search = (obj: unknown, depth = 0): ZFItem[] => {
        if (depth > 5 || !obj || typeof obj !== "object") return [];
        if (Array.isArray(obj) && obj.length > 0 && (obj[0]?.title || obj[0]?.name)) {
          return obj as ZFItem[];
        }
        for (const v of Object.values(obj as Record<string, unknown>)) {
          const found = search(v, depth + 1);
          if (found.length > 0) return found;
        }
        return [];
      };
      const items = search(state);
      if (items.length > 0) return items;
    } catch {
      // ignore parse error
    }
  }

  // Try <script type="application/json"> blocks
  const jsonBlockRe = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = jsonBlockRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const items = extractItems(parsed as ZFListResponse);
      if (items.length > 0) return items;
    } catch {
      // ignore
    }
  }

  return [];
}

// ── Slug builder ──────────────────────────────────────────────────────────────

function makeSlug(item: ZFItem, index: number): string {
  const base = item.slug ?? item.handle ?? item.url?.split("/").pop() ?? String(item.id ?? index);
  const title = (item.title ?? item.name ?? "").toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60);
  return `zf-${base || title || index}`.slice(0, 120);
}

// ── Primary: try known API endpoint patterns ──────────────────────────────────

// zFrontier category IDs for keyboards (most likely values based on UI order)
const KEYBOARD_CATEGORY_CANDIDATES = [
  // Endpoint pattern 1: /api/flows with category filter
  `${BASE}/api/flows?type=keyboard&page=1&limit=100`,
  `${BASE}/api/flows?cate=keyboard&page=1&limit=100`,
  `${BASE}/api/flows?category=keyboard&page=1&limit=100`,
  `${BASE}/api/flows?type=1&page=1&limit=100`,
  `${BASE}/api/flows?cate=1&page=1&limit=100`,
  // Endpoint pattern 2: /api/calendar
  `${BASE}/api/calendar?type=keyboard&limit=100`,
  `${BASE}/api/calendar?cate=1&limit=100`,
  `${BASE}/api/calendar/keyboard`,
  // Endpoint pattern 3: /v2/ prefix
  `${BASE}/v2/flows?type=keyboard&page=1`,
  `${BASE}/v2/calendar?type=1`,
];

async function tryApiEndpoints(): Promise<ZFItem[]> {
  for (const url of KEYBOARD_CATEGORY_CANDIDATES) {
    const data = await fetchJson<ZFListResponse | ZFItem[]>(url);
    if (!data) continue;
    const items = extractItems(data as ZFListResponse);
    if (items.length > 0) {
      console.log(`[zfrontier] API hit: ${url} → ${items.length} items`);
      return items;
    }
  }
  return [];
}

// ── Fallback: HTML page with keyboard filter ──────────────────────────────────

const HTML_CANDIDATES = [
  `${BASE}/app/calendar?type=keyboard`,
  `${BASE}/app/calendar?cate=1`,
  `${BASE}/app/calendar?type=1`,
];

async function tryHtmlPage(): Promise<ZFItem[]> {
  for (const url of HTML_CANDIDATES) {
    const html = await fetchHtml(url);
    if (!html) continue;
    const items = parseSSR(html);
    if (items.length > 0) {
      console.log(`[zfrontier] SSR hit: ${url} → ${items.length} items`);
      return items;
    }
  }
  return [];
}

// ── Main import ───────────────────────────────────────────────────────────────

export interface ZFrontierResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  endpointUsed: string | null;
}

export async function importZFrontierKeyboards(): Promise<ZFrontierResult> {
  const result: ZFrontierResult = {
    fetched: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    endpointUsed: null,
  };

  // Try API first, then HTML SSR parse.
  let items = await tryApiEndpoints();
  if (items.length === 0) {
    items = await tryHtmlPage();
  }

  if (items.length === 0) {
    result.errors.push("No data found — all API and SSR attempts failed. zFrontier may require auth or has changed its endpoint structure.");
    return result;
  }

  // Filter: keyboards only. Drop anything suspiciously cheap.
  const keyboardItems = items.filter((item) => {
    const price = parsePrice(item.price);
    // If price is present, enforce the minimum. If absent, include (let admin triage).
    if (price !== null && price < KEYBOARD_MIN_PRICE_USD) return false;
    return true;
  });

  result.fetched = keyboardItems.length;

  for (let i = 0; i < keyboardItems.length; i++) {
    const item = keyboardItems[i];
    try {
      const slug = makeSlug(item, i);
      const name = item.title ?? item.name ?? slug;
      const status = mapStatus(item.status ?? item.state ?? item.tag);
      const imageUrl = item.cover ?? item.image ?? item.thumb ?? item.images?.[0] ?? null;
      const images = item.images ?? (imageUrl ? [imageUrl] : []);
      const gbStart = item.start_time ?? item.gb_start ?? item.startTime
        ? new Date(item.start_time ?? item.gb_start ?? item.startTime ?? "") : null;
      const gbEnd = item.end_time ?? item.gb_end ?? item.endTime
        ? new Date(item.end_time ?? item.gb_end ?? item.endTime ?? "") : null;

      const existing = await prisma.groupBuy.findUnique({
        where: { slug },
        select: { id: true, layout: true, mountingStyle: true, material: true },
      });

      if (!existing) {
        await prisma.groupBuy.create({
          data: {
            slug,
            name,
            designer: "zFrontier",
            status,
            productType: "KEYBOARD",
            imageUrl: imageUrl ?? undefined,
            images,
            gbStart: gbStart instanceof Date && !isNaN(gbStart.getTime()) ? gbStart : null,
            gbEnd: gbEnd instanceof Date && !isNaN(gbEnd.getTime()) ? gbEnd : null,
          },
        });
        result.created++;
      } else {
        await prisma.groupBuy.update({
          where: { slug },
          data: {
            name,
            status,
            imageUrl: imageUrl ?? undefined,
            images: images.length > 0 ? images : undefined,
            gbStart: gbStart instanceof Date && !isNaN(gbStart.getTime()) ? gbStart : undefined,
            gbEnd: gbEnd instanceof Date && !isNaN(gbEnd.getTime()) ? gbEnd : undefined,
          },
        });
        result.updated++;
      }
    } catch (err) {
      result.errors.push(`item[${i}]: ${err}`);
    }
  }

  return result;
}
