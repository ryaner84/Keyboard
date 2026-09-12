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

import {
  isClientRenderedShell,
  isGoneFrontPage,
  isGoneHostError,
  isGoneRedirect,
} from "./lib/link-health.mjs";
import { isIncompleteChainError, retryWithRepairedChain } from "./lib/tls-chain.mjs";

// Hosts this probe had to complete a certificate chain for, so the report can
// say that the store was only readable because the AIA repair ran — the
// difference between "this shop is fine" and "this shop is fine ONLY because of
// src/lib/import/prices.ts's repair, and the nightly needs it too".
const repairedHosts = new Set();

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
    // A server that omits its intermediate certificate is a LIVE store that
    // Node alone refuses to talk to. Complete the chain the way a browser does
    // and try once more, so the probe reports what the store actually serves
    // rather than the handshake we failed to finish — and mirrors the retry
    // refreshPrices now makes, so the two halves reach the same verdict on the
    // same response.
    if (isIncompleteChainError(err)) {
      try {
        const res = await retryWithRepairedChain(url, err, {
          headers: BROWSER_HEADERS,
          signal: controller.signal,
          follow: redirect === "follow",
        });
        repairedHosts.add(hostOf(url));
        return { res, repaired: true };
      } catch {
        // Unrepairable — fall through and report the original failure.
      }
    }
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

/**
 * The currency the Shopify price path will judge this page's numbers in.
 *
 * Mirrors fetchShopifyCurrency: /meta.json on the shop origin, null when the
 * store doesn't answer it. It is printed because a price is only ever refused
 * or accepted RELATIVE to a currency — a store that hides /meta.json has its
 * numbers measured against the fallback window, and "READABLE" plus an
 * unpriced row is the shape that produces. Without this line the two are
 * indistinguishable from outside.
 */
