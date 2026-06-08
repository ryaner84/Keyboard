import { prisma } from "@/lib/prisma";

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
  currency: string;
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

// Shopify exposes a product's data at {productUrl}.json — used by most
// keyboard vendors (CannonKeys, NovelKeys, KBDfans, Deskhero, Daily Clack...).
async function fetchShopifyPrice(productUrl: string): Promise<PriceResult | null> {
  if (!productUrl.includes("/products/")) return null;

  // Strip query/hash, then request the .json variant.
  const clean = productUrl.split("?")[0].split("#")[0].replace(/\/$/, "");
  const jsonUrl = `${clean}.json`;

  try {
    const res = await fetchWithTimeout(jsonUrl);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      product?: { variants?: Array<{ price?: string | number; available?: boolean }> };
    };
    const variants = data.product?.variants ?? [];
    if (variants.length === 0) return null;

    // Use the cheapest available variant (usually the base kit).
    const prices = variants
      .map((v) => Number(v.price))
      .filter((p) => !isNaN(p) && p > 0);
    if (prices.length === 0) return null;
    const price = Math.min(...prices);

    const currency = await fetchShopifyCurrency(clean);
    return { price, currency: currency ?? "USD" };
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
  vk: { id: string; productUrl: string | null },
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
        currency: priceData.currency,
        priceUpdatedAt: new Date(),
        priceSource: "SCRAPED",
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
    select: { id: true, productUrl: true },
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
