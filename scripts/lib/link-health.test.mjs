import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AWAITING_OWN_FIX_PRICE_SOURCES,
  DEAD_LINK_FAILURE_THRESHOLD,
  DEAD_LINK_RECHECK_HOURS,
  DEAD_LINK_STATUSES,
  UNDIAGNOSED_RECHECK_HOURS,
  PRICE_SOURCE_REFUSED,
  PRICE_SOURCE_UNPARSED,
  describeDeadListings,
  isAwaitingOwnFix,
  isBackedOff,
  isDeadLinkStatus,
  GONE_HOST_ERROR_MARKERS,
  APP_SHELL_MAX_TEXT,
  isClientRenderedShell,
  isGoneFrontPage,
  isGoneHostError,
  isGoneRedirect,
  isUnbuyableDeadLink,
  isUnresolvedHostError,
  UNRESOLVED_HOST_ERROR_MARKERS,
  pageFingerprint,
  isUndiagnosed,
  nextLinkHealth,
  recheckHoursFor,
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

// --- pageFingerprint / isGoneFrontPage -------------------------------------
// The fourth answer, and the only one with nothing in the response to give it
// away: 200, no redirect, host resolves. Measured against production on
// 2026-09-05, drop.com served all 32 of its tracked /buy/ links as the same
// 27,140-byte Corsair landing page its root returns, and captus.io and
// kingly-keys.xyz answered everything with the same 114-byte placeholder their
// front door serves. 34 rows, filed as "teach the parser this platform".
assert.equal(pageFingerprint("  <a>  x\n\ty </a>\n"), "<a> x y </a>");
// Idempotent, so a cached front-page fingerprint can be passed straight back in.
assert.equal(pageFingerprint(pageFingerprint(" a  b ")), pageFingerprint(" a  b "));
assert.equal(pageFingerprint(null), "");

const LANDING = "<html><head><title>Drop - Gaming Collaborations by Corsair</title></head></html>";
assert.equal(
  isGoneFrontPage(
    "https://drop.com/buy/drop-full-metal-gmk-mecha-01-r2",
    "https://drop.com/buy/drop-full-metal-gmk-mecha-01-r2",
    LANDING,
    LANDING
  ),
  true,
  "a catch-all rewrite: the product URL answers with the storefront's own front page"
);
// An http→https upgrade is the same page: a store that only ever answers on
// https must not escape the check by upgrading the vendor's stored http link.
assert.equal(
  isGoneFrontPage(
    "http://shop.example/buy/gmk-x",
    "https://shop.example/buy/gmk-x",
    LANDING,
    `\n  ${LANDING}  \n`
  ),
  true,
  "a scheme upgrade to the same path is still the same page"
);
// The controls, each probed live on 2026-09-05 and each of which MUST stay
// readable-but-unpriced rather than be hidden:
//   funkeys  a real product page ("GMK Monochrome") on a platform we can't read
//   mokbstore a 301 onto a renamed handle — a different page, so no verdict
//   hexkeyboards a hop onto /password — a locked shop, not a gone one
assert.equal(
  isGoneFrontPage(
    "https://groupbuy.funkeys.com.ua/gmk_monochrome",
    "https://groupbuy.funkeys.com.ua/gmk_monochrome",
    "<html><title>GMK Monochrome</title></html>",
    "<html><title>Групбай</title></html>"
  ),
  false,
  "a page that differs from the root is a real page on an unread platform"
);
assert.equal(
  isGoneFrontPage(
    "https://mokbstore.com/gb-mv-expo-gmk-cyl",
    "https://mokbstore.com/gmk-mv-expo-keycaps",
    LANDING,
    LANDING
  ),
  false,
  "a redirect onto another path says nothing about this listing, whatever the body"
);
assert.equal(
  isGoneFrontPage(
    "https://hexkeyboards.com/collections/group-buys/products/gmk-handarbeige",
    "https://hexkeyboards.com/password",
    LANDING,
    LANDING
  ),
  false,
  "a storefront password page is a locked shop, and a block may never hide a listing"
);
// A redirect to the ROOT is isGoneRedirect's verdict, reached before the body
// is ever fetched — this check must not claim it too.
assert.equal(
  isGoneFrontPage("https://kono.store/products/x", "https://kono.store/", LANDING, LANDING),
  false
);
// Several vendors carry a bare homepage as a listing URL; it matches the front
// page by definition and is a bad link, not a gone one.
assert.equal(
  isGoneFrontPage("https://mykeyboard.eu/", "https://mykeyboard.eu/", LANDING, LANDING),
  false
);
// A root we could not read tells us nothing, and neither does an empty page.
assert.equal(
  isGoneFrontPage("https://shop.example/products/x", "https://shop.example/products/x", LANDING, ""),
  false
);
assert.equal(
  isGoneFrontPage("https://shop.example/products/x", "https://shop.example/products/x", "", ""),
  false
);
// A different host is a different shop's front page, which proves nothing here.
assert.equal(
  isGoneFrontPage(
    "https://shop.example/products/x",
    "https://other.example/products/x",
    LANDING,
    LANDING
  ),
  false
);
assert.equal(isGoneFrontPage(null, null, LANDING, LANDING), false);
// Byte equality is the safety, and the store it protects is a LIVE one. A
// client-rendered shop serves one shell for every route, its root included, so
// body-equals-root is true of a live single-page app for the same reason it is
// true of a retired catch-all — no HTTP-level test separates them.
//
// #164 relied on such a shell differing by its per-request nonce, and this
// assertion was written that way. MEASURED FROM A RUNNER ON 2026-09-08, THAT IS
// FALSE: www.zfrontier.com serves its 20,939-byte shell from a cache, and two of
// three LIVE zFrontier listings came back byte-identical to the root and were
// called DEAD_LINK. The production database had begun recording it — every
// deadSince on a www.zfrontier.com row was written on or after #164 shipped, and
// the app never 404s (a nonsense hash answers 200 with the same shell), so no
// other rule could have written one. So the shape is recognised instead of
// gambled on, and the token case must hold either way.
assert.equal(
  isGoneFrontPage(
    "https://spa.example/app/mch/abc",
    "https://spa.example/app/mch/abc",
    '<html><body><div id="app"></div><script>window.t="a1b2c3"</script></body></html>',
    '<html><body><div id="app"></div><script>window.t="d4e5f6"</script></body></html>'
  ),
  false,
  "a live app shell carrying a per-request token must never be called gone"
);
const ZF_SHELL =
  "<html><head><title>zFrontier 装备前线</title></head><body>" +
  '<div id="app"></div>' +
  '<script src="https://b1.zfrontier.com/www/21/vendor.7a32b5a317f4388cb954.js"></script>' +
  "<script>window.csrf_token = '17888786538ebd95c83385cddbfaf6387dd7f349'</script>" +
  "</body></html>";
