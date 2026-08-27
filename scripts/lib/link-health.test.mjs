import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEAD_LINK_FAILURE_THRESHOLD,
  DEAD_LINK_RECHECK_HOURS,
  DEAD_LINK_STATUSES,
  describeDeadListings,
  isBackedOff,
  isDeadLinkStatus,
  isGoneRedirect,
  isUnbuyableDeadLink,
  nextLinkHealth,
} from "./link-health.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- isDeadLinkStatus ------------------------------------------------------
// 404/410 is the store answering "gone". Everything else is the store being
// unreachable, which is what a Cloudflare block on a datacenter IP looks like —
// and half the roster does that on a good day.
assert.equal(isDeadLinkStatus(404), true);
assert.equal(isDeadLinkStatus(410), true);
assert.equal(isDeadLinkStatus("404"), true);
for (const status of [200, 301, 302, 401, 402, 403, 429, 500, 503, undefined, null]) {
  assert.equal(isDeadLinkStatus(status), false, `status ${status}`);
}

// --- isGoneRedirect --------------------------------------------------------
// The other answer a store gives, and the commonest one measured against
// production. It never produces a status the pass can read: fetch() follows the
// hop and hands back a 200 on a page that is not the listing.
assert.equal(
  isGoneRedirect(
    "https://kono.store/collections/all-products-list/products/gmk-boho",
    "https://kono.store/"
  ),
  true,
  "a deleted Shopify product redirected to its own front door"
);
assert.equal(
  isGoneRedirect(
    "https://www.ashkeebs.com/product/gmk-alpine-keycaps/",
    "https://kineticlabs.com/"
  ),
  true,
  "an acquired shop redirecting its whole domain to the buyer's home page"
);
// A bare origin, with or without the trailing slash, is the same front door.
assert.equal(isGoneRedirect("https://kono.store/products/x", "https://kono.store"), true);
assert.equal(
  isGoneRedirect("https://kono.store/products/x", "https://kono.store/?shop=1"),
  true
);
// Landing on another PAGE says nothing about this listing: a renamed handle
// still prices, a collection page is merely unreadable, and a storefront
// password page is a temporary lock on a live shop — hiding those would be the
// exact failure deadSince exists to avoid.
for (const final of [
  "https://shop.example/products/gmk-boho-r2",
  "https://shop.example/collections/keycaps",
  "https://shop.example/password",
]) {
  assert.equal(isGoneRedirect("https://shop.example/products/gmk-boho", final), false, final);
}
// Several vendors carry a bare homepage as a listing URL (mykeyboard.eu does).
// It is a bad link, but it was not redirected off anything.
assert.equal(isGoneRedirect("https://mykeyboard.eu/", "https://mykeyboard.eu/"), false);
// Nothing parseable to judge → never a verdict.
assert.equal(isGoneRedirect("https://shop.example/products/x", undefined), false);
assert.equal(isGoneRedirect("not a url", "https://shop.example/"), false);
assert.equal(isGoneRedirect(null, null), false);

// --- nextLinkHealth --------------------------------------------------------
const T0 = new Date("2026-08-01T00:00:00Z");
const T1 = new Date("2026-08-20T00:00:00Z");

// A read is a read. NO_BASE_KIT means the page loaded and carries only add-on
// kits — a legitimate listing, not a failure — so it clears the counters just
// like a price does. Counting it as a failure would flag every store whose GMK
// products are all extras.
for (const good of ["PRICED", "NO_BASE_KIT"]) {
  assert.deepEqual(
    nextLinkHealth({ linkFailures: 5, deadSince: T0 }, good, T1),
    { linkFailures: 0, deadSince: null },
    good
  );
}

// GONE stamps the FIRST sighting and keeps it: how long the store has been
// broken is what decides relink-or-retire, so a later 404 must not reset the
// clock to today.
assert.deepEqual(nextLinkHealth({ linkFailures: 0, deadSince: null }, "GONE", T0), {
  linkFailures: 1,
  deadSince: T0,
});
assert.deepEqual(nextLinkHealth({ linkFailures: 3, deadSince: T0 }, "GONE", T1), {
  linkFailures: 4,
  deadSince: T0,
});

