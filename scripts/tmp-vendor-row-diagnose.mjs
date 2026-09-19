// TEMPORARY read-only diagnostic (not part of the shipped tree).
//
// Asks the two halves of the price pass separately for the same URL:
//   * fetchShopifyPrice  — the rich product-JSON reader (via fetchVendorPrice)
//   * fetchJsonLdPrice   — the fallback used whenever that JSON does not answer
// plus whether the page declares a multi-variant ProductGroup and what its
// JSON-LD offers actually look like. Writes nothing.
import { htmlDeclaresVariantProductGroup } from "../src/lib/kit-variants.ts";
import { fetchVendorPrice, fetchJsonLdPrice } from "../src/lib/import/prices.ts";

const URLS = (process.env.DIAG_URLS ?? "")
  .split(/[\s,]+/)
  .map((u) => u.trim())
  .filter(Boolean);

const label = (out) =>
  out === null
    ? "UNREADABLE(null)"
    : typeof out === "string"
      ? out
      : `PRICED ${out.price} ${out.currency ?? "(null)"} inStock=${out.inStock}`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
};

for (const url of URLS) {
  console.log(`\n=== ${url}`);
  console.log(`  FULL PASS   | ${label(await fetchVendorPrice(url, "USD", "diag", false))}`);
  console.log(`  JSON-LD ONLY| ${label(await fetchJsonLdPrice(url, "USD", false))}`);
  try {
    const res = await fetch(url, { headers: HEADERS });
    const html = await res.text();
    console.log(`  PRODUCTGROUP| ${htmlDeclaresVariantProductGroup(html)}`);
    const blocks = Array.from(
      html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
    ).map((m) => m[1]);
    for (const block of blocks) {
      let data;
      try {
        data = JSON.parse(block.trim());
      } catch {
        continue;
      }
      const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const node of nodes) {
        const type = node?.["@type"];
        const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
        if (!isProduct || !node.offers) continue;
        const raw = node.offers;
        const list = Array.isArray(raw) ? raw : Array.isArray(raw.offers) ? raw.offers : [];
        console.log(
          `  LD PRODUCT  | offers=${list.length} | ` +
            JSON.stringify(
              (list.length ? list : [raw]).map((o) => ({
                type: o?.["@type"],
                name: o?.name ?? null,
                price: o?.price ?? o?.lowPrice ?? null,
                cur: o?.priceCurrency ?? null,
              }))
            )
        );
      }
    }
  } catch (err) {
    console.log(`  HTML        | fetch failed: ${err?.message}`);
  }
}
