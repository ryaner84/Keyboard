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
// Two columns carry the evidence, and they mean different things on purpose:
//
//   deadSince     the store itself said the page does not exist (404/410).
//                 Definitive, so it is the only signal allowed to take a link
//                 off the site.
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

/** True for a status that means the page is gone rather than unavailable. */
export function isDeadLinkStatus(status) {
  return DEAD_LINK_STATUSES.includes(Number(status));
}

/**
 * The link-health columns after one price attempt. Pure — the caller writes.
 *
 * `outcome` is one of:
 *   "PRICED"       a price was parsed
 *   "NO_BASE_KIT"  the page was READ and carries no base kit
 *   "GONE"         the store answered 404/410
 *   "UNREADABLE"   anything else: a redirect to the homepage, 401, 402, 5xx,
 *                  a DNS failure, a timeout, a block
 *
 * PRICED and NO_BASE_KIT are both successful reads. Treating NO_BASE_KIT as a
 * failure would flag every store that legitimately sells only add-on kits.
 */
export function nextLinkHealth(current, outcome, now = new Date()) {
  const failures = Number(current?.linkFailures ?? 0) || 0;
  const deadSince = current?.deadSince ?? null;
  if (outcome === "PRICED" || outcome === "NO_BASE_KIT") {
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
  if (dead >= total) {
    return (
      `all ${total} listing(s) return 404/410${since} — the store's pages are ` +
      `gone; relink or retire it (refresh-prices cannot help)`
    );
  }
  return (
    `${dead} of ${total} listing(s) return 404/410${since} — those pages are ` +
    `gone; the rest are still being read`
  );
}
