// Read-only probe: what does a vendor listing URL actually answer, and which
// price-parser path (if any) could read it?
//
// The publishing audit can say a vendor's links have "never been read", but not
// WHY — a store that redirects to its acquirer, one that 403s the scraper, one
// that answers 200 with no machine-readable price, and one that quietly moved
// its product pages all leave the identical `priceSource IS NULL` residue. The
// difference decides the repair (retire the row / relink it / teach the parser
// a platform), and until this script the only way to tell them apart was to
// guess.
//
// A transport failure gets the same split the price pass now makes: a host that
// does not resolve is GONE (and the www twin is checked, in case the shop only
// lost one spelling of its domain), while every other network error is a live
// host refusing us. "fetch failed" says neither out loud — the reason is buried
// in the error's `cause` — and the two need opposite repairs.
//
// It mirrors the DETECTION in src/lib/import/prices.ts — Shopify product JSON
// first, then the WooCommerce variations blob, then JSON-LD, then OpenGraph
// meta — and reports which of them a page offers. It deliberately does NOT
// re-implement the base-kit picking: the question here is "can this page be
// read at all", not "which variant is the base kit" (that is what
// vendor-probe's VARIANT dump answers, for the Shopify stores that have one).
//
// Writes nothing, touches no database. Run from a GitHub runner — vendor stores
// blanket-block cloud IPs, so a 403 from a laptop or a serverless function
// proves nothing.
//
//   PROBE_URLS="https://shop.example/products/x https://other.example/p/y" \
//     node scripts/vendor-link-probe.mjs

import { lookup as dnsLookup } from "node:dns/promises";

import { isGoneHostError } from "./lib/link-health.mjs";

const urls = (process.env.PROBE_URLS ?? process.argv.slice(2).join(" "))
  .split(/[\s,]+/)
  .map((u) => u.trim())
  .filter(Boolean);

if (urls.length === 0) {
  console.log("No URLs given. Set PROBE_URLS or pass them as arguments.");
  process.exit(0);
}

// Same headers refreshPrices sends, so a store that serves us differently from
// a browser does so for the same reason it does in production.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Generous next to the price pass's 6s: a slow answer here is still evidence,
// and a probe of a dozen URLs has no run budget to protect.
const TIMEOUT_MS = 20_000;

async function fetchOnce(url, redirect = "manual") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect, signal: controller.signal });
    return { res };
  } catch (err) {
    return {
      error: err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : err.message,
      err,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Follow redirects by hand so the chain itself is reported: an acquired store
// (ashkeebs.com → kineticlabs.com) and a live one look identical once fetch()
// has swallowed the hops.
async function fetchChain(url) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop < 10; hop++) {
    const { res, error, err } = await fetchOnce(current);
    if (error) return { chain, error, err, finalUrl: current };
    const location = res.headers.get("location");
    chain.push(`${res.status}${location ? ` → ${new URL(location, current).href}` : ""}`);
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    return { chain, res, finalUrl: current };
  }
  return { chain, error: "redirect loop (>10 hops)", finalUrl: current };
}

// Mirrors normalizeShopifyUrl: a collection-scoped product link
// (/collections/x/products/y) has its JSON on the canonical /products/y path.
function shopifyProductUrl(url) {
  const match = url.match(/^(https?:\/\/[^/]+)(?:\/[^/]+)*?\/products\/([^/?#]+)/);
  return match ? `${match[1]}/products/${match[2]}` : null;
}

/** The reason under a bare "fetch failed" — the codes fetch() hides in `cause`. */
function causeChain(err) {
  const seen = new Set();
  const stack = [err];
  const parts = [];
  while (stack.length > 0 && seen.size < 20) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.code === "string") parts.push(node.code);
    else if (typeof node.message === "string" && node !== err) parts.push(node.message);
    if (node.cause) stack.push(node.cause);
    if (Array.isArray(node.errors)) stack.push(...node.errors);
  }
  const unique = [...new Set(parts)];
  return unique.length > 0 ? ` (${unique.join(", ")})` : "";
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? "");
  }
}

/** Does this hostname resolve at all? Answers the "did the shop move?" question. */
async function resolves(host) {
  try {
    const { address } = await dnsLookup(host);
    return address;
  } catch {
    return null;
  }
}

function ldTypes(html) {
  const types = new Set();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of m[1].matchAll(/"@type"\s*:\s*"([^"]+)"/g)) types.add(t[1]);
  }
  return [...types];
}

/**
 * The OpenGraph price the last parser path would read, or null.
 *
 * "OG PRICE | present" answers whether a path EXISTS, which is a different
 * question from what it produces — and the difference is the whole diagnosis
 * when a row is unpriced: a number here means the page is fine and the refusal
 * is ours (KIT_BOUNDS, the Currency table, or a queue filter that never let the
 * row be fetched), while "present but unreadable" means the picker is at fault.
 * Same two regexes as fetchJsonLdPrice's fallback, in the same attribute-order-
 * agnostic pairs, so the value printed is the value that pass would see.
 */
