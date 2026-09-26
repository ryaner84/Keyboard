// Read-only audit of the /released "On sale" listings against the stores
// themselves, one batch at a time.
//
// The discounted rows are the ones visitors act on fastest — a struck-through
// price and a Buy button — and they are also the ones most likely to be wrong,
// because every field on them is a SNAPSHOT: the markdown (compareAtPrice), the
// stock flag and the link were true when the price pass last read the page, and
// a sale ends, a set sells out and a handle is renamed between passes. This
// script re-reads each BASE listing of each on-sale set from a runner (stores
// block this project's dev egress, not GitHub's) and prints one verdict line
// per listing, so the scheduled review can report the rows that are wrong
// through the site's own report buttons.
//
// Batching is by SLUG, alphabetically, after a cursor: `AFTER_SLUG` is the last
// slug the previous run covered and `BATCH_SIZE` (default 50) is how many sets
// to take after it. A slug cursor survives the list changing between runs —
// a set that joins the sale before the cursor is simply picked up on the next
// cycle — and when the cursor passes the end the batch wraps to the start.
//
// Writes nothing, touches no database. The report half lives in the workflow
// (released-deals-audit.yml, input `reports`), so filing a report is always an
// explicit, reviewed step and never a side effect of reading.
//
//   BASE_URL=https://keyboard-six-tau.vercel.app AFTER_SLUG=gmk-foo BATCH_SIZE=50 \
//     node scripts/released-deals-audit.mjs

import { currencyHomeCountry } from "./lib/currencies.mjs";
import { catalogProductTitle, shopifyProductNode } from "./lib/storefront-catalog.mjs";

const BASE = (process.env.BASE_URL ?? "https://keyboard-six-tau.vercel.app").replace(/\/$/, "");
const AFTER_SLUG = (process.env.AFTER_SLUG ?? "").trim();
const BATCH_SIZE = Math.max(1, parseInt(process.env.BATCH_SIZE ?? "50", 10) || 50);
// Every priced BASE listing of the set, not only the discounted one: a set page
// shows them side by side, and a visitor comparing the markdown against the
// others is misled just as much by a stale neighbour.
const ONLY_DISCOUNTED = process.env.ONLY_DISCOUNTED === "1";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const TIMEOUT_MS = 20_000;
// Per-host spacing. Stores rate-limit per IP and a 429 would read as a
// mismatch that is really our own burst (see scripts/lib/host-throttle.mjs).
const HOST_GAP_MS = 1_500;
const HOST_LANES = 6;
// A price within this fraction of the site's is the same number (rounding,
// a cents-vs-units display).
const PRICE_TOLERANCE = 0.02;

