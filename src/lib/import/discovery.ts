import { prisma } from "@/lib/prisma";
import { isBlockedVendorSet } from "./vendor-overrides";
import { NONBASE_SUBKIT_RE, PRODUCT_ACCESSORY_RE } from "@/lib/kit-variants";

// A catalog product whose RAW title names a subkit or accessory must never be
// linked as a set's VendorKit: normalizeSetName strips bracketed qualifiers,
// so "GMK Foo (Novelties)" would otherwise collide with the set name and the
// relink branch would overwrite the base product's URL — the price pass then
// stores the subkit's lone "Default Title" variant as the base price.
// "alphas" is matched plural-only so a set legitimately named "… Alpha" still
// links. ("extras" is NOT in this list — extras listings sell the base kit.)
const SUBKIT_PRODUCT_RE = new RegExp(
  `novelt|space\\s*bars?|\\balphas\\b|${NONBASE_SUBKIT_RE.source}|${PRODUCT_ACCESSORY_RE.source}`,
  "i"
);

// Catalog discovery: instead of trusting the (often stale) per-set product
// URLs from KeycapLendar, walk each vendor's own Shopify catalog, find every
// listing titled "GMK …", match it to a set we track, and wire it up as a
// scrapeable VendorKit. The nightly price refresh then prices it like any
// other row. Vendors are scanned a few per run, oldest-first, so the whole
// roster is re-crawled every few days without ever blowing the serverless
// time budget.

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_TIMEOUT_MS = 8000;

// Shopify caps products.json at 250 per page; 4 pages = 1000 products covers
// every keyboard store's full catalog comfortably.
const MAX_CATALOG_PAGES = 4;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface CatalogProduct {
  title: string;
  url: string;
}

// ── Shopify path ────────────────────────────────────────────────────────────
// Pull every product titled "GMK …" from a Shopify store's public catalog.
// Returns null when the store isn't Shopify / blocks the endpoint, so the
// caller can tell "no GMK products" apart from "couldn't look".
async function fetchGmkCatalogShopify(origin: string): Promise<CatalogProduct[] | null> {
  const found: CatalogProduct[] = [];
  for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
    let products: Array<{ title?: string; handle?: string }>;
    try {
      const res = await fetchWithTimeout(`${origin}/products.json?limit=250&page=${page}`);
      if (!res.ok) return page === 1 ? null : found;
      const data = (await res.json()) as { products?: Array<{ title?: string; handle?: string }> };
      products = data.products ?? [];
    } catch {
      return page === 1 ? null : found;
    }

    for (const p of products) {
      const title = String(p.title ?? "");
      if (!p.handle || !/\bGMK\b/i.test(title)) continue;
      found.push({ title, url: `${origin}/products/${p.handle}` });
    }
    if (products.length < 250) break; // last page
  }
  return found;
}

// ── Generic HTML path (non-Shopify stores) ──────────────────────────────────
// No catalog API, but every vendor homepage links a "Group Buys" / "Pre-order"
// section. Crawl: homepage → section pages → anchor links titled "GMK …".

const SECTION_LINK_RE = /group[\s_-]?buys?|pre[\s_-]?orders?|in[\s_-]?stock/i;
const MAX_SECTION_PAGES = 3;

interface PageLink {
  href: string;
  text: string;
}

