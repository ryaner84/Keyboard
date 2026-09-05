// A vendor listing whose page is GONE, told apart from one that simply has no
// base kit on offer — and backed off so it stops eating the price budget.
//
// Both price passes used to collapse those two into one answer. `shopify_price`
// (scrape.py) and `fetchShopifyPrice` (prices.ts) return the NO_BASE_KIT
// sentinel on a 404/410, and the caller writes `priceSource = 'SCRAPED'` for it
// — the same stamp a live page with only subkits gets. So a store that had
// simply removed the product read as "the price pass looked and there was
// nothing to price", which is the pricing-backlog diagnosis, and the publishing
// report sent the owner to `refresh-prices`: the one pass that can never end it.
// Measured against production, that mislabelled most of the silent stores —
// monokei (44 listings read, 0 priced), vala-supply (19/0), mechs-co (33/0) and
// apex-keyboards (19/0) all read as a backlog while every sampled product page
// was in fact gone.
//
// It is not only a reporting problem. Only a 404/410 clears a price, and a
// store that closed (kono.store), moved domain (apexkeyboards.ca → .com), was
// acquired (ashkeebs.com now serves kineticlabs.com), password-locked its
// Shopify (hexkeyboards.com) or let its plan lapse (402) answers with a
// redirect / 401 / 402 / 5xx / DNS failure instead. Neither pass ever recorded
// that, so those rows were re-fetched every six hours forever. The price run is
// time-boxed, so several hundred permanently-dead rows crowd out live listings
// — and an unpriced live listing is hidden outright on a RELEASED set. Dead
// links were costing the site real published listings.
//
// And the commonest of those answers is not a status at all. A store that has
// removed a product usually REDIRECTS to its own front door, and an acquired
// one redirects its whole domain to the buyer's — fetch() follows both without
// a word, so all the price pass ever saw was a 200 on a page that is not the
// listing. isGoneRedirect below is that answer, read off the final URL.
//
// And a store can say it with no redirect at all. drop.com (acquired by
// Corsair) serves its Corsair landing page for every /buy/<slug> path, 200, URL
// unchanged; captus.io and kingly-keys.xyz answer every path with the 114-byte
// placeholder their front door serves. Nothing in the response says so — the
// rewrite is server-side, so there is no Location header, the status is 200 and
// the host resolves — and the page carries no product markup, so all three
// checks above pass it through as "an unreadable platform" and the report asks
// the owner to teach the parser a store that no longer exists. isGoneFrontPage
// is that answer, read off the BODY: the store's reply to this URL was its own
// front page.
//
// Two columns carry the evidence, and they mean different things on purpose:
//
//   deadSince     the store itself said the page is not there — a 404/410, or
//                 a redirect to its front door. Definitive, so it is the only
//                 signal allowed to take a link off the site.
//   linkFailures  consecutive attempts that produced no readable page, for any
//                 reason. A heuristic — a store that blocks the runner for a
//                 week looks identical to one that shut down — so it may slow a
//                 row down and name it in the report, never hide it.
//
// Both reset on any successful READ, priced or not, so a store that comes back
// heals itself on the first check that gets through.
//
// This module is the single definition, imported by the TS price pass and by
// db-setup/the audit. `scrape.py` mirrors it (it cannot import JavaScript) and
// `npm run test:link-health` fails if the two copies disagree.

/** HTTP statuses that mean the listing is gone, not blocked. */
export const DEAD_LINK_STATUSES = [404, 410];

/**
 * Consecutive unreadable attempts before a link is treated as dead enough to
 * back off. The nightly pass gets one attempt per row per run, so six is about
 * a week of "this never once answered" — long enough that a Cloudflare block or
 * a bad night cannot reach it, short enough that a closed store stops costing
 * the run within days.
 */
export const DEAD_LINK_FAILURE_THRESHOLD = 6;

/**
 * How long a backed-off row waits between attempts, in hours. It is a back-off,
 * never a retirement: the row keeps its place in the queue and one successful
 * read restores the normal cadence, so a store that returns needs no
 * intervention. Fourteen days is ~56 attempts saved per dead row per fortnight.
 */
export const DEAD_LINK_RECHECK_HOURS = 24 * 14;

