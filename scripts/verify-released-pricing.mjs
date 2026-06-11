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
if (totalAvailable === 0) {
  console.log("FAIL: totalAvailable=0 — no released sets have a price in the DB.");
  process.exit(1);
}

let ok = 0;
let fail = 0;
for (const set of data) {
  // DB-level: how many vendorKits have a price (before currency conversion)
  const base = set.kits?.find((k) => k.type === "BASE") ?? set.kits?.[0];
  const dbPriced = (base?.vendorKits ?? []).filter((v) => v.price != null).length;
  const prices = computeCheapest(set, REGION, CURRENCY, rates);
  if (prices.length > 0) {
    ok++;
    console.log(
      `  ✓ ${set.slug}: ${prices.length} vendor(s) to SG, cheapest S$${Math.round(prices[0].totalLocal)} via ${prices[0].vendorName} (${dbPriced} priced in DB)`
    );
  } else {
    fail++;
    console.log(
      `  ✗ ${set.slug}: NO PRICE RENDERED (${dbPriced} priced in DB but none reachable to SG)`
    );
  }
}
console.log(`\nResult: ${ok} priced, ${fail} unpriced of ${data.length} "available" sets`);
process.exit(fail > 0 ? 1 : 0);