function extractLinks(html: string, baseUrl: string): PageLink[] {
  const links: PageLink[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    try {
      links.push({ href: new URL(m[1], baseUrl).href, text });
    } catch {
      // unparseable href — skip
    }
  }
  return links;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchGmkCatalogHtml(origin: string): Promise<CatalogProduct[]> {
  const home = await fetchHtml(origin);
  if (!home) return [];

  const homeLinks = extractLinks(home, origin);
  const sameOrigin = (href: string) => {
    try {
      return new URL(href).origin === origin;
    } catch {
      return false;
    }
  };

  // Candidate section pages: nav links that look like a GB/pre-order section.
  const sectionUrls = Array.from(
    new Set(
      homeLinks
        .filter(
          (l) => sameOrigin(l.href) && (SECTION_LINK_RE.test(l.text) || SECTION_LINK_RE.test(l.href))
        )
        .map((l) => l.href)
    )
  ).slice(0, MAX_SECTION_PAGES);

  // The homepage itself often lists current GBs — scan it too.
  const pages = [homeLinks];
  for (const url of sectionUrls) {
    const html = await fetchHtml(url);
    if (html) pages.push(extractLinks(html, url));
  }

  const seen = new Set<string>();
  const found: CatalogProduct[] = [];
  for (const links of pages) {
    for (const l of links) {
      if (!sameOrigin(l.href) || !/\bGMK\b/i.test(l.text) || seen.has(l.href)) continue;
      seen.add(l.href);
      found.push({ title: l.text, url: l.href });
    }
  }
  return found;
}

// Shopify catalog first (rich, one request); generic HTML crawl otherwise.
async function fetchGmkCatalog(origin: string): Promise<CatalogProduct[]> {
  const shopify = await fetchGmkCatalogShopify(origin);
  if (shopify !== null) return shopify;
  return fetchGmkCatalogHtml(origin);
}

// Normalize a set/product name for matching: drop bracketed tags ("[GB]",
// "(Pre-order)"), sales-status words, keycap filler words; unify "Round 3"
// with "R3"; strip punctuation.
export function normalizeSetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(group\s*buy|groupbuy|gb|pre[- ]?order|in[- ]?stock|extras?|live|launch(ed)?)\b/g, " ")
    // "cyl"/"mtnu" are GMK profile tokens, not set identity: "GMK CYL Seafarer"
    // is the same set as "GMK Seafarer" (vendor outlets and gmk.net both add it).
    .replace(/\b(keycap\s*sets?|keycaps?|keysets?|cherry\s*profile|cyl|mtnu)\b/g, " ")
    .replace(/\bround\s*(\d+)\b/g, "r$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "gmk striker r2" -> "gmk striker"; names without a round tag are unchanged.
function stripRound(normalized: string): string {
  return normalized.replace(/\s+r\d+$/, "").trim();
}

interface SetIndexEntry {
  groupBuyId: string;
  slug: string;
  baseKitId: string;
  status: string;
  gbStart: Date | null;
}

interface SetIndex {
  byFull: Map<string, SetIndexEntry>;
  byBase: Map<string, SetIndexEntry[]>;
}

async function buildSetIndex(): Promise<SetIndex> {
  const sets = await prisma.groupBuy.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      gbStart: true,
      kits: { where: { type: "BASE" }, take: 1, select: { id: true } },
    },
  });

  const byFull = new Map<string, SetIndexEntry>();
  const byBase = new Map<string, SetIndexEntry[]>();
  for (const s of sets) {
    const baseKit = s.kits[0];
    if (!baseKit) continue;
    const entry: SetIndexEntry = {
      groupBuyId: s.id,
      slug: s.slug,
      baseKitId: baseKit.id,
      status: s.status,
      gbStart: s.gbStart,
    };
    const full = normalizeSetName(s.name);
    if (full) byFull.set(full, entry);
    const base = stripRound(full);
    if (base) {
      const list = byBase.get(base) ?? [];
      list.push(entry);
      byBase.set(base, list);
    }
  }
  return { byFull, byBase };
}

// Match one product title to a tracked set. Exact (round-aware) name match
// wins; otherwise fall back to the base name and prefer the round that's
// actually selling (ACTIVE_GB), then the newest round. Returns null rather
// than guessing across genuinely different sets.
function matchProduct(title: string, index: SetIndex): SetIndexEntry | null {
  const full = normalizeSetName(title);
  if (!full) return null;

  const exact = index.byFull.get(full);
  if (exact) return exact;

  const candidates = index.byBase.get(stripRound(full));
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const active = candidates.filter((c) => c.status === "ACTIVE_GB");
  if (active.length === 1) return active[0];

  const pool = active.length > 0 ? active : candidates;
  return [...pool].sort(
    (a, b) => (b.gbStart?.getTime() ?? 0) - (a.gbStart?.getTime() ?? 0)
  )[0];
}

