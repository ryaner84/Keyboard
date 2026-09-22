// Every currency the site can price a listing in, and the ONE place the list
// is written.
//
// A price is only ever storable relative to a currency the site can convert.
// `convertCurrency` falls back to a rate of 1 for a code the `Currency` table
// does not carry, so an unconverted number renders as garbage (82,857 ARS as
// $82,857), and both price passes therefore REFUSE a price quoted in anything
// outside this list — `PRICE_REFUSED`, priceSource 'REFUSED', row left
// unpriced. An unpriced row is hidden outright on a RELEASED set, so a store
// whose every listing is quoted in an unregistered currency publishes NOTHING
// AT ALL, by our rule rather than by anything the store did.
//
// That is not hypothetical. mechaland.id — a live Indonesian Shopify store —
// was probed from a runner on 2026-09-15: every product page answers 200 with
// full Shopify product JSON and a JSON-LD Product/Offer, the base variant is
// titled "Base" / "Base Kit …" so the picker names it on the first try, and
// `/meta.json` says the shop quotes **IDR** (GMK Nerve base kit Rp 2,440,000 ≈
// USD 148; GMK Black Snail base Rp 1,390,000 ≈ USD 84). Both of its readable
// listings were refused on every six-hourly run — the third is a genuine dead
// link — so the vendor published nothing and the publishing audit named it
// under "read and the price REFUSED by this site … widen the window or add the
// currency (refresh-prices cannot help)". Nothing but a change HERE could ever
// end it.
//
// The list was written FIVE times over, which is how IDR came to be missing
// from all of them at once and how three codes added in #162 came to be half
// registered:
//
//   src/lib/import/prices.ts   SUPPORTED_CURRENCIES *and* CURRENCY_HOME_COUNTRY
//                              — the second was never updated for INR/ARS/CLP,
//                              so those stores were localized to "US" and
//                              Shopify served them USD numbers to be stored
//                              under the shop's own currency code.
//   scraper/scrape.py          _SUPPORTED_CURRENCIES + _CURRENCY_HOME_COUNTRY.
//   scripts/db-setup.mjs       ensureCurrencies — the Currency table the
//                              allowlist above claims to describe.
//   prisma/seed.ts             the local seed, already three codes behind.
//   scripts/lib/kit-bounds.mjs the plausibility window, which is only ever a
//                              window ON a currency.
//
// So this module is the source of truth and the consumers derive from it:
// prices.ts imports it (as it imports kit-bounds.mjs and link-health.mjs),
// db-setup GENERATES its seed SQL from it, and scrape.py mirrors it because
// Python cannot import a JS module. `test:currency-rates` fails if any of
// those halves drifts, if a vendor registry names a currency that is not here,
// or if a registered code has no plausibility window.
//
// REGISTERING ONE means four facts, not one, and this table carries all four:
//
//   name / symbol   the Currency row db-setup seeds, so conversion has a rate
//                   at the right magnitude from the first deploy. Those rates
//                   are PLACEHOLDERS stamped at epoch 0 — the exchange-rate
//                   refresh overwrites them on the first read (see
//                   src/lib/currency-rates.ts), and a code the feed does not
//                   carry keeps the placeholder rather than converting at 1.
//   homeCountry     Shopify Markets localizes by geo. Without the pin a store
//                   is asked as if from the US and answers in USD, which is
//                   then stored under the shop's own currency code — a price
//                   wrong by the exchange rate, and visibly cheapest.
//   a KIT_BOUNDS window  in scripts/lib/kit-bounds.mjs. Absent, the window is
//                   unbounded above, and on a 16,000:1 currency that is no
//                   backstop at all: a whole keyboard reads as a keycap kit.
//
// The bar for ADDING one is that a tracked store prices in it. The bar is low
// on purpose — the two ways this list can be wrong are not symmetrical, the
// same way kit-bounds' ceiling is not. A currency listed here that no store
// uses costs a seeded row nobody reads; a currency missing from it publishes
// nothing, silently, for ever.

/**
 * code → { name, symbol, homeCountry, placeholderRate }
 *
 * `placeholderRate` is units per 1 USD, at the right magnitude only. Never
 * read it as a live rate: the Currency table's own row is, and the feed
 * refreshes it.
 */
