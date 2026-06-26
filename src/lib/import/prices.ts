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
  // Vendor-level availability for the selected/base-kit variants.
  inStock: boolean;
  // null when the store's /meta.json is blocked — caller must fall back to the
  // vendor's own currency, never assume USD.
  currency: string | null;
  // Every variant on the product page, in display order: feeds the
  // Base / Alpha / Novelties / Spacebars / Others filter on the set page.
  variants: Array<{ title: string; price: number }>;
}

// Sentinel distinct from null. `null` means the listing couldn't be read this
// run (blocked / transient) — the caller KEEPS the last good price. NO_BASE_KIT
// means the listing was read fine but carries no identifiable base kit (only
// subkits, or an ambiguous multi-kit aggregate) — the caller CLEARS the stored
// price. Without this split a listing that scrapes to a wrong subkit price
// never heals: returning null preserved the stale wrong number every run. This
// is the root cause behind the recurring Keygem / Latamkeys / STACKS reports.
export const NO_BASE_KIT = "NO_BASE_KIT" as const;
export type FetchPriceOutcome = PriceResult | typeof NO_BASE_KIT | null;

// The base kit is the dearest individual kit on a GB listing — subkits (40s,
// accents, an ex-GST line) are cheaper. Pick the most expensive candidate
// rather than whichever happens to be first in display order; an out-of-range
// bundle is rejected downstream by isPlausibleBaseKitPrice.
function dearestCandidate<T extends { price: number }>(pool: T[]): T | undefined {
  if (pool.length === 0) return undefined;
  return pool.reduce((best, v) => (v.price > best.price ? v : best));
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
  ARS: { min: 30000, max: 400000 },
  MYR: { min: 140, max: 1100 },
};

// Currencies the site can actually convert (the Currency table). A price in
// any other currency renders as garbage (missing rate falls back to 1, so
// 82,857 ARS displayed as $82,857) — refuse to store those at all.
const SUPPORTED_CURRENCIES = new Set([
  "USD", "SGD", "EUR", "GBP", "CAD", "AUD", "JPY", "CNY", "KRW", "MYR",
  "THB", "NZD", "HKD", "TWD", "SEK", "NOK", "DKK", "CHF", "PLN",
  "INR", "ARS", "CLP",
]);

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

function structuredVariantAvailability(html: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const scriptPattern =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;

    const value = node as Record<string, unknown>;
    const offers =
      value.offers && typeof value.offers === "object"
        ? (value.offers as Record<string, unknown>)
        : null;
    const identity = [
      value["@id"],
      value.url,
      offers?.["@id"],
      offers?.url,
    ]
      .filter((item): item is string => typeof item === "string")
      .join(" ");
    const variantId = identity.match(/[?&]variant=(\d+)/)?.[1];
    const availability =
      typeof offers?.availability === "string"
        ? offers.availability
        : typeof value.availability === "string"
          ? value.availability
          : null;
    if (variantId && availability) {
      result.set(
        variantId,
        !/(outofstock|soldout|discontinued)/i.test(availability)
      );
    }

    Object.values(value).forEach(walk);
  };

  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      walk(JSON.parse(match[1]));
    } catch {
      // Ignore malformed third-party JSON-LD blocks.
    }
  }
  return result;
}

