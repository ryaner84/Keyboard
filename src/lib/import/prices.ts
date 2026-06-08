import { prisma } from "@/lib/prisma";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_TIMEOUT_MS = 8000;

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
  limit?: number; // max VendorKits to process this run (time-boxing)
  maxAgeHours?: number; // only refresh entries older than this
}

export interface RefreshResult {
  attempted: number;
  updated: number;
  failed: number;
}

// Refresh cached prices for VendorKits, oldest-checked first. Never touches
// MANUAL prices. Time-boxed via `limit` to fit serverless execution limits.
export async function refreshPrices(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const { limit = 40, maxAgeHours = 20 } = opts;
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  const candidates = await prisma.vendorKit.findMany({
    where: {
      productUrl: { not: null },
      priceSource: { not: "MANUAL" },
      OR: [{ priceUpdatedAt: null }, { priceUpdatedAt: { lt: cutoff } }],
    },
    orderBy: [{ priceUpdatedAt: { sort: "asc", nulls: "first" } }],
    take: limit,
  });

  const result: RefreshResult = { attempted: 0, updated: 0, failed: 0 };

  for (const vk of candidates) {
    if (!vk.productUrl) continue;
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

  return result;
}
