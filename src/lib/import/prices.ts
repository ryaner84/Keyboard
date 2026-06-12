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

async function fetchWithTimeout(url: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Home country per currency, for pinning Shopify's localization context.
const CURRENCY_HOME_COUNTRY: Record<string, string> = {
  USD: "US", SGD: "SG", EUR: "DE", GBP: "GB", CAD: "CA", AUD: "AU",
  JPY: "JP", KRW: "KR", CNY: "CN", HKD: "HK", THB: "TH", TWD: "TW",
  MYR: "MY", NZD: "NZ", SEK: "SE", NOK: "NO", DKK: "DK", CHF: "CH", PLN: "PL",
};

// Variant titles that are clearly NOT the keycap kit itself — GB listings
// often bundle add-ons (deskmats, samples, deposits...) as cheap variants.
const ADDON_VARIANT_RE =
  /(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain|coin|tray|deposit|shipping|insurance|add[\s-]?on|extra)/i;

// Per-currency plausibility bounds for a GMK BASE kit. New base kits run
// roughly USD 90–180, but RELEASED sets are routinely cleared out at USD
// 40–70 (NovelKeys/CannonKeys clearance sales), so the lower bound must
// admit clearance prices — the BASE-variant classifier is the primary guard
// against add-ons; this window is only a backstop for parse errors.
// IMPORTANT: this window must stay in sync with the purge in
// scripts/db-setup.mjs and the bounds in scraper/scrape.py — a purge window
// tighter than the producers' window silently wipes legitimate prices on
// every deploy (this is exactly what blanked released-set pricing).
const KIT_BOUNDS: Record<string, { min: number; max: number }> = {
  USD: { min: 30, max: 225 },
  EUR: { min: 28, max: 210 },
  GBP: { min: 24, max: 180 },
  AUD: { min: 45, max: 345 },
  CAD: { min: 41, max: 310 },
  SGD: { min: 40, max: 310 },
  JPY: { min: 4500, max: 34000 },
  KRW: { min: 40000, max: 320000 },
  CNY: { min: 215, max: 1650 },
  HKD: { min: 235, max: 1800 },
  THB: { min: 1075, max: 8100 },
  TWD: { min: 965, max: 7300 },
  CLP: { min: 27000, max: 210000 },
  INR: { min: 2500, max: 19000 },
};

// Plausibility check for a BASE kit price. Currencies without bounds
// have very different magnitudes, so we don't bound them.
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

// Vendor links often pin the exact kit variant (?variant=<id>) — e.g.
// shop.yushakobo.jp/products/12656?variant=52066151989479. That id is ground
// truth for which variant is the base kit, so it beats any title heuristic.
function pinnedVariantId(productUrl: string): string | null {
  try {
    return new URL(productUrl).searchParams.get("variant");
  } catch {
    return null;
  }
}

// Shopify exposes a product's data at {productUrl}.json — used by most
// keyboard vendors (CannonKeys, NovelKeys, KBDfans, Deskhero, Daily Clack...).
async function fetchShopifyPrice(productUrl: string, vendorCurrency?: string): Promise<PriceResult | null> {
  if (!productUrl.includes("/products/")) return null;

  // Strip query/hash, then request the .json variant.
  const pinnedId = pinnedVariantId(productUrl);
  const clean = normalizeShopifyUrl(productUrl).split("?")[0].split("#")[0].replace(/\/$/, "");
  const jsonUrl = `${clean}.json`;

  try {
    // Shop currency FIRST (cached per origin) — needed to pin the price
    // context below. May be null when the store blocks /meta.json; the caller
    // then falls back to the vendor's own currency (e.g. Deskhero = CAD),
    // NOT a blind USD default which previously inflated CA$88 into US$88.
    const detectedCurrency = await fetchShopifyCurrency(clean);

    // Shopify Markets geo-localizes prices to the REQUESTER's country — a
    // GitHub Actions runner IP can be geolocated to the wrong country, causing
    // the store to serve INR/SGD/etc. prices even for a USD-base store (e.g.
    // stackskb.com served INR to an Azure West US runner). When we know the
    // vendor's base currency from the DB and it differs from what geo-detection
    // returned, trust the DB — it's the ground truth for what the merchant
    // actually charges. Stores without Markets ignore the localization cookie.
    const currency =
      vendorCurrency && detectedCurrency && detectedCurrency !== vendorCurrency
        ? vendorCurrency
        : detectedCurrency;

    const cookie = currency
      ? `cart_currency=${currency}; localization=${CURRENCY_HOME_COUNTRY[currency] ?? "US"}`
      : undefined;

    const res = await fetchWithTimeout(jsonUrl, cookie ? { Cookie: cookie } : undefined);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      product?: {
        variants?: Array<{ id?: number | string; title?: string; price?: string | number; available?: boolean }>;
      };
    };
    const variants = (data.product?.variants ?? [])
      .map((v) => ({ id: String(v.id ?? ""), title: String(v.title ?? ""), price: Number(v.price) }))
      .filter((v) => !isNaN(v.price) && v.price > 0);
    if (variants.length === 0) return null;

    // Pick the variant that is actually the BASE kit, NOT the cheapest one — GB
    // listings carry cheap add-on variants (deskmats, samples, deposits) that
    // used to win a Math.min and produce absurd prices like $22 for a base kit.
    // Preference: the variant the vendor link itself pins (?variant=<id> — exact,
    // survives non-English titles like Yushakobo's) > the variant classified BASE
    // (same classifier the set-page filter uses, so the stored price always
    // matches what's displayed) > first non-add-on variant (Shopify returns
    // variants in display order; the primary kit comes first on single-kit
    // listings titled "Default Title").
    const pinned = pinnedId ? variants.find((v) => v.id === pinnedId) : undefined;
    const nonAddon = variants.filter((v) => !ADDON_VARIANT_RE.test(v.title));
    const pool = nonAddon.length > 0 ? nonAddon : variants;
    const chosen = pinned ?? pool.find((v) => classifyVariant(v.title) === "BASE") ?? pool[0];

    // Refuse implausible kit prices rather than store garbage.
    if (!isPlausibleBaseKitPrice(chosen.price, currency)) {
      return null;
    }

    return { price: chosen.price, currency, variants: variants.map(({ title, price }) => ({ title, price })) };
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

// Non-Shopify stores (custom platforms, WooCommerce, Magento, BigCommerce…)
// don't expose a product JSON API, but virtually every e-commerce platform
// embeds schema.org Product markup as JSON-LD for SEO — price + priceCurrency
// live in the `offers` node. OpenGraph product:price:* meta tags are the
// second fallback. No variant breakdown is available from either, so the
// variants list stays empty (the UI handles that like legacy rows).
async function fetchJsonLdPrice(productUrl: string): Promise<PriceResult | null> {
  try {
    const res = await fetchWithTimeout(productUrl);
    if (!res.ok) return null;
    const html = await res.text();

    const blocks = Array.from(
      html.matchAll(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      )
    ).map((m) => m[1]);

    for (const block of blocks) {
      let data: unknown;
      try {
        data = JSON.parse(block.trim());
      } catch {
        continue; // malformed block — try the next one
      }
      type LdOffer = {
        "@type"?: string;
        name?: string;
        price?: string | number;
        lowPrice?: string | number;
        priceCurrency?: string;
        offers?: LdOffer | LdOffer[];
      };
      type LdNode = {
        "@type"?: string | string[];
        "@graph"?: LdNode[];
        offers?: LdOffer | LdOffer[];
      };
      const root = data as LdNode | LdNode[];
      const nodes: LdNode[] = Array.isArray(root)
        ? root
        : root["@graph"]
          ? root["@graph"]
          : [root];

      for (const node of nodes) {
        const type = node["@type"];
        const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
        if (!isProduct || !node.offers) continue;

        // Flatten offers into a list. Shopware (GMK.net) emits an AggregateOffer
        // with nested individual offers (one per variant: "Base", "International",
        // etc.); Shopify pages may emit a plain array or single Offer.
        const rawOffers = node.offers;
        const offerList: LdOffer[] = Array.isArray(rawOffers)
          ? rawOffers
          : Array.isArray((rawOffers as LdOffer).offers)
            ? ((rawOffers as LdOffer).offers as LdOffer[])
            : [];

        // Prefer a variant explicitly named "Base" — GMK.net lists the base
        // keycap kit and International/regional variants as separate named
        // offers. The International variant may be in stock while Base is not,
        // but we always want the base keycap kit price regardless of stock.
        const chosen: LdOffer =
          offerList.find((o) => /\bbase\b/i.test(String(o?.name ?? ""))) ??
          offerList[0] ??
          (Array.isArray(rawOffers) ? rawOffers[0] : rawOffers as LdOffer);

        // Currency: from the chosen offer, then fall back to the parent
        // AggregateOffer's priceCurrency (Shopware often puts it there).
        const currency =
          chosen?.priceCurrency ??
          (!Array.isArray(rawOffers) ? (rawOffers as LdOffer)?.priceCurrency : null) ??
          null;

        const price = Number(chosen?.price ?? chosen?.lowPrice);
        if (!isNaN(price) && price > 0 && isPlausibleBaseKitPrice(price, currency)) {
          return { price, currency, variants: [] };
        }
      }
    }

    // OpenGraph product meta tags (attribute order varies by platform).
    const amount =
      html.match(/property=["']product:price:amount["'][^>]*content=["']([\d.,]+)["']/i) ??
      html.match(/content=["']([\d.,]+)["'][^>]*property=["']product:price:amount["']/i);
    const cur =
      html.match(/property=["']product:price:currency["'][^>]*content=["']([A-Z]{3})["']/i) ??
      html.match(/content=["']([A-Z]{3})["'][^>]*property=["']product:price:currency["']/i);
    if (amount) {
      const price = Number(amount[1].replace(/,/g, ""));
      const currency = cur ? cur[1] : null;
      if (!isNaN(price) && price > 0 && isPlausibleBaseKitPrice(price, currency)) {
        return { price, currency, variants: [] };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Attempt to fetch a live price for a single product URL: Shopify product
// JSON first (rich variant data), generic JSON-LD/OpenGraph markup otherwise.
// Pass vendorCurrency so Shopify geo-localization is pinned to the vendor's
// base currency rather than whatever the runner's IP geo-detects.
export async function fetchVendorPrice(productUrl: string, vendorCurrency?: string): Promise<PriceResult | null> {
  if (!productUrl) return null;
  const shopify = await fetchShopifyPrice(productUrl, vendorCurrency);
  if (shopify) return shopify;
  return fetchJsonLdPrice(productUrl);
}

export interface RefreshOptions {
  limit?: number; // max VendorKits to consider this run (DB query cap)
  maxAgeHours?: number; // only refresh entries older than this
  concurrency?: number; // how many URLs to fetch in parallel
  maxRuntimeMs?: number; // wall-clock budget; stop starting new fetches past this
  ids?: string[]; // refresh exactly these VendorKits (skips the age cutoff)
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
  const priceData = await fetchVendorPrice(vk.productUrl, vk.vendor.currency);
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
        // A live price means the vendor currently carries this set — mark it
        // available. (DELIVERED/SHIPPING GBs are often sold as clearance stock.)
        inStock: true,
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
    ids,
  } = opts;
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  const candidates = await prisma.vendorKit.findMany({
    where: {
      ...(ids && ids.length > 0 && { id: { in: ids } }),
      productUrl: { not: null },
      // Buyers decide on the base kit first — only base kit prices are shown
      // on the site, so scraping is limited to BASE kits only.
      kit: { type: "BASE" },
      // Never touch manually-entered prices. NULL priceSource (freshly imported,
      // never scraped) must be included — `not: "MANUAL"` alone would exclude
      // NULLs because `NULL <> 'MANUAL'` is NULL (not true) in SQL.
      OR: [{ priceSource: null }, { priceSource: { not: "MANUAL" } }],
      // An explicit id list means "price these NOW" — skip the staleness gate.
      ...(!ids?.length && {
        AND: {
          OR: [{ priceUpdatedAt: null }, { priceUpdatedAt: { lt: cutoff } }],
        },
      }),
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
