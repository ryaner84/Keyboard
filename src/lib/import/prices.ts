import { prisma } from "@/lib/prisma";
import {
  classifyVariant,
  pickBaseVariant,
  ADDON_VARIANT_RE,
  NONBASE_SUBKIT_RE,
  PRODUCT_ACCESSORY_RE,
} from "@/lib/kit-variants";
import {
  NOT_MANUFACTURER_LISTING,
  isManufacturerListingUrl,
} from "./manufacturer-vendors";
import {
  DEAD_LINK_FAILURE_THRESHOLD,
  DEAD_LINK_RECHECK_HOURS,
  PRICE_SOURCE_REFUSED,
  PRICE_SOURCE_UNPARSED,
  isDeadLinkStatus,
  isGoneHostError,
  isGoneRedirect,
  nextLinkHealth,
} from "../../../scripts/lib/link-health.mjs";
import { isPlausibleBaseKitPrice as isPlausibleBaseKitPriceImpl } from "../../../scripts/lib/kit-bounds.mjs";

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
  // Pre-discount price of the SAME variant `price` came from, when that
  // variant is actually marked down. Undefined otherwise — a discount on an
  // unrelated subkit says nothing about the base kit.
  compareAt?: number;
  // Vendor-level availability for the selected/base-kit variants.
  inStock: boolean;
  // null when the store's /meta.json is blocked — caller must fall back to the
  // vendor's own currency, never assume USD.
  currency: string | null;
  // Every variant on the product page, in display order: feeds the set
  // page's kit sections. `available` present only when the store reported
  // per-variant stock.
  variants: Array<{ title: string; price: number; compareAt?: number; available?: boolean }>;
}

// Sentinel distinct from null. `null` means the listing couldn't be read this
// run (blocked / transient) — the caller KEEPS the last good price. NO_BASE_KIT
// means the listing was read fine but carries no identifiable base kit (only
// subkits, or an ambiguous multi-kit aggregate) — the caller CLEARS the stored
// price. Without this split a listing that scrapes to a wrong subkit price
// never heals: returning null preserved the stale wrong number every run. This
// is the root cause behind the recurring Keygem / Latamkeys / STACKS reports.
export const NO_BASE_KIT = "NO_BASE_KIT" as const;

// A third answer, and the one that was missing. DEAD_LINK means the store
// itself said the page does not exist (404/410) — it clears the stored price
// exactly like NO_BASE_KIT, but it is a different FACT and has to be recorded
// as one. Folded into NO_BASE_KIT it stamped `priceSource = 'SCRAPED'`, the
// same mark a live page with only add-on kits gets, so a store whose products
// were all removed read as a pricing backlog and the publishing report sent the
// owner to refresh-prices, which can never fix a page that is gone. See
// scripts/lib/link-health.mjs.
export const DEAD_LINK = "DEAD_LINK" as const;

// The fourth and fifth answers, and the two that were still hiding inside
// `null`. Both mean the page was FETCHED and the fault is on THIS side of the
// connection, so filing them as "couldn't read the listing" was a lie with
// three consequences: the row never counted as read, so the publishing report
// told the owner to relink or retire a store that is live and selling the set;
// `linkFailures` climbed on a page that answered perfectly, so after six runs
// the row was demoted to the 14-day dead-link cadence; and nothing anywhere
// named the repair, which is a code or config change here, never a re-scrape.
//
//   PRICE_REFUSED    the product data parsed and the number was rejected by
//                    this site's rules — outside KIT_BOUNDS, or a currency the
//                    Currency table cannot convert. Probed from a runner,
//                    norbauer.co serves its DSA base kit at USD 230 against a
//                    USD ceiling that stood at 225 (raised to 300 once that was
//                    measured — see scripts/lib/kit-bounds.mjs), and
//                    rationalkeys.com.tr publishes JSON-LD Product markup
//                    priced in TRY.
//   NO_PRODUCT_DATA  a 200 carrying no markup any parser path knows: Drop's
//                    /buy/ SPA, funkeys' custom storefront, the 114-byte
//                    placeholder captus.io and kingly-keys.xyz now serve.
//
// Neither clears a stored price. The refusal is about the number just read, not
// about the last good one, and hiding a listing on this evidence would be the
// exact failure `deadSince` is kept narrow to avoid.
export const PRICE_REFUSED = "PRICE_REFUSED" as const;
export const NO_PRODUCT_DATA = "NO_PRODUCT_DATA" as const;
export type FetchPriceOutcome =
  | PriceResult
  | typeof NO_BASE_KIT
  | typeof DEAD_LINK
  | typeof PRICE_REFUSED
  | typeof NO_PRODUCT_DATA
  | null;

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
// ADDON_VARIANT_RE and NONBASE_SUBKIT_RE now live in @/lib/kit-variants (with
// classifyVariant and pickBaseVariant) so the price pickers and the nightly
// audit apply the exact same exclusions.

