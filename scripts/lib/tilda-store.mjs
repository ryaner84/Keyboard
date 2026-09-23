// Reading a **Tilda Store** catalogue — the one place the vocabulary of a
// storefront whose product grid is drawn in the BROWSER is written.
//
// Every other platform this codebase reads serves its products in the page or
// at a sibling endpoint: Shopify (and Haravan/Sapo, see storefront-catalog.mjs)
// answer `/products/<handle>.json`, WooCommerce ships the variation blob in the
// add-to-cart form, and anything else usually carries JSON-LD or an OpenGraph
// price. A Tilda Store serves NONE of that. What it serves is an empty
// `<div class="js-store-grid-cont">` plus a `t_store_init('<recid>', options)`
// call, and the grid is filled by an XHR the browser makes afterwards.
//
// FunKeys is the worked example. Probed from a runner on 2026-09-22 and again
// on 2026-09-23, `groupbuy.funkeys.com.ua/gmk_colorchrome` answers 200 with
// 307,495 bytes of real page — the set's own name in the title, the shop's
// news, its menu — and not one price, no `data-product-*` attribute, no
// JSON-LD, no OpenGraph price and no `itemprop="price"` anywhere in it. So
// every parser path here was correct to find nothing, `NO_PRODUCT_DATA` was the
// honest answer, and all 6 of FunKeys' rows had been unpriced — therefore
// hidden, their sets being released — for as long as the vendor has existed.
//
// #189 pinned the block's own parameters and got one step short of the data:
// the key in the options literal is **`storepart`**, not the `storepartuid` the
// request spells it as, the pair is per-BLOCK rather than per-site, and
// `https://store.tildaapi.com/api/getproductslist/?storepartuid=…&recid=…`
// answers a 20-byte `{"redirectto":"one"}` that had to be followed before any
// product list came back. It left the instruction this file states for
// zFrontier: do not write the reader against a GUESS at that hop.
//
// The hop is not a URL, which is why guessing would have failed. `redirectto`
// carries Tilda's **root ZONE**, and the app's own `t_store__handleRootzoneRedirect`
// swaps the LAST LABEL of the endpoint host for it before re-issuing the same
// request:
//
//     var n = o?.redirectto; if (!n) return false;
//     s = t_store__getRootZoneFromEndpoint(e) !== n;
//     s && (window.t_store_endpoint =
//       window.t_store_endpoint.split(".").slice(0, -1).join(".") + "." + n);
//
// So `store.tildaapi.com` + `"one"` is `store.tildaapi.one` — the same host on
// Tilda's other TLD, which serves the whole catalogue. Probed from a runner on
// 2026-09-23, that URL answers 200 with `total: 8` and the set's kits as named
// products the picker already understands:
//
//     "Base"            3600.0000  qty 0   (sku GMK-Colorchrome-Base)
//     "White Modifiers" 2900.0000  qty 0
//     "40s kit"         2100.0000  qty 0
//     "Accent"          1600.0000  qty 0
//     "NorDeUK"         1800.0000  qty 0
//     "Ковры"            (deskmats, qty "")
//
// Two things the swap must stay narrow about. The zone replaces ONE label of a
// host this module writes itself, and only when it is letters — a store's
// response may never point either price pass at a host of its choosing. And the
// hop is followed at most ONCE: the app re-issues the request, and a server
// answering `redirectto` forever would otherwise be an unbounded loop inside a
// time-boxed pass.
//
// WRITTEN TWICE, as everything that reads a store is: `scraper/scrape.py`
// mirrors this module (Python cannot import a JS module) and
// `npm run test:tilda-store` fails if the two halves drift.

/** The endpoint the Tilda app itself starts from (`window.t_store_endpoint`). */
export const TILDA_STORE_API_HOST = "store.tildaapi.com";

/** The catalogue route on that host. */
export const TILDA_PRODUCT_LIST_PATH = "/api/getproductslist/";

