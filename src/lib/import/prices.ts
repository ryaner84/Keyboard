import { prisma } from "@/lib/prisma";
import { classifyVariant } from "@/lib/kit-variants";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Per-request timeout. Most vendor stores behind Cloudflare reject datacenter
// IPs with a fast 403, but a few hang — cap them so one slow host can't stall
// the whole run.
const FETCH_TIMEOUT_MS = 6000;

// How many product URLs to fetch in parallel. Vendors are distinct hosts, so
// this is safe; it keeps the run well inside the serverless time limit.
const DEFAULT_CONCURRENCY = 8;

// Hard wall-clock budget for a single refresh run. Vercel Hobby functions are
// capped at 60s, so we stop starting new fetches at 50s and return what we have.
// Oldest-checked rows are processed first, so the next daily run resumes where
// this one left off — nothing is ever starved.
const DEFAULT_MAX_RUNTIME_MS = 50_000;

export interface PriceResult {
  price: number;
  // null when the store's /meta.json is blocked — caller must fall back to the
  // vendor's own currency, never assume USD.
  currency: string | null;
  // Every variant on the product page, in display order: feeds the
  // Base / Alpha / Novelties / Spacebars / Others filter on the set page.
  variants: Array<{ title: string; price: number }>;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Variant titles that are clearly NOT the keycap kit itself — GB listings
// often bundle add-ons (deskmats, samples, deposits...) as cheap variants.
const ADDON_VARIANT_RE =
  /(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain|coin|tray|deposit|shipping|insurance|add[\s-]?on|extra)/i;

// Per-currency plausibility bounds for a GMK BASE kit. Real base kits run
// roughly USD 90–180; the bounds leave headroom for sales and premium sets but
// reject add-on variants and bundle/parse errors. Calibrated in SGD first
// (primary market): anything below S$95 or above S$310 is definitely not a
// base kit price; other currencies are that same window FX-converted.
const KIT_BOUNDS: Record<string, { min: number; max: number }> = {
  USD: { min: 70, max: 225 },
  EUR: { min: 65, max: 210 },
  GBP: { min: 55, max: 180 },
  AUD: { min: 100, max: 345 },
  CAD: { min: 95, max: 310 },
  SGD: { min: 95, max: 310 },
};

// Plausibility check for a BASE kit price. Currencies without bounds
// (e.g. JPY, KRW) have very different magnitudes, so we don't bound them.
// `currency === null` means the store's currency is unknown — bound it as
// USD, since the fallback is always one of the western vendor currencies.
export function isPlausibleBaseKitPrice(price: number, currency: string | null): boolean {
  const b = KIT_BOUNDS[currency ?? "USD"];
  if (!b) return true;
  return price >= b.min && price <= b.max;
}

// Some stores link products through a collection path
// (e.g. ktechs.store/collections/group-buy/products/X); the .json endpoint
// lives on the canonical /products/X path.
function normalizeShopifyUrl(url: string): string {
  return url.replace(/\/collections\/[^/]+\/products\//, "/products/");
}

// Shopify exposes a product's data at {productUrl}.json — used by most
// keyboard vendors (CannonKeys, NovelKeys, KBDfans, Deskhero, Daily Clack...).
async function fetchShopifyPrice(productUrl: string): Promise<PriceResult | null> {
  if (!productUrl.includes("/products/")) return null;

  // Strip query/hash, then request the .json variant.
  const clean = normalizeShopifyUrl(productUrl).split("?")[0].split("#")[0].replace(/\/$/, "");
  const jsonUrl = `${clean}.json`;

  try {
    const res = await fetchWithTimeout(jsonUrl);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      product?: {
        variants?: Array<{ title?: string; price?: string | number; available?: boolean }>;
      };
    };
    const variants = (data.product?.variants ?? [])
      .map((v) => ({ title: String(v.title ?? ""), price: Number(v.price) }))
      .filter((v) => !isNaN(v.price) && v.price > 0);
    if (variants.length === 0) return null;

    // Pick the variant that is actually the BASE kit, NOT the cheapest one — GB
    // listings carry cheap add-on variants (deskmats, samples, deposits) that
    // used to win a Math.min and produce absurd prices like $22 for a base kit.
    // Preference: the variant classified BASE (same classifier the set-page
    // filter uses, so the stored price always matches what's displayed) > first
    // non-add-on variant (Shopify returns variants in display order; the
    // primary kit comes first on single-kit listings titled "Default Title").
    const nonAddon = variants.filter((v) => !ADDON_VARIANT_RE.test(v.title));
    const pool = nonAddon.length > 0 ? nonAddon : variants;
    const chosen = pool.find((v) => classifyVariant(v.title) === "BASE") ?? pool[0];

    // May be null when the store blocks /meta.json — the caller falls back to
    // the vendor's own currency (e.g. Deskhero = CAD), NOT a blind USD default
    // which previously inflated CA$88 into US$88.
    const currency = await fetchShopifyCurrency(clean);

    // Refuse implausible kit prices rather than store garbage.
    if (!isPlausibleBaseKitPrice(chosen.price, currency)) {
      return null;
    }

    return { price: chosen.price, currency, variants };
  } catch {
    return null;
  }
}

// Shopify stores expose their currency at /meta.json on the shop origin.
const currencyCache = new Map<string, string | null>();
async function fetchShopifyCurrency(productUrl: string): Promise<string | null> {
  const origin = (() => {
    try {
      return new URL(productUrl).origin;
    } catch {
      return null;
    }
  })();
  if (!origin) return null;
  if (currencyCache.has(origin)) return currencyCache.get(origin)!;

  try {
    const res = await fetchWithTimeout(`${origin}/meta.json`);
    if (res.ok) {
      const meta = (await res.json()) as { currency?: string };
      const cur = meta.currency ?? null;
      currencyCache.set(origin, cur);
      return cur;
    }
  } catch {
    // ignore
  }
  currencyCache.set(origin, null);
  return null;
}

// Attempt to fetch a live price for a single product URL.
export async function fetchVendorPrice(productUrl: string): Promise<PriceResult | null> {
  if (!productUrl) return null;
  return fetchShopifyPrice(productUrl);
}

export interface RefreshOptions {
  limit?: number; // max VendorKits to consider this run (DB query cap)
  maxAgeHours?: number; // only refresh entries older than this
  concurrency?: number; // how many URLs to fetch in parallel
  maxRuntimeMs?: number; // wall-clock budget; stop starting new fetches past this
}

export interface RefreshResult {
  attempted: number;
  updated: number;
  failed: number;
  stoppedEarly: boolean; // true if the time budget was hit before finishing
}

// Refresh one VendorKit's cached price: fetch, then write the outcome.
async function refreshOne(
  vk: { id: string; productUrl: string | null; vendor: { currency: string } },
  result: RefreshResult
): Promise<void> {
  if (!vk.productUrl) return;
  result.attempted++;
  const priceData = await fetchVendorPrice(vk.productUrl);
  if (priceData) {
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: {
        price: priceData.price,
        // Store currency (meta.json) when reachable; otherwise the vendor's
        // own currency — e.g. Deskhero prices are CAD even when meta is blocked.
        currency: priceData.currency ?? vk.vendor.currency,
        priceUpdatedAt: new Date(),
        priceSource: "SCRAPED",
        variants: priceData.variants,
      },
    });
    result.updated++;
  } else {
    // Record the attempt so we don't hammer the same blocked URL every run.
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: { priceUpdatedAt: new Date() },
    });
    result.failed++;
  }
}