/**
 * How long a backed-off row waits when the pass has reached NO VERDICT about it
 * at all — six unreadable attempts and still no `deadSince` and no
 * `priceSource`.
 *
 * The fortnight above is priced against knowledge: a row the store 404'd, or one
 * the pass has read and understood, will say the same thing tomorrow, so waiting
 * costs nothing. A row in neither state is the opposite case — six attempts have
 * produced no fact whatsoever — and parking it for a fortnight has a cost the
 * other two do not: it freezes the row against every IMPROVEMENT in diagnosis.
 *
 * That is not hypothetical. `isGoneHostError` (#156) shipped on 2026-08-30 to
 * answer DEAD_LINK for a host that no longer resolves. By then all seven of the
 * vendors it was written for had already hit DEAD_LINK_FAILURE_THRESHOLD and
 * been parked until 2026-09-13, so the check never ran against a single one of
 * the ~253 listings it was for. Four days of publishing audits printed the
 * pre-fix sentence — "the price pass has never read one — the store's links are
 * dead; relink or retire it" — about mykeyboard.eu (206 rows) and six others,
 * and about eight more stores that answer perfectly well (rationalkeys.com.tr
 * serves JSON-LD Product; thicthock, zionstudios.ph and alphakeys.ca were
 * blocking, not gone). A verdict shipped is worth nothing until it reaches its
 * rows, and only FORCE_PRICE_REFRESH — a person, by hand, who happens to know —
 * could make that happen.
 *
 * A day is the compromise: still four-fifths of what the back-off was for (one
 * attempt a day instead of four), and short enough that any diagnosis this
 * codebase learns reaches every undiagnosed row on the next nightly run rather
 * than a fortnight later. The moment a verdict does land — dead, read, refused
 * or unparsed — the row leaves this cadence for one of the other two by itself.
 */
export const UNDIAGNOSED_RECHECK_HOURS = 24;

/**
 * What `VendorKit.priceSource` records once the pass has READ a page.
 *
 * 'SCRAPED' used to be the only mark, so every read collapsed into one fact and
 * the publishing report had one sentence for four different repairs. These two
 * split off the reads that produce no price for a reason that is OURS, not the
 * store's:
 *
 *   REFUSED   the product data parsed and the number was rejected by this
 *             site's own rules (KIT_BOUNDS, the Currency table). The store is
 *             live, readable and selling the set — widening the window or
 *             adding the currency is the repair, and re-running the price pass
 *             a thousand times is not.
 *   UNPARSED  the page answered 200 and carries no product markup any parser
 *             path knows. Teaching the parser that platform is the repair.
 *
 * Everything that checks priceSource elsewhere compares against 'MANUAL', so
 * these behave exactly like 'SCRAPED' to the rest of the codebase: never
 * overwritten by hand, always re-priceable.
 */
export const PRICE_SOURCE_REFUSED = "REFUSED";
export const PRICE_SOURCE_UNPARSED = "UNPARSED";

/** True for a status that means the page is gone rather than unavailable. */
export function isDeadLinkStatus(status) {
  return DEAD_LINK_STATUSES.includes(Number(status));
}

/** A URL whose path is the site root — the storefront's front door. */
function isFrontDoor(url) {
  return url.pathname.replace(/\/+$/, "") === "";
}

function parseUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

/**
 * True when a request for `requestUrl` was answered by a FRONT DOOR — the site
 * root, on this host or another one.
 *
 * This is the other way a store says "gone", and measured against production it
 * is the commonest one. Shopify sends a deleted product to `/` rather than
 * 404ing it (kono.store does that for all 44 of its tracked listings); an
 * acquired shop 301s its entire domain to the buyer's home page (ashkeebs.com →
 * kineticlabs.com, 38 listings). Both are silent: fetch() follows the hop and
 * hands back a 200, so the price pass filed the row as "blocked, try later" and
 * re-fetched it every six hours for ever, because only a 404/410 clears a
 * price. The store did answer, and its answer was that this URL is not a page
 * here — as definitive as a 404, and the same repair (relink or retire).
 *
 * Deliberately narrow. Only the ROOT counts: a redirect onto another product (a
 * renamed handle) or onto a collection says nothing about this listing, and a
 * request that STARTED at the root — several vendors carry a bare homepage as a
 * listing URL — was not redirected off anything. It also stays self-healing,
 * because nextLinkHealth clears deadSince on the first read that gets through:
 * a store redirecting to its front door for a maintenance window costs a
 * fortnight of slow cadence, never a retirement.
 */