assert.equal(
  isGoneFrontPage(
    "https://www.zfrontier.com/app/mch/1xmjEGd2dQml",
    "https://www.zfrontier.com/app/mch/1xmjEGd2dQml",
    ZF_SHELL,
    ZF_SHELL
  ),
  false,
  "the SAME shell, served from cache to page and root alike, is still not a verdict"
);

// --- isClientRenderedShell -------------------------------------------------
// The three documents this has to keep apart, each measured live on 2026-09-08.
assert.equal(isClientRenderedShell(ZF_SHELL), true, "zfrontier: 14 chars of text, 6 bundles");
// drop.com's retirement page IS its content — 2,504 characters of Corsair
// landing copy — which is exactly what makes it evidence about the URL.
assert.equal(
  isClientRenderedShell(
    `<html><head><title>Drop - Gaming Collaborations by Corsair</title></head><body>` +
      `<script src="/_next/static/chunk.js"></script><p>${"Suit up for the carnage. ".repeat(20)}</p>` +
      `</body></html>`
  ),
  false,
  "a landing page that carries real copy is a page, however it was built"
);
// captus.io and kingly-keys.xyz answer every path with a 114-byte placeholder:
// no text AND no script coming to fill it in. Nothing is being rendered here —
// this is the whole of the store's answer, and #164's verdict stands.
assert.equal(
  isClientRenderedShell('<html><head><meta charset="utf-8"></head><body></body></html>'),
  false,
  "a scriptless placeholder is not a shell — nothing is coming to draw it"
);
assert.equal(isClientRenderedShell(""), false);
assert.equal(isClientRenderedShell(null), false);
// Script CONTENTS are instructions, not content: counting them would make the
// shell — which is almost entirely script — read as the wordiest page around.
assert.equal(
  isClientRenderedShell(
    '<html><body><script src="/app.js"></script><script>' +
      `var config = ${JSON.stringify({ blurb: "x".repeat(400) })};` +
      "</script></body></html>"
  ),
  true,
  "an inline blob of script does not make a shell into a page"
);
assert.ok(
  APP_SHELL_MAX_TEXT > 14 && APP_SHELL_MAX_TEXT < 2504,
  "the window has to clear zfrontier's title-only shell and stay under drop.com's copy"
);
// The other half of the pair: a page with plenty of text is judged on the body
// comparison as before, so drop.com keeps the verdict #164 shipped for it.
assert.equal(
  isGoneFrontPage(
    "https://drop.com/buy/drop-full-metal-gmk-mecha-01-r2",
    "https://drop.com/buy/drop-full-metal-gmk-mecha-01-r2",
    LANDING,
    LANDING
  ),
  true,
  "a text-carrying landing page served for a product URL is still gone"
);

// --- nextLinkHealth --------------------------------------------------------
const T0 = new Date("2026-08-01T00:00:00Z");
const T1 = new Date("2026-08-20T00:00:00Z");

