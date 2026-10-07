import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bestDiscount } from "./pricing";
import { ON_SALE_FILTER, isAddonListingUrl, isBlockedVendorListing, isOnSaleRow, rankHomeSales } from "./on-sale";
import type { GroupBuyWithPricing } from "@/types";

type Row = {
  vendor: string;
  price: number | null;
  compareAtPrice?: number | null;
  inStock?: boolean;
  priceSource?: string | null;
};

function set(name: string, rows: Row[]): GroupBuyWithPricing {
  return {
    name,
    kits: [
      {
        type: "BASE",
        vendorKits: rows.map((r, i) => ({
          id: `vk${i}`,
          price: r.price,
          compareAtPrice: r.compareAtPrice ?? null,
          currency: "USD",
          inStock: r.inStock ?? true,
          priceSource: r.priceSource ?? "SCRAPED",
          gbUrl: null,
          productUrl: null,
          priceUpdatedAt: null,
          vendor: { name: r.vendor, region: "US", country: "US", currency: "USD", shippingZones: [] },
        })),
      },
    ],
  } as unknown as GroupBuyWithPricing;
}

// --- isOnSaleRow is ON_SALE_FILTER's claim, row by row -----------------------
const row = { price: 145, compareAtPrice: 180, inStock: true, priceSource: "SCRAPED" };
assert.ok(isOnSaleRow(row), "a priced, in-stock markdown is on sale");
assert.ok(isOnSaleRow({ ...row, priceSource: null }), "a null priceSource is an ordinary row");
assert.ok(!isOnSaleRow({ ...row, inStock: false }), "sold out is not on sale");
assert.ok(!isOnSaleRow({ ...row, priceSource: "LOCKED" }), "a shut store is not on sale");
assert.ok(!isOnSaleRow({ ...row, price: null }), "unpriced is not on sale");
assert.ok(!isOnSaleRow({ ...row, compareAtPrice: null }), "no compare-at is not a markdown");
assert.ok(!isOnSaleRow({ ...row, compareAtPrice: 145 }), "compare-at equal to price is not a markdown");
assert.ok(!isOnSaleRow({ ...row, compareAtPrice: 100 }), "a hand-edited compare-at below price is not a markdown");

const vkWhere = ON_SALE_FILTER.kits.some.vendorKits.some;
assert.equal(ON_SALE_FILTER.kits.some.type, "BASE");
assert.deepEqual(vkWhere, {
  price: { not: null },
  compareAtPrice: { not: null },
  inStock: true,
  priceSource: { not: "LOCKED" },
}, "the SQL claim and isOnSaleRow must name the same four conditions");

// --- bestDiscount only counts a markdown someone can buy ---------------------
// GMK TeraDrive's shape: a sold-out shop's old 52% beside a buyable 6%.
const teraDrive = set("GMK TeraDrive", [
  { vendor: "Sold Out Shop", price: 84, compareAtPrice: 175, inStock: false },
  { vendor: "Shut Shop", price: 50, compareAtPrice: 175, priceSource: "LOCKED" },
  { vendor: "Mekibo", price: 165, compareAtPrice: 175 },
]);
const d = bestDiscount(teraDrive);
assert.ok(d, "the buyable markdown still counts");
assert.equal(d!.percent, 6, "the badge is the BUYABLE markdown, not the sold-out one");
assert.equal(d!.vendorName, "Mekibo", "and it names the shop running it");
assert.equal(
  bestDiscount(set("Nobody", [{ vendor: "A", price: 84, compareAtPrice: 175, inStock: false }])),
  null,
  "only sold-out markdowns → no badge at all"
);

// --- the homepage rail's collector bar ---------------------------------------
const cands = [
  ["GMK Tako", "Daily Clack", 44],
  ["GMK Dots r2", "Daily Clack", 44],
  ["GMK Redline", "Daily Clack", 37],
  ["GMK Gegenschlag Add-on", "Oblotzky", 35],
  ["GMK Maestro", "Mekibo", 22],
  ["GMK Monarch", "Mekibo", 19],
  ["GMK Kouhai", "Mekibo", 17],
  ["GMK Yuri r2", "Daily Clack", 1],
  ["GMK Nightshade", "SwitchKeys", 8],
  ["GMK Botanical r2", "iLumKB", 20],
].map(([name, vendorName, percent]) => ({
  set: name as string,
  name: name as string,
  discount: { vendorName: vendorName as string, percent: percent as number },
}));
const ranked = rankHomeSales(cands);
assert.deepEqual(
  ranked,
  ["GMK Dots r2", "GMK Tako", "GMK Maestro", "GMK Botanical r2", "GMK Monarch"],
  "≥10% only, no add-ons, at most 2 per shop, biggest first, name tie-break"
);
assert.deepEqual(rankHomeSales([{ set: 1, name: "x", discount: null }]), [], "no discount → not on the rail");