export function isGoneRedirect(requestUrl, finalUrl) {
  const from = parseUrl(requestUrl);
  const to = parseUrl(finalUrl);
  if (!from || !to) return false;
  if (isFrontDoor(from)) return false;
  return isFrontDoor(to);
}

/**
 * The whitespace-normalized body of a page, for front-page comparison.
 *
 * Idempotent, so a caller may cache the fingerprint of a storefront's front
 * page and hand it straight back to isGoneFrontPage without the module needing
 * two entry points. Normalizing whitespace is all the tolerance there is on
 * purpose: two documents that differ by so much as a nonce are not "the same
 * page", and a false negative here costs nothing while a false positive hides
 * a live listing.
 */
export function pageFingerprint(html) {
  return String(html ?? "").replace(/\s+/g, " ").trim();
}

/**
 * True when a store answered THIS EXACT product URL with its own front page —
 * a soft 404, served 200, with no redirect to give it away.
 *
 * This is the fourth way a store says "gone", after the 404, the front-door
 * redirect and the host that stopped resolving, and it is invisible to all
 * three. `isDeadLinkStatus` sees a 200. `isGoneRedirect` reads the final URL,
 * which is still the product URL — the rewrite happens on the server, so there
 * is no Location header at all. `isGoneHostError` sees a host that resolves
 * perfectly. What the pass got back was a page with no product markup on it, so
 * the row was filed NO_PRODUCT_DATA, and the publishing report told the owner to
 * "teach the parser or retire it" about a shop that no longer exists.
 *
 * Measured against production on 2026-09-05, three vendors and 34 listings were
 * in that state. drop.com serves every /buy/<slug> — all 32 tracked listings —
 * as a byte-identical 27,140-byte "Drop - Gaming Collaborations by Corsair"
 * landing page, the same document its root returns. captus.io and
 * kingly-keys.xyz both answer every path with the same 114-byte placeholder
 * their front door serves.
 *
 * The rule is the one isGoneRedirect already states, read off the BODY instead
 * of the Location header: the store's answer to this URL was its front door. It
 * is deliberately as narrow as that phrasing:
 *
 *   • the request must not have STARTED at the root — several vendors carry a
 *     bare homepage as a listing URL, which would match itself trivially;
 *   • the store must have answered this page and not another, so the final URL
 *     has to name the same host and the same path (an http→https upgrade is
 *     fine — that is the same page). A hop onto /password or onto a renamed
 *     handle is somebody else's verdict, and a hop onto the root is already
 *     isGoneRedirect's;
 *   • both bodies must be non-empty, and equal after nothing but whitespace
 *     normalization.
 *
 * The caller adds the last condition, and it is the important one: this is only
 * ever asked about a page that yielded NO product markup. A page the parser
 * could read is never "gone" however much it resembles the front door, and
 * asking only on the no-markup path also means a healthy storefront never pays
 * for the extra front-page fetch.
 *
 * BYTE EQUALITY IS THE SAFETY, and the store it protects is a live one. A
 * client-rendered storefront serves ONE shell for every route, root included,
 * and fills the page in from JavaScript — so "the body equals the root's" is
 * true of a live single-page app for exactly the same reason it is true of a
 * retired catch-all, and no HTTP-level test separates them. What separates them
 * in practice is that a real app's shell is not static: zfrontier.com, whose
 * /app/ pages are 20,939 bytes and looked identical to its root on one probe,
 * carries a per-request token and fails this comparison on the next — and it is
 * a live shop, which run_zfrontier in scrape.py reads through its app API. That
 * is why the tolerance here is whitespace and nothing else. Loosening it to
 * ignore inline script contents would "fix" zfrontier by hiding the listings of
 * every live app-rendered store on the roster, which is the one failure this
 * module exists to prevent. A store whose retirement page varies per request is
 * left as NO_PRODUCT_DATA, which is merely the previous, safe answer.
 *
 * Self-healing like the other three: nextLinkHealth clears deadSince on the
 * first read that gets through, so a shop behind a maintenance splash for a day
 * costs a fortnight of slow cadence, never a retirement.
 */
