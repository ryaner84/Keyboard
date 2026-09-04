import { prisma } from "@/lib/prisma";
import { isBlockedVendorSet } from "./vendor-overrides";
import { NOT_MANUFACTURER_VENDOR } from "./manufacturer-vendors";
// One host list, one definition of "is this a shop" — shared with db-setup's
// storefront repairs rather than re-listed here.
import { hostKey, hostOfUrl, needsStorefront } from "../../../scripts/lib/vendor-urls.mjs";
// Same arrangement for "does this catalog entry say it is sold out" — one
// definition, mirrored in scrape.py and pinned by `npm run test:catalog-stock`.
import {
  catalogAvailability,
  catalogStockUpdate,
} from "../../../scripts/lib/catalog-stock.mjs";
// A catalog product whose RAW title names a subkit or accessory must never be
// linked as a set's VendorKit: normalizeSetName strips bracketed qualifiers,
// so "GMK Foo (Novelties)" would otherwise collide with the set name and the
// relink branch would overwrite the base product's URL — the price pass then
// stores the subkit's lone "Default Title" variant as the base price.
// ("extras" is NOT in this list — extras listings sell the base kit.)
//
// It used to be declared here. It is now imported, because the price passes ask
// the SAME question of the tracked set's own name to decide whether a subkit
// product is that set's base kit (see `allowSubkits`), and two copies of the
// vocabulary would answer differently the first time either was edited.
import { SUBKIT_PRODUCT_RE } from "@/lib/kit-variants";
import { TRACKED_PROFILE_RE } from "@/lib/set-name";

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

// How many rows to read for each rotation slot before the storefront test
// below throws the uncrawlable ones away. Non-storefront rows are a handful
// out of ~125 and db-setup shrinks that set every deploy, so 4x leaves plenty
// of headroom; the cost of guessing low is a short rotation, not a wrong one.
const DISCOVERY_OVERFETCH = 4;

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
  // What the feed said about stock: true, false, or null for "it did not say".
  // Null is not a synonym for false — a store whose feed omits `available`
  // would otherwise have its whole catalogue marked sold out. The HTML fallback
  // carries no stock information at all, so it is always null there.
  available: boolean | null;
}

// Keycap profiles we track. A vendor listing must name one of these to be
// considered — the profile token is what makes "DCS Dolch" a different product
// from "GMK Dolch", so it is matched here and deliberately kept in the set name.
//
// The list comes from set-name.ts, which is where the site's maker registry
// lives. It used to be a local `\b(?:GMK|DCS)\b`, narrower than that registry:
// every SA / DSS / DSA / MTNU / CYL product in every store catalog was dropped
// before matching, so a store selling those sets published nothing at all.
// Mirrored in scraper/scrape.py; `npm run test:set-name` fails if they drift.
// (Imported at the top of the file, with the other set-name helpers.)

// ── Shopify path ────────────────────────────────────────────────────────────
// Pull every product for a tracked profile (GMK / DCS …) from a Shopify store's
// public catalog. Returns null when the store isn't Shopify / blocks the
// endpoint, so the caller can tell "no matching products" apart from
// "couldn't look".
async function fetchGmkCatalogShopify(origin: string): Promise<CatalogProduct[] | null> {
  const found: CatalogProduct[] = [];
  for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
    type ShopifyCatalogProduct = {
      title?: string;
      handle?: string;
      variants?: Array<{ available?: unknown }>;
    };
    let products: ShopifyCatalogProduct[];
    try {
      const res = await fetchWithTimeout(`${origin}/products.json?limit=250&page=${page}`);
      if (!res.ok) return page === 1 ? null : found;
      const data = (await res.json()) as { products?: ShopifyCatalogProduct[] };
      products = data.products ?? [];
    } catch {
      return page === 1 ? null : found;
    }

    for (const p of products) {
      const title = String(p.title ?? "");
      if (!p.handle || !TRACKED_PROFILE_RE.test(title)) continue;
      found.push({
        title,
        url: `${origin}/products/${p.handle}`,
        available: catalogAvailability(p),
      });
    }
    if (products.length < 250) break; // last page
  }
  return found;
}

// ── Generic HTML path (non-Shopify stores) ──────────────────────────────────
// No catalog API, but every vendor homepage links a "Group Buys" / "Pre-order"
// section. Crawl: homepage → section pages → anchor links titled "GMK …".
//
// Mirrored in scraper/scrape.py (extract_page_links / catalog_section_urls /
// tracked_products_from_links). That half is the one that actually reaches
// these stores — a fifth of the roster is WooCommerce or bespoke, and until it
// grew this path their listings were never linked or relinked at all — so
// `npm run test:set-name` fails if the section pattern here and there disagree.

const SECTION_LINK_RE = /group[\s_-]?buys?|pre[\s_-]?orders?|in[\s_-]?stock/i;
const MAX_SECTION_PAGES = 3;

