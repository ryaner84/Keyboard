import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  HOST_JITTER_MS,
  HOST_MIN_INTERVAL_MS,
  HostThrottle,
  hostOfUrl,
  interleaveByHost,
} from "./host-throttle.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- hostOfUrl -------------------------------------------------------------
// Host, not origin: http and https to one store are one store as far as a rate
// limiter is concerned, and several vendors carry both spellings.
assert.equal(hostOfUrl("https://Kono.Store/products/gmk-boho"), "kono.store");
assert.equal(hostOfUrl("http://kono.store/products/gmk-boho"), "kono.store");
// A www twin is a DIFFERENT name in DNS and usually a different edge, so it is
// deliberately not folded here — the throttle over-spaces rather than under.
assert.notEqual(hostOfUrl("https://www.kono.store/x"), hostOfUrl("https://kono.store/x"));
for (const bad of ["", null, undefined, "not a url", "/products/x"]) {
  assert.equal(hostOfUrl(bad), "", `${bad} has no host`);
}

// --- interleaveByHost ------------------------------------------------------
// The price queue comes back ORDER BY priceUpdatedAt ASC, and a store's rows
// are all stamped by the run that last visited them — so it does not merely
// happen to be clustered, it reproduces the previous run's per-vendor grouping.
// Eight workers pulling consecutive indices out of THAT are eight simultaneous
// requests to one store, for as many rows as the store has.
const clustered = [
  { productUrl: "https://a.example/products/1" },
  { productUrl: "https://a.example/products/2" },
  { productUrl: "https://a.example/products/3" },
  { productUrl: "https://b.example/products/1" },
  { productUrl: "https://b.example/products/2" },
  { productUrl: "https://c.example/products/1" },
];
const spread = interleaveByHost(clustered);

// Same rows, none dropped, none duplicated: only the order changes. A queue
// that silently lost rows here would starve them for ever, since the rotation
// is the only thing that ever revisits a listing.
assert.equal(spread.length, clustered.length);
assert.deepEqual(
  [...spread].map((r) => r.productUrl).sort(),
  [...clustered].map((r) => r.productUrl).sort()
);

// Consecutive rows address different hosts for as long as there are hosts left.
assert.deepEqual(
  spread.slice(0, 3).map((r) => hostOfUrl(r.productUrl)),
  ["a.example", "b.example", "c.example"]
);

// Relative order WITHIN a host is preserved, which is what keeps an
// oldest-first queue oldest-first per store: the throttle must not be able to
// reorder which of a vendor's listings gets checked first.
assert.deepEqual(
  spread.filter((r) => hostOfUrl(r.productUrl) === "a.example").map((r) => r.productUrl),
  [
    "https://a.example/products/1",
    "https://a.example/products/2",
    "https://a.example/products/3",
  ]
);

// The tail is the case the throttle exists for: once the small stores are
// exhausted only the giant is left, and its rows do run back to back.
const tailHeavy = interleaveByHost([
  ...Array.from({ length: 5 }, (_, i) => ({ productUrl: `https://big.example/products/${i}` })),
  { productUrl: "https://small.example/products/1" },
]);
assert.equal(tailHeavy.length, 6);
assert.equal(hostOfUrl(tailHeavy[1].productUrl), "small.example");
assert.equal(hostOfUrl(tailHeavy[5].productUrl), "big.example");

// Rows with no usable URL share the "" bucket rather than being discarded —
// refreshOne has its own handling for a blank productUrl, and dropping them
// here would mean they were never seen again.
assert.equal(interleaveByHost([{ productUrl: null }, { productUrl: "" }, {}]).length, 3);
assert.deepEqual(interleaveByHost([]), []);
assert.deepEqual(interleaveByHost(null), []);
// The key is configurable, because not every queue calls its column productUrl.
assert.equal(interleaveByHost([{ url: "https://a.example/x" }], "url").length, 1);