export interface DiscoveryOptions {
  vendorLimit?: number; // stores to scan this run
  maxRuntimeMs?: number; // wall-clock budget; stop starting new stores past this
}

export interface DiscoveryResult {
  vendorsScanned: number;
  gmkListings: number;
  linked: number; // new VendorKits created
  relinked: number; // existing VendorKits whose productUrl was refreshed
  stoppedEarly: boolean;
}

export async function discoverGmkProducts(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const { vendorLimit = 6, maxRuntimeMs = 20_000 } = opts;
  const start = Date.now();
  const result: DiscoveryResult = {
    vendorsScanned: 0,
    gmkListings: 0,
    linked: 0,
    relinked: 0,
    stoppedEarly: false,
  };

  const vendors = await prisma.vendor.findMany({
    orderBy: [{ lastDiscoveredAt: { sort: "asc", nulls: "first" } }],
    take: vendorLimit,
    select: { id: true, slug: true, websiteUrl: true },
  });
  if (vendors.length === 0) return result;

  const index = await buildSetIndex();

  for (const vendor of vendors) {
    if (Date.now() - start > maxRuntimeMs) {
      result.stoppedEarly = true;
      break;
    }

    // Mark the attempt up front so a store that hangs or blocks us still
    // rotates to the back of the queue instead of being retried every run.
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { lastDiscoveredAt: new Date() },
    });
    result.vendorsScanned++;

    const origin = (() => {
      try {
        return new URL(vendor.websiteUrl).origin;
      } catch {
        return null;
      }
    })();
    if (!origin) continue;

    const catalog = await fetchGmkCatalog(origin);
    if (catalog.length === 0) continue;
    result.gmkListings += catalog.length;

    // Existing links for this vendor, so we only touch rows that changed and
    // never clobber a manually-entered price's URL.
    const existing = await prisma.vendorKit.findMany({
      where: { vendorId: vendor.id },
      select: { kitId: true, productUrl: true, priceSource: true },
    });
    const existingByKit = new Map(existing.map((e) => [e.kitId, e]));

    for (const product of catalog) {
      // Subkit/accessory products (novelties, spacebars, deskmats…) are never
      // the set's base listing — skip before matching.
      if (SUBKIT_PRODUCT_RE.test(product.title)) continue;
      const match = matchProduct(product.title, index);
      if (!match) continue;
      // Owner removed this vendor for this set — don't re-create/relink it.
      if (isBlockedVendorSet(vendor.slug, match.slug)) continue;

      const current = existingByKit.get(match.baseKitId);
      if (!current) {
        await prisma.vendorKit.create({
          data: {
            kitId: match.baseKitId,
            vendorId: vendor.id,
            productUrl: product.url,
            gbUrl: product.url,
            inStock: true,
          },
        });
        // Keep the in-memory view consistent in case the catalog lists the
        // same set twice (e.g. GB page + extras page) — first one wins.
        existingByKit.set(match.baseKitId, {
          kitId: match.baseKitId,
          productUrl: product.url,
          priceSource: null,
        });
        result.linked++;
      } else if (current.priceSource !== "MANUAL" && current.productUrl !== product.url) {
        // The store moved/renamed the listing — point at the live page and
        // re-queue so the next price run scrapes the fresh URL.
        await prisma.vendorKit.update({
          where: { kitId_vendorId: { kitId: match.baseKitId, vendorId: vendor.id } },
          data: { productUrl: product.url, gbUrl: product.url, priceUpdatedAt: null },
        });
        existingByKit.set(match.baseKitId, { ...current, productUrl: product.url });
        result.relinked++;
      }
    }
  }

  return result;
}