// Refresh cached prices for VendorKits, oldest-checked first. Never touches
// MANUAL prices.
//
// Two safety limits keep this inside the serverless execution budget no matter
// how many vendors hang:
//   • `limit` caps how many rows we pull from the DB this run.
//   • `maxRuntimeMs` is a wall-clock budget — once exceeded we stop starting new
//     fetches and return. Because rows are processed oldest-first, the next
//     daily run resumes with whatever wasn't reached.
// Fetches run `concurrency`-at-a-time (vendors are distinct hosts), so a typical
// run clears its batch in seconds even though most stores block datacenter IPs.
export async function refreshPrices(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const {
    limit = 200,
    maxAgeHours = 20,
    concurrency = DEFAULT_CONCURRENCY,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  } = opts;
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  const candidates = await prisma.vendorKit.findMany({
    where: {
      productUrl: { not: null },
      // Buyers decide on the base kit first — only base kit prices are shown
      // on the site, so scraping is limited to BASE kits only.
      kit: { type: "BASE" },
      // Never touch manually-entered prices. NULL priceSource (freshly imported,
      // never scraped) must be included — `not: "MANUAL"` alone would exclude
      // NULLs because `NULL <> 'MANUAL'` is NULL (not true) in SQL.
      OR: [{ priceSource: null }, { priceSource: { not: "MANUAL" } }],
      AND: {
        OR: [{ priceUpdatedAt: null }, { priceUpdatedAt: { lt: cutoff } }],
      },
    },
    orderBy: [{ priceUpdatedAt: { sort: "asc", nulls: "first" } }],
    take: limit,
    select: { id: true, productUrl: true, vendor: { select: { currency: true } } },
  });

  const result: RefreshResult = { attempted: 0, updated: 0, failed: 0, stoppedEarly: false };
  const start = Date.now();
  let next = 0;

  // Worker-pool: each lane pulls the next index until the list is drained or the
  // time budget runs out. Index handout is synchronous (single-threaded JS), so
  // no two workers ever grab the same row.
  async function worker(): Promise<void> {
    while (true) {
      if (Date.now() - start > maxRuntimeMs) {
        result.stoppedEarly = true;
        return;
      }
      const i = next++;
      if (i >= candidates.length) return;
      await refreshOne(candidates[i], result);
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, candidates.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  return result;
}
