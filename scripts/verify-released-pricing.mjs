// E2E verification: every set the /api/released "available" filter returns
// must produce at least one rendered price via the same computeCheapest()
// logic SetCard uses. Run with: npx tsx scripts/verify-released-pricing.mjs
import { computeCheapest } from "../src/lib/pricing.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const REGION = "SG";
const CURRENCY = "SGD";

const ratesRes = await fetch(`${BASE}/api/currencies`);
const { rates } = await ratesRes.json();

const res = await fetch(`${BASE}/api/released?availability=available&page=1&limit=48`);
const { data, total, totalAvailable } = await res.json();

console.log(`API: total=${total} totalAvailable=${totalAvailable} returned=${data.length}`);

let ok = 0;
let fail = 0;
for (const set of data) {
  const prices = computeCheapest(set, REGION, CURRENCY, rates);
  if (prices.length > 0) {
    ok++;
    console.log(`  ✓ ${set.slug}: ${prices.length} vendor(s), cheapest S$${Math.round(prices[0].totalLocal)} via ${prices[0].vendorName}`);
  } else {
    fail++;
    console.log(`  ✗ ${set.slug}: NO PRICE RENDERED (card would say "no live prices")`);
  }
}
console.log(`\nResult: ${ok} priced, ${fail} unpriced of ${data.length} "available" sets`);
process.exit(fail > 0 ? 1 : 0);