// `t_store_init('<recid>', options)` — the call that draws the grid. The recid
// is the Tilda RECORD (the block on the page); there is one per catalogue block.
const STORE_INIT_RE = /t_store_init\(\s*['"](\d+)['"]/g;

// `storepart:'<uid>'` inside the options literal that PRECEDES its own init
// call. Note the spelling: the request parameter is `storepartuid`, the options
// key is `storepart`, and reading the request's spelling off the page finds
// nothing at all.
const STORE_PART_RE = /storepart\s*:\s*['"](\d+)['"]/g;

// The shop's own statement of what money its numbers are in. Tilda writes it on
// the page wrapper, so it is available before any request is made — and a price
// is only ever refused or accepted RELATIVE to a currency, which is why the
// page's own answer outranks the vendor row's guess.
const PROJECT_CURRENCY_RE = /data-project-currency-code=["']([A-Za-z]{3})["']/;

/**
 * Every catalogue block on the page, as `{ recid, storepart }`, in page order.
 *
 * The two parameters are per-BLOCK, not per-site, so they are paired by
 * position: a block's options literal is emitted immediately before its own
 * `t_store_init` call. An init call with no `storepart` ahead of it is dropped
 * rather than paired with a later one — a mis-paired uid reads as another
 * block's catalogue, and this reader's whole job is to answer for THIS page.
 */
export function tildaStoreBlocks(html) {
  if (typeof html !== "string" || html === "") return [];
  const parts = [...html.matchAll(STORE_PART_RE)].map((m) => ({
    index: m.index ?? 0,
    storepart: m[1],
  }));
  if (parts.length === 0) return [];
  const blocks = [];
  const seen = new Set();
  for (const init of html.matchAll(STORE_INIT_RE)) {
    const at = init.index ?? 0;
    let paired = null;
    for (const part of parts) {
      if (part.index < at) paired = part;
      else break;
    }
    if (!paired) continue;
    const key = `${paired.storepart}:${init[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ recid: init[1], storepart: paired.storepart });
  }
  return blocks;
}

/** Does this page declare a Tilda Store block at all? */
export function isTildaStorePage(html) {
  return tildaStoreBlocks(html).length > 0;
}

/** The currency the shop says its own numbers are in, or null. */
export function tildaProjectCurrency(html) {
  if (typeof html !== "string") return null;
  const match = html.match(PROJECT_CURRENCY_RE);
  return match ? match[1].toUpperCase() : null;
}

/**
 * The catalogue URL for one block on one API host.
 *
 * `c` is the app's own cache-buster (it sends `Date.now()`); it is passed in
 * rather than read here so both halves stay pure and testable.
 */
export function tildaProductListUrl(host, block, cacheBuster) {
  const params = new URLSearchParams({
    storepartuid: String(block.storepart),
    recid: String(block.recid),
    c: String(cacheBuster),
    size: "100",
    slice: "1",
  });
  return `https://${host}${TILDA_PRODUCT_LIST_PATH}?${params.toString()}`;
}

/**
 * The host to re-ask when the API answers with a root-zone redirect, or null.
 *
 * Mirrors `t_store__handleRootzoneRedirect`: the answer names a TLD, and only
 * the endpoint's last label changes. Null when the body is not that answer, or
 * names the zone the request already used — the app treats "same zone" as no
 * redirect, and so must this, or a caller that retries on it never terminates.
 *
 * Deliberately narrow about what it will accept, because the value comes from
 * the store: letters only, no dot, no slash, at most ten of them. A price pass
 * may follow a shop's pointer to another TLD of a host IT chose; it may never
 * be sent to a host the shop names.
 */
export function tildaRootZoneEndpoint(body, currentHost) {
  let payload = body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const zone = payload && typeof payload === "object" ? payload.redirectto : null;
  if (typeof zone !== "string" || !/^[a-z]{2,10}$/i.test(zone)) return null;
  const labels = String(currentHost ?? "").split(".");
  if (labels.length < 2) return null;
  if (labels[labels.length - 1].toLowerCase() === zone.toLowerCase()) return null;
  return [...labels.slice(0, -1), zone.toLowerCase()].join(".");
}

/**
 * Is this product purchasable, as far as the catalogue says?
 *
 * Tilda's `quantity` is a STRING and its empty value is the meaningful one:
 * `"0"` is a tracked product that has sold out, `""` is a product whose stock
 * is not tracked at all (the deskmats on FunKeys' own pages). Reading `""` as
 * zero would mark a whole untracked catalogue sold out, which on a released set
 * is the same harm as an unpriced row — the three-answer rule
 * `catalogAvailability` is built on, arriving through another platform.
 */
function tildaProductAvailable(product) {
  const quantity = product?.quantity;
  if (typeof quantity === "number") return quantity > 0;
  if (typeof quantity !== "string" || quantity.trim() === "") return true;
  const parsed = Number(quantity);
  return Number.isNaN(parsed) ? true : parsed > 0;
}

/**
 * The block's products as the kit pickers want them: `{ title, price, available }`.
 *
 * Tilda names every kit ("Base", "40s kit", "Accent"), which is what makes this
 * list safe for `pickBaseVariant` / `choose_kit_variant` to clear a price from:
 * a NAMED offer list that contains no base really does say there is no base
 * kit here, the distinction `offersNameEveryKit` draws next door.
 *
 * Entries with no title or no positive price are dropped — a catalogue row with
 * neither is a divider or a "coming soon" placeholder, never something to price.
 */
export function tildaStoreVariants(payload) {
  const products = payload && typeof payload === "object" ? payload.products : null;
  if (!Array.isArray(products)) return [];
  const variants = [];
  for (const product of products) {
    if (!product || typeof product !== "object") continue;
    const title = typeof product.title === "string" ? product.title.trim() : "";
    if (title === "") continue;
    const price = Number.parseFloat(String(product.price ?? ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    variants.push({ title, price, available: tildaProductAvailable(product) });
  }
  return variants;
}
