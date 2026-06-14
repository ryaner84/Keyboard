// Scraper for keyboard vendor stores (Shopify-based).
// Both NovelKeys and MatrixLab expose a public /products.json endpoint —
// no authentication, no bot-protection from server-side Vercel IPs.
//
// Each product is upserted as a GroupBuy with productType="KEYBOARD".
// Spec fields (layout, material, mountingStyle) are auto-detected from
// the product title and tags; if a field is already set in the DB by an
// admin it is NOT overwritten (manual curation wins).

import { prisma } from "@/lib/prisma";
import type { GBStatus } from "@/generated/prisma";

const FETCH_TIMEOUT_MS = 10_000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9",
  "Accept-Language": "en-US,en;q=0.9",
};

// ── Vendor registry ──────────────────────────────────────────────────────────

// Keyboards are expensive — anything below this threshold is almost certainly
// an accessory (cable, artisan, deskmat) in the same collection, not a board.
const KEYBOARD_MIN_PRICE_USD = 300;

// Mass-produced always-available brands are not limited group buys — skip them.
const BLOCKED_BRANDS = ["keychron"];

function isBlockedProduct(product: ShopifyProduct): boolean {
  const text = `${product.title} ${product.tags} ${product.product_type}`.toLowerCase();
  return BLOCKED_BRANDS.some((brand) => text.includes(brand));
}

// Collection category hint — overrides auto-detected status for collections
// where the category is known from the URL (e.g. "extra-drop" → IN_STOCK,
// "on-going-gb" → ACTIVE_GB). Auto-detection still runs as a fallback.
type CollectionCategory = "group-buy" | "pre-order" | "extra-drop" | "ongoing-gb";

interface VendorConfig {
  id: string;           // slug prefix used to build the GroupBuy.slug
  displayName: string;  // stored as the "designer" until a real designer is set
  collectionUrl: string;
  extraCollectionUrls?: string[]; // additional collections to merge (e.g. Prototypist has two)
  collectionCategory?: CollectionCategory; // status hint derived from collection name
  currency: string;
  region: string;
}

export const KEYBOARD_VENDORS: VendorConfig[] = [
  {
    id: "nk",
    displayName: "NovelKeys",
    collectionUrl: "https://novelkeys.com/collections/keyboards/products.json",
    currency: "USD",
    region: "US",
  },
  {
    id: "ml",
    displayName: "MatrixLab",
    collectionUrl: "https://www.matrixlab.store/collections/group-buy/products.json",
    currency: "USD",
    region: "Global",
  },
  {
    id: "pt",
    displayName: "Prototypist",
    // Two separate collections — we'll fetch both and dedupe by Shopify product id.
    collectionUrl: "https://prototypist.net/collections/live-group-buys/products.json",
    extraCollectionUrls: [
      "https://prototypist.net/collections/pre-orders/products.json",
    ],
    currency: "USD",
    region: "US",
  },
  {
    id: "klc",
    displayName: "KLC Playground",
    // Extra-drop = leftover stock from a closed GB, available immediately.
    // Ongoing-GB = currently open group buy.
    // Both merged and deduped by Shopify product id.
    collectionUrl: "https://klc-playground.com/collections/extra-drop-from-group-buy/products.json",
    extraCollectionUrls: [
      "https://klc-playground.com/collections/on-going-gb/products.json",
    ],
    currency: "SGD",
    region: "SG",
  },
  {
    id: "kt",
    displayName: "Ktechs",
    collectionUrl: "https://ktechs.store/collections/group-buy/products.json",
    extraCollectionUrls: [
      "https://ktechs.store/collections/pre-order/products.json",
    ],
    currency: "USD",
    region: "US",
  },
  {
    id: "pk",
    displayName: "Pantheon Keys",
    collectionUrl: "https://pantheonkeys.com/collections/ongoing-group-buys/products.json",
    currency: "USD",
    region: "US",
  },
  {
    id: "kbd",
    displayName: "KBDfans",
    collectionUrl: "https://kbdfans.com/collections/group-buy-live/products.json",
    extraCollectionUrls: [
      "https://kbdfans.com/collections/group-buy-extra/products.json",
      "https://kbdfans.com/collections/pre-order/products.json",
    ],
    currency: "USD",
    region: "Global",
  },
  {
    id: "cc",
    displayName: "ClickClack",
    collectionUrl: "https://clickclack.io/collections/groupbuy/products.json",
    currency: "SGD",
    region: "SG",
  },
  {
    id: "ilu",
    displayName: "iLumKB",
    // "live" = ongoing GBs; "pre-order-keycaps" may also carry keyboard pre-orders.
    // The $300 minimum price filter drops any keycap-only products automatically.
    collectionUrl: "https://ilumkb.com/collections/live/products.json",
    extraCollectionUrls: [
      "https://ilumkb.com/collections/pre-order-keycaps/products.json",
    ],
    currency: "SGD",
    region: "SG",
  },
  {
    id: "ck",
    displayName: "CannonKeys",
    // keyboard-group-buys = active GBs; keyboard-extras = extra/leftover stock;
    // coming-soon = upcoming / interest check stage.
    collectionUrl: "https://cannonkeys.com/collections/keyboard-group-buys/products.json",
    extraCollectionUrls: [
      "https://cannonkeys.com/collections/keyboard-extras/products.json",
      "https://cannonkeys.com/collections/coming-soon/products.json",
    ],
    currency: "USD",
    region: "US",
  },
];

