import assert from "node:assert/strict";
import {
  hostOfUrl,
  hostKey,
  isStorefrontHost,
  storefrontHostFromUrls,
  planVendorUrlHeal,
  nextVendorWebsiteUrl,
} from "./vendor-urls.mjs";

// Every fixture below is a real row from supabase-setup.sql — these are the
// 28 vendors that shipped with a blank websiteUrl, and the URLs are the ones
// their own VendorKit rows carry.

// --- hostOfUrl / hostKey ---------------------------------------------------
assert.equal(hostOfUrl("https://basekeys.jp/products/gmk-bento"), "basekeys.jp");
assert.equal(hostOfUrl("https://WWW.Inpad.com.tw/x"), "www.inpad.com.tw");
// Not a URL, not http(s), or blank — the cases that made `new URL()` throw in
// discovery.ts in the first place.
for (const junk of ["", "   ", null, undefined, "mekibo.com", "mailto:a@b.c"]) {
  assert.equal(hostOfUrl(junk), "", JSON.stringify(junk));
}
assert.equal(hostKey("www.mekibo.com"), "mekibo.com");
assert.equal(hostKey("mekibo.com"), "mekibo.com");
// Only the leading www. folds: zFrontier really does run two sites (#110), and
// collapsing them would point discovery back at the app that 404s.
assert.notEqual(hostKey("en.zfrontier.com"), hostKey("www.zfrontier.com"));

// --- isStorefrontHost ------------------------------------------------------
assert.equal(isStorefrontHost("mekibo.com"), true);
assert.equal(isStorefrontHost("www.originativeco.com"), true);
// Typist Club's only links are a Taobao shop; Cocobrais' and Kekkon's are
// goo.gl redirects. Pointing discovery at those burns a rotation slot on a
// host that has no /products.json, every few days, forever.
assert.equal(isStorefrontHost("shop278801163.m.taobao.com"), false);
assert.equal(isStorefrontHost("goo.gl"), false);
assert.equal(isStorefrontHost("docs.google.com"), false);
assert.equal(isStorefrontHost("www.instagram.com"), false);
assert.equal(isStorefrontHost("geekhack.org"), false);
// Hosts KeycapLendar files real stores under that are not shops: an Imgur
// album and a GitHub Pages docs site (both Drop), Naver's marketplace
// (GEONWORKS, Swagkeys), a Discord invite (Mechaland).
assert.equal(isStorefrontHost("imgur.com"), false);
assert.equal(isStorefrontHost("matrixzj.github.io"), false);
assert.equal(isStorefrontHost("smartstore.naver.com"), false);
assert.equal(isStorefrontHost("discord.link"), false);
// The block is on Naver's storefront subdomain only — a shop that merely
// happens to sit under some other naver.com host is not a marketplace.
assert.equal(isStorefrontHost("shop.naver.com"), true);
// A bare token is not a host.
assert.equal(isStorefrontHost("localhost"), false);

// --- storefrontHostFromUrls ------------------------------------------------
// BaseKeys: 34 listing URLs, all one host.
assert.equal(
  storefrontHostFromUrls([
    "https://basekeys.jp/products/gmk-bento",
    "https://basekeys.jp/products/gmk-olivia",
  ]),
  "basekeys.jp"
);
// Mekibo also sells through txkeyboards.com, but its own site is the plurality
// (52 links vs 34) — the winner is decided by count, not by first sight.
assert.equal(
  storefrontHostFromUrls([
    "https://www.us.txkeyboards.com/products/gmk-a",
    "https://mekibo.com/products/gmk-a",
    "https://mekibo.com/products/gmk-b",
  ]),
  "mekibo.com"
);
// Inpad's links are all www. — keep the spelling the store actually serves.
assert.equal(
  storefrontHostFromUrls(["https://www.inpad.com.tw/products/gmk-a"]),
  "www.inpad.com.tw"
);
// …but the www. and bare forms still count as ONE store, so a store seen
// mostly bare wins with its bare spelling.
assert.equal(
  storefrontHostFromUrls([
    "https://www.mekibo.com/products/gmk-a",
    "https://mekibo.com/products/gmk-b",
    "https://mekibo.com/products/gmk-c",
  ]),
  "mekibo.com"
);
// Maamaadei: one maamaadei.xyz link and one maamaadei.com link. A tie is a
// coin toss — refuse rather than store a guess as fact.
assert.equal(
  storefrontHostFromUrls([
    "https://www.maamaadei.xyz/products/gmk-a",
    "https://www.maamaadei.com/products/gmk-b",
  ]),
  null
);
// Nothing usable at all.
assert.equal(storefrontHostFromUrls([]), null);
assert.equal(storefrontHostFromUrls(["", null, "not a url"]), null);
assert.equal(storefrontHostFromUrls(["https://shop1.m.taobao.com/x"]), null);

