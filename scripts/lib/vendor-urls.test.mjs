import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  hostOfUrl,
  hostKey,
  isStorefrontHost,
  needsStorefront,
  storefrontHostFromUrls,
  planPublishingReport,
  planRosterSync,
  planStorefrontOwnership,
  planStorefrontRelocation,
  planVendorUrlHeal,
  nextVendorWebsiteUrl,
  NON_STOREFRONT_HOSTS,
} from "./vendor-urls.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// --- needsStorefront -------------------------------------------------------
// The predicate every storefront repair is keyed on. Blank was only half of
// it: a row an import parked on goo.gl is exactly as uncrawlable, and because
// it is NOT blank it was the shape nothing ever revisited — the store dropped
// off the site the day it was downgraded and stayed off.
assert.equal(needsStorefront("https://basekeys.jp"), false);
assert.equal(needsStorefront("https://www.keebzncables.com"), false);
for (const blank of ["", "   ", null, undefined]) {
  assert.equal(needsStorefront(blank), true, JSON.stringify(blank));
}
// The four shapes actually sitting in supabase-setup.sql, plus the downgrades
// KeycapLendar offers for stores that already have a real site.
for (const parked of [
  "https://goo.gl",
  "https://www.instagram.com",
  "https://docs.google.com",
  "https://world.taobao.com",
  "https://item.taobao.com/item.htm?id=1",
  "https://geekhack.org/index.php?topic=1",
  "https://imgur.com/a/abc",
]) {
  assert.equal(needsStorefront(parked), true, parked);
}
// Junk `new URL()` rejects is not a storefront either — hostOfUrl returns "",
// which isStorefrontHost already refuses.
assert.equal(needsStorefront("TBA"), true);
assert.equal(needsStorefront("mekibo.com"), true);

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

// A row parked on a shortener is repaired the same way a blank one is — that
// is the whole point of the widening. `current` travels with the plan so the
// caller can guard its UPDATE on the value the plan was built from, and so the
// build log can say what was replaced.
const parked = planVendorUrlHeal([
  {
    id: "v1",
    slug: "cocobrais",
    websiteUrl: "https://goo.gl",
    listingUrls: ["https://cocobrais.com/products/gmk-a"],
  },
  // The residue: parked AND its own listings are the same shortener. Nothing
  // to derive from, so it is reported rather than left looking crawlable.
  {
    id: "v2",
    slug: "kekkon",
    websiteUrl: "https://goo.gl",
    listingUrls: ["https://goo.gl/forms/SNkHTJJ7zZ9Ht4Hf2"],
  },
]);
assert.deepEqual(
  parked.heal.map((v) => [v.slug, v.current, v.websiteUrl]),
  [["cocobrais", "https://goo.gl", "https://cocobrais.com"]]
);
assert.deepEqual(parked.stranded.map((v) => v.slug), ["kekkon"]);
assert.equal(parked.stranded[0].reason, "links are marketplace/forum pages only");
// Two vendors parked on the SAME shortener must not block each other: goo.gl
// is nobody's storefront, so it is not a host anyone can own.
assert.equal(parked.duplicate.length, 0);

// A blank row still reports "" as its previous value, so the caller's guard
// works for both shapes with one code path.
assert.deepEqual(
  planVendorUrlHeal([{ id: "v", slug: "basekeys", listingUrls: ["https://basekeys.jp/p/1"] }])
    .heal.map((v) => v.current),
  [""]
);

// A vendor that already has a real storefront must never be touched, even if a
// caller widens its selection by mistake — the planner refuses it outright.
assert.deepEqual(
  planVendorUrlHeal([
    {
      id: "v",
      slug: "mekibo",
      websiteUrl: "https://mekibo.com",
      listingUrls: ["https://www.us.txkeyboards.com/products/gmk-a"],
    },
  ]),
  { heal: [], duplicate: [], stranded: [] }
);

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

// --- planRosterSync --------------------------------------------------------
// The roster is the only rung that can give a storefront to a store whose
// upstream entries name nothing but a marketplace. These are the shapes the
// database actually presents it with.
const sync = planRosterSync(
  [
    // Already correct under its own slug — nothing to do.
    { slug: "ilumkb", websiteUrl: "https://ilumkb.com" },
    // Blank under its own slug: the case the roster exists for.
    { slug: "geonworks", websiteUrl: "https://geon.works" },
    // Blank under an ALIAS spelling. Slug matching misses it and host matching
    // cannot see it (a blank row has no host), so the old code inserted a
    // second row and left the original stranded and unpublishable.
    { slug: "cannonkeys", websiteUrl: "https://cannonkeys.com", aliases: ["cannon-keys"] },
    // Present under an alias that ALREADY has the right storefront — no insert,
    // no heal, no duplicate row.
    { slug: "thekeyco", websiteUrl: "https://thekey.company", aliases: ["the-key-company"] },
    // A different slug already owns this host: one store, one Vendor row.
    { slug: "mech-land", websiteUrl: "https://mech.land" },
    // Genuinely new.
    { slug: "saber-keebs", websiteUrl: "https://saberkeebs.com" },
  ],
  [
    { slug: "ilumkb", websiteUrl: "https://ilumkb.com" },
    { slug: "geonworks", websiteUrl: "" },
    { slug: "cannon-keys", websiteUrl: "" },
    { slug: "the-key-company", websiteUrl: "https://thekey.company" },
    { slug: "mechland", websiteUrl: "https://mech.land" },
  ]
);
assert.deepEqual(sync.insert.map((v) => v.slug), ["saber-keebs"]);
assert.deepEqual(
  sync.heal.map((v) => [v.slug, v.websiteUrl]),
  [
    ["geonworks", "https://geon.works"],
    ["cannon-keys", "https://cannonkeys.com"],
  ]
);
assert.deepEqual(sync.aliased.map((v) => [v.slug, v.owner]), [["mech-land", "mechland"]]);
assert.deepEqual(sync.duplicate, []);
// The heal carries what it replaced, so db-setup's UPDATE can be guarded on it.
assert.deepEqual(sync.heal.map((v) => v.current), ["", ""]);