// --- HostThrottle ----------------------------------------------------------
// Fake clock and sleep: real time makes these assertions slow and flaky, and
// what is being pinned is the arithmetic, not setTimeout.
function fakeThrottle(overrides = {}) {
  let now = 0;
  const slept = [];
  const throttle = new HostThrottle({
    now: () => now,
    // Deliberately does NOT advance the clock. Time only moves when a test says
    // it does, so each returned wait is measured from the same instant and the
    // assertions pin the RESERVATION arithmetic rather than the interleaving of
    // fake timers.
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 0, // no jitter, so the gap is exactly the interval
    ...overrides,
  });
  return {
    throttle,
    slept,
    advance: (ms) => {
      now += ms;
    },
    at: () => now,
  };
}

// A host seen for the first time never waits: the throttle spaces requests, it
// does not add a startup cost to every store.
{
  const { throttle, slept } = fakeThrottle();
  assert.equal(await throttle.wait("https://a.example/products/1"), 0);
  assert.deepEqual(slept, []);
}

// A second request to the SAME host waits out the interval.
{
  const { throttle } = fakeThrottle();
  await throttle.wait("https://a.example/products/1");
  assert.equal(await throttle.wait("https://a.example/products/2"), HOST_MIN_INTERVAL_MS);
}

// Requests to DIFFERENT hosts never wait on each other. This is the whole
// reason interleaving makes the throttle nearly free — and the reason a
// throttle without interleaving would be nothing but sleep.
{
  const { throttle } = fakeThrottle();
  await throttle.wait("https://a.example/products/1");
  assert.equal(await throttle.wait("https://b.example/products/1"), 0);
  assert.equal(await throttle.wait("https://c.example/products/1"), 0);
}

// Enough time already elapsed → no wait. The gap is a minimum, not a schedule.
{
  const { throttle, advance } = fakeThrottle();
  await throttle.wait("https://a.example/products/1");
  advance(HOST_MIN_INTERVAL_MS * 3);
  assert.equal(await throttle.wait("https://a.example/products/2"), 0);
}

// Concurrent lanes landing on one host QUEUE UP rather than firing together.
// The slot is claimed synchronously, before the sleep, so a second worker
// arriving in the same tick reads the reservation the first one made — not the
// stale timestamp it would have seen if the map were written after awaiting.
// Reading stale is exactly the burst this class exists to prevent.
{
  const { throttle } = fakeThrottle();
  const waits = await Promise.all([
    throttle.wait("https://a.example/products/1"),
    throttle.wait("https://a.example/products/2"),
    throttle.wait("https://a.example/products/3"),
  ]);
  assert.deepEqual(waits, [0, HOST_MIN_INTERVAL_MS, HOST_MIN_INTERVAL_MS * 2]);
}

// A row with no host is not throttled — it never reaches the network.
{
  const { throttle } = fakeThrottle();
  assert.equal(await throttle.wait(""), 0);
  assert.equal(await throttle.wait(null), 0);
}

// Jitter is added on top of the interval, never subtracted from it: a perfectly
// regular cadence is its own bot signature, but the minimum gap is a minimum.
{
  const { throttle } = fakeThrottle({ random: () => 1 });
  await throttle.wait("https://a.example/products/1");
  assert.equal(
    await throttle.wait("https://a.example/products/2"),
    HOST_MIN_INTERVAL_MS + HOST_JITTER_MS
  );
}
assert.ok(HOST_MIN_INTERVAL_MS > 0 && HOST_JITTER_MS >= 0);

// --- the Python mirror -----------------------------------------------------
// The price pass is written twice — run_prices in scraper/scrape.py (the
// nightly with a real browser) and refreshPrices in src/lib/import/prices.ts
// (the Vercel cron and refresh-prices-ci). prices.ts imports this module;
// scrape.py cannot, so it mirrors it, and for as long as it did so ALONE the
// half that actually runs had no throttle at all.
const scrapePy = readFileSync(join(REPO_ROOT, "scraper", "scrape.py"), "utf8");

