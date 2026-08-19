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
  planRosterSync,
  planStorefrontOwnership,
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
  { insert: [], heal: [], aliased: [], duplicate: [] }
);
assert.deepEqual(planRosterSync(undefined, undefined), {
  insert: [],
  heal: [],
  aliased: [],
  duplicate: [],
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

console.log("vendor-url heal checks passed");
