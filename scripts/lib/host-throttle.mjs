// Spacing requests per HOST, and ordering a queue so the spacing is free.
//
// Stores rate-limit per IP, and HTTP 429 — like 403, like a connection that
// simply never answers — is UNREADABLE to the price pass: it increments
// `linkFailures`, and DEAD_LINK_FAILURE_THRESHOLD of those back the row off to
// the 14-day cadence, where it stays unpriced. An unpriced row is hidden
// outright on a RELEASED set. So a store we hammer into blocking us disappears
// from the site under OUR rule, which is the exact failure link-health.mjs is
// built to avoid ("a block may never hide a listing") — arrived at from the
// other end, by producing the block ourselves.
//
// This was written twice and only ONE half had it. `run_prices` in
// `scraper/scrape.py` (the nightly) has spaced its requests through a
// `HostThrottle` and spread its queue with `HostThrottle.interleave` since it
// was written. `refreshPrices` in `src/lib/import/prices.ts` — the half that
// actually runs, four times a day in CI and again on the Vercel cron — had
// neither, and recorded the premise that made it look safe:
//
//     // How many product URLs to fetch in parallel. Vendors are distinct
//     // hosts, so this is safe;
//
// which is false for the order that queue is built in. The candidates come back
// `ORDER BY priceUpdatedAt ASC`, and a vendor's rows are all stamped within
// milliseconds of each other by the run that last visited them — so the queue
// is not merely host-clustered, it reproduces the previous run's per-vendor
// grouping exactly. Eight workers pulling consecutive indices out of that are
// eight simultaneous, unspaced requests to ONE store, and they stay on that
// store for as many rows as it has: 219 in a row for zfrontier-cn, 206 for
// mykeyboard-eu, 46 for monokei. The stores with the most listings — the ones
// worth the most published rows — take the heaviest burst.
//
// Two pieces, and the order matters more than the sleep:
//
//   interleaveByHost   round-robins the rows across hosts, so consecutive
//                      fetches are to DIFFERENT stores and the throttle almost
//                      never has to sleep at all. Relative order within a host
//                      is preserved, so each store's oldest listing is still
//                      checked first and the oldest-first rotation is intact.
//   HostThrottle       the backstop for the tail, where the small stores are
//                      exhausted and only the giants are left: requests to one
//                      host are spaced by HOST_MIN_INTERVAL_MS plus jitter.
//                      Requests to DIFFERENT hosts never wait on each other.
//
// Throttling can mean fewer rows in a time-boxed run. That is not a loss: the
// rotation is oldest-first and resumes next run, and the rows it drops are the
// ones that would have come back 429 anyway.
//
// `scrape.py` cannot import JavaScript, so it mirrors this module and
// `npm run test:host-throttle` fails if the two copies disagree.

/**
 * Minimum gap between two requests to the same host, in milliseconds.
 *
 * Mirrors HOST_MIN_INTERVAL_S in scraper/scrape.py (seconds there, since that
 * half sleeps with time.sleep).
 */
export const HOST_MIN_INTERVAL_MS = 1500;

/**
 * Random extra delay added to each gap, in milliseconds. A perfectly regular
 * cadence is itself a bot signature; the jitter costs nothing and blurs it.
 *
 * Mirrors HOST_JITTER_S in scraper/scrape.py.
 */
export const HOST_JITTER_MS = 500;

/** The host a URL addresses, lowercased. "" when there is nothing to read. */
export function hostOfUrl(url) {
  try {
    return new URL(String(url ?? "")).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Round-robin `rows` across the host of `key`, so consecutive rows address
 * different stores.
 *
 * Same rows, same count, no row dropped or duplicated — only the order changes.
 * Relative order WITHIN a host is preserved, which is what keeps an
 * oldest-first queue oldest-first per store.
 *
 * Rows whose URL is missing or unparseable share the "" bucket rather than
 * being discarded: the price pass has its own handling for a blank productUrl,
 * and silently losing rows here would starve them for ever.
 */
export function interleaveByHost(rows, key = "productUrl") {
  const buckets = new Map();
  for (const row of rows ?? []) {
    const host = hostOfUrl(row?.[key]);
    const bucket = buckets.get(host);
    if (bucket) bucket.push(row);
    else buckets.set(host, [row]);
  }
  const spread = [];
  while (buckets.size > 0) {
    for (const [host, bucket] of [...buckets]) {
      spread.push(bucket.shift());
      if (bucket.length === 0) buckets.delete(host);
    }
  }
  return spread;
}

/**
 * Per-host request spacing.
 *
 * `wait(url)` resolves once this host may be hit again and returns how many
 * milliseconds it slept, so a run can report what the throttle cost — the
 * nightly prints the same number as `throttled_s`. A host seen for the first
 * time never waits.
 *
 * The reservation is taken SYNCHRONOUSLY, before the sleep, so concurrent
 * workers that land on the same host queue up behind each other instead of all
 * reading the same stale timestamp and firing together — which is the exact
 * burst this class exists to prevent.
 */
export class HostThrottle {
  constructor({
    intervalMs = HOST_MIN_INTERVAL_MS,
    jitterMs = HOST_JITTER_MS,
    // Injectable for the tests: real time makes the assertions slow and flaky.
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = {}) {
    this._intervalMs = intervalMs;
    this._jitterMs = jitterMs;
    this._now = now;
    this._sleep = sleep;
    this._random = random;
    /** host → the earliest time the NEXT request to it may start. */
    this._nextAllowed = new Map();
  }

  async wait(url) {
    const host = hostOfUrl(url);
    if (!host) return 0;
    const now = this._now();
    const earliest = this._nextAllowed.get(host) ?? now;
    const waitMs = Math.max(0, earliest - now);
    const gap =
      this._intervalMs + (this._jitterMs ? this._random() * this._jitterMs : 0);
    // Claim the slot before awaiting: a second worker arriving on this host in
    // the same tick must queue behind this one, not alongside it.
    this._nextAllowed.set(host, now + waitMs + gap);
    if (waitMs > 0) await this._sleep(waitMs);
    return waitMs;
  }
}
