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
    return { error: err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : err.message };
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
    const { res, error } = await fetchOnce(current);
    if (error) return { chain, error, finalUrl: current };
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

function ldTypes(html) {
  const types = new Set();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of m[1].matchAll(/"@type"\s*:\s*"([^"]+)"/g)) types.add(t[1]);
  }
  return [...types];
}

for (const url of urls) {
  console.log(`\n=== PROBE ${url}`);
  const { chain, res, error, finalUrl } = await fetchChain(url);
  if (chain.length > 0) console.log(`  CHAIN     | ${chain.join("  ")}`);
  if (error || !res) {
    // A transport failure (DNS gone, TLS expired, connection refused, hang) is
    // the answer a store that simply stopped existing gives — and the one that
    // never produces a 404, so nothing ever clears its rows.
    console.log(`  RESULT    | UNREACHABLE — ${error}`);
    console.log(`  VERDICT   | no HTTP answer at all — the row can only be relinked or retired`);
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
  const ogPrice = /property=["']product:price:amount["']/.test(body);
  console.log(`  WOO       | ${woo ? "data-product_variations present" : "absent"}`);
  console.log(`  JSON-LD   | ${types.length > 0 ? types.join(", ") : "none"}`);
  console.log(`  OG PRICE  | ${ogPrice ? "present" : "absent"}`);

  const readable =
    shopify.includes("variant(s)") || woo || types.includes("Product") || ogPrice;
  console.log(
    `  VERDICT   | ${
      readable
        ? "READABLE — a price parser path exists; if the row is unpriced the picker is at fault"
        : "200 but NOTHING MACHINE-READABLE — the page carries no product markup the parser knows"
    }`
  );
}