// The roster repairs a DOWNGRADED row too, not just a blank one. iLumKB has
// upstream entries on item.taobao.com and NovelKeys on geekhack.org; before
// nextVendorWebsiteUrl existed either could have been written over the real
// storefront, and nothing since would have put it back — the roster's heal was
// keyed on blank, so the store stayed uncrawlable and published nothing.
const downgraded = planRosterSync(
  [
    { slug: "ilumkb", websiteUrl: "https://ilumkb.com" },
    { slug: "novelkeys", websiteUrl: "https://novelkeys.com" },
    // Parked under an ALIAS spelling: still the same store, still repaired.
    { slug: "cannonkeys", websiteUrl: "https://cannonkeys.com", aliases: ["cannon-keys"] },
  ],
  [
    { slug: "ilumkb", websiteUrl: "https://item.taobao.com/item.htm?id=1" },
    { slug: "novelkeys", websiteUrl: "https://geekhack.org/index.php?topic=1" },
    { slug: "cannon-keys", websiteUrl: "https://www.instagram.com/cannonkeys" },
  ]
);
assert.deepEqual(
  downgraded.heal.map((v) => [v.slug, v.websiteUrl]),
  [
    ["ilumkb", "https://ilumkb.com"],
    ["novelkeys", "https://novelkeys.com"],
    ["cannon-keys", "https://cannonkeys.com"],
  ]
);
assert.deepEqual(downgraded.insert, []);
// item.taobao.com is not a storefront, so the downgraded row never "owned"
// that host — otherwise a second roster entry could be mistaken for its alias.
assert.deepEqual(downgraded.aliased, []);

// Both spellings exist as rows: that is two Vendor rows for one shop, which
// only a human can merge. Heal the canonical one, name the other.
const twinRows = planRosterSync(
  [{ slug: "cannonkeys", websiteUrl: "https://cannonkeys.com", aliases: ["cannon-keys"] }],
  [
    { slug: "cannonkeys", websiteUrl: "" },
    { slug: "cannon-keys", websiteUrl: "" },
  ]
);
assert.deepEqual(twinRows.heal.map((v) => v.slug), ["cannonkeys"]);
assert.deepEqual(twinRows.duplicate, [{ slug: "cannon-keys", keeps: "cannonkeys" }]);
assert.deepEqual(twinRows.insert, []);

// Two roster entries pointing at one host: the first claims it, so the second
// cannot create a second row for the same store on a fresh database.
const sameHost = planRosterSync(
  [
    { slug: "store-a", websiteUrl: "https://store.example" },
    { slug: "store-b", websiteUrl: "https://www.store.example" },
  ],
  []
);
assert.deepEqual(sameHost.insert.map((v) => v.slug), ["store-a"]);
assert.deepEqual(sameHost.aliased.map((v) => [v.slug, v.owner]), [["store-b", "store-a"]]);

// Entries with nothing to act on are dropped, not inserted blank.
assert.deepEqual(
  planRosterSync([{ slug: "x", websiteUrl: "  " }, { slug: "", websiteUrl: "https://y.com" }], []),
  { insert: [], heal: [], aliased: [], duplicate: [], conflicted: [] }
);
assert.deepEqual(planRosterSync(undefined, undefined), {
  insert: [],
  heal: [],
  aliased: [],
  duplicate: [],
  conflicted: [],
});

// --- the roster file itself ------------------------------------------------
const roster = JSON.parse(
  readFileSync(join(REPO_ROOT, "src", "data", "seed", "vendors.json"), "utf8")
);
const rosterHosts = new Map();
for (const entry of roster) {
  assert.ok(entry.slug, `roster entry without a slug: ${JSON.stringify(entry)}`);
  const host = hostKey(hostOfUrl(entry.websiteUrl));
  assert.ok(host, `roster entry ${entry.slug} has no parseable websiteUrl`);
  // A roster entry that isn't a storefront would point discovery at a
  // marketplace — the exact thing nextVendorWebsiteUrl refuses to store.
  assert.ok(isStorefrontHost(host), `roster entry ${entry.slug} is not a storefront: ${host}`);
  // One store, one entry: two entries on one host race to own it.
  assert.equal(rosterHosts.has(host), false, `roster lists ${host} twice`);
  rosterHosts.set(host, entry.slug);
}
// A slug may only appear once, as itself or as somebody's alias — otherwise
// planRosterSync's "first candidate wins" would depend on file order.
const claimedSlugs = new Set();
for (const entry of roster) {
  for (const slug of [entry.slug, ...(entry.aliases ?? [])]) {
    assert.equal(claimedSlugs.has(slug), false, `roster claims the slug ${slug} twice`);
    claimedSlugs.add(slug);
  }
}