async function get(url, { json = false, cookie } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = cookie ? { ...HEADERS, Cookie: cookie } : HEADERS;
    const res = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    const text = await res.text();
    let data = null;
    if (json) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: res.status, finalUrl: res.url || url, text, data };
  } catch (err) {
    return { status: 0, finalUrl: url, text: "", data: null, error: err.name === "AbortError" ? "timeout" : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── The on-sale list, exactly as /released?deals=1 serves it ─────────────────
async function loadOnSaleSets() {
  const sets = [];
  for (let page = 1; page < 50; page++) {
    const r = await get(`${BASE}/api/released?deals=1&sort=name&limit=48&page=${page}`, { json: true });
    if (!r.data) throw new Error(`/api/released page ${page} answered ${r.status} ${r.error ?? ""}`);
    sets.push(...(r.data.data ?? []));
    if (sets.length >= (r.data.total ?? 0) || (r.data.data ?? []).length === 0) break;
  }
  return sets.sort((a, b) => a.slug.localeCompare(b.slug));
}

function pickBatch(sets) {
  const start = AFTER_SLUG ? sets.findIndex((s) => s.slug.localeCompare(AFTER_SLUG) > 0) : 0;
  const from = start < 0 ? 0 : start; // cursor past the end → wrap
  const batch = sets.slice(from, from + BATCH_SIZE);
  const wrapped = start < 0 && AFTER_SLUG !== "";
  return { batch, from, wrapped };
}

// ── Reading the store ────────────────────────────────────────────────────────
const metaCache = new Map();
async function shopCurrency(origin) {
  if (!metaCache.has(origin)) {
    metaCache.set(
      origin,
      get(`${origin}/meta.json`, { json: true }).then((r) => (r.data && typeof r.data.currency === "string" ? r.data.currency : null)),
    );
  }
  return metaCache.get(origin);
}

function variantIdOf(url) {
  try {
    return new URL(url).searchParams.get("variant");
  } catch {
    return null;
  }
}

function shopifyHandleUrl(url) {
  const m = url.match(/^(https?:\/\/[^/]+)(?:\/[^/?#]+)*?\/products\/([^/?#]+)/);
  return m ? `${m[1]}/products/${m[2]}` : null;
}

/** Shopify (and clones): variants with price, compare-at and availability. */
async function readShopify(productUrl) {
  const handleUrl = shopifyHandleUrl(productUrl);
  if (!handleUrl) return null;
  // Pinned to the store's home market exactly as refreshPrices pins it: a
  // runner is in the US, and Shopify Markets otherwise answers a Canadian or
  // Australian shop in converted USD and a European one ex-VAT — a "mismatch"
  // against the number the site correctly stores.
  const currency = await shopCurrency(new URL(handleUrl).origin);
  const home = currency ? currencyHomeCountry(currency) : null;
  const cookie = currency ? `cart_currency=${currency}${home ? `; localization=${home}` : ""}` : undefined;
  // .js carries `available` per variant (the .json does not) and prices in
  // cents; .json carries the price strings the price pass reads.
  const [js, json] = await Promise.all([get(`${handleUrl}.js`, { json: true, cookie }), get(`${handleUrl}.json`, { json: true, cookie })]);
  const node = json.data ? shopifyProductNode(json.data) : null;
  if (!js.data?.variants && !node?.variants) {
    return { status: js.status || json.status, error: js.error ?? json.error, finalUrl: js.finalUrl };
  }
  const jsById = new Map((js.data?.variants ?? []).map((v) => [String(v.id), v]));
  const source = node?.variants ?? js.data.variants;
  const variants = source.map((v) => {
    const jv = jsById.get(String(v.id));
    const price = node ? parseFloat(v.price) : v.price / 100;
    const cmpRaw = node ? v.compare_at_price : v.compare_at_price != null ? v.compare_at_price / 100 : null;
    const compareAt = cmpRaw != null && cmpRaw !== "" ? parseFloat(cmpRaw) : null;
    const available = jv ? jv.available : typeof v.available === "boolean" ? v.available : null;
    return { id: String(v.id), title: v.title ?? v.name ?? "", price, compareAt, available };
  });
  return {
    kind: "shopify",
    status: 200,
    finalUrl: js.finalUrl,
    title: node ? catalogProductTitle(node) : js.data?.title ?? "",
    variants,
    currency,
  };
}

function schemaAvailability(value) {
  if (typeof value !== "string") return null;
  if (/InStock|PreOrder|BackOrder|LimitedAvailability|OnlineOnly/i.test(value)) return true;
  if (/OutOfStock|SoldOut|Discontinued/i.test(value)) return false;
  return null;
}

/** Everything else: WooCommerce variation blob, JSON-LD offers, OpenGraph. */
async function readGeneric(productUrl) {
  const r = await get(productUrl);
  if (r.status !== 200) return { status: r.status, error: r.error, finalUrl: r.finalUrl };
  const html = r.text;
  const title = (html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] ??
    html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "").trim();
  const variants = [];
  let currency = null;

  const woo = html.match(/data-product_variations=["']([^"']+)["']/i);
  if (woo) {
    try {
      const list = JSON.parse(woo[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      for (const v of list) {
        variants.push({
          id: String(v.variation_id),
          title: Object.values(v.attributes ?? {}).join(" / "),
          price: Number(v.display_price),
          compareAt: Number(v.display_regular_price) > Number(v.display_price) ? Number(v.display_regular_price) : null,
          available: typeof v.is_in_stock === "boolean" ? v.is_in_stock : null,
        });
      }
    } catch {
      // unreadable blob — fall through to JSON-LD
    }
  }
  if (variants.length === 0) {
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let data;
      try {
        data = JSON.parse(m[1]);
      } catch {
        continue;
      }
      const nodes = [data, ...(Array.isArray(data) ? data : []), ...(data["@graph"] ?? [])].flat();
      for (const n of nodes) {
        if (!n || !/Product/.test(String(n["@type"]))) continue;
        const offers = [n.offers, ...(n.hasVariant ?? []).map((hv) => hv.offers)].flat().filter(Boolean);
        for (const o of offers.flatMap((o) => (o.offers ? [o.offers].flat() : [o]))) {
          const price = parseFloat(o.price ?? o.lowPrice);
          if (!Number.isFinite(price)) continue;
          currency ??= o.priceCurrency ?? null;
          variants.push({ id: "", title: o.name ?? "", price, compareAt: null, available: schemaAvailability(o.availability) });
        }
      }
    }
  }
  if (variants.length === 0) {
    const og = html.match(/property=["']product:price:amount["'][^>]*content=["']([\d.,]+)["']/i);
    if (og) {
      currency = html.match(/property=["']product:price:currency["'][^>]*content=["']([A-Z]{3})["']/i)?.[1] ?? null;
      const avail = html.match(/property=["']product:availability["'][^>]*content=["']([^"']+)["']/i)?.[1];
      variants.push({
        id: "",
        title: "",
        price: parseFloat(og[1].replace(/,/g, "")),
        compareAt: null,
        available: avail ? !/out|sold/i.test(avail) : null,
      });
    }
  }
  return { kind: woo ? "woocommerce" : "html", status: 200, finalUrl: r.finalUrl, title, variants, currency };
}

// ── Judging one listing ──────────────────────────────────────────────────────
const STOP_TOKENS = new Set(["gmk", "cyl", "dcs", "sa", "dss", "dsa", "mtnu", "keycaps", "keycap", "set", "the", "r1", "base", "kit"]);
function nameTokens(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(0.5, PRICE_TOLERANCE * Math.max(a, b));

function chooseVariant(live, vk) {
  const wanted = variantIdOf(vk.productUrl ?? "");
  if (wanted) {
    const v = live.variants.find((x) => x.id === wanted);
    if (v) return { v, how: "url ?variant" };
  }
  const base = live.variants.filter((x) => /\bbase\b/i.test(x.title) && !/\b(bundle|\+|and)\b/i.test(x.title));
  if (base.length === 1) return { v: base[0], how: "titled base" };
  if (live.variants.length === 1) return { v: live.variants[0], how: "only variant" };
  const byPrice = live.variants.find((x) => near(x.price, vk.price));
  if (byPrice) return { v: byPrice, how: "price match" };
  return { v: null, how: "no base variant identified" };
}

async function judge(set, vk) {
  const url = vk.productUrl;
  const siteCur = vk.currency ?? vk.vendor?.currency ?? "USD";
  const row = {
    set: set.slug,
    setName: set.name,
    vendor: vk.vendor?.name ?? "?",
    vkId: vk.id,
    url,
    site: { price: vk.price, currency: siteCur, compareAt: vk.compareAtPrice, inStock: vk.inStock, updated: (vk.priceUpdatedAt ?? "").slice(0, 10) },
    issues: [],
    live: null,
  };
  if (!url) {
    row.issues.push("NO_URL");
    return row;
  }
  let live = null;
  try {
    live = (await readShopify(url)) ?? null;
    if (!live || !live.variants) {
      const generic = await readGeneric(url);
      // A renamed handle or a moved domain (novelkeys.xyz → novelkeys.com)
      // answers the human page through a redirect while the old .js/.json
      // do not follow it — re-ask the product JSON where the page landed.
      const moved = generic.finalUrl && generic.finalUrl !== url ? await readShopify(generic.finalUrl) : null;
      live = moved?.variants ? { ...moved, finalUrl: generic.finalUrl } : generic.variants ? generic : live ?? generic;
      if (moved?.variants) row.issues.push(`MOVED(${generic.finalUrl})`);
    }
  } catch (err) {
    live = { status: 0, error: err.message };
  }
  row.live = live;

  if (!live?.variants) {
    if (live?.status === 404 || live?.status === 410) row.issues.push(`DEAD_LINK(${live.status})`);
    else {
      try {
        if (live?.finalUrl && new URL(live.finalUrl).pathname === "/" && new URL(url).pathname !== "/") row.issues.push("REDIRECTS_TO_HOMEPAGE");
      } catch {
        /* ignore */
      }
      if (row.issues.length === 0) row.issues.push(`UNREADABLE(${live?.status ?? "?"}${live?.error ? ` ${live.error}` : ""})`);
    }
    return row;
  }
  if (live.variants.length === 0) {
    row.issues.push("UNREADABLE(no price markup)");
    return row;
  }
  try {
    if (new URL(live.finalUrl).pathname === "/" && new URL(url).pathname !== "/") row.issues.push("REDIRECTS_TO_HOMEPAGE");
  } catch {
    /* ignore */
  }

  // Wrong product: the page's title shares no distinctive word with the set.
  const tokens = nameTokens(set.name);
  // Compared with spacing and punctuation squeezed out, so "2Pack" and
  // "2 Pack" are one word.
  const title = (live.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (tokens.length > 0 && title && !tokens.some((t) => title.includes(t))) {
    row.issues.push(`WRONG_PRODUCT(page "${live.title}")`);
  }

  const { v, how } = chooseVariant(live, vk);
  row.picked = v ? { ...v, how } : { how };
  if (live.currency && live.currency !== siteCur) row.issues.push(`CURRENCY(site ${siteCur} / store ${live.currency})`);
  if (!v) {
    row.issues.push(`PRICE_NOT_ON_PAGE(site ${vk.price}; page ${live.variants.map((x) => `${x.title || "?"}=${x.price}`).slice(0, 6).join(", ")})`);
  } else {
    if (!near(v.price, vk.price)) row.issues.push(`PRICE(site ${vk.price} / live ${v.price})`);
    const liveDiscount = v.compareAt != null && v.compareAt > v.price ? v.compareAt : null;
    // A markdown is only shown on a buyable row; on one sold out on both
    // sides a differing compare-at misleads nobody.
    const bothSoldOut = !vk.inStock && v.available === false;
    if (bothSoldOut) {
      // nothing to check
    } else if (vk.compareAtPrice != null && liveDiscount == null) row.issues.push(`DISCOUNT_ENDED(site was ${vk.compareAtPrice} → ${vk.price}; live no markdown)`);
    else if (vk.compareAtPrice != null && !near(liveDiscount, vk.compareAtPrice)) row.issues.push(`COMPARE_AT(site ${vk.compareAtPrice} / live ${liveDiscount})`);
    else if (vk.compareAtPrice == null && liveDiscount != null) row.issues.push(`DISCOUNT_MISSING(live ${liveDiscount} → ${v.price})`);
    if (v.available === false && vk.inStock) row.issues.push("STOCK(site in stock / live sold out)");
    if (v.available === true && !vk.inStock) row.issues.push("STOCK(site sold out / live in stock)");
  }
  return row;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sets = await loadOnSaleSets();
  const { batch, from, wrapped } = pickBatch(sets);
  console.log(`ON_SALE_TOTAL | ${sets.length}`);
  console.log(`BATCH | from index ${from}${wrapped ? " (cursor passed the end — wrapped to start)" : ""} | ${batch.length} set(s) | after_slug="${AFTER_SLUG}"`);
  if (batch.length) console.log(`BATCH_RANGE | ${batch[0].slug} … ${batch[batch.length - 1].slug}`);
  console.log(`NEXT_AFTER_SLUG | ${batch.length ? batch[batch.length - 1].slug : ""}`);

  const jobs = [];
  for (const set of batch) {
    const base = (set.kits ?? []).find((k) => k.type === "BASE");
    if (!base) {
      console.log(`SET_NO_BASE | ${set.slug}`);
      continue;
    }
    for (const vk of base.vendorKits ?? []) {
      if (vk.price == null) continue;
      if (ONLY_DISCOUNTED && vk.compareAtPrice == null) continue;
      jobs.push({ set, vk });
    }
  }

  // Sequential per host with a gap, hosts in parallel lanes.
  const byHost = new Map();
  for (const j of jobs) {
    let host = "?";
    try {
      host = new URL(j.vk.productUrl).host;
    } catch {
      /* no URL */
    }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(j);
  }
  const queues = [...byHost.values()];
  const results = [];
  async function lane() {
    for (;;) {
      const q = queues.shift();
      if (!q) return;
      for (const j of q) {
        results.push(await judge(j.set, j.vk));
        await new Promise((r) => setTimeout(r, HOST_GAP_MS));
      }
    }
  }
  await Promise.all(Array.from({ length: HOST_LANES }, lane));

  results.sort((a, b) => a.set.localeCompare(b.set) || a.vendor.localeCompare(b.vendor));
  let bad = 0;
  for (const r of results) {
    const s = r.site;
    const p = r.picked;
    const verdict = r.issues.length ? "ISSUE" : "OK";
    if (r.issues.length) bad++;
    console.log(
      `${verdict} | ${r.set} | ${r.vendor} | vk=${r.vkId} | site ${s.price} ${s.currency}` +
        `${s.compareAt != null ? ` (was ${s.compareAt})` : ""} ${s.inStock ? "in-stock" : "sold-out"} upd=${s.updated}` +
        ` | live ${p?.price ?? "-"}${p?.compareAt ? ` (was ${p.compareAt})` : ""} ${p?.available === true ? "in-stock" : p?.available === false ? "sold-out" : "stock?"}` +
        ` ${r.live?.currency ?? ""} [${p?.how ?? "-"}${p?.title ? `: ${p.title}` : ""}]` +
        ` | ${r.issues.join("; ") || "-"} | ${r.url ?? ""}`,
    );
  }
  console.log(`SUMMARY | sets=${batch.length} listings=${results.length} issues=${bad}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