// --- planVendorUrlHeal -----------------------------------------------------
const plan = planVendorUrlHeal(
  [
    { id: "v1", slug: "basekeys", listingUrls: ["https://basekeys.jp/products/gmk-a"] },
    { id: "v2", slug: "mkultra", listingUrls: ["https://mkultra.click/products/gmk-a"] },
    // Panc Interactive's links point at panc.co — which is already the `pancco`
    // vendor's site. Two Vendor rows, one store: healing this would have the
    // crawler walk one catalogue twice and publish every listing under both
    // names. Report it instead.
    { id: "v3", slug: "panc-interactive", listingUrls: ["https://panc.co/products/gmk-a"] },
    { id: "v4", slug: "maamaadei", listingUrls: ["https://a.xyz/p/1", "https://b.com/p/2"] },
    // VERTEX, NyxKeys, Photekq…: a Vendor row and VendorKit rows, and not one
    // URL between them. These are the stores that publish literally nothing.
    { id: "v5", slug: "vertex", listingUrls: [] },
    { id: "v6", slug: "typist-club", listingUrls: ["https://shop1.m.taobao.com/x"] },
  ],
  new Set(["panc.co"])
);
assert.deepEqual(
  plan.heal.map((v) => [v.slug, v.websiteUrl]),
  [
    ["basekeys", "https://basekeys.jp"],
    ["mkultra", "https://mkultra.click"],
  ]
);
assert.deepEqual(plan.duplicate.map((v) => [v.slug, v.host]), [["panc-interactive", "panc.co"]]);
assert.deepEqual(plan.stranded.map((v) => v.slug), ["maamaadei", "vertex", "typist-club"]);
// The reason travels with the vendor so the build log says what to do next.
assert.equal(plan.stranded[0].reason, "listing URLs disagree on the storefront");
assert.equal(plan.stranded[1].reason, "no listing carries a URL either");
assert.equal(plan.stranded[2].reason, "links are marketplace/forum pages only");

// Two blank vendors whose listings name the SAME host: the first claims it,
// the second is a duplicate — otherwise both get crawled and the store is
// published twice.
const twins = planVendorUrlHeal([
  { id: "a", slug: "store-a", listingUrls: ["https://store.example/p/1"] },
  { id: "b", slug: "store-b", listingUrls: ["https://www.store.example/p/2"] },
]);
assert.deepEqual(twins.heal.map((v) => v.slug), ["store-a"]);
assert.deepEqual(twins.duplicate.map((v) => v.slug), ["store-b"]);

// A vendor that already has a websiteUrl never reaches the planner, so the
// planner never has to defend against overwriting one: the callers select
// blank rows only. Guard the empty case anyway.
assert.deepEqual(planVendorUrlHeal([]), { heal: [], duplicate: [], stranded: [] });
assert.deepEqual(planVendorUrlHeal(undefined), { heal: [], duplicate: [], stranded: [] });

// --- nextVendorWebsiteUrl --------------------------------------------------
// The nightly KeycapLendar import offers a storeLink per SET, so one shop is
// described once per keyset. These are the shapes those entries actually take.

// A real storefront link is adopted, reduced to its origin — the store link
// points at one product page, the storefront is the site.
assert.equal(
  nextVendorWebsiteUrl("", "https://ilumkb.com/products/gmk-bento"),
  "https://ilumkb.com"
);
// …and it replaces a previous storefront: a store that genuinely moved should
// follow. (KeycapLendar has kbdfans under kbdfans.com AND kbd.fans.)
assert.equal(
  nextVendorWebsiteUrl("https://kbd.fans", "https://kbdfans.com/products/x"),
  "https://kbdfans.com"
);

// THE REGRESSION: 1228 of 9031 upstream vendor entries carry no storeLink, and
// 142 stores have both linked and blank entries. Under the old last-write-wins
// the blank one erased the storefront, discovery's `websiteUrl <> ''` filter
// then dropped the store, and it published nothing until the next deploy.
for (const nothing of ["", "   ", null, undefined]) {
  assert.equal(
    nextVendorWebsiteUrl("https://ilumkb.com", nothing),
    "https://ilumkb.com",
    JSON.stringify(nothing)
  );
}

// The same overwrite could DOWNGRADE instead of erase. iLumKB has entries on
// item.taobao.com, NovelKeys on geekhack.org, Drop on imgur.com. Those are
// where that listing lives — they stay on the VendorKit — but as a storefront
// they are worse than blank: /products.json 404s there forever, and a non-blank
// row is never revisited by planVendorUrlHeal.
assert.equal(
  nextVendorWebsiteUrl("https://ilumkb.com", "https://item.taobao.com/item.htm?id=1"),
  "https://ilumkb.com"
);
assert.equal(
  nextVendorWebsiteUrl("https://novelkeys.xyz", "https://geekhack.org/index.php?topic=1"),
  "https://novelkeys.xyz"
);
assert.equal(
  nextVendorWebsiteUrl("https://drop.com", "https://imgur.com/a/abc"),
  "https://drop.com"
);

// On a BRAND-NEW vendor those same links leave the row blank rather than
// storing an uncrawlable one. Blank is the strictly better state: it is the
// only one planVendorUrlHeal and ensureVendorRoster can still recover from,
// and #131's discovery filter keeps it from eating a rotation slot meanwhile.
assert.equal(nextVendorWebsiteUrl("", "https://item.taobao.com/item.htm?id=1"), "");
assert.equal(nextVendorWebsiteUrl("", "https://goo.gl/abc"), "");
assert.equal(nextVendorWebsiteUrl("", ""), "");

// Junk that `new URL()` rejects, and non-http(s) schemes, are not links either.
// The old code fell back to storing the raw string as the websiteUrl.
assert.equal(nextVendorWebsiteUrl("https://mekibo.com", "TBA"), "https://mekibo.com");
assert.equal(nextVendorWebsiteUrl("https://mekibo.com", "mekibo.com"), "https://mekibo.com");
assert.equal(nextVendorWebsiteUrl("", "mailto:sales@mekibo.com"), "");

console.log("vendor-url heal checks passed");