export function isGoneFrontPage(requestUrl, finalUrl, pageBody, rootBody) {
  const from = parseUrl(requestUrl);
  const to = parseUrl(finalUrl);
  if (!from || !to) return false;
  if (isFrontDoor(from)) return false;
  // A redirect to the root is isGoneRedirect's answer, not this one.
  if (isFrontDoor(to)) return false;
  if (from.host !== to.host) return false;
  if (from.pathname.replace(/\/+$/, "") !== to.pathname.replace(/\/+$/, "")) return false;
  const page = pageFingerprint(pageBody);
  const root = pageFingerprint(rootBody);
  if (!page || !root) return false;
  return page === root;
}

/**
 * The network-level answers that mean the HOST itself is gone — NXDOMAIN, in
 * each of the three spellings this codebase can be handed one:
 *
 *   ENOTFOUND               Node/undici, from getaddrinfo (both price passes'
 *                           fetch(), and the probe)
 *   EAI_NONAME              the same failure surfaced by name rather than errno
 *   ERR_NAME_NOT_RESOLVED   Chromium, i.e. Playwright's page.goto in scrape.py
 *
 * plus the two libc strings a Python socket.gaierror carries.
 *
 * Nothing else belongs here, and the exclusions are the whole point:
 * EAI_AGAIN is a TEMPORARY resolver failure (SERVFAIL, our resolver, not their
 * domain), ECONNREFUSED / ETIMEDOUT / ECONNRESET are a host that exists and
 * would not talk to us, and a certificate error is a live site with a lapsed
 * cert. Every one of those is a block, and blocks may never hide a listing.
 */
export const GONE_HOST_ERROR_MARKERS = [
  "ENOTFOUND",
  "EAI_NONAME",
  "ERR_NAME_NOT_RESOLVED",
  "Name or service not known",
  "nodename nor servname",
];

/**
 * True when a fetch failed because the host does not exist.
 *
 * A domain that stopped resolving is the third way a store says "gone", after
 * the 404 and the front-door redirect — and the only one with no HTTP answer at
 * all, which is exactly why it was invisible. `fetch()` reports it as a bare
 * "TypeError: fetch failed" whose reason is buried in `cause`, so both price
 * passes filed a shop whose domain had lapsed under the same null a Cloudflare
 * block gives: never dead, never retired, re-fetched every six hours for ever,
 * and named in the publishing report as "the price pass has never read one",
 * which is a guess rather than a diagnosis. Measured against production, seven
 * vendors and ~253 listings were in that state — mykeyboard.eu alone holds 206.
 *
 * NXDOMAIN is as definitive as a 404: there is no server to ask. It is also
 * self-healing the same way — nextLinkHealth clears deadSince on the first read
 * that gets through — so a domain that comes back needs no intervention.
 */
export function isGoneHostError(err) {
  const seen = new Set();
  const stack = [err];
  const text = [];
  while (stack.length > 0 && seen.size < 20) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.code === "string") text.push(node.code);
    if (typeof node.message === "string") text.push(node.message);
    if (node.cause) stack.push(node.cause);
    // AggregateError (undici tries every address a host resolves to).
    if (Array.isArray(node.errors)) stack.push(...node.errors);
  }
  const joined = text.join("\n");
  return GONE_HOST_ERROR_MARKERS.some((marker) => joined.includes(marker));
}

/**
 * The link-health columns after one price attempt. Pure — the caller writes.
 *
 * `outcome` is one of:
 *   "PRICED"          a price was parsed
 *   "NO_BASE_KIT"     the page was READ and carries no base kit
 *   "PRICE_REFUSED"   the page was READ, its product data parsed, and the
 *                     number it quotes was refused by THIS SITE's rules —
 *                     outside the plausible base-kit window, or in a currency
 *                     the Currency table cannot convert
 *   "NO_PRODUCT_DATA" the page answered 200 and carries no product markup any
 *                     parser path knows (a storefront on a platform the pass
 *                     cannot read, a placeholder page, a bot-check served as
 *                     200)
 *   "GONE"            the store answered 404/410, or redirected to its front
 *                     door
 *   "UNREADABLE"      anything else: 401, 402, 5xx, a DNS failure, a timeout,
 *                     a block, a storefront password page
 *
 * PRICED, NO_BASE_KIT and PRICE_REFUSED are all successful reads. Treating
 * NO_BASE_KIT as a failure would flag every store that legitimately sells only
 * add-on kits, and treating PRICE_REFUSED as one flags a store that is live,
 * readable and quoting a real number the site simply won't store — which is a
 * fault on THIS side of the connection, never evidence about the link.
 *
 * NO_PRODUCT_DATA is deliberately NOT a read here. The page came back, so the
 * caller records what it learned (`priceSource`), but an unparseable 200 and a
 * bot-check page served with a 200 are indistinguishable from here — the same
 * reason linkFailures exists at all — so the row stays on the failure count and
 * earns the slow cadence like any other page that never yields a price.
 */
