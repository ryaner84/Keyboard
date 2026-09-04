// The plausibility window a scraped BASE-kit price has to fall inside, and the
// one place it is written.
//
// It exists as a backstop for parse errors. `pickBaseVariant` is the primary
// guard — it is what stops a deskmat, a deposit or a novelty kit being stored
// as the set's price — and this window only catches the cases that get past it
// (a bundle total, a keyboard, a mis-parsed decimal). That makes its ceiling a
// blunt instrument, and a blunt instrument set too low does not fail loudly: it
// answers PRICE_REFUSED on a page that was fetched, parsed and completely
// understood, leaves the row unpriced, and an unpriced row is hidden outright
// on a RELEASED set. The store publishes nothing and looks, from outside, like
// a store nobody buys from.
//
// That is exactly what happened. The ceiling was calibrated when a GMK base kit
// topped out near USD 180 and nothing in the roster sold above it. The roster
// now carries the Signature Plastics profiles too (DCS, DSA, DSS, SA) and the
// boutique makers who use them price well above GMK: norbauer.co sells its
// "After-school 1992" keyset at USD 230 on both its variants (DSA and DSS), and
// the ceiling sat at 225. So the one listing that vendor has was refused on
// every run, for ever, by our own rule rather than by anything the store did —
// the publishing audit named it, correctly, as "read and the price REFUSED by
// this site … refresh-prices cannot help". Only a code change here can end it.
//
// AND IT HAPPENED AGAIN FIVE DOLLARS LATER. Raising 225 to 300 answered the
// listing in hand rather than the trend it was evidence of: in-stock boutique
// sets keep climbing, and keyspresso.ca sells "[Extras] GMK Harvest" — whose
// base variant, "Hiragana Base - Inari", is a keycap base kit, in stock, in USD
// — at 305. Refused, unpriced, hidden (the set is released), and that ONE row
// is the vendor's only listing, so keyspresso published nothing at all.
//
// So the ceiling is now set against what the window is FOR, not against the
// dearest kit anyone has yet found. It is a backstop for parse errors —
// pickBaseVariant is what actually keeps a deskmat, a deposit or a bundle off a
// set page — and the two ways it can be wrong are not symmetrical:
//
//   too HIGH  stores a visible wrong number, which the wrong-price report feed
//             and the nightly price audit both exist to catch, and which any
//             reader can see is wrong.
//   too LOW   publishes nothing, silently, for ever, and reads from outside
//             like a store nobody buys from.
//
// USD 400 keeps every real keycap kit we have seen (the dearest is 305) inside
// the window with room for the next one, and still rejects the magnitudes the
// backstop is aimed at — a bundle total, a whole keyboard, a decimal parsed a
// place out.
//
// Every currency is the same USD-equivalent, deliberately: a window that is
// generous in USD and tight in EUR publishes a set on one storefront and hides
// it on another, for no reason a reader could ever discover.
//
// WRITTEN TWICE, AND ONLY TWICE. This module is the source of truth; the three
// other places that used to restate it now derive from it:
//
//   src/lib/import/prices.ts   imports KIT_BOUNDS + isPlausibleBaseKitPrice.
//   scripts/db-setup.mjs       builds the deploy purge SQL and the restore
//                              window from it (kitBoundsPurgeSql below).
//   scraper/scrape.py          cannot import a JS module, so it mirrors the
//                              table as _KIT_BOUNDS — and test:kit-bounds
//                              fails if the two ever disagree.
//
// The purge is the half that must never drift low. It nulls any stored SCRAPED
// price outside the window on every deploy, so a purge window TIGHTER than what
// the price passes will store wipes legitimate prices nightly — which is
// exactly what blanked released-set pricing once before. Deriving all of it
// from one table is what makes that drift impossible rather than merely
// discouraged.

/**
 * Per-currency plausibility window for a BASE kit price.
 *
 * The floor is 0 in every currency ON PURPOSE, and is not a rounding of some
 * real minimum: the dcs.wiki archive tracks accessory products (DCS Bae Addon,
 * 6u bars, 10U Spacebars, 9009 Fix Kit …) as first-class sets whose real price
 * is a few dollars, and any floor above 0 threw those away as "implausible".
 * Only a 0 or negative result — always a parse failure, never a price — is
 * refused at the bottom.
 */
export const KIT_BOUNDS = Object.freeze({
  USD: Object.freeze({ min: 0, max: 400 }),
  EUR: Object.freeze({ min: 0, max: 375 }),
  GBP: Object.freeze({ min: 0, max: 320 }),
  AUD: Object.freeze({ min: 0, max: 615 }),
  CAD: Object.freeze({ min: 0, max: 555 }),
  SGD: Object.freeze({ min: 0, max: 555 }),
  JPY: Object.freeze({ min: 0, max: 60000 }),
  KRW: Object.freeze({ min: 0, max: 570000 }),
  CNY: Object.freeze({ min: 0, max: 2950 }),
  HKD: Object.freeze({ min: 0, max: 3200 }),
  THB: Object.freeze({ min: 0, max: 14400 }),
  TWD: Object.freeze({ min: 0, max: 13000 }),
  // Chilean Peso — used by Fancy Customs (CL). 1 USD ≈ 960 CLP.
  CLP: Object.freeze({ min: 0, max: 375000 }),
  // Indian Rupee — 1 USD ≈ 84 INR.
  INR: Object.freeze({ min: 0, max: 33500 }),
  // Argentine Peso — used by Latamkeys. Volatile; deliberately wide.
  ARS: Object.freeze({ min: 0, max: 715000 }),
  // Malaysian Ringgit — 1 USD ≈ 4.71 MYR.
  MYR: Object.freeze({ min: 0, max: 1960 }),
});

/**
 * Is this a number the site is willing to publish as a base-kit price?
 *
 * A currency with no entry is unbounded above: those have magnitudes we have
 * never calibrated, and refusing them would hide a live listing on a guess.
 * `currency === null` means the store never told us — bound it as USD, since
 * the fallback is always one of the western vendor currencies.
 */
export function isPlausibleBaseKitPrice(price, currency) {
  const b = KIT_BOUNDS[currency ?? "USD"];
  if (!b) return price > 0;
  return price > b.min && price <= b.max;
}

/**
 * The deploy purge's WHERE clause, generated from the table above.
 *
 * db-setup used to spell these sixteen comparisons out by hand next to a
 * comment begging the next reader to keep them in step with two other files.
 * Generating it is the same rule stated once: the purge can no longer be
 * tighter than what the price passes store, because it is no longer a separate
 * statement of the window.
 *
 * @param {string} priceColumn     SQL expression for the price.
 * @param {string} currencyColumn  SQL expression for the ISO currency code.
 */
export function kitBoundsPurgeSql(priceColumn = "price", currencyColumn = "currency") {
  return Object.entries(KIT_BOUNDS)
    .map(
      ([code, { min, max }]) =>
        `(${currencyColumn} = '${code}' AND (${priceColumn} <= ${min} OR ${priceColumn} > ${max}))`
    )
    .join("\n           OR ");
}