// --- OUTLET_COLLECTIONS must resolve to a vendor ---------------------------
// run_outlets resolves a collection's vendor from the URL's HOST against
// Vendor.websiteUrl (find_vendor_for_url) — a host no Vendor row carries logs
// "no tracked vendor" and does nothing, every night, forever. That is how
// geon.works sat in the list while GEONWORKS itself had a blank websiteUrl
// (KeycapLendar files it under smartstore.naver.com, which every automatic
// repair correctly refuses to adopt) and published no listing at all.
//
// So the collection list and the vendor registry are two halves of one thing:
// every outlet host must be registered by the roster or by SEEDED_VENDORS in
// scrape.py, which exists for exactly the stores the roster doesn't carry.
const scrapePy = readFileSync(join(REPO_ROOT, "scraper", "scrape.py"), "utf8");
const pyList = (name) => {
  const start = scrapePy.indexOf(`${name} = [`);
  assert.notEqual(start, -1, `${name} not found in scrape.py`);
  const end = scrapePy.indexOf("\n]", start);
  assert.notEqual(end, -1, `${name} is not terminated in scrape.py`);
  return [...scrapePy.slice(start, end).matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
};
const seededHosts = new Set(pyList("SEEDED_VENDORS").map((u) => hostKey(hostOfUrl(u))));
const registered = new Set([...rosterHosts.keys(), ...seededHosts]);
const unresolvable = [
  ...new Set(pyList("OUTLET_COLLECTIONS").map((u) => hostKey(hostOfUrl(u)))),
].filter((host) => !registered.has(host));
assert.deepEqual(
  unresolvable,
  [],
  `OUTLET_COLLECTIONS names host(s) no Vendor row is guaranteed to carry, so ` +
    `run_outlets skips them silently: ${unresolvable.join(", ")}. Add them to ` +
    `src/data/seed/vendors.json or to SEEDED_VENDORS in scraper/scrape.py.`
);

// --- the two discovery halves must refuse the same hosts -------------------
// Discovery is written twice: run_discovery in scrape.py is the nightly that
// actually crawls, discoverGmkProducts in discovery.ts is the Vercel cron.
// #131 excluded blank-URL vendors in the TS copy alone and the nightly kept
// spending a fifth of every rotation on stores it could not fetch. The
// storefront test excludes the OTHER uncrawlable shape, so both halves have to
// agree on which hosts that is.
const pyHosts = (() => {
  const m = /_NON_STOREFRONT_HOSTS\s*=\s*\(([\s\S]*?)\n\)/.exec(scrapePy);
  assert.ok(m, "scrape.py must keep _NON_STOREFRONT_HOSTS");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();
assert.deepEqual(
  pyHosts,
  [...NON_STOREFRONT_HOSTS],
  "scrape.py and scripts/lib/vendor-urls.mjs must refuse the same non-storefront hosts"
);

// Both halves must actually apply it, not just carry the list.
assert.ok(
  /_crawlable_vendors\(cur\.fetchall\(\), _DISCOVERY_VENDOR_LIMIT\)/.test(scrapePy),
  "run_discovery must filter its rotation through _crawlable_vendors"
);
const discoveryTs = readFileSync(
  join(REPO_ROOT, "src", "lib", "import", "discovery.ts"),
  "utf8"
);
assert.ok(
  /needsStorefront/.test(discoveryTs),
  "discoverGmkProducts must skip vendors with no usable storefront"
);
// The over-fetch is what makes the Python-side filter safe: filtering a page
// sized exactly to the rotation limit would shorten the rotation instead of
// replacing the refused rows.
assert.ok(
  /_DISCOVERY_VENDOR_LIMIT \* _DISCOVERY_OVERFETCH/.test(scrapePy),
  "run_discovery must over-fetch so the storefront filter still fills the rotation"
);
assert.ok(
  /vendorLimit \* DISCOVERY_OVERFETCH/.test(discoveryTs),
  "discoverGmkProducts must over-fetch so the storefront filter still fills the rotation"
);

// --- planStorefrontOwnership -----------------------------------------------
// The third shape of "no storefront of its own": a row parked on a host that
// belongs to a DIFFERENT store. It is a shop, so needsStorefront calls it
// healthy and no repair revisits it — while discovery crawls that shop's
// catalogue under this vendor's name and this vendor's own site is never
// fetched at all. Fixtures are the real rows: Swagkeys (KR) shipped as
// https://mokbstore.com, the host Mokb Store's own row carries, and 11 of its
// 13 listings are on www.swagkey.kr.
const misparked = planStorefrontOwnership([
  {
    id: "v1",
    slug: "swagkeys-kr",
    websiteUrl: "https://mokbstore.com",
    listingUrls: [
      "https://www.swagkey.kr/915144507/?idx=1413",
      "https://www.swagkey.kr/915144507/?idx=735",
      "https://www.swagkey.kr/40/?idx=692",
      "https://mokbstore.com/gb-mv-expo-gmk-cyl",
      "https://swagkeys.com/products/gmk-cyl-pandemonium",
    ],
  },
  {
    id: "v2",
    slug: "mokb-store",
    websiteUrl: "https://mokbstore.com",
    listingUrls: [
      "https://mokbstore.com/gb-mv-expo-gmk-cyl",
      "https://mokbstore.com/gb-mv-t3rminal-gmk-cyl",
    ],
  },
  // Uncontested rows are never touched, whatever their listings say.
  { id: "v3", slug: "swagkeys", websiteUrl: "https://swagkeys.com", listingUrls: [] },
]);
assert.deepEqual(
  misparked.heal.map((v) => [v.slug, v.current, v.websiteUrl]),
  [["swagkeys-kr", "https://mokbstore.com", "https://www.swagkey.kr"]]
);
assert.deepEqual(misparked.contested, []);

// Two rows whose listings BOTH sell from the shared host are two rows for one
// shop (Protozoa Studio / Protozoa Studio (US)) — a merge, which no automatic
// pass should perform. Report, change nothing.
const twinShop = planStorefrontOwnership([
  {
    id: "p1",
    slug: "protozoa-studio",
    websiteUrl: "https://protozoa.studio",
    listingUrls: ["https://protozoa.studio/products/uk-gmk-blot", "https://protozoa.studio/products/uk-gmk-diner"],
  },
  {
    id: "p2",
    slug: "protozoa-studio-us",
    websiteUrl: "https://protozoa.studio",
    listingUrls: ["https://protozoa.studio/products/usa-gmk-diner"],
  },
]);
assert.deepEqual(twinShop.heal, []);
assert.deepEqual(
  twinShop.contested.map((v) => v.slug),
  ["protozoa-studio", "protozoa-studio-us"]
);

// Neither row's listings name the shared host: nothing to settle it with.
const noEvidence = planStorefrontOwnership([
  { id: "a", slug: "a", websiteUrl: "https://shared.example", listingUrls: [] },
  { id: "b", slug: "b", websiteUrl: "https://www.shared.example", listingUrls: [] },
]);
assert.deepEqual(noEvidence.heal, []);
assert.deepEqual(noEvidence.contested.map((v) => v.reason), [
  "no row's own listings sell from it",
  "no row's own listings sell from it",
]);

// The roster outranks the listings: it is the hand-written rung that exists to
// be right about which store owns which site. Here the loser's listings agree
// with the shared host, so the evidence rule alone would have called it a tie.
const rosterWins = planStorefrontOwnership(
  [
    {
      id: "r1",
      slug: "kbdfans",
      websiteUrl: "https://kbdfans.com",
      listingUrls: ["https://kbdfans.com/products/gmk-a", "https://kbdfans.com/products/gmk-b"],
    },
    {
      id: "r2",
      slug: "kbd-reseller",
      websiteUrl: "https://kbdfans.com",
      listingUrls: ["https://kbdfans.com/products/gmk-a", "https://reseller.example/gmk-b", "https://reseller.example/gmk-c"],
    },
  ],
  [{ slug: "kbdfans", websiteUrl: "https://kbdfans.com" }]
);
assert.deepEqual(
  rosterWins.heal.map((v) => [v.slug, v.websiteUrl]),
  [["kbd-reseller", "https://reseller.example"]]
);

// A loser whose own storefront is ALREADY somebody else's row is a duplicate of
// that row, not a store waiting for a URL — moving it there would have two
// vendors crawling one catalogue again, which is the state being repaired.
const wouldCollide = planStorefrontOwnership([
  {
    id: "c1",
    slug: "shop",
    websiteUrl: "https://shop.example",
    listingUrls: ["https://shop.example/a", "https://shop.example/b"],
  },
  {
    id: "c2",
    slug: "shop-twin",
    websiteUrl: "https://shop.example",
    listingUrls: ["https://other.example/a", "https://other.example/b"],
  },
  { id: "c3", slug: "other", websiteUrl: "https://other.example", listingUrls: [] },
]);
assert.deepEqual(wouldCollide.heal, []);
assert.deepEqual(
  wouldCollide.contested.map((v) => [v.slug, v.reason]),
  [["shop-twin", "its own storefront other.example already belongs to other"]]
);

// Blank and parked-on-a-shortener rows are planVendorUrlHeal's business: two
// vendors both registered as https://goo.gl are not fighting over a storefront.
assert.deepEqual(
  planStorefrontOwnership([
    { id: "g1", slug: "cocobrais", websiteUrl: "https://goo.gl", listingUrls: [] },
    { id: "g2", slug: "kekkon", websiteUrl: "https://goo.gl", listingUrls: [] },
    { id: "g3", slug: "vertex", websiteUrl: "", listingUrls: [] },
    { id: "g4", slug: "photekq", websiteUrl: "", listingUrls: [] },
  ]),
  { heal: [], contested: [] }
);
assert.deepEqual(planStorefrontOwnership(), { heal: [], contested: [] });
assert.deepEqual(planStorefrontOwnership([], []), { heal: [], contested: [] });

// --- nextVendorWebsiteUrl vs. another vendor's storefront -------------------
// One of Swagkeys (KR)'s upstream entries names mokbstore.com. Without this the
// nightly import re-parks the row the deploy just repaired, every night.
const takenByOthers = new Set(["mokbstore.com"]);
assert.equal(
  nextVendorWebsiteUrl("https://www.swagkey.kr", "https://mokbstore.com/gb-mv-expo", takenByOthers),
  "https://www.swagkey.kr"
);
// …and it does not invent one for a brand-new vendor either.
assert.equal(nextVendorWebsiteUrl("", "https://mokbstore.com/gb-mv-expo", takenByOthers), "");
// The store that OWNS the host still adopts it — the set is "hosts owned by
// someone else", so a vendor is never refused its own site.
assert.equal(
  nextVendorWebsiteUrl("", "https://mokbstore.com/gb-mv-expo", new Set()),
  "https://mokbstore.com"
);
// www-insensitive, like every other host comparison here.
assert.equal(
  nextVendorWebsiteUrl("", "https://www.mokbstore.com/gb-mv-expo", takenByOthers),
  ""
);
// The import must actually pass the set through, not merely compute it.
const keycaplendarTs = readFileSync(
  join(REPO_ROOT, "src", "lib", "import", "keycaplendar.ts"),
  "utf8"
);
assert.ok(
  /nextVendorWebsiteUrl\(\s*vendor\?\.websiteUrl \?\? "",\s*v\.storeLink,\s*hostsOwnedByOthers\(vSlug\)/.test(
    keycaplendarTs
  ),
  "the KeycapLendar import must refuse a storeLink on another vendor's host"
);

// --- planPublishingReport --------------------------------------------------
// The residue nothing above sees: a Vendor row with a real storefront that the
// site never actually surfaces. Fixtures are the concrete cases this planner
// exists to sort out.
const silent = planPublishingReport(
  [
    // Healthy storefront, zero visible listings — the case this reports.
    { slug: "quiet-shop", websiteUrl: "https://quietshop.com", visibleListings: 0 },
    // Same story but the count arrived as a string from the DB driver, or was
    // omitted — both must read as zero.
    { slug: "no-count", websiteUrl: "https://nocount.com" },
    { slug: "string-count", websiteUrl: "https://stringcount.com", visibleListings: "0" },
    // Healthy storefront that DOES publish — must be silent (not reported).
    { slug: "cannonkeys", websiteUrl: "https://cannonkeys.com", visibleListings: 12 },
    // Blank websiteUrl / parked on a shortener / on a marketplace: these are
    // planVendorUrlHeal's territory and reporting them here would just double
    // the noise on the deploy log.
    { slug: "blank", websiteUrl: "", visibleListings: 0 },
    { slug: "shortener", websiteUrl: "https://goo.gl", visibleListings: 0 },
    { slug: "marketplace", websiteUrl: "https://item.taobao.com/x", visibleListings: 0 },
    // Catalog markers and about-to-be-purged rows publish nothing by design —
    // the caller passes their slugs in so this planner stays free of the
    // manufacturer registry (which is TypeScript, out of reach here).
    { slug: "gmk", websiteUrl: "https://www.gmk.net", visibleListings: 0 },
    { slug: "dcs-wiki", websiteUrl: "https://dcs.wiki", visibleListings: 0 },
    { slug: "fancycustoms", websiteUrl: "https://fancycustoms.com", visibleListings: 0 },
  ],
  new Set(["gmk", "dcs-wiki", "fancycustoms", "fancy-customs"])
);
assert.deepEqual(
  silent.map((v) => v.slug),
  ["no-count", "quiet-shop", "string-count"]
);
// Report shape is {slug, websiteUrl, reason} — the caller wants all three, for
// a log line the owner can act on without opening a psql session.
assert.deepEqual(silent[0], {
  slug: "no-count",
  websiteUrl: "https://nocount.com",
  reason: "no listing linked — discovery has never matched a tracked set",
});

// --- the reason, which is the whole point of naming them -------------------
// "one of three things went wrong" sent the owner to the wrong pass as often as
// the right one. The three causes leave different residue, and the counts
// separate them: no rows at all is discovery's, rows-but-no-price is the price
// pass's, priced-but-invisible is a non-BASE/catalog row.
const reasonOf = (vendor) => planPublishingReport([vendor])[0].reason;

// Discovery never linked the store to anything. This is the shape a Signature
// Plastics specialist sat in for as long as the tracked-profile gate refused
// SA / DSS / DSA titles — the store was crawled every rotation and matched
// nothing, so it looked exactly like a shop that had stopped selling.
assert.match(
  reasonOf({ slug: "saber-keebs", websiteUrl: "https://saberkeebs.com", visibleListings: 0, listings: 0, pricedListings: 0 }),
  /no listing linked/
);
// Linked but never priced — unpriced rows are hidden outright on RELEASED sets,
// which is where most listings live, so the store has rows and shows nothing.
assert.match(
  reasonOf({ slug: "unpriced", websiteUrl: "https://unpriced.com", visibleListings: 0, listings: 7, pricedListings: 0 }),
  /7 listing\(s\) linked, none priced/
);
// Priced, but every row is filtered off the set page.
assert.match(
  reasonOf({ slug: "invisible", websiteUrl: "https://invisible.com", visibleListings: 0, listings: 9, pricedListings: 4 }),
  /4 of 9 listing\(s\) priced but none visible/
);
// Counts arrive from the driver as strings on some paths; a "0" must not read
// as "has listings" and flip the diagnosis to the wrong pass.
assert.match(
  reasonOf({ slug: "stringy", websiteUrl: "https://stringy.com", visibleListings: "0", listings: "0", pricedListings: "0" }),
  /no listing linked/
);
assert.match(
  reasonOf({ slug: "stringy2", websiteUrl: "https://stringy2.com", visibleListings: "0", listings: "3", pricedListings: "0" }),
  /3 listing\(s\) linked, none priced/
);
// Deterministic order (alphabetical by slug), so the deploy log doesn't churn.
assert.deepEqual(
  planPublishingReport([
    { slug: "b", websiteUrl: "https://b.com", visibleListings: 0 },
    { slug: "a", websiteUrl: "https://a.com", visibleListings: 0 },
    { slug: "c", websiteUrl: "https://c.com", visibleListings: 0 },
  ]).map((v) => v.slug),
  ["a", "b", "c"]
);
// A row that other passes should own (blank/parked) counts here as OK for the
// purposes of this report even if `excludeSlugs` doesn't name it — the shape
// filter takes precedence over the count.
assert.deepEqual(
  planPublishingReport([
    { slug: "someone", websiteUrl: "https://goo.gl", visibleListings: 0 },
  ]),
  []
);
// Empty / undefined inputs — this is called every deploy, so it must not
// throw when the DB pass hands back nothing at all.
assert.deepEqual(planPublishingReport(), []);
assert.deepEqual(planPublishingReport([]), []);
assert.deepEqual(planPublishingReport(undefined, undefined), []);
// A row missing a slug (defensive — should never happen from SQL) is skipped
// rather than crashing the planner with a null-key comparison.
assert.deepEqual(
  planPublishingReport([
    { websiteUrl: "https://a.com", visibleListings: 0 },
    { slug: "ok", websiteUrl: "https://ok.com", visibleListings: 0 },
  ]).map((v) => v.slug),
  ["ok"]
);

// db-setup must actually run the report — the plan is only useful if the SQL
// pass that feeds it is wired into main(). Without this, the whole diagnostic
// is one file edit away from silently disabled.
const dbSetup = readFileSync(join(REPO_ROOT, "scripts", "db-setup.mjs"), "utf8");
assert.ok(
  /planPublishingReport/.test(dbSetup),
  "scripts/db-setup.mjs must call planPublishingReport to surface silent vendors"
);
assert.ok(
  /reportVendorsPublishingNothing\(client\)/.test(dbSetup),
  "scripts/db-setup.mjs's main() must invoke reportVendorsPublishingNothing"
);
// …and it must feed the counts the reason is derived from. Omitting them is not
// a missing detail: every field defaults to 0, so the report would tell the
// owner "no listing linked — discovery has never matched a tracked set" about
// every silent vendor, confidently and wrongly, and send them to the one pass
// that has nothing to do with it.
for (const field of ["listings", "pricedListings", "visibleListings"]) {
  assert.ok(
    new RegExp(`${field}:`).test(dbSetup),
    `scripts/db-setup.mjs must pass ${field} to planPublishingReport`
  );
}
assert.ok(
  /AS listings/.test(dbSetup) && /AS priced_listings/.test(dbSetup),
  "scripts/db-setup.mjs must count the vendor's rows and priced rows in SQL"
);
// The reason must reach the log, not just the plan.
assert.ok(
  /\.reason/.test(dbSetup),
  "scripts/db-setup.mjs must print each silent vendor's reason"
);

// --- the roster outranks a WRONG storefront, not just a missing one --------
// `novelkeys` shipped as https://novelkeys.xyz — NovelKeys' retired domain —
// while this very roster names https://novelkeys.com. needsStorefront reads
// novelkeys.xyz as "a shop", so the heal skipped it on every deploy for a year
// and discovery kept asking the dead site for /products.json.
const wrongHost = planRosterSync(
  [
    { slug: "novelkeys", websiteUrl: "https://novelkeys.com" },
    // Same shape reached through an alias spelling.
    { slug: "swagkeys-kr", websiteUrl: "https://www.swagkey.kr", aliases: ["swagkeys-korea"] },
    // Host already agrees — a www-only spelling difference is not churn worth
    // writing (the DB has www.ashkeebs.com, the roster ashkeebs.com).
    { slug: "ashkeebs", websiteUrl: "https://ashkeebs.com" },
  ],
  [
    { slug: "novelkeys", websiteUrl: "https://novelkeys.xyz" },
    { slug: "swagkeys-korea", websiteUrl: "https://mokbstore.com" },
    { slug: "ashkeebs", websiteUrl: "https://www.ashkeebs.com" },
  ]
);
assert.deepEqual(
  wrongHost.heal.map((v) => [v.slug, v.current, v.websiteUrl]),
  [
    ["novelkeys", "https://novelkeys.xyz", "https://novelkeys.com"],
    ["swagkeys-korea", "https://mokbstore.com", "https://www.swagkey.kr"],
  ]
);
assert.deepEqual(wrongHost.conflicted, []);

// …but never onto a host another Vendor row already holds. Taking it would
// park two rows on one shop, which is the state planStorefrontOwnership exists
// to undo — so it is reported and nothing is written.
const rosterClash = planRosterSync(
  [{ slug: "swagkeys-kr", websiteUrl: "https://mokbstore.com" }],
  [
    { slug: "mokb-store", websiteUrl: "https://mokbstore.com" },
    { slug: "swagkeys-kr", websiteUrl: "https://swagkeys.com" },
  ]
);
assert.deepEqual(rosterClash.heal, []);
assert.deepEqual(rosterClash.conflicted, [
  { slug: "swagkeys-kr", owner: "mokb-store", host: "mokbstore.com" },
]);
// The row that already IS the owner is healed, not reported against itself.
assert.deepEqual(
  planRosterSync(
    [{ slug: "mokb-store", websiteUrl: "https://www.mokbstore.com" }],
    [{ slug: "mokb-store", websiteUrl: "https://mokbstore.com" }]
  ).heal,
  []
);

// --- planStorefrontRelocation ----------------------------------------------
// The shape every repair above reads as healthy: a row parked ALONE on a real
// storefront that is not this store's site. Fixtures are the five rows
// supabase-setup.sql actually ships in that state, with their real listing
// hosts and counts.
const offsite = planStorefrontRelocation(
  [
    // Retired domain. Also the one the roster names — so the roster decides it
    // and this planner must keep its hands off (see the pinned check below).
    {
      id: "nk",
      slug: "novelkeys",
      websiteUrl: "https://novelkeys.xyz",
      listingUrls: [
        ...Array(162).fill("https://novelkeys.com/products/gmk-x"),
        ...Array(96).fill("https://novelkeys.xyz/products/gmk-x"),
      ],
    },
    // Registered on a DIFFERENT LIVE SHOP. Discovery reads DixieMech's
    // catalogue and files it as Omnitype's listings — planStorefrontOwnership's
    // harm, with no collision for it to detect.
    {
      id: "om",
      slug: "omnitype",
      websiteUrl: "https://dixiemech.com",
      listingUrls: [
        ...Array(42).fill("https://omnitype.com/products/gmk-x"),
        ...Array(6).fill("https://dixiemech.com/products/gmk-x"),
      ],
    },
    // Corporate apex instead of the shop subdomain. hostKey folds "www." and
    // nothing else, so yushakobo.jp and shop.yushakobo.jp are two hosts — which
    // is why SEEDED_VENDORS in scrape.py had to hard-code a repoint for this
    // one store, in the Python half only.
    {
      id: "yk",
      slug: "yushakobo",
      websiteUrl: "https://yushakobo.jp",
      listingUrls: [
        ...Array(44).fill("https://shop.yushakobo.jp/products/gmk-x"),
        ...Array(8).fill("https://yushakobo.jp/products/gmk-x"),
      ],
    },
    // Renamed shop.
    {
      id: "mk",
      slug: "mekanisk",
      websiteUrl: "https://mekanisktastatur.no",
      listingUrls: [
        ...Array(14).fill("https://tastatur.no/products/gmk-x"),
        ...Array(2).fill("https://mekanisktastatur.no/products/gmk-x"),
      ],
    },
    // Group buys on a sibling subdomain.
    {
      id: "mb",
      slug: "mechboards",
      websiteUrl: "http://mechboards.co.uk",
      listingUrls: [
        ...Array(6).fill("https://groupbuys.mechboards.co.uk/products/gmk-x"),
        ...Array(2).fill("https://mechboards.co.uk/products/gmk-x"),
      ],
    },
    // Registered host and listings agree — the overwhelming majority of rows,
    // and none of them may be touched.
    {
      id: "ck",
      slug: "cannon-keys",
      websiteUrl: "https://cannonkeys.com",
      listingUrls: Array(124).fill("https://cannonkeys.com/products/gmk-x"),
    },
    // Blank / shortener rows are planVendorUrlHeal's shape, never this one.
    { id: "bk", slug: "basekeys", websiteUrl: "", listingUrls: ["https://basekeys.jp/p/x"] },
    { id: "cb", slug: "cocobrais", websiteUrl: "https://goo.gl", listingUrls: ["https://goo.gl/x"] },
  ],
  [{ slug: "novelkeys", websiteUrl: "https://novelkeys.com" }]
);
assert.deepEqual(
  offsite.heal.map((v) => [v.slug, v.current, v.websiteUrl]),
  [
    ["omnitype", "https://dixiemech.com", "https://omnitype.com"],
    ["yushakobo", "https://yushakobo.jp", "https://shop.yushakobo.jp"],
    ["mekanisk", "https://mekanisktastatur.no", "https://tastatur.no"],
    ["mechboards", "http://mechboards.co.uk", "https://groupbuys.mechboards.co.uk"],
  ]
);
assert.deepEqual(offsite.contested, []);
// The id rides through, because db-setup's UPDATE is keyed on it.
assert.deepEqual(offsite.heal.map((v) => v.id), ["om", "yk", "mk", "mb"]);

// A host two rows SHARE is a contested host: different evidence, different
// planner (planStorefrontOwnership, which the roster can also settle). Leaving
// it alone here is what keeps the two from fighting over the same rows.
assert.deepEqual(
  planStorefrontRelocation([
    {
      slug: "swagkeys-kr",
      websiteUrl: "https://mokbstore.com",
      listingUrls: Array(11).fill("https://www.swagkey.kr/p/x"),
    },
    { slug: "mokb-store", websiteUrl: "https://mokbstore.com", listingUrls: [] },
  ]).heal,
  []
);

// The winning host already belongs to someone else: report, never take. This
// is exactly how a vendor gets parked on another shop in the first place.
const relClash = planStorefrontRelocation([
  {
    slug: "omnitype",
    websiteUrl: "https://dixiemech.com",
    listingUrls: Array(9).fill("https://omnitype.com/p/x"),
  },
  { slug: "omnitype-eu", websiteUrl: "https://omnitype.com", listingUrls: [] },
]);
assert.deepEqual(relClash.heal, []);
assert.deepEqual(relClash.contested.map((v) => [v.slug, v.owner]), [["omnitype", "omnitype-eu"]]);

// A tie is never broken by guessing — Maamaadei's links are one .com and one
// .xyz, and picking either would be a coin toss stored as fact.
assert.deepEqual(
  planStorefrontRelocation([
    {
      slug: "maamaadei",
      websiteUrl: "https://maamaadei.store",
      listingUrls: ["https://www.maamaadei.com/x", "https://www.maamaadei.xyz/x"],
    },
  ]).heal,
  []
);
// Marketplace/forum links never win one either: a row whose listings are all
// Taobao keeps its storefront rather than being pointed at a marketplace.
assert.deepEqual(
  planStorefrontRelocation([
    {
      slug: "typist-club",
      websiteUrl: "https://typist.club",
      listingUrls: Array(4).fill("https://shop278801163.m.taobao.com/x"),
    },
  ]).heal,
  []
);
// Called every deploy — must not throw on nothing at all.
assert.deepEqual(planStorefrontRelocation(), { heal: [], contested: [] });
assert.deepEqual(planStorefrontRelocation([], []), { heal: [], contested: [] });

// --- nextVendorWebsiteUrl vs. the store's own listings ---------------------
// Once a row IS on the host its own listings sell from, no upstream storeLink
// may move it off: 96 of NovelKeys' 258 links are its retired novelkeys.xyz, so
// without this the deploy repairs the row and that same night's import undoes
// it — the loop #133 and #137 each had to close for their own shape.
assert.equal(
  nextVendorWebsiteUrl(
    "https://novelkeys.com",
    "https://novelkeys.xyz/products/gmk-x",
    new Set(),
    "novelkeys.com"
  ),
  "https://novelkeys.com"
);
// The store's own host is still adopted — this refuses the wrong link, not the
// right one — and the comparison folds www. like every other host check here.
assert.equal(
  nextVendorWebsiteUrl(
    "https://novelkeys.com",
    "https://www.novelkeys.com/products/gmk-x",
    new Set(),
    "novelkeys.com"
  ),
  "https://www.novelkeys.com"
);
// When the row is NOT yet on that host, only a link naming it is adopted, so
// the import converges on the store's real site instead of wandering between
// its old ones.
assert.equal(
  nextVendorWebsiteUrl(
    "https://novelkeys.xyz",
    "https://novelkeys.com/products/gmk-x",
    new Set(),
    "novelkeys.com"
  ),
  "https://novelkeys.com"
);
assert.equal(
  nextVendorWebsiteUrl(
    "https://novelkeys.xyz",
    "https://geekhack.org/index.php?topic=1",
    new Set(),
    "novelkeys.com"
  ),
  "https://novelkeys.xyz"
);
// Unknown (a brand-new vendor, or one whose listings name no storefront) leaves
// the existing rule exactly as it was — including the kbd.fans → kbdfans.com
// move a genuinely relocated store still needs.
for (const unknown of ["", null, undefined]) {
  assert.equal(
    nextVendorWebsiteUrl("https://kbd.fans", "https://kbdfans.com/products/x", new Set(), unknown),
    "https://kbdfans.com",
    JSON.stringify(unknown)
  );
}
// Another vendor's host still loses, whatever the listings say.
assert.equal(
  nextVendorWebsiteUrl(
    "https://www.swagkey.kr",
    "https://mokbstore.com/gb-mv-expo",
    new Set(["mokbstore.com"]),
    "mokbstore.com"
  ),
  "https://www.swagkey.kr"
);

// The import must actually pass the vendor's own host through, and derive it
// from the listings rather than re-deciding what a storefront is.
assert.ok(
  /ownHostByVendorId\.get\(vendor\?\.id \?\? ""\)/.test(keycaplendarTs),
  "the KeycapLendar import must pass each vendor's own listing host to nextVendorWebsiteUrl"
);
assert.ok(
  /storefrontHostFromUrls\(urls\)/.test(keycaplendarTs),
  "the KeycapLendar import must derive that host with storefrontHostFromUrls"
);

// db-setup must run the relocation pass, in both of main()'s branches — a
// planner nothing calls is a repair that never happens.
assert.ok(
  /planStorefrontRelocation/.test(dbSetup),
  "scripts/db-setup.mjs must call planStorefrontRelocation"
);
assert.equal(
  (dbSetup.match(/await healOffsiteVendorUrls\(client\);/g) ?? []).length,
  2,
  "scripts/db-setup.mjs's main() must invoke healOffsiteVendorUrls on both paths"
);
// Order matters: contested hosts are settled first (a row moved off one frees
// it), and the blank/shortener heal runs last so it sees final ownership.
assert.ok(
  dbSetup.indexOf("await healMisparkedVendorUrls(client);") <
    dbSetup.indexOf("await healOffsiteVendorUrls(client);") &&
    dbSetup.indexOf("await healOffsiteVendorUrls(client);") <
      dbSetup.indexOf("await healVendorUrlsFromListings(client);"),
  "healOffsiteVendorUrls must run after healMisparkedVendorUrls and before healVendorUrlsFromListings"
);
// The roster's new finding has to reach the build log too.
assert.ok(
  /plan\.conflicted/.test(dbSetup),
  "scripts/db-setup.mjs must report roster entries whose host another row holds"
);

console.log("vendor-url heal checks passed");
