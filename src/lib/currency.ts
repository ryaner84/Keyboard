import { prisma } from "./prisma";
import { parseRatePayload, RATE_SOURCES } from "./currency-rates";
export { convertCurrency, formatCurrency } from "./currency-utils";

const STALE_HOURS = 24;
const FETCH_TIMEOUT_MS = 8_000;

// `isStale` is true until a refresh SUCCEEDS, and the seeded rows are stamped
// at epoch 0, so every request that reads rates would re-attempt the fetch for
// as long as the feed is down — on a serverless app that is a request-rate
// stampede against a third party that is already unhappy. Per-instance and
// therefore approximate, which is all it needs to be: it caps the retry rate,
// it is not a correctness guard.
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
let nextAttemptMs = 0;

async function fetchRates(): Promise<Record<string, number> | null> {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  let triedAny = false;

  for (const source of RATE_SOURCES) {
    const url = source.url(apiKey);
    if (!url) continue; // needs a key, none configured — try the next source
    triedAny = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[currency] ${source.name} answered HTTP ${res.status}`);
        continue;
      }
      const rates = parseRatePayload(await res.json());
      if (!rates) {
        // The distinction that matters: the feed ANSWERED and we refused it.
        // Writing a payload we cannot vouch for would be far worse than
        // keeping yesterday's numbers.
        console.warn(`[currency] ${source.name} returned no usable rate map`);
        continue;
      }
      console.log(
        `[currency] refreshed ${Object.keys(rates).length} rates from ${source.name}`
      );
      return rates;
    } catch (err) {
      console.warn(
        `[currency] ${source.name} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Cannot happen while a keyless source is registered, but says so rather
  // than going quiet if one is ever removed — silence is what let the
  // placeholders ship.
  if (!triedAny) console.warn("[currency] no usable rate source configured");
  return null;
}

export async function getExchangeRates(): Promise<Record<string, number>> {
  const currencies = await prisma.currency.findMany();

  const isStale =
    currencies.length === 0 ||
    currencies.some((c) => {
      const ageMs = Date.now() - c.lastUpdated.getTime();
      return ageMs > STALE_HOURS * 60 * 60 * 1000;
    });

  const cached = Object.fromEntries(
    currencies.map((c) => [c.code, c.exchangeRateToUSD])
  );

  if (!isStale || Date.now() < nextAttemptMs) return cached;

  const rates = await fetchRates();
  if (!rates) {
    nextAttemptMs = Date.now() + FAILURE_COOLDOWN_MS;
    console.warn(
      "[currency] serving cached rates; they may still be db-setup's placeholders"
    );
    return cached;
  }

  try {
    const now = new Date();
    await Promise.all(
      Object.entries(rates).map(([code, rate]) =>
        prisma.currency.upsert({
          where: { code },
          update: { exchangeRateToUSD: rate, lastUpdated: now },
          create: {
            code,
            name: code,
            symbol: code,
            exchangeRateToUSD: rate,
            lastUpdated: now,
          },
        })
      )
    );
  } catch (err) {
    // The rates are good even if the write failed, so use them for this
    // request rather than falling back to placeholders.
    console.warn(
      `[currency] rate write failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  nextAttemptMs = 0;
  return rates;
}