export const CURRENCIES = Object.freeze({
  USD: Object.freeze({ name: "US Dollar", symbol: "$", homeCountry: "US", placeholderRate: 1.0 }),
  SGD: Object.freeze({ name: "Singapore Dollar", symbol: "S$", homeCountry: "SG", placeholderRate: 1.35 }),
  EUR: Object.freeze({ name: "Euro", symbol: "€", homeCountry: "DE", placeholderRate: 0.92 }),
  GBP: Object.freeze({ name: "British Pound", symbol: "£", homeCountry: "GB", placeholderRate: 0.79 }),
  CAD: Object.freeze({ name: "Canadian Dollar", symbol: "CA$", homeCountry: "CA", placeholderRate: 1.37 }),
  AUD: Object.freeze({ name: "Australian Dollar", symbol: "A$", homeCountry: "AU", placeholderRate: 1.54 }),
  JPY: Object.freeze({ name: "Japanese Yen", symbol: "¥", homeCountry: "JP", placeholderRate: 150.5 }),
  CNY: Object.freeze({ name: "Chinese Yuan", symbol: "¥", homeCountry: "CN", placeholderRate: 7.24 }),
  KRW: Object.freeze({ name: "South Korean Won", symbol: "₩", homeCountry: "KR", placeholderRate: 1340 }),
  MYR: Object.freeze({ name: "Malaysian Ringgit", symbol: "RM", homeCountry: "MY", placeholderRate: 4.71 }),
  THB: Object.freeze({ name: "Thai Baht", symbol: "฿", homeCountry: "TH", placeholderRate: 35.8 }),
  NZD: Object.freeze({ name: "New Zealand Dollar", symbol: "NZ$", homeCountry: "NZ", placeholderRate: 1.64 }),
  HKD: Object.freeze({ name: "Hong Kong Dollar", symbol: "HK$", homeCountry: "HK", placeholderRate: 7.82 }),
  TWD: Object.freeze({ name: "New Taiwan Dollar", symbol: "NT$", homeCountry: "TW", placeholderRate: 32.1 }),
  SEK: Object.freeze({ name: "Swedish Krona", symbol: "kr", homeCountry: "SE", placeholderRate: 10.5 }),
  NOK: Object.freeze({ name: "Norwegian Krone", symbol: "kr", homeCountry: "NO", placeholderRate: 10.8 }),
  DKK: Object.freeze({ name: "Danish Krone", symbol: "kr", homeCountry: "DK", placeholderRate: 6.89 }),
  CHF: Object.freeze({ name: "Swiss Franc", symbol: "CHF", homeCountry: "CH", placeholderRate: 0.89 }),
  PLN: Object.freeze({ name: "Polish Zloty", symbol: "zł", homeCountry: "PL", placeholderRate: 4.02 }),
  // STACKS (IN) and Neo Macro (IN) price in rupees. The home country was the
  // half that was missing when INR was registered: without it the store is
  // asked as if from the US.
  INR: Object.freeze({ name: "Indian Rupee", symbol: "₹", homeCountry: "IN", placeholderRate: 84.0 }),
  // Latamkeys (AR). Volatile — the window in kit-bounds is deliberately wide.
  ARS: Object.freeze({ name: "Argentine Peso", symbol: "AR$", homeCountry: "AR", placeholderRate: 1200 }),
  // Fancy Customs (CL).
  CLP: Object.freeze({ name: "Chilean Peso", symbol: "CL$", homeCountry: "CL", placeholderRate: 960 }),
  // Mechaland (ID), whose two readable listings were refused on every run
  // until this row existed. See the note at the top of this file.
  IDR: Object.freeze({ name: "Indonesian Rupiah", symbol: "Rp", homeCountry: "ID", placeholderRate: 16500 }),
  // Mokb Store (VN), a Haravan storefront whose /meta.json says VND. The shop
  // was unreadable for a second reason as well (see
  // scripts/lib/storefront-catalog.mjs), so registering the currency alone
  // would not have published a thing — which is the point: a store publishes
  // nothing until EVERY rule between it and the set page lets it through, and
  // each of them is silent on its own.
  VND: Object.freeze({ name: "Vietnamese Dong", symbol: "₫", homeCountry: "VN", placeholderRate: 26300 }),
  // FunKeys (UA), whose storefront quotes hryvnia and says so in its own
  // markup (`data-project-currency-code="UAH"`, measured from a runner on
  // 2026-09-22). Registered ahead of the reader that will need it: the store
  // is a Tilda Store, whose catalogue is drawn client-side, so no parser path
  // here reads a price off it yet and the vendor's rows are `UNPARSED` rather
  // than `REFUSED` today. That is the same two-wall shape Mokb Store had —
  // see the VND note above — and it is why the currency is registered
  // separately: a store publishes nothing until EVERY rule between it and the
  // set page lets it through, the walls are silent one at a time, and the
  // cheap one should not be left standing behind the expensive one.
  UAH: Object.freeze({ name: "Ukrainian Hryvnia", symbol: "₴", homeCountry: "UA", placeholderRate: 41.5 }),
});

/** Every registered code, in registration order. */
export const SUPPORTED_CURRENCY_CODES = Object.freeze(Object.keys(CURRENCIES));

/**
 * Can the site store a price quoted in this currency at all?
 *
 * A null/blank code is NOT refused: "the store never told us" is answered by
 * the caller's own fallback (the vendor row's currency), never by a refusal.
 */
export function isSupportedCurrency(code) {
  if (!code) return true;
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/**
 * The market to pin Shopify's localization to, so variant prices come back in
 * the store's own base currency rather than converted to wherever the caller
 * geolocates. "US" for an unknown code, which is what the hand-written map
 * fell back to — but every registered code now has a real answer.
 */
export function currencyHomeCountry(code) {
  return CURRENCIES[code]?.homeCountry ?? "US";
}

/**
 * The VALUES rows for db-setup's `ensureCurrencies` insert, generated from the
 * table above rather than restated beside it.
 *
 * `lastUpdated` is epoch 0 on every row deliberately: it marks the rate as a
 * placeholder, so the first exchange-rate refresh overwrites it.
 */
export function currenciesSeedSql() {
  return Object.entries(CURRENCIES)
    .map(
      ([code, { name, symbol, placeholderRate }]) =>
        `('${code}', '${name.replace(/'/g, "''")}', '${symbol.replace(/'/g, "''")}', ` +
        `${placeholderRate}, to_timestamp(0))`
    )
    .join(",\n         ");
}