// The per-currency plausibility window for a BASE kit used to be restated here,
// in scrape.py and twice in db-setup.mjs, under a comment asking each reader to
// keep four copies in step. It now lives in scripts/lib/kit-bounds.mjs and this
// half imports it (see the import block at the top), exactly as it imports
// link-health.mjs rather than copying it. Only scrape.py still mirrors it,
// because Python cannot import a JS module, and test:kit-bounds fails if the
// mirror drifts.

// Currencies the site can actually convert (the Currency table). A price in
// any other currency renders as garbage (missing rate falls back to 1, so
// 82,857 ARS displayed as $82,857) — refuse to store those at all.
const SUPPORTED_CURRENCIES = new Set([
  "USD", "SGD", "EUR", "GBP", "CAD", "AUD", "JPY", "CNY", "KRW", "MYR",
  "THB", "NZD", "HKD", "TWD", "SEK", "NOK", "DKK", "CHF", "PLN",
  "INR", "ARS", "CLP",
]);

// Re-exported so price-audit.ts and the rest of this module keep one import
// site for the rule. The implementation is kit-bounds.mjs's.
export const isPlausibleBaseKitPrice: (price: number, currency: string | null) => boolean =
  isPlausibleBaseKitPriceImpl;

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
    if (!res.ok) {
      // Dead-link audit: a removed product (even after canonical-handle retry)
      // returns 404/410. Clear the stale price instead of preserving it AND
      // record that the page is gone; any other failure (403 block, 5xx,
      // timeout) is transient → keep last good.
      return isDeadLinkStatus(res.status) ? DEAD_LINK : null;
    }
    // The .json request was answered by the storefront's front door. That is
    // what a removed product looks like on Shopify — but it is also what a
    // store that never served /products/*.json at all looks like, and only the
    // HUMAN product page can tell those apart. So this half never declares a
    // listing gone: fall through to the JSON-LD reader, which fetches that page
    // and does (isGoneRedirect there).
    if (isGoneRedirect(`${clean}.json`, res.url)) return null;
    const data = (await res.json()) as {
      product?: {
        title?: string;
        variants?: Array<{
          id?: number | string;
          title?: string;
          price?: string | number;
          compare_at_price?: string | number | null;
          available?: boolean;
        }>;
      };
    };
    const rawVariants = data.product?.variants ?? [];
    const variants = rawVariants
      .map((v) => {
        // compare_at_price is often populated at the SAME value as price on
        // Shopify; treating that as a markdown would advertise 0% off across
        // half the catalogue, so keep it only when strictly greater.
        const price = Number(v.price);
        const compare = Number(v.compare_at_price);
        return {
          id: String(v.id ?? ""),
          title: String(v.title ?? ""),
          price,
          ...(Number.isFinite(compare) && compare > price ? { compareAt: compare } : {}),
        };
      })
      .filter((v) => !isNaN(v.price) && v.price > 0);
    if (variants.length === 0) return null;

    // The kit identity of a SINGLE-variant product lives in the PRODUCT title
    // (its only variant is Shopify's literal "Default Title"): vendors sell
    // novelties/spacebars/artisans as separate products, and without this
    // guard such a product's lone variant classifies OTHERS and gets stored
    // as the set's base price. A vendor-pinned ?variant= link stays ground
    // truth and bypasses the guard. Mirrors the scraper's title guard.
    const productTitle = String(data.product?.title ?? "");
    if (!pinnedId && productTitle) {
      const titleCategory = classifyVariant(productTitle);
      const isSubkitProduct =
        titleCategory === "NOVELTIES" ||
        titleCategory === "SPACEBARS" ||
        NONBASE_SUBKIT_RE.test(productTitle) ||
        // Product-title-safe accessory set: ADDON_VARIANT_RE's "extra"/
        // "shipping" would wrongly clear real "GMK Foo Extras" listings.
        PRODUCT_ACCESSORY_RE.test(productTitle);
      if (isSubkitProduct) {
        // The linked product IS a subkit/accessory — it has no base price, so
        // clear any stale stored number rather than preserve it.
        return NO_BASE_KIT;
      }
    }

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
    // pickBaseVariant is THE canonical base pick (shared with the nightly
    // audit): accessories dropped (an accessory-only list yields null instead
    // of falling back to a deskmat price), labeled subkits dropped, first
    // BASE-titled variant wins, else the dearest remaining candidate.
    const chosen = pinned ?? pickBaseVariant(variants);
    if (!chosen) {
      // Read the product fine, but it has no base candidate (only subkits or
      // accessories) and the vendor didn't pin a variant. Clear any stale
      // price rather than preserve a wrong subkit number. variants is
      // non-empty here (the empty case returned null above), so this is
      // always a definitive no-base.
      return NO_BASE_KIT;
    }
    const baseVariants = variants.filter(
      (variant) =>
        !ADDON_VARIANT_RE.test(variant.title) &&
        classifyVariant(variant.title) === "BASE"
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
    // currencies the site can't convert. Both are refusals by THIS SITE of a
    // page it read and understood, so they answer PRICE_REFUSED — never null,
    // which would file a live, readable store as an unreachable one.
    const effectiveCurrency = currency ?? vendorCurrency ?? null;
    if (effectiveCurrency && !SUPPORTED_CURRENCIES.has(effectiveCurrency)) {
      return PRICE_REFUSED;
    }
    if (!isPlausibleBaseKitPrice(chosen.price, currency)) {
      return PRICE_REFUSED;
    }

    return {
      price: chosen.price,
      currency,
      inStock,
      // The markdown belongs to the CHOSEN variant only — a sale on some
      // unrelated subkit is not a sale on the base kit.
      ...(chosen.compareAt ? { compareAt: chosen.compareAt } : {}),
      // Persist per-variant availability when Shopify reported it, so the set
      // page's "Complete the set" section can show subkit stock the same way
      // the base table does. Unknown stock is omitted, not guessed.
      variants: variants.map((v) => ({
        title: v.title,
        price: v.price,
        ...(v.compareAt ? { compareAt: v.compareAt } : {}),
        ...(availableById.has(v.id) ? { available: availableById.get(v.id)! } : {}),
      })),
    };
  } catch {
    // Includes the host not resolving at all. This half never declares a
    // listing gone — exactly as it defers the front-door verdict to the human
    // product page (isGoneRedirect above) — so fall through to the JSON-LD
    // reader, which fetches that page and answers DEAD_LINK there.
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

// Minimal HTML-entity decoder for the attribute-escaped WooCommerce blob
// below. The blob only ever contains &quot; (JSON quotes), the occasional
// numeric entity, and &amp; for literal ampersands — decode &amp; LAST so a
// double-escaped &amp;quot; survives as &quot; rather than collapsing to a
// quote. Matches Python's html.unescape() for these cases.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

// WooCommerce variable products (Latamkeys /productos/, STACKS /store/) embed
// every variation as JSON in the add-to-cart form's data-product_variations
// attribute, HTML-escaped. There is no /products/.json equivalent, so without
// parsing this blob the caller keeps the stale (subkit / pre-GST) price and
// reporters keep flagging the wrong number. Mirrors parse_woocommerce_variations
// in scraper/scrape.py so both producers pick the same base kit.
const WOO_VARIATIONS_RE = /data-product_variations\s*=\s*(["'])([\s\S]*?)\1/;

interface WooVariant {
  id: string;
  title: string;
  price: number;
  available: boolean;
}

export function parseWooCommerceVariations(html: string): WooVariant[] {
  const match = html.match(WOO_VARIATIONS_RE);
  if (!match) return [];
  let data: unknown;
  try {
    data = JSON.parse(decodeHtmlEntities(match[2]));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: WooVariant[] = [];
  for (const v of data) {
    if (typeof v !== "object" || v === null) continue;
    const row = v as {
      variation_id?: number | string;
      id?: number | string;
      display_price?: number | string;
      display_regular_price?: number | string;
      attributes?: Record<string, unknown>;
      is_in_stock?: boolean;
    };
    // display_price is a plain number already in the store's base currency.
    const price = Number(row.display_price ?? row.display_regular_price);
    if (isNaN(price) || price <= 0) continue;
    // The variation's attribute values become the title so classifyVariant()
    // can tell a base kit from a subkit (attribute_kit: "Base Kit" → "Base Kit").
    const attrs = row.attributes;
    const title =
      attrs && typeof attrs === "object"
        ? Object.values(attrs).filter(Boolean).map(String).join(" ")
        : "";
    out.push({
      id: String(row.variation_id ?? row.id ?? ""),
      title,
      price,
      available: row.is_in_stock !== false,
    });
  }
  return out;
}

// Non-Shopify stores (custom platforms, WooCommerce, Magento, BigCommerce…)
// don't expose a product JSON API. WooCommerce variable products carry a full
// per-variant blob (parsed first, so the base kit is picked over a cheaper
// subkit); otherwise virtually every e-commerce platform embeds schema.org
// Product markup as JSON-LD for SEO — price + priceCurrency live in the
// `offers` node. OpenGraph product:price:* meta tags are the last fallback.
// vendorCurrency is used for the WooCommerce blob, whose display_price carries
// no currency of its own.
async function fetchJsonLdPrice(
  productUrl: string,
  vendorCurrency?: string
): Promise<FetchPriceOutcome> {
  try {
    const res = await fetchWithTimeout(productUrl);
    if (!res.ok) {
      // Dead-link audit: a removed page returns 404/410 → clear the stale price
      // and record the page as gone; any other failure is transient → keep the
      // last good price.
      return isDeadLinkStatus(res.status) ? DEAD_LINK : null;
    }
    // The store answered, but not with this page — the request ended at a front
    // door. Shopify sends a deleted product to `/` instead of 404ing it, and an
    // acquired shop sends its whole domain to the buyer's home page; fetch()
    // follows both silently, so a row in that state looked merely blocked and
    // was re-fetched every six hours for ever. Tested BEFORE the body is
    // parsed, because a home page that carries Product markup of its own would
    // otherwise be read and published as this set's price at this vendor.
    if (isGoneRedirect(productUrl, res.url)) return DEAD_LINK;
    const html = await res.text();

    // WooCommerce variable product: pick the base kit from the variation blob,
    // not the cheapest subkit (mirrors generic_price() + choose_kit_variant() in
    // scraper/scrape.py). display_price has no currency, so use the vendor's.
    const wooVariants = parseWooCommerceVariations(html);
    if (wooVariants.length > 0) {
      const currency = vendorCurrency ?? null;
      // Refuse currencies the site can't convert (renders as garbage) — a
      // refusal of a page that was read, so PRICE_REFUSED, not null.
      if (currency && !SUPPORTED_CURRENCIES.has(currency)) return PRICE_REFUSED;
      // Same canonical pick as the Shopify path and the audit; an
      // accessory-only variation list yields null → NO_BASE_KIT below.
      const chosen = pickBaseVariant(wooVariants);
      // Only subkits on offer (no base candidate) — clear the stale wrong price
      // rather than preserve it forever.
      if (!chosen) return NO_BASE_KIT;
      if (!isPlausibleBaseKitPrice(chosen.price, currency)) return PRICE_REFUSED;
      return {
        price: chosen.price,
        currency,
        inStock: chosen.available,
        variants: wooVariants.map((v) => ({
          title: v.title,
          price: v.price,
          available: v.available,
        })),
      };
    }

    // Set when we positively parse a Product whose offers are an ambiguous
    // multi-kit aggregate (no base-named offer). We skip storing any of its
    // prices, but having SEEN one means the stale stored price is a wrong
    // subkit — so we clear it (NO_BASE_KIT) instead of preserving it (null).
    let sawAmbiguousAggregate = false;

    // Set when a Product node WAS parsed and its number turned away by one of
    // this site's own rules (an unconvertible currency, a price outside
    // KIT_BOUNDS). The page is readable and the store is selling — the repair
    // is here, not at the vendor — so the row must not be filed as unreachable.
    let sawRefusedPrice = false;
    // Set when the page carries product markup of ANY kind we understand, so
    // "no price came out of this" can be told from "there was nothing here to
    // read". Without it a storefront on an unreadable platform is
    // indistinguishable from a blocked one, which is how Drop's 35 listings sat
    // under "the store's links are dead" while every one of them answered 200.
    let sawProductMarkup = false;

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
        sawProductMarkup = true;

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
        // Classify offer names with the SHARED classifier, not a bare
        // \bbase\b test — "Base + Novelties Bundle" contains "base" but
        // classifies NOVELTIES, and a bundle's price is not the base price.
        const namedBase = offerList.find(
          (o) => classifyVariant(String(o?.name ?? "")) === "BASE"
        );
        if (!namedBase && offerList.length > 1) {
          // Multiple named/unnamed offers, none identifiable as the base —
          // offers[0] would just be the cheapest subkit. Skip, and remember
          // this so the stale wrong price gets cleared.
          sawAmbiguousAggregate = true;
          continue;
        }
        if (!namedBase && offerList.length === 1) {
          // A single NAMED offer that is a subkit/accessory (the base sold out
          // and was delisted, leaving e.g. "Novelties — €39") must not be
          // stored as the base price.
          const name = String(offerList[0]?.name ?? "");
          const category = classifyVariant(name);
          if (
            name &&
            (category === "NOVELTIES" ||
              category === "SPACEBARS" ||
              category === "ALPHA" ||
              NONBASE_SUBKIT_RE.test(name) ||
              PRODUCT_ACCESSORY_RE.test(name))
          ) {
            sawAmbiguousAggregate = true;
            continue;
          }
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
        if (currency && !SUPPORTED_CURRENCIES.has(currency)) {
          sawRefusedPrice = true;
          continue;
        }

        const price = Number(chosen?.price ?? chosen?.lowPrice);
        // A real number this site won't publish (outside KIT_BOUNDS) is a
        // refusal; a missing or unparseable one is not — that is just a page
        // whose markup carries no price.
        if (!isNaN(price) && price > 0 && !isPlausibleBaseKitPrice(price, currency)) {
          sawRefusedPrice = true;
        }
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
      sawProductMarkup = true;
      const price = Number(amount[1].replace(/,/g, ""));
      const currency = cur ? cur[1] : null;
      if (currency && !SUPPORTED_CURRENCIES.has(currency)) return PRICE_REFUSED;
      if (!isNaN(price) && price > 0 && isPlausibleBaseKitPrice(price, currency)) {
        const inStock =
          !availability ||
          !/(outofstock|soldout|discontinued)/i.test(availability[1]);
        return { price, currency, inStock, variants: [] };
      }
      if (!isNaN(price) && price > 0) sawRefusedPrice = true;
    }
    // Read the page and found no usable base price. Which of the four reasons
    // it was decides the repair, so answer them apart rather than collapsing
    // them into the "couldn't reach it" null they used to share:
    //   • a real number this site refused → PRICE_REFUSED (fix the window or
    //     the Currency table)
    //   • an ambiguous multi-kit aggregate → NO_BASE_KIT (clear the stale
    //     wrong price, as before)
    //   • no product markup at all → NO_PRODUCT_DATA (teach the parser this
    //     platform, or retire the row)
    //   • markup that carries no number → null, unchanged: the page was a
    //     product page and simply had no price on it this time.
    if (sawRefusedPrice) return PRICE_REFUSED;
    if (sawAmbiguousAggregate) return NO_BASE_KIT;
    if (!sawProductMarkup) return NO_PRODUCT_DATA;
    return null;
  } catch (err) {
    // The third way a store says "gone", and the only one with no HTTP answer:
    // its domain stopped resolving. fetch() reports that as a bare
    // "TypeError: fetch failed", indistinguishable from a timeout or a refused
    // connection until the cause chain is read — so a shop whose domain lapsed
    // was filed as blocked and re-fetched every six hours for ever.
    if (isGoneHostError(err)) return DEAD_LINK;
    return null;
  }
}

// Attempt to fetch a live price for a single product URL: Shopify product
// JSON first (rich variant data), generic JSON-LD/OpenGraph markup otherwise.
// Pass vendorCurrency so Shopify geo-localization is pinned to the vendor's
// base currency rather than whatever the runner's IP geo-detects.
export async function fetchVendorPrice(productUrl: string, vendorCurrency?: string): Promise<FetchPriceOutcome> {
  if (!productUrl) return null;
  // GMK and dcs.wiki are catalog sources, not vendors — their links are
  // catalog/image references and must never produce a price. A JSON-LD reader
  // pointed at an archive page will happily return a number otherwise, and a
  // number is all it takes for the wiki to be published as a set's cheapest
  // vendor.
  if (isManufacturerListingUrl(productUrl)) return null;
  // A priced result OR the NO_BASE_KIT sentinel (both truthy) is a definitive
  // answer from the Shopify path — only a null (transient) falls through to the
  // JSON-LD reader.
  const shopify = await fetchShopifyPrice(productUrl, vendorCurrency);
  // A refusal falls through too, exactly as the null it replaced did: the
  // product page's own markup is allowed to answer better than the variant this
  // pass picked, and a bookkeeping split must not quietly change which number
  // gets stored. It is only the ANSWER that changes — if the page has nothing
  // better to say, the refusal is still what happened, and saying "couldn't
  // read it" instead is what filed live shops as dead links.
  if (shopify && shopify !== PRICE_REFUSED) return shopify;
  const generic = await fetchJsonLdPrice(productUrl, vendorCurrency);
  if (
    shopify === PRICE_REFUSED &&
    (generic === null || generic === NO_PRODUCT_DATA)
  ) {
    return PRICE_REFUSED;
  }
  return generic;
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
  // Subset of `failed`: the store answered 404/410. Reported separately so a
  // run whose failures are all dead links doesn't read as a blocked run.
  dead: number;
  // Reads that produced no price for a reason on OUR side. Neither is a
  // failure — the store answered — and neither is an update, because nothing
  // was stored; counted so a run can show that N listings stay unpublished for
  // want of a wider price window or a parser, not for want of another scrape.
  refused: number;
  unparsed: number;
  stoppedEarly: boolean; // true if the time budget was hit before finishing
}

// Refresh one VendorKit's cached price: fetch, then write the outcome.
async function refreshOne(
  vk: {
    id: string;
    productUrl: string | null;
    vendor: { currency: string };
    linkFailures?: number;
    deadSince?: Date | null;
  },
  result: RefreshResult
): Promise<void> {
  if (!vk.productUrl) return;
  result.attempted++;
  const priceData = await fetchVendorPrice(vk.productUrl, vk.vendor.currency);
  const outcome =
    priceData === DEAD_LINK
      ? "GONE"
      : priceData === NO_BASE_KIT
        ? "NO_BASE_KIT"
        : priceData === PRICE_REFUSED
          ? "PRICE_REFUSED"
          : priceData === NO_PRODUCT_DATA
            ? "NO_PRODUCT_DATA"
            : priceData
              ? "PRICED"
              : "UNREADABLE";
  const health = nextLinkHealth(vk, outcome);
  if (priceData === DEAD_LINK) {
    // The store answered "gone". Clear the price like NO_BASE_KIT does — a
    // removed listing must not keep quoting its last price — but leave
    // priceSource alone: this page was never READ, and stamping it 'SCRAPED'
    // is what made a closed store read as a pricing backlog for months.
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: {
        price: null,
        compareAtPrice: null,
        inStock: false,
        priceUpdatedAt: new Date(),
        variants: [],
        ...health,
      },
    });
    result.dead++;
    result.failed++;
  } else if (priceData === PRICE_REFUSED || priceData === NO_PRODUCT_DATA) {
    // The page was fetched. Record WHAT was learned — priceSource is the only
    // column that carries it, and leaving it NULL is what made a live store
    // read as a dead link set — but do NOT touch the price: the refusal is
    // about the number just read, and a page with no markup says nothing at
    // all about the last good one. Link health follows nextLinkHealth: a
    // refusal is a read (counters reset), an unparseable 200 is not, because a
    // bot check served as 200 is indistinguishable from one.
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: {
        priceUpdatedAt: new Date(),
        priceSource:
          priceData === PRICE_REFUSED
            ? PRICE_SOURCE_REFUSED
            : PRICE_SOURCE_UNPARSED,
        ...health,
      },
    });
    if (priceData === PRICE_REFUSED) result.refused++;
    else result.unparsed++;
  } else if (priceData === NO_BASE_KIT) {
    // Listing has no base kit (only subkits / ambiguous aggregate) — clear the
    // stale wrong price so it stops showing, instead of preserving it forever.
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: {
        price: null,
        compareAtPrice: null,
        inStock: false,
        priceUpdatedAt: new Date(),
        priceSource: "SCRAPED",
        variants: [],
        ...health,
      },
    });
    result.updated++;
  } else if (priceData) {
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: {
        price: priceData.price,
        // Null when the chosen variant isn't marked down, so a stale markdown
        // never outlives the discount that produced it.
        compareAtPrice: priceData.compareAt ?? null,
        // Store currency (meta.json) when reachable; otherwise the vendor's
        // own currency — e.g. Deskhero prices are CAD even when meta is blocked.
        currency: priceData.currency ?? vk.vendor.currency,
        priceUpdatedAt: new Date(),
        priceSource: "SCRAPED",
        variants: priceData.variants,
        // Keep the last valid price for comparison, while stock follows the
        // selected/base variant's current vendor availability.
        inStock: priceData.inStock,
        ...health,
      },
    });
    result.updated++;
  } else {
    // Record the attempt so we don't hammer the same blocked URL every run,
    // and count it: enough consecutive unreadable answers is the only evidence
    // a store that redirects, 401s, 402s or stopped resolving ever gives.
    await prisma.vendorKit.update({
      where: { id: vk.id },
      data: { priceUpdatedAt: new Date(), ...health },
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
  // `maxAgeHours: 0` is FORCE_PRICE_REFRESH — a person saying "check
  // everything now". The back-off is an optimisation, not a quarantine, so it
  // must not survive that: dead rows fall back to the normal cutoff.
  const deadCutoff =
    maxAgeHours <= 0
      ? cutoff
      : new Date(Date.now() - DEAD_LINK_RECHECK_HOURS * 60 * 60 * 1000);

  const candidates = await prisma.vendorKit.findMany({
    where: {
      ...(ids && ids.length > 0 && { id: { in: ids } }),
      // Blank ("") productUrls are bad import data, not scrapeable listings —
      // they pass a bare IS NOT NULL filter and once sent a whole nightly
      // price pass to navigate to "".
      productUrl: { not: null, notIn: [""] },
      // Manufacturer/catalog rows (gmk → gmk.net, dcs-wiki → dcs.wiki) only
      // carry a catalog URL for the catalog and image passes and must never
      // enter the price queue: they can never be priced, yet with no price
      // timestamp they sort AHEAD of every real listing under the NULLS FIRST
      // ordering below, and this run is time-boxed to ~35s of a 60s function.
      ...NOT_MANUFACTURER_LISTING,
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
          // Two cadences, not one. A row whose page the store says is GONE, or
          // that has been unreadable for DEAD_LINK_FAILURE_THRESHOLD runs in a
          // row, waits DEAD_LINK_RECHECK_HOURS instead of `maxAgeHours` — it
          // cannot be priced, and this run is time-boxed, so re-fetching it
          // every six hours costs live listings their turn (and an unpriced
          // live listing is hidden outright on a RELEASED set). It is a
          // back-off, never a retirement: the row keeps its place and the
          // first read that gets through resets both columns.
          OR: [
            { priceUpdatedAt: null },
            {
              AND: [
                { deadSince: null },
                { linkFailures: { lt: DEAD_LINK_FAILURE_THRESHOLD } },
                { priceUpdatedAt: { lt: cutoff } },
              ],
            },
            {
              AND: [
                {
                  OR: [
                    { deadSince: { not: null } },
                    { linkFailures: { gte: DEAD_LINK_FAILURE_THRESHOLD } },
                  ],
                },
                { priceUpdatedAt: { lt: deadCutoff } },
              ],
            },
          ],
        },
      }),
    },
    orderBy: [{ priceUpdatedAt: { sort: "asc", nulls: "first" } }],
    take: limit,
    select: {
      id: true,
      productUrl: true,
      linkFailures: true,
      deadSince: true,
      vendor: { select: { currency: true } },
    },
  });

  const result: RefreshResult = {
    attempted: 0,
    updated: 0,
    failed: 0,
    dead: 0,
    refused: 0,
    unparsed: 0,
    stoppedEarly: false,
  };
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