// A read is a read. NO_BASE_KIT means the page loaded and carries only add-on
// kits — a legitimate listing, not a failure — so it clears the counters just
// like a price does. Counting it as a failure would flag every store whose GMK
// products are all extras.
// PRICE_REFUSED is a read too, and the one that used to be counted as a
// failure: the store served its product data and this site turned the number
// away (outside KIT_BOUNDS, or a currency the Currency table cannot convert).
// Charging that to the link demoted live, readable shops — norbauer.co quotes
// USD 230 against a USD ceiling of 225 — to the 14-day dead-link cadence.
for (const good of ["PRICED", "NO_BASE_KIT", "PRICE_REFUSED"]) {
  assert.deepEqual(
    nextLinkHealth({ linkFailures: 5, deadSince: T0 }, good, T1),
    { linkFailures: 0, deadSince: null },
    good
  );
}

// NO_PRODUCT_DATA is NOT a read for link health. The page came back 200 and the
// caller records what it learned, but a platform no parser knows and a bot
// check served as a 200 are indistinguishable from here — the exact reason
// linkFailures is a heuristic — so the row keeps counting failures.
assert.deepEqual(
  nextLinkHealth({ linkFailures: 2, deadSince: null }, "NO_PRODUCT_DATA", T1),
  { linkFailures: 3, deadSince: null }
);
// …and it never clears a deadSince already established, for the same reason
// UNREADABLE doesn't: only a successful READ heals that.
assert.deepEqual(
  nextLinkHealth({ linkFailures: 1, deadSince: T0 }, "NO_PRODUCT_DATA", T1),
  { linkFailures: 2, deadSince: T0 }
);

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
  // …the third, which produces no HTTP answer at all…
  assert.match(all, /host no longer resolves/);
  // …and the fourth, which produces a perfectly ordinary 200 on the URL itself.
  assert.match(all, /answered with the storefront's own front page/);
  assert.match(all, /relink or retire/);
  // The whole point: never send the owner to the pass that cannot help.
  assert.match(all, /refresh-prices cannot help/);
}
{
  const some = describeDeadListings(44, 12, T0);
  assert.match(some, /12 of 44 listing\(s\) are gone/);
  // A partial count states what the store said about THOSE rows and stops
  // there. It used to end "; the rest are still being read", which the count
  // cannot support and which was false about the vendors it mattered most for
  // — zfrontier-cn has one dead listing and 214 the parser cannot read, and was
  // reported as one broken link with 218 rows in hand. The caller adds the
  // diagnosis for the rows that are not dead; see publishingFailureReason.
  assert.doesNotMatch(some, /still being read/);
  assert.doesNotMatch(some, /the rest/);
  // The partial branch keeps the "relink or retire it" advice OUT: it is not
  // advice about this vendor, only about the dead fraction of it.
  assert.doesNotMatch(some, /relink or retire/);
}

// --- isGoneHostError -------------------------------------------------------
// The third answer, and the only one with no HTTP status: the host stopped
// resolving. fetch() hides the reason in `cause`, so a shop whose domain had
// lapsed left the identical residue a Cloudflare block leaves — and seven
// vendors, ~253 listings (mykeyboard.eu alone holds 206), sat in that state.
{
  // What undici actually throws: a bare TypeError with the reason in `cause`.
  const undiciDns = new TypeError("fetch failed");
  undiciDns.cause = Object.assign(new Error("getaddrinfo ENOTFOUND mykeyboard.eu"), {
    code: "ENOTFOUND",
  });
  assert.equal(isGoneHostError(undiciDns), true, "undici NXDOMAIN");

  // Node tries every address a host resolves to and aggregates the failures.
  const aggregated = new TypeError("fetch failed");
  aggregated.cause = Object.assign(new AggregateError([], ""), {
    errors: [Object.assign(new Error("getaddrinfo ENOTFOUND letsgetit.io"), { code: "ENOTFOUND" })],
  });
  assert.equal(isGoneHostError(aggregated), true, "aggregated NXDOMAIN");

  // Chromium's spelling, i.e. what Playwright hands scrape.py.
  assert.equal(
    isGoneHostError(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://kono.store/x")),
    true,
    "Chromium NXDOMAIN"
  );
  // …and libc's, via a Python socket.gaierror relayed as text.
  assert.equal(
    isGoneHostError(new Error("[Errno -2] Name or service not known")),
    true,
    "gaierror NXDOMAIN"
  );
}
// Everything else is a host that EXISTS and would not talk to us. deadSince is
// the one signal allowed to take a listing off the site, so each of these must
// stay a block: EAI_AGAIN in particular is a temporary resolver failure — the
// sandbox this was written in answers every lookup with it — and counting it
// would retire the whole roster the first time our own DNS hiccupped.
for (const [label, err] of [
  ["EAI_AGAIN", Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } })],
  ["refused", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
  ["timeout", Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })],
  ["reset", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })],
  ["expired cert", Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })],
  ["abort", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })],
  ["blocked", new Error("net::ERR_CONNECTION_REFUSED")],
  ["nothing", null],
  ["empty", {}],
]) {
  assert.equal(isGoneHostError(err), false, `${label} is a block, not a dead host`);
}