interface PageLink {
  href: string;
  text: string;
}

// Anchor text is markup plus entities: a product tile wraps its title in
// <span>/<h3>, and "GMK Black &amp; White" must normalise to the same key as
// the set's stored name — normalizeSetName would otherwise keep "amp" as a word
// and the listing would never match.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

function extractLinks(html: string, baseUrl: string): PageLink[] {
  const links: PageLink[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    try {
      links.push({ href: new URL(decodeEntities(m[1]).trim(), baseUrl).href, text });
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
  // Deliberately looser than comparing origins: a Vendor row carries whichever
  // spelling of the store someone typed, and it is regularly not the one the
  // site serves — donutcables and mechboards ship as http://, ashkeebs and
  // keebz-n-cables as www. An origin comparison would then read every anchor on
  // the store's own homepage as somebody else's site. Folds exactly what the
  // rest of the codebase folds (scheme and a leading "www."), so
  // en.zfrontier.com and www.zfrontier.com stay two different sites. Mirrored
  // by _same_site in scraper/scrape.py.
  const originHost = hostKey(hostOfUrl(origin));
  const sameSite = (href: string) => !!originHost && hostKey(hostOfUrl(href)) === originHost;

  // Candidate section pages: nav links that look like a GB/pre-order section.
  const sectionUrls = Array.from(
    new Set(
      homeLinks
        .filter(
          (l) => sameSite(l.href) && (SECTION_LINK_RE.test(l.text) || SECTION_LINK_RE.test(l.href))
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
      if (!sameSite(l.href) || !TRACKED_PROFILE_RE.test(l.text) || seen.has(l.href)) continue;
      seen.add(l.href);
      // An anchor on a storefront page says nothing about stock.
      found.push({ title: l.text, url: l.href, available: null });
    }
  }
  return found;
}

// Shopify catalog first (rich, one request); generic HTML crawl otherwise.
// `fromHtml` rides along because the two sources carry different authority: a
// Shopify feed states what is buyable and what it costs, an anchor on a
// homepage states neither — see the relink guard in discoverGmkProducts.
async function fetchGmkCatalog(
  origin: string
): Promise<{ products: CatalogProduct[]; fromHtml: boolean }> {
  const shopify = await fetchGmkCatalogShopify(origin);
  if (shopify !== null) return { products: shopify, fromHtml: false };
  return { products: await fetchGmkCatalogHtml(origin), fromHtml: true };
}

// Name normalization now lives in src/lib/set-name.ts (shared with the set
// page's round-family links); re-exported here for existing callers.
export { normalizeSetName, stripRound } from "@/lib/set-name";
import { normalizeSetName, stripRound } from "@/lib/set-name";

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
function pickFromFamily(candidates: SetIndexEntry[]): SetIndexEntry {
  if (candidates.length === 1) return candidates[0];
  const active = candidates.filter((c) => c.status === "ACTIVE_GB");
  if (active.length === 1) return active[0];
  const pool = active.length > 0 ? active : candidates;
  return [...pool].sort(
    (a, b) => (b.gbStart?.getTime() ?? 0) - (a.gbStart?.getTime() ?? 0)
  )[0];
}

function matchProduct(title: string, index: SetIndex): SetIndexEntry | null {
  const full = normalizeSetName(title);
  if (!full) return null;

  // A title WITH an explicit round ("GMK Striker R2") is unambiguous: exact
  // match wins, family fallback only when the DB lacks that exact round.
  if (/r\d+$/.test(full)) {
    const exact = index.byFull.get(full);
    if (exact) return exact;
    const candidates = index.byBase.get(stripRound(full));
    return candidates && candidates.length > 0 ? pickFromFamily(candidates) : null;
  }

  // A BARE title is ambiguous between the ORIGINAL run (whose DB row is also
  // unsuffixed) and the CURRENT round — vendors sell the current round under
  // the bare name. Exact-matching first attached R2/R3 listings (and their
  // prices) to the round-1 row. Resolve within the round family instead: the
  // round that's actually selling wins, else the newest.
  const candidates = index.byBase.get(full);
  if (candidates && candidates.length > 0) return pickFromFamily(candidates);
  return index.byFull.get(full) ?? null;
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
  soldOut: number; // rows the store's own feed reported as unavailable
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
    soldOut: 0,
    stoppedEarly: false,
  };

  // A vendor with a blank websiteUrl can never be crawled: `new URL("")` throws
  // below, so the store is skipped — but only AFTER it has taken one of the
  // `vendorLimit` slots and had lastDiscoveredAt stamped, which also counts it
  // into vendorsScanned. It therefore reads as "scanned" in the run summary
  // while never having been fetched. 28 of the 125 seeded vendors shipped with
  // '' here, so roughly a fifth of every rotation was spent on stores that
  // cannot produce a listing. Exclude them so the budget goes to crawlable
  // stores; db-setup's ensureVendorRoster refills the ones the roster knows.
  //
  // Manufacturer/catalog sources are refused for the same reason: gmk.net and
  // dcs.wiki aren't stores, so a slot spent on one is a slot a real store
  // doesn't get. dcs.wiki is the worse of the two — it serves no
  // products.json, so it falls through to the generic HTML crawl, where every
  // "DCS …" anchor on a wiki index reads as a product and is written back as a
  // VendorKit that can never be priced. Mirrors _DISCOVERY_VENDOR_SQL in
  // scrape.py, which has refused both since dcs.wiki was added.
  //
  // A blank URL is only half of "cannot be crawled", though. A row pointed at
  // goo.gl, item.taobao.com or an Instagram profile answers /products.json
  // with a 404 just as reliably, and it sorts to the FRONT of the rotation
  // (lastDiscoveredAt NULLS FIRST) — five of the seeded vendors are in exactly
  // that state. SQL can't tell a host from a substring (`LIKE '%x.com%'` also
  // matches mybox.com), so the storefront test runs here, over a deliberately
  // over-fetched page, and `vendorLimit` is applied to what survives.
  const candidates = await prisma.vendor.findMany({
    where: { websiteUrl: { not: "" }, ...NOT_MANUFACTURER_VENDOR },
    orderBy: [{ lastDiscoveredAt: { sort: "asc", nulls: "first" } }],
    take: vendorLimit * DISCOVERY_OVERFETCH,
    select: { id: true, slug: true, websiteUrl: true },
  });
  const vendors = candidates
    .filter((v) => !needsStorefront(v.websiteUrl))
    .slice(0, vendorLimit);
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

    const { products: catalog, fromHtml } = await fetchGmkCatalog(origin);
    if (catalog.length === 0) continue;
    result.gmkListings += catalog.length;

    // Existing links for this vendor, so we only touch rows that changed and
    // never clobber a manually-entered price's URL.
    const existing = await prisma.vendorKit.findMany({
      where: { vendorId: vendor.id },
      select: {
        kitId: true,
        productUrl: true,
        priceSource: true,
        price: true,
        inStock: true,
      },
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
            // …unless the feed we just read says otherwise. Spread last so a
            // sold-out entry wins over the optimistic default above.
            ...catalogStockUpdate(product.available),
          },
        });
        // Keep the in-memory view consistent in case the catalog lists the
        // same set twice (e.g. GB page + extras page) — first one wins.
        existingByKit.set(match.baseKitId, {
          kitId: match.baseKitId,
          productUrl: product.url,
          priceSource: null,
          price: null,
          inStock: catalogStockUpdate(product.available).inStock ?? true,
        });
        result.linked++;
      } else if (
        current.priceSource !== "MANUAL" &&
        current.productUrl !== product.url &&
        // A candidate crawled off the storefront's own HTML may only take over
        // a row that is NOT currently priced. Unpriced is the state the HTML
        // path exists to end (an unpriced row is hidden outright on a released
        // set); a link the price pass is successfully reading is not something
        // a homepage anchor should be allowed to replace. Mirrored in
        // run_discovery's `html_guard` in scraper/scrape.py.
        (!fromHtml || current.price == null)
      ) {
        // The store moved/renamed the listing — point at the live page and
        // re-queue so the next price run scrapes the fresh URL.
        await prisma.vendorKit.update({
          where: { kitId_vendorId: { kitId: match.baseKitId, vendorId: vendor.id } },
          data: { productUrl: product.url, gbUrl: product.url, priceUpdatedAt: null },
        });
        existingByKit.set(match.baseKitId, { ...current, productUrl: product.url });
        result.relinked++;
      }

      // Stock, separately from the link. The relink branch above only fires
      // when the URL CHANGED, so a listing the store has ended keeps whatever
      // inStock it had — and inStock is DEFAULT true, so "ended a year ago"
      // reads as buyable until the time-boxed price pass happens to reach the
      // row. The feed just read says so outright.
      //
      // One direction only (catalogStockUpdate): a feed may mark a row SOLD
      // OUT, never in stock. An unreported availability writes nothing.
      const stock = catalogStockUpdate(product.available);
      const known = existingByKit.get(match.baseKitId);
      if (
        stock.inStock === false &&
        known &&
        known.inStock !== false &&
        known.priceSource !== "MANUAL"
      ) {
        await prisma.vendorKit.update({
          where: { kitId_vendorId: { kitId: match.baseKitId, vendorId: vendor.id } },
          data: { inStock: false },
        });
        existingByKit.set(match.baseKitId, { ...known, inStock: false });
        result.soldOut++;
      }
    }
  }

  return result;
}