// A markdown read off an add-on page is not the set on sale.
assert.ok(isAddonListingUrl("https://swiftcables.net/products/gmk-aurora-polaris-extras"));
assert.ok(isAddonListingUrl("https://x.com/products/gmk-foo-novelties"));
assert.ok(!isAddonListingUrl("https://swiftcables.net/products/gmk-mika-keycaps-1"));
assert.ok(!isAddonListingUrl("https://prototypist.net/products/in-stock-gmk-mika"));
assert.ok(!isAddonListingUrl(null) && !isAddonListingUrl("not a url"));

// An accessory-only vendor's "-extras" cable is dropped vendor-wide (it does not
// heal via a per-set block — the same cable re-appears on a sibling set), but
// the block is scoped so it can only ever drop a cable, never a real keycap.
assert.ok(isBlockedVendorListing("swiftcables", "https://swiftcables.net/products/gmk-evil-dolch-extras"), "SwiftCables -extras cable on R1 set");
assert.ok(isBlockedVendorListing("swiftcables", "https://swiftcables.net/products/gmk-aurora-polaris-extras"), "SwiftCables -extras cable, any set");
assert.ok(!isBlockedVendorListing("swiftcables", "https://swiftcables.net/products/gmk-mika-keycaps-1"), "SwiftCables' one real keycap (not -extras) is kept");
assert.ok(!isBlockedVendorListing("switchmod", "https://switchmod.net/products/gmk-vamp-extras"), "another vendor's -extras handle is a real keycap — not blocked");
assert.ok(!isBlockedVendorListing("swiftcables", null) && !isBlockedVendorListing(null, "https://swiftcables.net/products/x-extras") && !isBlockedVendorListing("swiftcables", "not a url"), "null/garbage safe");
assert.deepEqual(
  rankHomeSales([
    { set: "polaris", name: "GMK Aurora Polaris", discount: { vendorName: "SwiftCables", percent: 40, productUrl: "https://swiftcables.net/products/gmk-aurora-polaris-extras" } },
    { set: "mika", name: "GMK Mika", discount: { vendorName: "SwiftCables", percent: 46, productUrl: "https://swiftcables.net/products/gmk-mika-keycaps-1" } },
  ]),
  ["mika"],
  "the extras listing stays off the rail"
);

// --- one definition, not two ---------------------------------------------------
const root = join(__dirname, "..", "..");
const released = readFileSync(join(root, "src/app/api/released/route.ts"), "utf8");
assert.match(released, /import \{ ON_SALE_FILTER \} from "@\/lib\/on-sale"/, "/released imports the shared filter");
assert.doesNotMatch(released, /const ON_SALE_FILTER\s*=/, "/released must not redefine it");
const home = readFileSync(join(root, "src/app/page.tsx"), "utf8");
assert.match(home, /\.\.\.ON_SALE_FILTER/, "the homepage rail uses the shared filter");
assert.match(home, /rankHomeSales\(/, "and the tested ranker");
assert.match(home, /name: cleanDisplayName\(set\.name\)/, "the rail shows display names, as /released does");
const pricing = readFileSync(join(root, "src/lib/pricing.ts"), "utf8");
assert.match(pricing, /if \(!isOnSaleRow\(vk\)\) continue;/, "bestDiscount asks isOnSaleRow");

// The addon-only vendor block is enforced at every place a listing is linked
// (both discovery halves of the import) and purged in db-setup — a guard missing
// from one half lets the cable re-appear, which is exactly the per-set block's
// failure. Pin all three so none silently drops it.
const discovery = readFileSync(join(root, "src/lib/import/discovery.ts"), "utf8");
assert.match(discovery, /isBlockedVendorListing/, "discovery skips addon-only vendor listings");
const overrides = readFileSync(join(root, "src/lib/import/vendor-overrides.ts"), "utf8");
assert.match(overrides, /isBlockedVendorListing/, "the link-override import skips them too");
const dbSetup = readFileSync(join(root, "scripts/db-setup.mjs"), "utf8");
assert.match(dbSetup, /purgeAddonOnlyVendorListings/, "db-setup purges them every deploy");
assert.match(dbSetup, /-extras\/\?\$/, "db-setup mirrors the vendor + -extras handle rule");

console.log("on-sale checks passed");