function pyConst(name) {
  const m = scrapePy.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"));
  assert.ok(m, `scrape.py must define ${name}`);
  return m[1].trim();
}

// Seconds there, milliseconds here — the same gap either way. A drift means one
// half is spacing its requests differently from the other against the same
// stores, which is how a rate limit gets found by exactly one of them.
assert.equal(
  Number(pyConst("HOST_MIN_INTERVAL_S")) * 1000,
  HOST_MIN_INTERVAL_MS,
  "scrape.py's HOST_MIN_INTERVAL_S must match HOST_MIN_INTERVAL_MS"
);
assert.equal(
  Number(pyConst("HOST_JITTER_S")) * 1000,
  HOST_JITTER_MS,
  "scrape.py's HOST_JITTER_S must match HOST_JITTER_MS"
);
assert.match(scrapePy, /class HostThrottle:/, "scrape.py must define HostThrottle");
assert.match(
  scrapePy,
  /def interleave\(/,
  "scrape.py must mirror interleaveByHost as HostThrottle.interleave"
);
// The nightly must actually USE both, not merely define them. It spread its
// queue and spaced its requests from the day it was written; the point of this
// suite is that neither half may quietly stop.
assert.match(
  scrapePy,
  /candidates\s*=\s*HostThrottle\.interleave\(fetch_price_candidates\(conn\)\)/,
  "run_prices must interleave its price queue across hosts"
);
assert.match(
  scrapePy,
  /throttle\.wait\(product_url\)/,
  "run_prices must space each price fetch through the throttle"
);

// --- the TypeScript half ---------------------------------------------------
// The half that actually runs: four times a day in CI and again on the Vercel
// cron. It had neither piece, and recorded "vendors are distinct hosts, so this
// is safe" as the reason it needed neither — false for a queue ordered by
// priceUpdatedAt, which groups by vendor. Eight unspaced lanes on one store
// invite the 429 that reads as UNREADABLE, backs the row off for a fortnight,
// and hides it outright on every released set. Pin all three halves of the fix.
const pricesTs = readFileSync(join(REPO_ROOT, "src", "lib", "import", "prices.ts"), "utf8");

assert.match(
  pricesTs,
  /from\s+"\.\.\/\.\.\/\.\.\/scripts\/lib\/host-throttle\.mjs"/,
  "prices.ts must IMPORT host-throttle.mjs rather than copy it"
);
assert.match(
  pricesTs,
  /interleaveByHost\(candidates\)/,
  "refreshPrices must interleave its candidates across hosts before running them"
);
assert.match(
  pricesTs,
  /await throttle\.wait\(/,
  "refreshPrices must space each fetch through the per-host throttle"
);
// Ordering by priceUpdatedAt is what makes the queue host-clustered in the
// first place. It must stay (oldest-first is the rotation), which is precisely
// why the interleave above is not optional.
assert.match(
  pricesTs,
  /orderBy:\s*\[\{\s*priceUpdatedAt/,
  "the price queue is still oldest-first, so it is still host-clustered"
);
// The throttle must not buy the run wall clock past its deadline: a sleep can
// outlast the budget, and the check before the sleep cannot see that.
assert.match(
  pricesTs,
  /await throttle\.wait\([\s\S]{0,200}?maxRuntimeMs[\s\S]{0,120}?stoppedEarly = true/,
  "refreshPrices must re-check the time budget AFTER waiting on the throttle"
);
assert.match(
  pricesTs,
  /throttledMs:\s*number/,
  "RefreshResult must report what the throttle cost"
);

// And the runner summary must print it, for the same reason #151 made it print
// the dead count: the CI log is the only place anyone reads a price run.
const refreshCi = readFileSync(join(REPO_ROOT, "scripts", "refresh-prices-ci.mjs"), "utf8");
assert.match(
  refreshCi,
  /throttledS=/,
  "the CI price-refresh summary must report the throttle cost"
);

console.log("host-throttle checks passed");
