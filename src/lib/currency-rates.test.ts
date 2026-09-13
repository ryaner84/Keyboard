import assert from "node:assert/strict";
import {
  MIN_RATE_CODES,
  parseRatePayload,
  RATE_SOURCES,
  REQUIRED_CODES,
} from "@/lib/currency-rates";

// A payload with enough codes to clear MIN_RATE_CODES, so each case below
// tests one rule rather than tripping the size floor by accident.
function bulkRates(over: Record<string, unknown> = {}): Record<string, unknown> {
  const rates: Record<string, unknown> = { USD: 1 };
  for (const code of REQUIRED_CODES) rates[code] = 1.5;
  // Filler codes, distinct and syntactically valid.
  for (let i = 0; i < 30; i++) {
    rates[`X${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (i % 7))}`] = 2;
  }
  return { ...rates, ...over };
}

// ── Both feed shapes this codebase can meet ─────────────────────────────────
const keyed = parseRatePayload({ result: "success", conversion_rates: bulkRates({ SGD: 1.2671 }) });
assert.ok(keyed, "the keyed v6 endpoint sends conversion_rates");
assert.equal(keyed.SGD, 1.2671);

const keyless = parseRatePayload({ result: "success", rates: bulkRates({ SGD: 1.267105 }) });
assert.ok(keyless, "the keyless endpoint sends rates");
assert.equal(keyless.SGD, 1.267105);

// frankfurter sends no `result` and omits its own base.
const noBase = bulkRates();
delete noBase.USD;
const framed = parseRatePayload({ rates: noBase });
assert.ok(framed, "a payload with no result field is still readable");
assert.equal(framed.USD, 1, "a base-USD feed may omit USD; identity must hold");

// ── The reported numbers ────────────────────────────────────────────────────
// db-setup's placeholder was SGD 1.35; the live rate is 1.2679. US$124 is
// S$157, not the S$167 the collection was showing.
const live = parseRatePayload({ result: "success", rates: bulkRates({ SGD: 1.2679 }) });
assert.ok(live);
assert.equal(Math.round(124 * live.SGD), 157);
assert.notEqual(Math.round(124 * 1.35), 157);

// ── Refusals: a bad payload must never reach the database ───────────────────
assert.equal(parseRatePayload(null), null);
assert.equal(parseRatePayload("<html>502</html>"), null, "an error page is not rates");
assert.equal(parseRatePayload({}), null);
assert.equal(parseRatePayload({ rates: null }), null);
assert.equal(parseRatePayload({ rates: [] }), null, "an array is not a rate map");
assert.equal(
  parseRatePayload({ result: "error", "error-type": "invalid-key", conversion_rates: bulkRates() }),
  null,
  "an error envelope can still carry a plausible rates object — result wins"
);
assert.equal(
  parseRatePayload({ rates: { USD: 1, SGD: 1.27, EUR: 0.86 } }),
  null,
  `fewer than ${MIN_RATE_CODES} codes is a different document, not a rate feed`
);
for (const missing of REQUIRED_CODES) {
  const partial = bulkRates();
  delete partial[missing];
  assert.equal(
    parseRatePayload({ rates: partial }),
    null,
    `a payload missing ${missing} would blank that currency, not merely date it`
  );
}

// ── Individual entries that cannot be a rate are dropped, not trusted ───────
const dirty = parseRatePayload({
  rates: bulkRates({
    SGD: 1.2679,
    AAA: 0,
    BBB: -1,
    CCC: Number.NaN,
    DDD: Number.POSITIVE_INFINITY,
    EEE: "1.27",
    FFF: null,
    toolong: 1.5,
  }),
});
assert.ok(dirty);
for (const bad of ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "toolong"]) {
  assert.equal(dirty[bad], undefined, `${bad} must not survive as a rate`);
}
assert.equal(dirty.SGD, 1.2679, "the good entries alongside them still come through");

// ── Source order: the keyless fallback is what makes this self-healing ──────
assert.equal(RATE_SOURCES.length, 2);
assert.equal(
  RATE_SOURCES[0].url(undefined),
  null,
  "the keyed source contributes nothing without a key"
);
assert.equal(
  RATE_SOURCES[0].url("placeholder"),
  null,
  ".env.example ships the literal 'placeholder' — it is not a key"
);
assert.ok(
  RATE_SOURCES[0].url("realkey")?.includes("realkey"),
  "a real key is used when configured"
);
assert.ok(
  RATE_SOURCES[1].url(undefined),
  "the fallback needs no key — without it the table never refreshes at all"
);

console.log("currency rate feed checks passed");