// --- isUnresolvedHostError --------------------------------------------------
// The cheap question next door: did the request get an ADDRESS? It hides
// nothing — it only lets a run stop paying the full navigation timeout once per
// LISTING for a host that will not resolve. mykeyboard.eu holds 206 of them,
// its lookups take ~10s to end EAI_AGAIN, and refresh-prices is time-boxed to
// twelve minutes; the rows that budget crowds out are live listings, and an
// unpriced live listing is hidden outright on a released set.
{
  // Everything isGoneHostError calls gone is unresolved too — that is the
  // superset, and it is what lets the memo re-raise the ORIGINAL error and let
  // every row reach the verdict its own fetch would have reached.
  for (const marker of GONE_HOST_ERROR_MARKERS) {
    assert.ok(
      UNRESOLVED_HOST_ERROR_MARKERS.includes(marker),
      `${marker} must stay a resolution failure as well as a dead host`
    );
  }
  const nxdomain = new TypeError("fetch failed");
  nxdomain.cause = Object.assign(new Error("getaddrinfo ENOTFOUND mykeyboard.eu"), {
    code: "ENOTFOUND",
  });
  assert.equal(isUnresolvedHostError(nxdomain), true, "NXDOMAIN never resolved");

  // …and the one that is NOT a dead host, which is the whole reason this
  // question exists separately. The resolver declined to answer; the domain may
  // be perfectly alive, so this must stay false for isGoneHostError.
  const again = Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });
  assert.equal(isUnresolvedHostError(again), true, "EAI_AGAIN never resolved either");
  assert.equal(again && isGoneHostError(again), false, "EAI_AGAIN is still not a dead host");

  // Chromium's spelling, i.e. what Playwright hands scrape.py.
  assert.equal(
    isUnresolvedHostError(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/y")),
    true,
    "Chromium name failure"
  );
  assert.equal(
    isUnresolvedHostError(new Error("[Errno -3] Temporary failure in name resolution")),
    true,
    "gaierror EAI_AGAIN"
  );

  // A host that EXISTS must never be memoized: the connection reached a server
  // (or a certificate), so one slow or hostile page says nothing about the next
  // listing on the same store — and skipping the rest of a healthy store's rows
  // is exactly the failure this speed-up must not introduce.
  for (const [label, err] of [
    ["refused", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
    ["timeout", Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })],
    ["reset", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })],
    ["expired cert", Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })],
    ["incomplete chain", Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } })],
    ["abort", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })],
    ["nothing", null],
    ["empty", {}],
  ]) {
    assert.equal(
      isUnresolvedHostError(err),
      false,
      `${label} reached a host — the rest of its listings must still be fetched`
    );
  }
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
assert.ok(
  /def is_gone_host_error\(/.test(scrapePy),
  "scrape.py must mirror isGoneHostError as is_gone_host_error"
);
assert.ok(
  /def is_gone_front_page\(/.test(scrapePy),
  "scrape.py must mirror isGoneFrontPage as is_gone_front_page"
);
assert.ok(
  /def page_fingerprint\(/.test(scrapePy),
  "scrape.py must mirror pageFingerprint as page_fingerprint"
);
// The half that runs nightly has a browser, so its shells are rendered DOMs
// rather than bootstrap markup — but it reads the storefront root the same way
// (see _front_page_html below), so an app-rendered store can hand it two equal
// documents just as it does the TS half. A copy that drops this check retires
// live listings on exactly the stores the other copy protects.
assert.ok(
  /def is_client_rendered_shell\(/.test(scrapePy),
  "scrape.py must mirror isClientRenderedShell as is_client_rendered_shell"
);
assert.ok(
  /def rendered_text\(/.test(scrapePy),
  "scrape.py must mirror renderedText as rendered_text"
);
assert.equal(
  Number(pyConst("APP_SHELL_MAX_TEXT")),
  APP_SHELL_MAX_TEXT,
  "scrape.py's APP_SHELL_MAX_TEXT must match link-health.mjs"
);
// Both halves must ASK, not merely define it: the whole failure was a rule that
// looked right and hid a live shop's listings on one of the two paths.
assert.equal(
  (scrapePy.match(/(?<!def )is_client_rendered_shell\(/g) ?? []).length,
  1,
  "scrape.py's front-page comparison must refuse a client-rendered shell"
);
// The comparison is only meaningful between two documents fetched the SAME way:
// a browser-rendered DOM and Scrapling's raw markup are different documents for
// the same page, so a mismatched pair could never be equal and the check would
// silently do nothing.
assert.ok(
  /def _front_page_html\(/.test(scrapePy),
  "scrape.py must fetch the storefront root the same way it fetched the product page"
);
// The marker list decides which network failures may hide a listing, so the two
// copies drifting is the whole hazard: one half retiring a store the other half
// keeps re-fetching, and neither summary looking wrong.
{
  const m = scrapePy.match(/^GONE_HOST_ERROR_MARKERS = \(([\s\S]*?)\)$/m);
  assert.ok(m, "scrape.py must define GONE_HOST_ERROR_MARKERS");
  const pyMarkers = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(
    pyMarkers,
    GONE_HOST_ERROR_MARKERS,
    "scrape.py's GONE_HOST_ERROR_MARKERS must match link-health.mjs"
  );
  // The exclusions carry the safety, so name them: a temporary resolver
  // failure must never read as a domain that no longer exists.
  for (const notGone of ["EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "CERT_"]) {
    assert.ok(
      !GONE_HOST_ERROR_MARKERS.some((marker) => marker.includes(notGone)),
      `${notGone} is a block, and a block may never hide a listing`
    );
  }
}

// The resolution-failure list is mirrored too, and it is the one place EAI_AGAIN
// is allowed to appear — so a drift here is a half that either keeps paying the
// timeout per row, or (far worse) starts treating one as a verdict.
{
  const m = scrapePy.match(
    /^UNRESOLVED_HOST_ERROR_MARKERS = GONE_HOST_ERROR_MARKERS \+ \(([\s\S]*?)\)$/m
  );
  assert.ok(m, "scrape.py must define UNRESOLVED_HOST_ERROR_MARKERS off the gone list");
  const extra = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(
    [...GONE_HOST_ERROR_MARKERS, ...extra],
    UNRESOLVED_HOST_ERROR_MARKERS,
    "scrape.py's UNRESOLVED_HOST_ERROR_MARKERS must match link-health.mjs"
  );
  assert.ok(
    /def is_unresolved_host_error\(/.test(scrapePy),
    "scrape.py must mirror isUnresolvedHostError as is_unresolved_host_error"
  );
}

// scrape.py must actually CONSULT the memo, and must record into it.
// Remembering without consulting is a no-op; consulting without remembering can
// never fire. It asks before it navigates and records in the except block that
// already exists, so the row's verdict is unchanged either way. (prices.ts's
// half of the same pair is asserted below, once that file is read.)
{
  assert.ok(
    /_UNRESOLVED_HOSTS: dict\[str, Exception\] = \{\}/.test(scrapePy),
    "scrape.py must mirror the per-host memo"
  );
  assert.equal(
    (scrapePy.match(/raise_if_host_unresolved\(product_url\)/g) ?? []).length,
    2,
    "both of scrape.py's price paths must consult the memo before navigating"
  );
  assert.equal(
    (scrapePy.match(/remember_unresolved_host\(product_url, exc\)/g) ?? []).length,
    2,
    "both of scrape.py's price paths must record a resolver failure"
  );
  assert.ok(
    /_UNRESOLVED_HOSTS\.clear\(\)/.test(scrapePy),
    "run_prices must clear the memo at the start of each run"
  );
}

// A 404 must return DEAD_LINK, not NO_BASE_KIT, in BOTH of scrape.py's price
// paths — Shopify (/products/*.json) and the generic WooCommerce/JSON-LD
// reader. About a fifth of the roster is not Shopify, and it was the non-
// Shopify half that went unnoticed the last three times. Each path answers the
// same way for a redirect to the front door, which is why there are four.
assert.equal(
  (scrapePy.match(/return DEAD_LINK\b/g) ?? []).length,
  7,
  "both of scrape.py's price paths must return DEAD_LINK on 404/410, on a " +
    "redirect to the storefront's front door, AND on a host that no longer " +
    "resolves — plus the generic reader's fourth answer, a catch-all rewrite " +
    "that serves the storefront's front page for the URL itself"
);
// The front-page comparison lives in the reader that has a PAGE to compare:
// scrape.py picks one path per URL and the Shopify half reads JSON endpoints,
// never the rendered product page. The TS half — the one that runs four times a
// day — falls through to this same reader for every URL shape, so no listing
// depends on the Python Shopify path learning it.
assert.equal(
  (scrapePy.match(/(?<!def )is_gone_front_page\(/g) ?? []).length,
  1,
  "scrape.py's generic reader must judge an unreadable 200 for a catch-all rewrite"
);
// The third answer, in both paths. scrape.py picks ONE path per URL, so a half
// that cannot recognise NXDOMAIN keeps re-fetching a domain that is gone.
assert.equal(
  // Call sites, not the definition.
  (scrapePy.match(/(?<!def )is_gone_host_error\(/g) ?? []).length,
  2,
  "both of scrape.py's price paths must judge a failed navigation for NXDOMAIN"
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
    scrapePy.indexOf('elif result in (PRICE_REFUSED, NO_PRODUCT_DATA):')
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
  /WHEN vk\."deadSince" IS NOT NULL\s*\n\s*OR coalesce\(vk\."linkFailures", 0\) >= %s/,
  "fetch_price_candidates must give dead rows a slower cadence"
);
// …and a row it has reached no verdict about must NOT wait the full fortnight.
// That arm is what lets a newly-shipped diagnosis reach the rows it was written
// for: without it #156's dead-host check could not run against a single one of
// the seven vendors it was for, because all of them had been parked the day
// before it landed. The undiagnosed arm has to come FIRST in the CASE — SQL
// takes the first matching WHEN, and an undiagnosed row also satisfies the
// linkFailures test in the arm below it.
// …and that arm has to carry BOTH cases the short cadence is for: no verdict at
// all, and a verdict that only a change here can end. Naming just the first is
// what left #164 parked against every listing it was written for.
assert.match(
  scrapePy,
  /CASE\s*\n\s*WHEN vk\."deadSince" IS NULL\s*\n\s*AND \(vk\."priceSource" IS NULL\s*\n\s*OR vk\."priceSource" = ANY\(%s\)\)\s*\n\s*AND coalesce\(vk\."linkFailures", 0\) >= %s/,
  "fetch_price_candidates must check the undiagnosed cadence before the dead one"
);
assert.equal(
  eval(pyConst("UNDIAGNOSED_RECHECK_HOURS")),
  UNDIAGNOSED_RECHECK_HOURS,
  "scrape.py's UNDIAGNOSED_RECHECK_HOURS must match link-health.mjs"
);
// The ANY() above is only that arm if it is handed the same two marks. A tuple
// with SCRAPED in it would put every read row on the daily cadence and undo the
// back-off; one missing UNPARSED reopens the bug this arm exists to close.
{
  const pyList = pyConst("AWAITING_OWN_FIX_PRICE_SOURCES");
  const pyMarks = [...pyList.matchAll(/PRICE_SOURCE_(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(
    pyMarks,
    AWAITING_OWN_FIX_PRICE_SOURCES.map((mark) => mark.toUpperCase()),
    "scrape.py's AWAITING_OWN_FIX_PRICE_SOURCES must match link-health.mjs"
  );
  assert.match(
    scrapePy,
    /list\(AWAITING_OWN_FIX_PRICE_SOURCES\),/,
    "fetch_price_candidates must pass the marks to its ANY() placeholder"
  );
}
// The shorter window is only worth having if it is shorter — and only worth
// bounding if it is still slower than the normal cadence it backed off from.
assert.ok(
  UNDIAGNOSED_RECHECK_HOURS < DEAD_LINK_RECHECK_HOURS,
  "an undiagnosed row must be rechecked sooner than one with a verdict"
);

// --- isUndiagnosed / recheckHoursFor ---------------------------------------
// deadSince and priceSource are both verdicts; either one ends the short
// cadence. All three priceSource marks count — SCRAPED, REFUSED and UNPARSED
// each record something the pass learned about the row.
assert.equal(isUndiagnosed({ deadSince: null, priceSource: null }), true);
assert.equal(isUndiagnosed({ deadSince: T0, priceSource: null }), false);
for (const mark of ["SCRAPED", PRICE_SOURCE_REFUSED, PRICE_SOURCE_UNPARSED]) {
  assert.equal(
    isUndiagnosed({ deadSince: null, priceSource: mark }),
    false,
    `${mark} is a verdict, so the row is diagnosed`
  );
}
assert.equal(
  recheckHoursFor({ deadSince: null, priceSource: null }),
  UNDIAGNOSED_RECHECK_HOURS
);
assert.equal(recheckHoursFor({ deadSince: T0 }), DEAD_LINK_RECHECK_HOURS);
assert.equal(
  recheckHoursFor({ priceSource: "SCRAPED" }),
  DEAD_LINK_RECHECK_HOURS
);

// --- isAwaitingOwnFix ------------------------------------------------------
// REFUSED and UNPARSED are verdicts, so isUndiagnosed is false for them — but
// what they record is OUR inability to store the page's number, never the
// store's answer, so the fortnight buys nothing and freezes the row against the
// only thing that can end it. #164 shipped isGoneFrontPage for drop.com,
// captus.io and kingly-keys.xyz and every one of those 34 rows was already
// stamped UNPARSED with eight failures — parked until 2026-09-18 against the
// listings it was written for, which is #156's failure repeated exactly.
assert.deepEqual(AWAITING_OWN_FIX_PRICE_SOURCES, [
  PRICE_SOURCE_REFUSED,
  PRICE_SOURCE_UNPARSED,
]);
assert.ok(
  !AWAITING_OWN_FIX_PRICE_SOURCES.includes("SCRAPED"),
  "SCRAPED is the store's answer read and understood — it keeps the fortnight"
);
for (const mark of AWAITING_OWN_FIX_PRICE_SOURCES) {
  assert.equal(isAwaitingOwnFix({ deadSince: null, priceSource: mark }), true);
  assert.equal(
    recheckHoursFor({ deadSince: null, priceSource: mark }),
    UNDIAGNOSED_RECHECK_HOURS,
    `${mark} names a repair in this repo, so the row must not wait a fortnight`
  );
  // deadSince outranks it: the store answering "gone" IS knowledge about the
  // store, whatever a later unparseable fetch stamped on top of it. UNPARSED
  // preserves deadSince (nextLinkHealth), so this pair really does occur.
  assert.equal(isAwaitingOwnFix({ deadSince: T0, priceSource: mark }), false);
  assert.equal(
    recheckHoursFor({ deadSince: T0, priceSource: mark }),
    DEAD_LINK_RECHECK_HOURS,
    `deadSince must outrank ${mark}`
  );
}
assert.equal(isAwaitingOwnFix({ deadSince: null, priceSource: null }), false);
assert.equal(isAwaitingOwnFix({ deadSince: null, priceSource: "SCRAPED" }), false);
assert.equal(isAwaitingOwnFix(undefined), false);

// --- the TypeScript half ---------------------------------------------------
const pricesTs = readFileSync(join(REPO_ROOT, "src", "lib", "import", "prices.ts"), "utf8");
assert.ok(
  /from "\.\.\/\.\.\/\.\.\/scripts\/lib\/link-health\.mjs"/.test(pricesTs),
  "prices.ts must import this module rather than restate the thresholds"
);
// The half that actually runs must carry the undiagnosed cadence too. Without
// it a diagnosis shipped here reaches the nightly and never the six-hourly CI
// run, which is the one that visits most rows — half a fix, again.
assert.ok(
  /UNDIAGNOSED_RECHECK_HOURS/.test(pricesTs),
  "prices.ts must give an undiagnosed backed-off row the shorter cadence"
);
assert.ok(
  /const undiagnosedCutoff =\s*\n\s*maxAgeHours <= 0\s*\n\s*\? cutoff/.test(pricesTs),
  "FORCE_PRICE_REFRESH must override the undiagnosed cadence like the dead one"
);
// The two backed-off arms must be disjoint on the verdict columns, or the
// fortnight arm also matches a short-cadence row and Prisma's OR lets it back
// in on the slow cadence — the bug this split exists to close.
//
// The short arm carries BOTH cases: no verdict at all, and a verdict only a
// change here can end. The fortnight arm has to exclude the second explicitly —
// `priceSource: { not: null }` is true of an UNPARSED row, which is how #164
// shipped parked against every listing it was written for.
assert.ok(
  /\{ deadSince: null \},\s*\n\s*\{\s*\n\s*OR: \[\s*\n\s*\{ priceSource: null \},\s*\n\s*\{ priceSource: \{ in: AWAITING_OWN_FIX_PRICE_SOURCES \} \},\s*\n\s*\],\s*\n\s*\},\s*\n\s*\{ linkFailures: \{ gte: DEAD_LINK_FAILURE_THRESHOLD \} \},\s*\n\s*\{ priceUpdatedAt: \{ lt: undiagnosedCutoff \} \},/.test(
    pricesTs
  ),
  "the short arm must take no deadSince and either no priceSource or an own-fix one"
);
assert.ok(
  /\{ deadSince: \{ not: null \} \},\s*\n\s*\{ priceSource: \{ not: null \} \},\s*\n\s*\],\s*\n\s*\},/.test(
    pricesTs
  ),
  "the fortnight arm must require a verdict (deadSince or priceSource)"
);
assert.ok(
  /\{ deadSince: \{ not: null \} \},\s*\n\s*\{ priceSource: \{ notIn: AWAITING_OWN_FIX_PRICE_SOURCES \} \},/.test(
    pricesTs
  ),
  "the fortnight arm must require the verdict to be the STORE's, not ours"
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
// A host that no longer resolves throws before any of that, in whichever path
// fetches first. The verdict is taken in the same place as the front-door one
// — the JSON-LD reader, which fetches the human product page — so the Shopify
// half stays a pure fall-through here too.
assert.ok(
  /if \(isGoneHostError\(err\)\) return DEAD_LINK;/.test(pricesTs),
  "fetchJsonLdPrice must answer DEAD_LINK when the host does not resolve"
);
assert.equal(
  (pricesTs.match(/isGoneHostError\(/g) ?? []).length,
  1,
  "only the human-product-page path may declare a host gone"
);
// The TypeScript half of the memo pair. It lives in fetchWithTimeout, so every
// fetch a row makes — the Shopify JSON, the page, /meta.json, the storefront
// root — is covered by one guard rather than four.
{
  assert.ok(
    /const hostResolution = new Map<string, unknown>\(\);/.test(pricesTs),
    "prices.ts must memoize the resolver error per host"
  );
  assert.ok(
    /const settled = host === null \? null : hostResolution\.get\(host\);\s*\n\s*if \(settled\) throw settled;/.test(
      pricesTs
    ),
    "fetchWithTimeout must re-raise the memoized error instead of re-fetching"
  );
  assert.ok(
    /if \(host !== null\) await settleHostResolution\(host, err\);/.test(pricesTs),
    "fetchWithTimeout must settle the host after a failed fetch"
  );
  // The subtle half. FETCH_TIMEOUT_MS is 6s and a lame domain takes ~10s to
  // answer EAI_AGAIN, so the abort fires FIRST and all the pass ever catches is
  // an AbortError. Inferring "unresolvable" from that would be wrong in the
  // dangerous direction — a slow page on a healthy store looks identical — so
  // the resolver has to be asked outright, and only its answer may memoize.
  assert.ok(
    /async function hostResolutionFailure\(host: string\): Promise<unknown> \{/.test(pricesTs),
    "prices.ts must ask the resolver directly, not infer a dead name from a timeout"
  );
  assert.ok(
    /return isUnresolvedHostError\(err\) \? err : null;/.test(pricesTs),
    "only the resolver's own no-address answer may short-circuit a host"
  );
  // Claimed before the probe, so eight lanes ask once and a host that resolves
  // is never asked about twice.
  assert.ok(
    /hostResolution\.set\(host, null\);/.test(pricesTs),
    "settleHostResolution must claim the host before probing it"
  );
  // Per run. The module outlives one invocation in CI and on Vercel, so a
  // domain that comes back must not stay memoized as unreachable for ever.
  assert.ok(
    /hostResolution\.clear\(\);/.test(pricesTs),
    "refreshPrices must clear the memo at the start of each run"
  );
}
{
  const branch = pricesTs.slice(
    pricesTs.indexOf("if (priceData === DEAD_LINK) {"),
    pricesTs.indexOf("} else if (priceData === PRICE_REFUSED")
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
  5,
  "all five refreshOne outcomes must write the link-health columns"
);

// --- read, and still no price: the two answers that were hiding in null -----
// A page can be fetched, parsed and understood and still leave the row
// unpriced because THIS side refused the number or could not read the page's
// platform. Both used to answer null — the same answer a Cloudflare block
// gives — so priceSource stayed NULL, the row never counted as read, and the
// publishing report told the owner to relink or retire a live, readable shop.
assert.ok(
  /export const PRICE_REFUSED = "PRICE_REFUSED"/.test(pricesTs) &&
    /export const NO_PRODUCT_DATA = "NO_PRODUCT_DATA"/.test(pricesTs),
  "prices.ts must answer a refusal and an unreadable page apart from null"
);
// The refusals: an unconvertible currency and a price outside KIT_BOUNDS, in
// the Shopify path, the WooCommerce path and the JSON-LD/OpenGraph path.
assert.ok(
  (pricesTs.match(/return PRICE_REFUSED;/g) ?? []).length >= 5,
  "every currency/plausibility refusal must answer PRICE_REFUSED, not null"
);
assert.ok(
  !/if \(!isPlausibleBaseKitPrice\([^)]*\)\) \{?\s*return null/.test(pricesTs),
  "a price this site refuses is a READ — it must never answer null"
);
// Neither answer may clear a stored price: the refusal is about the number just
// read, and a page with no markup says nothing about the last good one.
{
  const branch = pricesTs.slice(
    pricesTs.indexOf("} else if (priceData === PRICE_REFUSED"),
    pricesTs.indexOf("} else if (priceData === NO_BASE_KIT) {")
  );
  assert.ok(branch.length > 0, "refreshOne must have a refused/unparsed branch");
  assert.ok(
    !/price: null/.test(branch),
    "the refused/unparsed branch must not clear the stored price"
  );
  assert.match(branch, /priceSource:/);
  assert.match(branch, /\.\.\.health/);
}
// scrape.py mirrors both sentinels and both priceSource marks.
for (const name of ["PRICE_REFUSED", "NO_PRODUCT_DATA"]) {
  assert.ok(
    new RegExp(`^${name} = "${name}"$`, "m").test(scrapePy),
    `scrape.py must mirror the ${name} sentinel`
  );
}
assert.equal(
  pyConst("PRICE_SOURCE_REFUSED"),
  `"${PRICE_SOURCE_REFUSED}"`,
  "scrape.py's REFUSED priceSource mark must match link-health.mjs"
);
assert.equal(
  pyConst("PRICE_SOURCE_UNPARSED"),
  `"${PRICE_SOURCE_UNPARSED}"`,
  "scrape.py's UNPARSED priceSource mark must match link-health.mjs"
);
// Both of scrape.py's price paths refuse rather than go quiet: the Shopify
// path (unsupported currency + implausible price) and the generic path
// (unsupported currency + implausible Woo variant + implausible JSON-LD
// offer). The non-Shopify half is the one that keeps getting missed.
assert.ok(
  (scrapePy.match(/return PRICE_REFUSED\b/g) ?? []).length >= 5,
  "both of scrape.py's price paths must answer PRICE_REFUSED on a refusal"
);
assert.ok(
  /return NO_PRODUCT_DATA\b/.test(scrapePy),
  "scrape.py's generic path must answer NO_PRODUCT_DATA for a 200 with no markup"
);

// refreshPrices counts the dead answers separately from the failed ones, and
// the CI runner is where anyone ever sees that number: a run whose dead count
// jumps has just taken links off the site, while a failure count says almost
// nothing (most of them are blocks). The refused/unparsed counts are there for
// the opposite reason — they are the listings no further scrape can rescue.
{
  const ci = readFileSync(join(REPO_ROOT, "scripts", "refresh-prices-ci.mjs"), "utf8");
  assert.match(ci, /dead=\$\{result\.dead\}/, "refresh-prices-ci must report the dead count");
  assert.match(
    ci,
    /refused=\$\{result\.refused\}/,
    "refresh-prices-ci must report the refused count"
  );
  assert.match(
    ci,
    /unparsed=\$\{result\.unparsed\}/,
    "refresh-prices-ci must report the unparsed count"
  );
}

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
