// MatrixLab official Notion database scraper.
//
// Source: https://matrixlab.notion.site/?v=b2053c28d1614303a42a91b0a6762a5e
// This is MatrixLab's public-facing product/raffle tracker — the canonical
// reference for all their keyboard launches, raffle dates, and dev updates.
//
// Notion public pages expose data via their internal v1 API without auth.
// We load the root page chunk to discover the database collection ID, then
// query all records from that collection.

import { prisma } from "@/lib/prisma";
import type { GBStatus } from "@/generated/prisma";

const NOTION_DOMAIN = "https://matrixlab.notion.site";
const NOTION_API = "https://www.notion.so/api/v3";
const VENDOR_NAME = "MatrixLab";
const VENDOR_SLUG_PREFIX = "ml";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/html, */*",
  "Content-Type": "application/json",
};

const FETCH_TIMEOUT_MS = 15_000;

// ── Notion internal type helpers ─────────────────────────────────────────────

type NotionPropertyValue =
  | { type: "title"; title: Array<{ plain_text: string }> }
  | { type: "rich_text"; rich_text: Array<{ plain_text: string }> }
  | { type: "select"; select: { name: string } | null }
  | { type: "multi_select"; multi_select: Array<{ name: string }> }
  | { type: "date"; date: { start: string; end?: string } | null }
  | { type: "number"; number: number | null }
  | { type: "url"; url: string | null }
  | { type: "files"; files: Array<{ name: string; file?: { url: string }; external?: { url: string } }> }
  | { type: "checkbox"; checkbox: boolean }
  | { type: "formula"; formula: { type: string; string?: string; number?: number } }
  | { type: "status"; status: { name: string } | null };

interface NotionPage {
  id: string;
  properties: Record<string, NotionPropertyValue>;
  url: string;
}

interface NotionDatabaseResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

// ── Property extraction helpers ───────────────────────────────────────────────

function getText(prop: NotionPropertyValue | undefined): string {
  if (!prop) return "";
  if (prop.type === "title") return prop.title.map((t) => t.plain_text).join("").trim();
  if (prop.type === "rich_text") return prop.rich_text.map((t) => t.plain_text).join("").trim();
  if (prop.type === "formula" && prop.formula.type === "string") return (prop.formula.string ?? "").trim();
  return "";
}

function getSelect(prop: NotionPropertyValue | undefined): string {
  if (!prop) return "";
  if (prop.type === "select") return prop.select?.name ?? "";
  if (prop.type === "status") return prop.status?.name ?? "";
  return "";
}

function getMultiSelect(prop: NotionPropertyValue | undefined): string[] {
  if (!prop || prop.type !== "multi_select") return [];
  return prop.multi_select.map((s) => s.name);
}

function getDate(prop: NotionPropertyValue | undefined): string | null {
  if (!prop || prop.type !== "date" || !prop.date) return null;
  return prop.date.start ?? null;
}

function getNumber(prop: NotionPropertyValue | undefined): number | null {
  if (!prop || prop.type !== "number") return null;
  return prop.number ?? null;
}

function getUrl(prop: NotionPropertyValue | undefined): string | null {
  if (!prop || prop.type !== "url") return null;
  return prop.url ?? null;
}

function getImage(prop: NotionPropertyValue | undefined): string | null {
  if (!prop || prop.type !== "files" || prop.files.length === 0) return null;
  const f = prop.files[0];
  return f.file?.url ?? f.external?.url ?? null;
}

// ── Status mapping ────────────────────────────────────────────────────────────

// MatrixLab uses their own status vocabulary in the Notion DB.
// These mappings will be refined once the actual property names are known.
const STATUS_MAP: Record<string, GBStatus> = {
  // Raffle / IC stages
  "interest check": "INTEREST_CHECK",
  ic: "INTEREST_CHECK",
  "raffle open": "ACTIVE_GB",
  "raffle ongoing": "ACTIVE_GB",
  "group buy": "ACTIVE_GB",
  "gb open": "ACTIVE_GB",
  open: "ACTIVE_GB",
  live: "ACTIVE_GB",
  "extra sale": "IN_STOCK",
  "in stock": "IN_STOCK",
  extras: "IN_STOCK",
  shipping: "SHIPPING",
  "in transit": "SHIPPING",
  delivered: "DELIVERED",
  fulfilled: "DELIVERED",
  complete: "DELIVERED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
};

function mapStatus(raw: string): GBStatus {
  if (!raw) return "INTEREST_CHECK";
  const lower = raw.toLowerCase().trim();
  for (const [key, status] of Object.entries(STATUS_MAP)) {
    if (lower.includes(key)) return status;
  }
  return "INTEREST_CHECK";
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, body?: object): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: HEADERS,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`[matrixlab-notion] ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[matrixlab-notion] fetch error:`, err);
    return null;
  }
}

// ── Discover the Notion database ID from the public page ─────────────────────
// Notion custom domains redirect to notion.so URLs that encode the page ID.
// We try multiple strategies to extract it.

async function discoverDatabaseId(): Promise<string | null> {
  // Strategy 1: follow the redirect from the custom domain root page and
  // parse the pageId from the redirected URL or the page HTML.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(NOTION_DOMAIN, {
      headers: { ...HEADERS, Accept: "text/html,*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    const html = await res.text();

    // Notion embeds the page ID in a <script> block as pageId or in __NEXT_DATA__.
    const idPattern = /['"]([\da-f]{8}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{12})['"]/gi;
    const ids: string[] = [];
    let m;
    while ((m = idPattern.exec(html)) !== null) {
      const id = m[1].replace(/-/g, "");
      if (!ids.includes(id)) ids.push(id);
    }

    // The first UUID in the page source is usually the root page ID.
    if (ids.length > 0) {
      console.log(`[matrixlab-notion] Discovered candidate page IDs: ${ids.slice(0, 3).join(", ")}`);
      return ids[0];
    }
  } catch (err) {
    console.warn(`[matrixlab-notion] Discovery via HTML failed:`, err);
  }

  // Strategy 2: the view param from the URL encodes the collection view ID,
  // which can be used to look up the collection.
  // ?v=b2053c28d1614303a42a91b0a6762a5e → view ID
  const viewId = "b2053c28d1614303a42a91b0a6762a5e";
  console.log(`[matrixlab-notion] Trying collection view lookup via viewId ${viewId}`);
  const viewData = await fetchJson<{ recordMap?: { collection_view?: Record<string, { value?: { collection_id?: string } }> } }>(
    `${NOTION_API}/getCollectionData`,
    {
      collectionViewId: viewId,
      query: { filter: { filters: [], operator: "and" }, sort: [] },
      loader: { type: "table", limit: 1, searchQuery: "" },
    }
  );
  if (viewData?.recordMap?.collection_view) {
    const views = Object.values(viewData.recordMap.collection_view);
    const collectionId = views[0]?.value?.collection_id;
    if (collectionId) {
      console.log(`[matrixlab-notion] Found collection ID via view: ${collectionId}`);
      return collectionId;
    }
  }

  return null;
}

// ── Fetch all records from the Notion database ───────────────────────────────

async function fetchAllRecords(databaseId: string): Promise<NotionPage[]> {
  // Try the official public Notion API first (no auth for public DBs).
  const formatted = databaseId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  while (true) {
    const body: Record<string, unknown> = {
      filter: {},
      sorts: [],
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetchJson<NotionDatabaseResult>(
      `${NOTION_API}/databases/${formatted}/query`,
      body
    );
    if (!res) break;
    pages.push(...res.results);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  // If the official query API returned nothing (not exposed as public DB),
  // fall back to the internal queryCollection endpoint.
  if (pages.length === 0) {
    console.log(`[matrixlab-notion] Official API returned 0 — trying internal queryCollection`);
    const res = await fetchJson<{ recordMap?: { block?: Record<string, { value?: Record<string, unknown> }> } }>(
      `${NOTION_API}/queryCollection`,
      {
        collectionId: databaseId,
        collectionViewId: "b2053c28d1614303a42a91b0a6762a5e",
        query: { filter: { filters: [], operator: "and" }, sort: [] },
        loader: { type: "table", limit: 200, searchQuery: "" },
      }
    );
    // Internal API returns blocks — we convert them to a page-like structure.
    if (res?.recordMap?.block) {
      for (const [id, block] of Object.entries(res.recordMap.block)) {
        if (block.value) {
          pages.push({ id, properties: block.value as Record<string, NotionPropertyValue>, url: "" });
        }
      }
    }
  }

  return pages;
}

// ── Main import function ──────────────────────────────────────────────────────

export interface MatrixLabNotionResult {
  pagesFound: number;
  created: number;
  updated: number;
  errors: string[];
  status: "ok" | "no_db_id" | "no_pages" | "partial";
}

export async function importMatrixLabNotion(): Promise<MatrixLabNotionResult> {
  const result: MatrixLabNotionResult = {
    pagesFound: 0,
    created: 0,
    updated: 0,
    errors: [],
    status: "ok",
  };

  const dbId = await discoverDatabaseId();
  if (!dbId) {
    console.warn("[matrixlab-notion] Could not discover database ID — skipping.");
    result.status = "no_db_id";
    return result;
  }

  const pages = await fetchAllRecords(dbId);
  result.pagesFound = pages.length;

  if (pages.length === 0) {
    console.warn("[matrixlab-notion] No pages returned from Notion DB.");
    result.status = "no_pages";
    return result;
  }

  console.log(`[matrixlab-notion] Processing ${pages.length} records`);

  for (const page of pages) {
    try {
      const props = page.properties;

      // Extract fields — property names will vary; getText() falls back gracefully.
      // Common Notion DB column names for keyboard trackers:
      const name = getText(props["Name"] ?? props["Project"] ?? props["Keyboard"] ?? props["Title"]);
      if (!name) continue; // skip rows with no name

      const rawStatus = getSelect(props["Status"] ?? props["Stage"] ?? props["Phase"]);
      const status = mapStatus(rawStatus);

      const gbStart = getDate(props["GB Start"] ?? props["Raffle Date"] ?? props["Launch Date"] ?? props["Start"]);
      const gbEnd = getDate(props["GB End"] ?? props["End Date"] ?? props["Deadline"]);
      const price = getNumber(props["Price"] ?? props["USD Price"] ?? props["Cost"]);
      const imageUrl = getImage(props["Image"] ?? props["Cover"] ?? props["Photo"]);
      const productUrl = getUrl(props["Link"] ?? props["URL"] ?? props["Store Link"] ?? props["Buy Link"]);
      const notes = getText(props["Notes"] ?? props["Description"] ?? props["Details"] ?? props["Update"]);

      const slug = `${VENDOR_SLUG_PREFIX}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 120);

      const existing = await prisma.groupBuy.findFirst({
        where: {
          OR: [
            { slug },
            { name: { equals: name, mode: "insensitive" }, vendorName: VENDOR_NAME },
          ],
        },
        select: { id: true, slug: true, layout: true, mountingStyle: true, material: true },
      });

      const sharedData = {
        name,
        status,
        productType: "KEYBOARD",
        vendorName: VENDOR_NAME,
        vendorRegion: "Global",
        gbStart: gbStart ? new Date(gbStart) : null,
        gbEnd: gbEnd ? new Date(gbEnd) : null,
        basePrice: price ?? undefined,
        priceCurrency: price ? "USD" : undefined,
        productUrl: productUrl ?? undefined,
        imageUrl: imageUrl ?? undefined,
        description: notes || null,
      };

      if (!existing) {
        await prisma.groupBuy.create({
          data: { ...sharedData, slug, designer: VENDOR_NAME },
        });
        result.created++;
      } else {
        await prisma.groupBuy.update({
          where: { id: existing.id },
          data: sharedData,
        });
        result.updated++;
      }
    } catch (err) {
      result.errors.push(`page ${page.id}: ${err}`);
    }
  }

  if (result.errors.length > 0) result.status = "partial";
  return result;
}
