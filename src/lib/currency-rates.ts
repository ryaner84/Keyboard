// Reading an exchange-rate feed, and refusing one that would poison every
// price on the site.
//
// `ensureCurrencies` in db-setup seeds the Currency table with PLACEHOLDERS —
// its own comment says so, and stamps `lastUpdated` at epoch 0 "so the next
// exchange-rate refresh overwrites them immediately". Production was still
// serving those placeholders: SGD 1.35 against a real 1.2679, MYR 4.71 against
// 4.07, INR 84 against 95.6. Errors of 6–16%, on every figure the site
// converts — collection spend, realised P/L, and the cross-currency comparison
// that decides which vendor is cheapest.
//
// They were never overwritten because the refresh could only run when
// EXCHANGE_RATE_API_KEY was set, and every way it could fail was silent: an
// absent key skipped the block, a throw hit an empty `catch {}`, and a
// non-success payload fell through — all three returning the cached
// placeholders with no log, no error and nothing anywhere saying the number on
// screen was a guess.
//
// So this module does two things: it accepts more than one feed shape (so a
// keyless source can stand in when no key is configured), and it VALIDATES
// before anything is written. Stale rates are wrong by a few percent; rates
// parsed out of an error page or a half-empty payload are wrong by orders of
// magnitude, and they would be written over the only copy we have.

// Codes the site genuinely prices in. A payload missing any of them is a
// partial answer, and writing it would blank conversions for those currencies
// rather than merely dating them.
export const REQUIRED_CODES = ["EUR", "GBP", "SGD", "JPY", "CNY"] as const;

// A real USD feed carries well over a hundred codes. Anything this small is a
// different document — an error envelope, a stub, a single-pair response.
export const MIN_RATE_CODES = 20;

/**
 * The rate map inside a feed's payload, or null when the payload cannot be
 * trusted.
 *
 * Accepts both shapes this codebase can meet: `conversion_rates` (the keyed
 * exchangerate-api v6 endpoint) and `rates` (its keyless open endpoint, and
 * frankfurter). Rates are "units of X per 1 USD", matching convertCurrency's
 * contract, so USD is normalised to 1 — a base-USD feed may omit its own base.
 */
export function parseRatePayload(payload: unknown): Record<string, number> | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;

  // Only the keyed endpoint sends `result`. When present it is authoritative:
  // an error envelope can still carry a plausible-looking rates object.
  if (typeof body.result === "string" && body.result !== "success") return null;

  const raw =
    (body.conversion_rates as unknown) ?? (body.rates as unknown) ?? null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Z]{3}$/.test(code)) continue;
    // Strictly a positive, finite number. A string "1.27" is not a rate from a
    // feed we understand, and NaN/0/negative would divide the site by nonsense.
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    rates[code] = value;
  }

  // A base-USD feed may omit USD itself (frankfurter does). Setting it rather
  // than requiring it keeps convertCurrency's identity case exact.
  rates.USD = 1;

  if (Object.keys(rates).length < MIN_RATE_CODES) return null;
  if (REQUIRED_CODES.some((code) => rates[code] === undefined)) return null;
  return rates;
}

export interface RateSource {
  name: string;
  /** Null when the source needs a key and none is configured. */
  url: (apiKey: string | undefined) => string | null;
}

// Tried in order. The keyed endpoint first when a key exists — it is the one
// the owner pays for and has the higher quota — then the SAME provider's free
// keyless endpoint, so the table refreshes even with nothing configured. That
// fallback is the difference between "rates are a day old" and "rates have
// never once been real", which is the state this repairs.
export const RATE_SOURCES: RateSource[] = [
  {
    name: "exchangerate-api v6 (keyed)",
    url: (apiKey) =>
      apiKey && apiKey !== "placeholder"
        ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
        : null,
  },
  {
    name: "open.er-api.com (keyless)",
    url: () => "https://open.er-api.com/v6/latest/USD",
  },
];