export function nextLinkHealth(current, outcome, now = new Date()) {
  const failures = Number(current?.linkFailures ?? 0) || 0;
  const deadSince = current?.deadSince ?? null;
  if (
    outcome === "PRICED" ||
    outcome === "NO_BASE_KIT" ||
    outcome === "PRICE_REFUSED"
  ) {
    return { linkFailures: 0, deadSince: null };
  }
  if (outcome === "GONE") {
    // Keep the FIRST moment it was seen gone: the report says how long the
    // store has been broken, which is what decides relink-or-retire.
    return { linkFailures: failures + 1, deadSince: deadSince ?? now };
  }
  return { linkFailures: failures + 1, deadSince };
}

/** True when the price queue should visit this row on the slow cadence. */
export function isBackedOff(row) {
  if (row?.deadSince) return true;
  return (Number(row?.linkFailures ?? 0) || 0) >= DEAD_LINK_FAILURE_THRESHOLD;
}

/**
 * True when a backed-off row carries no verdict of any kind.
 *
 * `deadSince` means the store answered "gone"; `priceSource` means the pass READ
 * the page (SCRAPED, REFUSED or UNPARSED all count — each records something the
 * pass learned). Neither means six attempts produced no fact at all, which is
 * the only state where waiting DEAD_LINK_RECHECK_HOURS buys nothing and costs
 * the row every diagnosis shipped in the meantime. See
 * UNDIAGNOSED_RECHECK_HOURS.
 *
 * Deliberately about the ROW's stored evidence, not about why it failed: the
 * pass cannot tell a Cloudflare block from a closed shop, which is the premise
 * `linkFailures` exists on. It only asks whether anything is known yet.
 */
export function isUndiagnosed(row) {
  return !row?.deadSince && !row?.priceSource;
}

/**
 * Hours a backed-off row waits before the queue looks again.
 *
 * One function so the two halves cannot drift on which cadence applies to which
 * row: prices.ts builds its Prisma filter from it and scrape.py mirrors the same
 * CASE in SQL.
 */
export function recheckHoursFor(row) {
  return isUndiagnosed(row) ? UNDIAGNOSED_RECHECK_HOURS : DEAD_LINK_RECHECK_HOURS;
}

/**
 * True when a listing must not be offered as a place to buy.
 *
 * Only the definitive signal counts. A row the heuristic merely suspects stays
 * on the site: hiding a live listing on a hunch is the failure this whole
 * repository is built to avoid, and a blocked store looks exactly like a closed
 * one from here. A 404 does not — the store answered.
 *
 * Priced rows are never hidden. A price means the page was read and parsed, and
 * on the same pass a 404 clears the price, so "priced and dead" only ever means
 * the flag is staler than the price.
 */
export function isUnbuyableDeadLink(row) {
  return Boolean(row?.deadSince) && row?.price == null;
}

/**
 * How a vendor's dead listings should be described in the publishing report.
 * Returns null when nothing about this vendor is dead, so the caller keeps
 * whatever diagnosis it had.
 */
export function describeDeadListings(listings, deadListings, deadestSince) {
  const total = Number(listings ?? 0);
  const dead = Number(deadListings ?? 0);
  if (!(dead > 0) || !(total > 0)) return null;
  const since = deadestSince ? ` since ${new Date(deadestSince).toISOString().slice(0, 10)}` : "";
  // "gone" covers all four answers a store gives: 404/410, a redirect to its
  // front door, the storefront's front page served for the URL itself, and a
  // host that no longer resolves. Naming only the status sent the owner looking
  // for a 404 that the commonest cases never produce.
  const how =
    "404/410, redirected to the storefront's front door, answered with the " +
    "storefront's own front page, or the host no longer resolves";
  if (dead >= total) {
    return (
      `all ${total} listing(s) are gone${since} (${how}) — relink or retire it ` +
      `(refresh-prices cannot help)`
    );
  }
  return `${dead} of ${total} listing(s) are gone${since} (${how}); the rest are still being read`;
}