// ── Shopify product types ────────────────────────────────────────────────────

interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  available: boolean;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

interface ShopifyImage {
  src: string;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  tags: string;          // comma-separated string
  product_type: string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

// ── Status detection ─────────────────────────────────────────────────────────

// Derive a category hint from a collection URL when it isn't set explicitly.
function categoryFromUrl(url: string): CollectionCategory | null {
  if (/extra.?drop|extras|keyboard.?extras/i.test(url)) return "extra-drop";
  if (/on.?going/i.test(url)) return "ongoing-gb";
  if (/pre.?order|coming.?soon/i.test(url)) return "pre-order";
  if (/group.?buy|live.?gb/i.test(url)) return "group-buy";
  return null;
}

function detectStatus(
  product: ShopifyProduct,
  categoryHint?: CollectionCategory | null
): GBStatus {
  const tags = product.tags.toLowerCase().split(",").map((t) => t.trim());
  const title = product.title.toLowerCase();
  const anyAvailable = product.variants.some((v) => v.available);

  // Tags and title are the most reliable signals.
  if (tags.includes("interest-check") || tags.includes("ic") || title.includes("interest check")) {
    return "INTEREST_CHECK";
  }
  if (tags.includes("shipping") || tags.includes("fulfillment") || title.includes("shipping now")) {
    return "SHIPPING";
  }
  if (tags.includes("delivered") || tags.includes("complete") || tags.includes("fulfilled")) {
    return "DELIVERED";
  }

  // Collection category overrides availability-based guessing.
  if (categoryHint === "extra-drop") {
    // Extra drop = GB closed, selling leftover units. Available = IN_STOCK.
    return anyAvailable ? "IN_STOCK" : "DELIVERED";
  }
  if (categoryHint === "ongoing-gb" || categoryHint === "group-buy") {
    return anyAvailable ? "ACTIVE_GB" : "DELIVERED";
  }
  if (categoryHint === "pre-order") {
    return anyAvailable ? "ACTIVE_GB" : "INTEREST_CHECK";
  }

  // Fallback: availability + tags
  if (anyAvailable) {
    if (
      tags.some((t) => ["pre-order", "preorder", "group-buy", "gb"].includes(t)) ||
      title.includes("pre-order") ||
      title.includes("group buy")
    ) {
      return "ACTIVE_GB";
    }
    return "ACTIVE_GB";
  }
  return "DELIVERED";
}

// ── Spec detection from title + tags ─────────────────────────────────────────

const LAYOUT_PATTERNS: [RegExp, string][] = [
  [/\b(100%|full[\s-]?size|fullsize)\b/i, "Full-size"],
  [/\b(tkl|80%|tenkeyless)\b/i, "TKL"],
  [/\b(75%|75\s?percent)\b/i, "75%"],
  [/\b(65%|65\s?percent)\b/i, "65%"],
  [/\b(60%|60\s?percent)\b/i, "60%"],
  [/\b(40%|40\s?percent)\b/i, "40%"],
  [/\b(alice|arisu| alice[\s-]?arisu)\b/i, "Alice/Arisu"],
  [/\b(split)\b/i, "Split"],
  [/\b(numpad|num\s?pad)\b/i, "Numpad"],
  [/\b(ergo)\b/i, "Ergo"],
];

const MOUNT_PATTERNS: [RegExp, string][] = [
  [/\bgasket\b/i, "Gasket"],
  [/\btop[\s-]?mount\b/i, "Top Mount"],
  [/\btray[\s-]?mount\b/i, "Tray Mount"],
  [/\bleaf[\s-]?spring\b/i, "Leaf Spring"],
  [/\bburger\b/i, "Burger"],
  [/\bplateless\b/i, "Plateless"],
];

const MATERIAL_PATTERNS: [RegExp, string][] = [
  [/\bpolycarbonate\b|\bpc\b/i, "Polycarbonate"],
  [/\balumini?u?m\b|\balu\b/i, "Aluminum"],
  [/\bacrylic\b/i, "Acrylic"],
  [/\bbrass\b/i, "PC + Brass"],
];

function detect<T extends string>(
  patterns: [RegExp, T][],
  text: string
): T | null {
  for (const [re, value] of patterns) {
    if (re.test(text)) return value;
  }
  return null;
}

function detectSpecs(product: ShopifyProduct) {
  const haystack = [
    product.title,
    product.tags,
    product.body_html.replace(/<[^>]+>/g, " "),
  ].join(" ");

  return {
    layout: detect(LAYOUT_PATTERNS, haystack),
    mountingStyle: detect(MOUNT_PATTERNS, haystack),
    material: detect(MATERIAL_PATTERNS, haystack),
  };
}

// ── Price extraction ──────────────────────────────────────────────────────────

function variantPrices(product: ShopifyProduct): number[] {
  return product.variants
    .filter((v) => parseFloat(v.price) > 0)
    .map((v) => parseFloat(v.price));
}

// A product qualifies as a keyboard if ANY variant meets the price floor.
// GB listings often bundle cheap add-on variants (deposit, deskmat, extra PCB,
// daughterboard) that would drag a naive Math.min below the floor and wrongly
// drop the whole board — so we check for at least one keyboard-priced variant.
function qualifiesAsKeyboard(product: ShopifyProduct): boolean {
  return variantPrices(product).some((p) => p >= KEYBOARD_MIN_PRICE_USD);
}

// Representative base price = cheapest variant that still clears the floor
// (the base keyboard config), ignoring sub-floor add-on variants. Falls back to
// the overall minimum if nothing clears the floor (shouldn't happen post-filter).
function lowestPrice(product: ShopifyProduct): number | null {
  const prices = variantPrices(product);
  if (prices.length === 0) return null;
  const real = prices.filter((p) => p >= KEYBOARD_MIN_PRICE_USD);
  return real.length > 0 ? Math.min(...real) : Math.min(...prices);
}

// "https://novelkeys.com/collections/keyboards/products.json" → "https://novelkeys.com"
function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// ── Strip HTML for description ────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 1000);
}