// UNREADABLE counts but never declares: a 401, a 402, a storefront password
// page or a DNS failure all land here, and none of them is the store saying the
// page is gone.
assert.deepEqual(nextLinkHealth({ linkFailures: 0, deadSince: null }, "UNREADABLE", T1), {
  linkFailures: 1,
  deadSince: null,
});
// …and it does not clear a deadSince already established.
assert.deepEqual(nextLinkHealth({ linkFailures: 1, deadSince: T0 }, "UNREADABLE", T1), {
  linkFailures: 2,
  deadSince: T0,
});
// Missing columns (a row written before the migration) read as zero/null, not
// NaN — the price pass writes these on every attempt and a NaN would poison the
// column for good.
assert.deepEqual(nextLinkHealth({}, "UNREADABLE", T1), { linkFailures: 1, deadSince: null });
assert.deepEqual(nextLinkHealth(undefined, "UNREADABLE", T1), {
  linkFailures: 1,
  deadSince: null,
});

// --- isBackedOff -----------------------------------------------------------
assert.equal(isBackedOff({ linkFailures: 0, deadSince: null }), false);
assert.equal(isBackedOff({ linkFailures: DEAD_LINK_FAILURE_THRESHOLD - 1 }), false);
assert.equal(isBackedOff({ linkFailures: DEAD_LINK_FAILURE_THRESHOLD }), true);
// A confirmed-gone page backs off immediately, however few attempts it took.
assert.equal(isBackedOff({ linkFailures: 1, deadSince: T0 }), true);

// --- isUnbuyableDeadLink ---------------------------------------------------
// Only the definitive signal takes a listing off the site. The heuristic may
// slow a row down and name it in the report; it may never hide a live store,
// because a blocked shop and a closed one are indistinguishable from here.
assert.equal(isUnbuyableDeadLink({ deadSince: T0, price: null }), true);
assert.equal(isUnbuyableDeadLink({ deadSince: null, price: null, linkFailures: 99 }), false);
// A price means the page was read and parsed; the same pass that sees a 404
// clears the price, so priced-and-dead only means the flag outlived the price.
assert.equal(isUnbuyableDeadLink({ deadSince: T0, price: 129 }), false);