function ogPriceOf(html) {
  const amount =
    html.match(/property=["']product:price:amount["'][^>]*content=["']([\d.,]+)["']/i) ??
    html.match(/content=["']([\d.,]+)["'][^>]*property=["']product:price:amount["']/i);
  if (!amount) return null;
  const currency =
    html.match(/property=["']product:price:currency["'][^>]*content=["']([A-Z]{3})["']/i) ??
    html.match(/content=["']([A-Z]{3})["'][^>]*property=["']product:price:currency["']/i);
  return `${amount[1]}${currency ? ` ${currency[1]}` : ""}`;
}

for (const url of urls) {
  console.log(`\n=== PROBE ${url}`);
  const { chain, res, error, err, finalUrl } = await fetchChain(url);
  if (chain.length > 0) console.log(`  CHAIN     | ${chain.join("  ")}`);
  if (error || !res) {
    // A transport failure produces no status at all, so the price pass cannot
    // tell these apart on its own — but they need opposite repairs, and
    // "fetch failed" is all fetch() says out loud. Print the cause chain and
    // split it the way the price pass now does: a host that does not resolve
    // is GONE (NXDOMAIN — there is no server to ask), and every other
    // transport failure is a live host refusing us.
    console.log(`  RESULT    | UNREACHABLE — ${error}${causeChain(err)}`);
    if (isGoneHostError(err)) {
      const host = hostOf(finalUrl);
      console.log(
        `  VERDICT   | DEAD_LINK — ${host} does not resolve; the domain itself is gone` +
          ` (retire the row, or relink it if the shop moved)`
      );
      // The one relink worth checking automatically: a shop that kept its
      // Shopify but lost one of the two spellings of its domain. It is a
      // question, not an answer — spaceholdings.net lost the apex and its www
      // twin 301s straight back to it, so the shop is gone either way.
      const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
      const twinAddr = await resolves(twin);
      console.log(
        `  TWIN      | ${twin} ${twinAddr ? `resolves (${twinAddr}) — probe it before retiring` : "does not resolve either"}`
      );
    } else {
      console.log(
        `  VERDICT   | UNREADABLE — the host exists and would not answer; a block,` +
          ` never a 404, so nothing clears the row on its own`
      );
    }
    continue;
  }

  const contentType = res.headers.get("content-type") ?? "(none)";
  let body = "";
  try {
    body = await res.text();
  } catch (err) {
    body = "";
    console.log(`  BODY      | unreadable: ${err.message}`);
  }
  console.log(`  FINAL     | ${res.status} ${finalUrl}`);
  console.log(`  TYPE      | ${contentType} | ${body.length} bytes`);

  if (res.status === 404 || res.status === 410) {
    // The one definitive answer: deadSince is allowed to hide these rows.
    console.log(`  VERDICT   | DEAD_LINK — the store says the page is gone`);
    continue;
  }
  if (!res.ok) {
    console.log(
      `  VERDICT   | UNREADABLE (${res.status}) — blocked or broken, never a 404,` +
        ` so nothing clears the row on its own`
    );
    continue;
  }

  // Shopify: the platform four fifths of the roster runs, and the only one that
  // hands over per-variant data.
  const canonical = shopifyProductUrl(finalUrl);
  let shopify = "no /products/ path — not a Shopify product URL";
  if (canonical) {
    const { res: jsonRes, error: jsonError } = await fetchOnce(`${canonical}.json`, "follow");
    if (jsonError) shopify = `${canonical}.json — ${jsonError}`;
    else if (!jsonRes.ok) shopify = `${canonical}.json — ${jsonRes.status}`;
    else {
      const text = await jsonRes.text();
      let variants = null;
      try {
        variants = JSON.parse(text)?.product?.variants?.length ?? null;
      } catch {
        // A storefront password page answers 200 with HTML for .json too.
        variants = null;
      }
      shopify =
        variants === null
          ? `${canonical}.json — 200 but not product JSON (password page / proxy?)`
          : `${canonical}.json — 200, ${variants} variant(s)`;
    }
  }
  console.log(`  SHOPIFY   | ${shopify}`);

  const woo = /data-product_variations\s*=/.test(body);
  const types = ldTypes(body);
  const ogTag = /property=["']product:price:amount["']/.test(body);
  const ogValue = ogPriceOf(body);
  console.log(`  WOO       | ${woo ? "data-product_variations present" : "absent"}`);
  console.log(`  JSON-LD   | ${types.length > 0 ? types.join(", ") : "none"}`);
  console.log(
    `  OG PRICE  | ${
      ogValue ? ogValue : ogTag ? "tag present, no readable amount" : "absent"
    }`
  );

  const readable =
    shopify.includes("variant(s)") || woo || types.includes("Product") || ogTag;
  console.log(
    `  VERDICT   | ${
      readable
        ? "READABLE — a price parser path exists; if the row is unpriced the picker is at fault"
        : "200 but NOTHING MACHINE-READABLE — the page carries no product markup the parser knows"
    }`
  );
}