// Shopify exposes a product's data at {productUrl}.json — used by most
// keyboard vendors (CannonKeys, NovelKeys, KBDfans, Deskhero, Daily Clack...).
async function fetchShopifyPrice(productUrl: string, vendorCurrency?: string): Promise<FetchPriceOutcome> {
  if (!productUrl.includes("/products/")) return null;

  // Strip query/hash, then request the .json variant.
  const pinnedId = pinnedVariantId(productUrl);
  let clean = normalizeShopifyUrl(productUrl).split("?")[0].split("#")[0].replace(/\/$/, "");

  try {
    // Shop currency FIRST (cached per origin) — needed to pin the price
    // context below. /meta.json reports the store's PRIMARY currency (not
    // geo-localized), so it's the truth about what the merchant charges in.
    // May be null when the store blocks /meta.json; the caller then falls
    // back to the vendor's own currency (e.g. Deskhero = CAD), NOT a blind
    // USD default which previously inflated CA$88 into US$88.
    // NOTE: do NOT override this with the vendor DB record — several vendor
    // rows carry a wrong currency (Yushakobo listed as USD, store is JPY),
    // and relabeling real ¥20,000 numbers as "USD" poisons the listing. Wrong
    // vendor records are fixed in db-setup, not papered over here.
    let currency = await fetchShopifyCurrency(clean);

    let cookie = currency
      ? `cart_currency=${currency}; localization=${CURRENCY_HOME_COUNTRY[currency] ?? "US"}`
      : undefined;

    let res = await fetchWithTimeout(
      `${clean}.json`,
      cookie ? { Cookie: cookie } : undefined
    );
    if (!res.ok) {
      // Shopify product handles can change. The human product URL redirects to
      // the current handle, while the old .json/.js endpoints return 404.
      // Resolve that canonical product URL before giving up so old database
      // links self-heal and still receive exact variant stock data.
      try {
        const canonicalRes = await fetchWithTimeout(
          clean,
          cookie ? { Cookie: cookie } : undefined
        );
        const canonical = normalizeShopifyUrl(canonicalRes.url)
          .split("?")[0]
          .split("#")[0]
          .replace(/\/$/, "");
        if (
          canonicalRes.ok &&
          canonical.includes("/products/") &&
          canonical !== clean
        ) {
          clean = canonical;
          currency = await fetchShopifyCurrency(clean);
          cookie = currency
            ? `cart_currency=${currency}; localization=${CURRENCY_HOME_COUNTRY[currency] ?? "US"}`
            : undefined;
          res = await fetchWithTimeout(
            `${clean}.json`,
            cookie ? { Cookie: cookie } : undefined
          );
        }
      } catch {
        // Fall through to the existing generic structured-data fallback.
      }
    }
    if (!res.ok) return null;
    const data = (await res.json()) as {
      product?: {
        variants?: Array<{ id?: number | string; title?: string; price?: string | number; available?: boolean }>;
      };
    };
    const rawVariants = data.product?.variants ?? [];
    const variants = rawVariants
      .map((v) => ({ id: String(v.id ?? ""), title: String(v.title ?? ""), price: Number(v.price) }))
      .filter((v) => !isNaN(v.price) && v.price > 0);
    if (variants.length === 0) return null;

    // Shopify's product.json omits availability on some themes. product.js
    // exposes the same variant IDs with an explicit `available` boolean.
    const availableById = new Map<string, boolean>();
    for (const variant of rawVariants) {
      if (typeof variant.available === "boolean") {
        availableById.set(String(variant.id ?? ""), variant.available);
      }
    }
    try {
      const stockRes = await fetchWithTimeout(
        `${clean}.js`,
        cookie ? { Cookie: cookie } : undefined
      );
      if (stockRes.ok) {
        const stockData = (await stockRes.json()) as {
          variants?: Array<{ id?: number | string; available?: boolean }>;
        };
        for (const variant of stockData.variants ?? []) {
          if (typeof variant.available === "boolean") {
            availableById.set(String(variant.id ?? ""), variant.available);
          }
        }
      }
    } catch {
      // Availability remains unknown; preserve the priced listing as available.
    }

    // Pick the variant that is actually the BASE kit, NOT the cheapest one — GB
    // listings carry cheap add-on variants (deskmats, samples, deposits) that
    // used to win a Math.min and produce absurd prices like $22 for a base kit.
    // Preference: the variant the vendor link itself pins (?variant=<id> — exact,
    // survives non-English titles like Yushakobo's) > the variant classified BASE
    // (same classifier the set-page filter uses, so the stored price always
    // matches what's displayed) > first non-subkit candidate (Shopify returns
    // variants in display order; the primary kit comes first on single-kit
    // listings titled "Default Title"). Labeled subkits are excluded below.
    const pinned = pinnedId ? variants.find((v) => v.id === pinnedId) : undefined;
    const nonAddon = variants.filter((v) => !ADDON_VARIANT_RE.test(v.title));
    const pool = nonAddon.length > 0 ? nonAddon : variants;
    // Drop labeled subkits (alphas/novelties/spacebars) so an absent base kit
    // can't fall through to a cheap subkit; BASE and unlabeled OTHERS (incl. a
    // single "Default Title" variant) are kept. A listing left with no base
    // candidate — e.g. Keygem carrying only novelties/spacebars for a set — has
    // no base price to store, so skip it rather than store a subkit price.
    const basePool = pool.filter((v) => {
      const category = classifyVariant(v.title);
      return category === "BASE" || category === "OTHERS";
    });
    const chosen =
      pinned ??
      basePool.find((v) => classifyVariant(v.title) === "BASE") ??
      dearestCandidate(basePool);
    if (!chosen) {
      // Read the product fine, but it has no base candidate (only subkits) and
      // the vendor didn't pin a variant. Clear any stale price rather than
      // preserve a wrong subkit number. variants is non-empty here (the empty
      // case returned null above), so this is always a definitive no-base.
      return NO_BASE_KIT;
    }
    const baseVariants = basePool.filter(
      (variant) => classifyVariant(variant.title) === "BASE"
    );
    const relevantVariants = pinned
      ? [pinned]
      : baseVariants.length > 0
        ? baseVariants
        : [chosen];
    let knownAvailability = relevantVariants
      .map((variant) => availableById.get(variant.id))
      .filter((available): available is boolean => available !== undefined);

    // Shopify also exposes each variant independently at /variants/{id}.js.
    // This remains available on some stores that block product.js and the
    // rendered product page to CI/datacenter traffic.
    if (knownAvailability.length === 0) {
      const origin = new URL(clean).origin;
      await Promise.all(
        relevantVariants.map(async (variant) => {
          try {
            const variantRes = await fetchWithTimeout(
              `${origin}/variants/${variant.id}.js`,
              cookie ? { Cookie: cookie } : undefined
            );
            if (!variantRes.ok) return;
            const variantData = (await variantRes.json()) as {
              available?: boolean;
            };
            if (typeof variantData.available === "boolean") {
              availableById.set(variant.id, variantData.available);
            }
          } catch {
            // Fall through to structured product-page data.
          }
        })
      );
      knownAvailability = relevantVariants
        .map((variant) => availableById.get(variant.id))
        .filter((available): available is boolean => available !== undefined);
    }

    // Some stores serve product.json but block product.js to datacenter IPs.
    // Their rendered product page still publishes per-variant JSON-LD offers,
    // so use that precise structured data before treating stock as unknown.
    if (knownAvailability.length === 0) {
      try {
        const pageRes = await fetchWithTimeout(
          clean,
          cookie ? { Cookie: cookie } : undefined
        );
        if (pageRes.ok) {
          const structured = structuredVariantAvailability(await pageRes.text());
          structured.forEach((available, id) => {
            availableById.set(id, available);
          });
          knownAvailability = relevantVariants
            .map((variant) => availableById.get(variant.id))
            .filter((available): available is boolean => available !== undefined);
        }
      } catch {
        // Availability remains unknown; preserve the priced listing.
      }
    }
    const inStock =
      knownAvailability.length === 0 || knownAvailability.some(Boolean);

    // Refuse implausible kit prices rather than store garbage, and refuse
    // currencies the site can't convert.
    const effectiveCurrency = currency ?? vendorCurrency ?? null;
    if (effectiveCurrency && !SUPPORTED_CURRENCIES.has(effectiveCurrency)) {
      return null;
    }
    if (!isPlausibleBaseKitPrice(chosen.price, currency)) {
      return null;
    }

    return {
      price: chosen.price,
      currency,
      inStock,
      variants: variants.map(({ title, price }) => ({ title, price })),
    };
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
async function fetchJsonLdPrice(productUrl: string): Promise<FetchPriceOutcome> {
  try {
    const res = await fetchWithTimeout(productUrl);
    if (!res.ok) return null;
    const html = await res.text();

    // Set when we positively parse a Product whose offers are an ambiguous
    // multi-kit aggregate (no base-named offer). We skip storing any of its
    // prices, but having SEEN one means the stale stored price is a wrong
    // subkit — so we clear it (NO_BASE_KIT) instead of preserving it (null).
    let sawAmbiguousAggregate = false;

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
        highPrice?: string | number;
        priceCurrency?: string;
        availability?: string;
        offerCount?: string | number;
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
        // Multiple offers with no "Base"-named one (Shopware emits UNNAMED
        // offer arrays) means we cannot tell the base kit from a spacebars/
        // addon child kit — offers[0] is just the cheapest (how GMK.net base
        // kits got stored as 49.82). Skip rather than guess.
        const namedBase = offerList.find((o) => /\bbase\b/i.test(String(o?.name ?? "")));
        if (!namedBase && offerList.length > 1) {
          // Multiple named/unnamed offers, none identifiable as the base —
          // offers[0] would just be the cheapest subkit. Skip, and remember
          // this so the stale wrong price gets cleared.
          sawAmbiguousAggregate = true;
          continue;
        }
        const chosen: LdOffer | undefined =
          namedBase ??
          offerList[0] ??
          (Array.isArray(rawOffers) ? rawOffers[0] : (rawOffers as LdOffer));

        // A bare AggregateOffer covering several kits exposes lowPrice/highPrice
        // (and sometimes offerCount) but no single base price. lowPrice is the
        // CHEAPEST child kit — a spacebars/alpha/addon kit, not the base. This is
        // how GMK.net base kits got stored as 49.82, and how Latamkeys/STACKS
        // variable products stored a cheap subkit instead of the base kit. A
        // spanned price range (lowPrice != highPrice) OR offerCount > 1 means the
        // aggregate covers multiple kits; without a base-named offer to
        // disambiguate, skip rather than store the cheapest.
        const agg = !Array.isArray(rawOffers) ? (rawOffers as LdOffer) : null;
        const aggSpansMultipleKits =
          agg != null &&
          (Number(agg.offerCount ?? 1) > 1 ||
            (agg.lowPrice != null &&
              agg.highPrice != null &&
              Number(agg.lowPrice) !== Number(agg.highPrice)));
        if (
          offerList.length === 0 &&
          agg &&
          chosen?.price == null &&
          aggSpansMultipleKits
        ) {
          // A bare AggregateOffer spanning a price range with no single base
          // price — same story: skip, and mark for clearing the stale value.
          sawAmbiguousAggregate = true;
          continue;
        }

        // Currency: from the chosen offer, then fall back to the parent
        // AggregateOffer's priceCurrency (Shopware often puts it there).
        const currency =
          chosen?.priceCurrency ??
          (!Array.isArray(rawOffers) ? (rawOffers as LdOffer)?.priceCurrency : null) ??
          null;
        // Refuse currencies the site can't convert (e.g. geo-localized INR
        // from an Indian WooCommerce store before INR was supported).
        if (currency && !SUPPORTED_CURRENCIES.has(currency)) continue;

        const price = Number(chosen?.price ?? chosen?.lowPrice);
        if (!isNaN(price) && price > 0 && isPlausibleBaseKitPrice(price, currency)) {
          const availability =
            chosen?.availability ??
            (!Array.isArray(rawOffers)
              ? (rawOffers as LdOffer)?.availability
              : undefined);
          const inStock =
            !availability ||
            !/(outofstock|soldout|discontinued)/i.test(availability);
          return { price, currency, inStock, variants: [] };
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
    const availability =
      html.match(/property=["']product:availability["'][^>]*content=["']([^"']+)["']/i) ??
      html.match(/content=["']([^"']+)["'][^>]*property=["']product:availability["']/i);
    if (amount) {
      const price = Number(amount[1].replace(/,/g, ""));
      const currency = cur ? cur[1] : null;
      if (currency && !SUPPORTED_CURRENCIES.has(currency)) return null;
      if (!isNaN(price) && price > 0 && isPlausibleBaseKitPrice(price, currency)) {
        const inStock =
          !availability ||
          !/(outofstock|soldout|discontinued)/i.test(availability[1]);
        return { price, currency, inStock, variants: [] };
      }
    }
    // Read the page but found no usable base price. If that was because the
    // product is an ambiguous multi-kit aggregate, clear the stale wrong price;
    // otherwise it's a non-product / unreadable page → keep the last good one.
    return sawAmbiguousAggregate ? NO_BASE_KIT : null;
  } catch {
    return null;
  }
}

// Attempt to fetch a live price for a single product URL: Shopify product
// JSON first (rich variant data), generic JSON-LD/OpenGraph markup otherwise.
// Pass vendorCurrency so Shopify geo-localization is pinned to the vendor's
// base currency rather than whatever the runner's IP geo-detects.
export async function fetchVendorPrice(productUrl: string, vendorCurrency?: string): Promise<FetchPriceOutcome> {
  if (!productUrl) return null;
  // GMK is the manufacturer, not a vendor — gmk.net links are catalog/image
  // references and must never produce a price.
  if (/gmk\.net/i.test(productUrl)) return null;
  // A priced result OR the NO_BASE_KIT sentinel (both truthy) is a definitive
  // answer from the Shopify path — only a null (transient) falls through to the
  // JSON-LD reader.
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
  if (priceData === NO_BASE_KIT) {
    // Listing has no base kit (only subkits / ambiguous aggregate) — clear the
    // stale wrong price so it stops showing, instead of preserving it forever.
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: {
        price: null,
        inStock: false,
        priceUpdatedAt: new Date(),
        priceSource: "SCRAPED",
        variants: [],
      },
    });
    result.updated++;
  } else if (priceData) {
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
        // Keep the last valid price for comparison, while stock follows the
        // selected/base variant's current vendor availability.
        inStock: priceData.inStock,
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
      // GMK is the manufacturer, not a vendor — its rows only carry the
      // gmk.net URL for the image pass and must never enter the price queue.
      vendor: { slug: { not: "gmk" } },
      NOT: { productUrl: { contains: "gmk.net" } },
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