// --- describeDeadListings --------------------------------------------------
assert.equal(describeDeadListings(0, 0), null);
assert.equal(describeDeadListings(12, 0), null);
// A vendor with nothing linked has no dead links either — "0 of 0" must not
// read as a dead store, or discovery's diagnosis is lost.
assert.equal(describeDeadListings(0, 3), null);
{
  const all = describeDeadListings(44, 44, T0);
  assert.match(all, /all 44 listing\(s\) are gone since 2026-08-01/);
  // Both answers are named. Saying only "404/410" sent the owner looking for a
  // status the commonest case never produces.
  assert.match(all, /redirected to the storefront's front door/);
  assert.match(all, /relink or retire/);
  // The whole point: never send the owner to the pass that cannot help.
  assert.match(all, /refresh-prices cannot help/);
}
{
  const some = describeDeadListings(44, 12, T0);
  assert.match(some, /12 of 44 listing\(s\) are gone/);
  assert.match(some, /the rest are still being read/);
}

// --- the Python mirror -----------------------------------------------------
// The price pass is written twice — run_prices in scraper/scrape.py (the
// nightly that actually crawls, with a real browser) and refreshPrices in
// src/lib/import/prices.ts (the Vercel cron and refresh-prices-ci). prices.ts
// imports this module; scrape.py cannot, so it mirrors it, and a fix to one
// half is only half a fix.
const scrapePy = readFileSync(join(REPO_ROOT, "scraper", "scrape.py"), "utf8");

const pyConst = (name) => {
  const m = scrapePy.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"));
  assert.ok(m, `scrape.py must define ${name}`);
  return m[1].trim();
};
assert.equal(
  pyConst("DEAD_LINK_STATUSES"),
  `(${DEAD_LINK_STATUSES.join(", ")})`,
  "scrape.py's DEAD_LINK_STATUSES must match link-health.mjs"
);
assert.equal(
  pyConst("DEAD_LINK_FAILURE_THRESHOLD"),
  String(DEAD_LINK_FAILURE_THRESHOLD),
  "scrape.py's DEAD_LINK_FAILURE_THRESHOLD must match link-health.mjs"
);
assert.equal(
  // Written as `24 * 14` on both sides so the intent (days) survives.
  eval(pyConst("DEAD_LINK_RECHECK_HOURS")),
  DEAD_LINK_RECHECK_HOURS,
  "scrape.py's DEAD_LINK_RECHECK_HOURS must match link-health.mjs"
);
assert.ok(
  /^DEAD_LINK = "DEAD_LINK"$/m.test(scrapePy),
  "scrape.py must define the DEAD_LINK sentinel"
);
assert.ok(
  /def next_link_health\(/.test(scrapePy),
  "scrape.py must mirror nextLinkHealth as next_link_health"
);
assert.ok(
  /def is_gone_redirect\(/.test(scrapePy),
  "scrape.py must mirror isGoneRedirect as is_gone_redirect"
);

// A 404 must return DEAD_LINK, not NO_BASE_KIT, in BOTH of scrape.py's price
// paths — Shopify (/products/*.json) and the generic WooCommerce/JSON-LD
// reader. About a fifth of the roster is not Shopify, and it was the non-
// Shopify half that went unnoticed the last three times. Each path answers the
// same way for a redirect to the front door, which is why there are four.
assert.equal(
  (scrapePy.match(/return DEAD_LINK\b/g) ?? []).length,
  4,
  "both of scrape.py's price paths must return DEAD_LINK on 404/410 AND on a " +
    "redirect to the storefront's front door"
);
// scrape.py picks ONE path per URL (shopify_price if /products/ is in it, else
// generic_price) with no fallback between them, so each has to read the final
// URL for itself. Both read it off the browser navigation, which is the HUMAN
// product page — the only URL whose front door means anything.
assert.equal(
  (scrapePy.match(/is_gone_redirect\(product_url,/g) ?? []).length,
  2,
  "both of scrape.py's price paths must judge the redirect on the product URL"
);
// The dead branch must NOT stamp priceSource: that stamp is what made a store
// whose pages were all removed read as "read, just not priced".
{
  const branch = scrapePy.slice(
    scrapePy.indexOf('if result == DEAD_LINK:'),
    scrapePy.indexOf('elif result == NO_BASE_KIT:')
  );
  assert.ok(branch.length > 0, "run_prices must have a DEAD_LINK branch");
  // The comment in that branch explains the stamp, so match the SQL itself.
  assert.ok(
    !/"priceSource" =/.test(branch),
    "the DEAD_LINK branch must not write priceSource — that is the mis-diagnosis"
  );
  assert.match(branch, /"deadSince" = %s/);
}
// The queue must back dead rows off rather than re-fetch them every six hours.
assert.match(
  scrapePy,
  /CASE WHEN vk\."deadSince" IS NOT NULL/,
  "fetch_price_candidates must give dead rows a slower cadence"
);

// --- the TypeScript half ---------------------------------------------------
const pricesTs = readFileSync(join(REPO_ROOT, "src", "lib", "import", "prices.ts"), "utf8");
assert.ok(
  /from "\.\.\/\.\.\/\.\.\/scripts\/lib\/link-health\.mjs"/.test(pricesTs),
  "prices.ts must import this module rather than restate the thresholds"
);
// Same two paths as scrape.py: fetchShopifyPrice and fetchJsonLdPrice.
assert.equal(
  (pricesTs.match(/\? DEAD_LINK : null/g) ?? []).length,
  2,
  "both of prices.ts's price paths must return DEAD_LINK on 404/410"
);
assert.ok(
  !/res\.status === 404 \|\| res\.status === 410/.test(pricesTs),
  "prices.ts must test dead statuses with isDeadLinkStatus, not a literal pair"
);
// The redirect verdict is taken on the HUMAN product page, never on the
// .json endpoint: a store that simply doesn't serve /products/*.json answers
// that request from its front door too, and it is very much alive. Unlike
// scrape.py, this half falls through from fetchShopifyPrice to fetchJsonLdPrice,
// so one check on the product URL covers Shopify and non-Shopify alike.
assert.ok(
  /if \(isGoneRedirect\(productUrl, res\.url\)\) return DEAD_LINK;/.test(pricesTs),
  "fetchJsonLdPrice must return DEAD_LINK when the product page redirects to a front door"
);
assert.ok(
  /if \(isGoneRedirect\(`\$\{clean\}\.json`, res\.url\)\) return null;/.test(pricesTs),
  "fetchShopifyPrice must fall through, not declare death, on a .json front door"
);
{
  const branch = pricesTs.slice(
    pricesTs.indexOf("if (priceData === DEAD_LINK) {"),
    pricesTs.indexOf("} else if (priceData === NO_BASE_KIT) {")
  );
  assert.ok(branch.length > 0, "refreshOne must have a DEAD_LINK branch");
  assert.ok(
    !/priceSource:/.test(branch),
    "the DEAD_LINK branch must not write priceSource — that is the mis-diagnosis"
  );
}
// Every write path records link health, including the plain-failure one: a
// store that redirects to its homepage never returns a status we can read, so
// the consecutive-failure count is the only evidence it leaves.
assert.equal(
  (pricesTs.match(/\.\.\.health\b/g) ?? []).length,
  4,
  "all four refreshOne outcomes must write the link-health columns"
);

// refreshPrices counts the dead answers separately from the failed ones, and
// the CI runner is where anyone ever sees that number: a run whose dead count
// jumps has just taken links off the site, while a failure count says almost
// nothing (most of them are blocks).
assert.match(
  readFileSync(join(REPO_ROOT, "scripts", "refresh-prices-ci.mjs"), "utf8"),
  /dead=\$\{result\.dead\}/,
  "refresh-prices-ci must report the dead count, not just failures"
);

// --- the site + the report -------------------------------------------------
const manufacturerTs = readFileSync(
  join(REPO_ROOT, "src", "lib", "import", "manufacturer-vendors.ts"),
  "utf8"
);
assert.ok(
  /deadSince: \{ not: null \}/.test(manufacturerTs),
  "PURCHASABLE_VENDOR_KIT_WHERE must refuse a listing the store answers 404 for"
);

const dbSetup = readFileSync(join(REPO_ROOT, "scripts", "db-setup.mjs"), "utf8");
assert.equal(
  (dbSetup.match(/await ensureLinkHealthColumns\(client\);/g) ?? []).length,
  2,
  "db-setup's main() must create the link-health columns on both paths"
);
// The report reads them, and the visible-listing count applies the same rule
// the site does — otherwise the audit and the set page disagree about what is
// published.
for (const [file, source] of [
  ["scripts/db-setup.mjs", dbSetup],
  [
    "scripts/vendor-publishing-audit.mjs",
    readFileSync(join(REPO_ROOT, "scripts", "vendor-publishing-audit.mjs"), "utf8"),
  ],
]) {
  assert.match(source, /AS dead_listings/, `${file} must count dead listings`);
  assert.match(source, /deadestSince: r\.deadest_since/, `${file} must pass deadestSince`);
  assert.match(
    source,
    /AND NOT \(vk\."deadSince" IS NOT NULL AND vk\.price IS NULL\)/,
    `${file}'s visible-listing count must apply the site's dead-link rule`
  );
}

console.log("link-health checks passed");