async function shopCurrency(url) {
  try {
    const { res, error, err } = await fetchOnce(`${new URL(url).origin}/meta.json`, "follow");
    if (error) return { currency: null, note: `${error}${causeChain(err)}` };
    if (!res.ok) return { currency: null, note: `meta.json ${res.status}` };
    const meta = JSON.parse(await res.text());
    return { currency: meta?.currency ?? null, note: meta?.currency ? "" : "meta.json carries no currency" };
  } catch (err) {
    return { currency: null, note: err.message };
  }
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
    } else if (isIncompleteChainError(err)) {
      // Reported apart from a block because the repair is the opposite one. The
      // store is live and serving; its server omits the intermediate
      // certificate, which every browser fetches via the leaf's AIA extension
      // and Node does not. When this prints, the repair could not complete the
      // chain to a trusted root either — a certificate that is genuinely
      // broken, not merely under-sent.
      console.log(
        `  VERDICT   | UNREADABLE (incomplete TLS chain) — the server did not send` +
          ` its intermediate certificate and the AIA repair could not complete the` +
          ` chain to a trusted root; a live host, never a 404`
      );
    } else {
      console.log(
        `  VERDICT   | UNREADABLE — the host exists and would not answer; a block,` +
          ` never a 404, so nothing clears the row on its own`
      );
    }
    continue;
  }

  if (repairedHosts.has(hostOf(url))) {
    console.log(
      `  CHAIN FIX | the server omitted its intermediate certificate; completed it` +
        ` from the leaf's AIA extension (see scripts/lib/tls-chain.mjs). Everything` +
        ` below is what the store serves once that is done`
    );
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

  // Where a PRODUCTION-shaped fetch lands, which is a different question from
  // where the hand-followed chain above lands and is the one that decides the
  // row. Both price passes let the transport follow the hops and then judge the
  // URL it reports (`res.url` / `page.url`); this probe follows them itself,
  // with redirect:"manual", so anything fetch() declines to follow — or
  // rewrites — shows up here as a chain the price pass never walked. Printed
  // only when there WAS a hop, so a direct 200 costs nothing.
  if (chain.length > 1) {
    const { res: followed, error: followError, err: followErr } = await fetchOnce(url, "follow");
    if (followError) {
      console.log(`  FOLLOWED  | fetch(redirect:"follow") failed — ${followError}${causeChain(followErr)}`);
    } else {
      console.log(`  FOLLOWED  | ${followed.status} ${followed.url}`);
    }
  }

  // The question the price pass asks FIRST, before it parses a byte — and the
  // one shape this probe never reported. A store that removed a product usually
  // sends it to the front door rather than 404ing it, and an acquired shop
  // sends its whole domain to the buyer's; isGoneRedirect answers DEAD_LINK for
  // both. Without this line the probe called those pages "200 but nothing
  // machine-readable", i.e. contradicted the verdict the price pass reaches on
  // the identical response, and the report's most actionable answer looked like
  // its least.
  if (isGoneRedirect(url, finalUrl)) {
    console.log(
      `  VERDICT   | DEAD_LINK — answered by a front door (${finalUrl}), not this page;` +
        ` the price pass clears the row on this alone (relink or retire it)`
    );
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
    const { res: jsonRes, error: jsonError, err: jsonErr } = await fetchOnce(
      `${canonical}.json`,
      "follow"
    );
    // The cause chain, for the same reason the transport failure above prints
    // it: "fetch failed" is the one message fetch() gives for a refused
    // connection, a broken certificate and a reset alike, and the product page
    // succeeding while its own .json does not is a difference worth naming.
    if (jsonError) shopify = `${canonical}.json — ${jsonError}${causeChain(jsonErr)}`;
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
  if (canonical) {
    const { currency, note } = await shopCurrency(canonical);
    console.log(
      `  SHOP CCY  | ${
        currency
          ? `${currency} (/meta.json)`
          : `unknown — ${note}; the price pass falls back to the vendor row's own currency` +
            ` for the supported-currency test, and to USD for the KIT_BOUNDS window`
      }`
    );
  }

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
  if (readable) {
    console.log(
      `  VERDICT   | READABLE — a price parser path exists; if the row is unpriced the picker is at fault`
    );
    continue;
  }

  // Nothing machine-readable is where two opposite diagnoses meet: a platform
  // the parser has never been taught, and a shop that has been retired behind a
  // catch-all rewrite. The second answers 200 on the URL itself with no
  // redirect, so only the BODY tells them apart — ask the store for its front
  // page and compare. See isGoneFrontPage in scripts/lib/link-health.mjs.
  let frontPage = "";
  try {
    const { res: rootRes, error: rootError } = await fetchOnce(
      `${new URL(finalUrl).origin}/`,
      "follow"
    );
    if (!rootError && rootRes.ok) frontPage = await rootRes.text();
  } catch {
    frontPage = "";
  }
  const isFrontPage = isGoneFrontPage(url, finalUrl, body, frontPage);
  // A bootstrap shell is identical to the front page on every route the store
  // serves, so the comparison says nothing about this URL — printed separately
  // because "IDENTICAL to the root" and "not gone" read as a contradiction
  // otherwise, and that pairing is what a live app-rendered store looks like.
  const shell = isClientRenderedShell(body);
  console.log(
    `  ROOT PAGE | ${
      !frontPage
        ? "storefront root unreadable — cannot tell a catch-all rewrite from an unknown platform"
        : shell
          ? "a client-rendered app SHELL — every route on this store answers with it," +
            " root included, so a match here is not evidence about this listing"
          : isFrontPage
            ? "IDENTICAL to the storefront root — this URL is not a page there"
            : `differs from the storefront root (${frontPage.length} bytes) — a real page on an unread platform`
    }`
  );
  console.log(
    `  VERDICT   | ${
      isFrontPage
        ? "DEAD_LINK — the store answers this URL with its own front page (a soft 404);" +
          " relink or retire it, teaching the parser cannot help"
        : "200 but NOTHING MACHINE-READABLE — the page carries no product markup the parser knows"
    }`
  );
  // The verdict above splits two repairs that look identical from the row and
  // need opposite work: "teach the parser this platform" is worth doing for a
  // real storefront and is wasted on a parked domain or a holding page, which
  // is what a few kilobytes of HTML with no markup usually is. The rendered
  // text is the only thing that tells them apart, so print enough of it to
  // read — cheap, since the body is already in hand.
  if (!isFrontPage) {
    const text = body
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    console.log(
      `  TEXT      | ${text ? `${text.slice(0, 200)}${text.length > 200 ? "…" : ""}` : "(no rendered text at all)"}`
    );
  }
}
