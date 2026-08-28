// Is a store's catalog entry sold out? — the one question, with three answers.
//
// `VendorKit.inStock` is `DEFAULT true`, both discovery halves create rows as
// true, and until now the ONLY writer of false was the price pass. That pass is
// time-boxed and runs oldest-first over the whole roster, so a listing the store
// ended could stay green for a long time — Ktechs' GMK CYL Thunder God is
// `available: false` on every endpoint the shop serves, tagged "Ended", and our
// set page still offered a Buy button for it.
//
// The catalog crawl already fetches the feed that answers this. Shopify's
// `/products.json` and `/collections/<h>/products.json` carry `available` on
// every variant; discovery reads those pages for titles and throws the field
// away. This is that field, read carefully.
//
// THREE answers, not two. "every variant is unavailable" and "this feed does not
// report availability" must never collapse into one `false`, or a store whose
// feed omits the field gets its whole catalogue marked sold out. Ktechs itself
// shows why the distinction is real: its `/products.json` carries `available`,
// but its `/products/<handle>.json` has no `available` key at all — same store,
// same product, two endpoints, one of which knows nothing.
//
//   false  every variant that reports availability reports false
//   true   at least one variant reports available
//   null   nothing in this entry reports availability — say so, don't guess
//
// Callers may only act on `false`. See catalogStockUpdate below for why.
//
// Kept as plain .mjs alongside link-health.mjs so both the TS discovery pass and
// scripts/ can import the single definition; `scrape.py` mirrors it and
// `npm run test:catalog-stock` fails if the two copies disagree.

// One catalog entry's availability, or null when the entry does not say.
// Accepts the raw Shopify product object — `variants[].available`.
export function catalogAvailability(product) {
  const variants = product?.variants;
  if (!Array.isArray(variants)) return null;
  let known = false;
  let anyAvailable = false;
  for (const variant of variants) {
    // Strictly boolean: a missing key, null, or a string "true" is NOT a report.
    if (typeof variant?.available !== "boolean") continue;
    known = true;
    if (variant.available) anyAvailable = true;
  }
  if (!known) return null;
  return anyAvailable;
}

// What discovery may write to VendorKit.inStock, given an availability from
// catalogAvailability above — `{ inStock: false }`, or nothing at all.
//
// It takes the tri-state rather than the raw product because the two halves
// parse the feed at different moments: the Python catalog parser resolves
// availability up front (pick_store_listing scores on it), so by the time the
// write happens the raw variants are long gone. Same rule, one input.
//
// The rule is deliberately one-directional, mirroring the `html_guard` /
// `fromHtml` rule that already governs which links this pass may take over:
//
//   • It MAY mark a row sold out. A feed that reports every variant unavailable
//     is the store itself saying nobody can buy this, which is exactly the state
//     a stale `inStock` gets wrong.
//   • It may NEVER mark a row in stock. "The product exists and something on it
//     is purchasable" is not "the BASE variant this row is priced from is
//     purchasable" — a listing can be sold out on the base kit and available on
//     a novelty, which is the shape half of these catalogues have. The price
//     pass reads the actual variant and is the only authority for `true`.
//     Writing `true` here is the bug this whole module exists to undo.
//
// Returns a partial update object so a caller can spread it: `{}` means leave
// the flag exactly as it is.
export function catalogStockUpdate(availability) {
  return availability === false ? { inStock: false } : {};
}