// ── Fetch all pages of a Shopify collection ──────────────────────────────────

async function fetchCollection(
  baseUrl: string,
  maxRuntimeMs: number
): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let page = 1;
  const deadline = Date.now() + maxRuntimeMs;

  while (Date.now() < deadline) {
    const url = `${baseUrl}?limit=250&page=${page}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`[keyboard-vendors] ${url} → HTTP ${res.status}`);
        break;
      }

      const json: ShopifyProductsResponse = await res.json();
      const batch = json.products ?? [];
      products.push(...batch);

      if (batch.length < 250) break; // last page
      page++;
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[keyboard-vendors] fetch error ${url}:`, err);
      break;
    }
  }

  return products;
}

// ── Main import function ──────────────────────────────────────────────────────

export interface KeyboardVendorResult {
  vendor: string;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export async function importKeyboardVendor(
  vendor: VendorConfig,
  { maxRuntimeMs = 20_000 }: { maxRuntimeMs?: number } = {}
): Promise<KeyboardVendorResult> {
  const result: KeyboardVendorResult = {
    vendor: vendor.id,
    fetched: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  // Merge all collections for this vendor, deduplicated by Shopify product id.
  // Track the source URL so we can derive a category hint from its name.
  const urls = [vendor.collectionUrl, ...(vendor.extraCollectionUrls ?? [])];
  const seen = new Map<number, string>(); // id → source url
  const allProducts: ShopifyProduct[] = [];
  const budgetPerUrl = Math.floor((maxRuntimeMs - 2000) / urls.length);

  for (const url of urls) {
    const batch = await fetchCollection(url, budgetPerUrl);
    for (const p of batch) {
      if (!seen.has(p.id)) {
        seen.set(p.id, url);
        allProducts.push(p);
      }
    }
  }

  // Drop accessories (no variant clears the price floor) and mass-produced
  // always-available brands.
  const products = allProducts.filter(
    (p) => !isBlockedProduct(p) && qualifiesAsKeyboard(p)
  );

  result.fetched = products.length;
  if (allProducts.length !== products.length) {
    console.log(
      `[keyboard-vendors] ${vendor.id}: filtered out ${allProducts.length - products.length} products below $${KEYBOARD_MIN_PRICE_USD}`
    );
  }

  for (const product of products) {
    try {
      const slug = `${vendor.id}-${product.handle}`.slice(0, 120);
      const sourceUrl = seen.get(product.id) ?? vendor.collectionUrl;
      const categoryHint = vendor.collectionCategory ?? categoryFromUrl(sourceUrl);
      const status = detectStatus(product, categoryHint);
      const specs = detectSpecs(product);
      const imageUrl = product.images[0]?.src ?? null;
      const images = product.images.slice(0, 8).map((i) => i.src);
      const description = stripHtml(product.body_html);
      const basePrice = lowestPrice(product); // already passed the >= $300 filter
      const productUrl = `${originFromUrl(sourceUrl)}/products/${product.handle}`;

      // Check if the record already exists.
      const existing = await prisma.groupBuy.findUnique({
        where: { slug },
        select: {
          id: true,
          layout: true,
          mountingStyle: true,
          material: true,
          images: true,
        },
      });

      // Spec fields: only set from scraper if not already manually curated.
      const specUpdates = {
        layout: existing?.layout ?? specs.layout,
        mountingStyle: existing?.mountingStyle ?? specs.mountingStyle,
        material: existing?.material ?? specs.material,
      };

      // Pricing/vendor fields — refreshed every run (price moves, vendor fixed).
      const vendorFields = {
        basePrice: basePrice ?? undefined,
        priceCurrency: vendor.currency,
        productUrl,
        vendorName: vendor.displayName,
        vendorRegion: vendor.region,
      };

      if (!existing) {
        await prisma.groupBuy.create({
          data: {
            slug,
            name: product.title,
            designer: vendor.displayName,
            status,
            productType: "KEYBOARD",
            imageUrl,
            images,
            description: description || null,
            ...specUpdates,
            ...vendorFields,
          },
        });
        result.created++;
      } else {
        // Always update status, name, images (preserve manual spec overrides).
        const keepImages =
          existing.images.length > 0 &&
          !existing.images.every((u) => images.includes(u));

        await prisma.groupBuy.update({
          where: { slug },
          data: {
            name: product.title,
            status,
            imageUrl: imageUrl ?? undefined,
            images: keepImages ? existing.images : images,
            description: description || undefined,
            ...specUpdates,
            ...vendorFields,
          },
        });
        result.updated++;
      }
    } catch (err) {
      result.errors.push(`${product.handle}: ${err}`);
    }
  }

  return result;
}

export async function importAllKeyboardVendors(
  options: { maxRuntimeMs?: number } = {}
): Promise<KeyboardVendorResult[]> {
  const { maxRuntimeMs = 40_000 } = options;
  const perVendor = Math.floor(maxRuntimeMs / KEYBOARD_VENDORS.length);
  const results: KeyboardVendorResult[] = [];

  for (const vendor of KEYBOARD_VENDORS) {
    const r = await importKeyboardVendor(vendor, { maxRuntimeMs: perVendor });
    results.push(r);
    console.log(
      `[keyboard-vendors] ${vendor.id}: fetched=${r.fetched} created=${r.created} updated=${r.updated} errors=${r.errors.length}`
    );
  }

  return results;
}
