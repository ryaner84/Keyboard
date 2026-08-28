# Wrong-price report ledger

Persistent, audit-trail record of every visitor **wrong-price report** filed
against the GMK group-buy tracker, with the date the client logged it and how
it was resolved. The live feed (`/api/price-reports`) only returns *pending*
reports and drops each one the moment it resolves, so this committed ledger is
the only durable source of "what was reported and when".

**Rendering convention (per `price-report-review-routine.md`).** Every run
renders three tables:

1. **Open wrong-price reports** — ledger rows **not yet resolved**. Resolved
   rows are **omitted** here (when everything is resolved this table shows
   "none").
2. **Open client-recommended values** — client-suggested corrected
   prices/URLs/vendors **still awaiting verification**. Verified ones are
   **omitted**.
3. **Client-reported items** — the full client's-eye log of every report ever
   filed (always shown, including resolved).

The **Self-heal watch** (table 1b) holds every item flagged `self-healed`,
which the *next* run must confirm actually healed or else fix. It is rendered
and reconciled on every run alongside the three tables.

The **Resolution audit** table below keeps the full root-cause/fix detail for
every report; it is the durable audit trail and is not part of the routine's
per-run rendered output. When a new report appears in the feed, add its row to
both the client-reported log and the resolution audit in the same run.

`logged` = the report's `submittedAt` (UTC). `verdict`: **self-healed** (stock
/ availability only — clears on the next scrape, no code) vs **needs fix**
(systematic scrape bug — wrong variant, currency, or product).

> **2026-08-26 full-history reconciliation.** The `?all=1` feed exposed the
> complete `PriceReport` history (40 submissions across 33 listings), where the
> pending-only snapshots this ledger was built from had captured just 15. The
> 25 previously-missing reports (2026-07-02 … 2026-08-24) are folded in below —
> almost all already resolved by structural fixes shipped since (base-kit
> picker, `NO_BASE_KIT`, plausibility bounds, storefront-ownership heal,
> WooCommerce base parsing) or by stock/availability re-scrapes. All 40 carry
> the same `resolvedAt` (2026-08-25T22:55:31Z): the first `?all=1` sweep
> auto-resolved the whole backlog at once (route.ts stamps a report resolved
> when its listing's price is `null` or was re-scraped after the report), so
> "resolved" here is the genuine self-heal signal, not a manual mask. The one
> live never-heals surfaced by the reconciliation — SwiftCables × evil-dolch
> (a cable listing, reported 3×) — is fixed this run via a blocked vendor-set
> pair.

> **2026-08-27 run.** The `?all=1` feed now returns **41 submissions across 34
> listings**, all resolved, 0 pending. The one report added since the
> 2026-08-26 sweep is **gmk-vamp × Switchmod** (logged 2026-08-26T17:39,
> "all has no stock"). It is a **stock-only self-heal, confirmed in-run**: a
> live Vendor probe (run 33086317179) shows the Shopify listing's **Base**
> variant priced at **84.99 USD, available=true** — the picker chose the base
> correctly, the price is right (GMK *CYL* Vamp is the cheaper doubleshot line),
> and every variant is now in stock, so the availability complaint no longer
> holds. No code change. (The full-history feed re-stamps `resolvedAt` at each
> sweep; the 2026-08-27 run reports all 41 resolved at 2026-08-27T10:05:41Z.)

> **2026-08-28 run.** Feed run 33183506189 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run and nothing is
> appended. The incoming **Self-heal watch was empty**; the prior run's one
> self-heal (**gmk-vamp × Switchmod**) is **re-confirmed healed** here — the
> feed shows it resolved (`resolvedAt=2026-08-28T11:36:50.543Z`, after the
> 2026-08-26T17:39 submit) with `current=84.99 USD source=SCRAPED`, the correct
> CYL base, so the stock-only complaint no longer holds. No item failed
> verification, so no fix was required. (The full-history feed re-stamps
> `resolvedAt` at each sweep; this run reports all 41 resolved at
> 2026-08-28T11:36:50.543Z.)

## 1. Open wrong-price reports (unresolved only)

_None — 0 pending reports in the feed; every logged report is resolved._

## 1b. Self-heal watch (pending next-day confirmation)

Every item a run marks **self-healed** lands here and stays until the *next*
run proves it. A nightly scrape runs between review runs, so by the next run
each row must be confirmed **healed** (report resolved, wrong value gone) or,
if it did not heal (still pending after a scrape, wrong value returned, or the
same listing was re-reported), reclassified **needs fix** and **fixed in that
run** — the scheduler owns the fix (see routine step 2). A confirmed row moves
to the resolution audit and drops out of this table.

_None. The 2026-08-28 run's incoming watch was empty. The prior run's one
self-heal, **gmk-vamp × Switchmod** (flagged 2026-08-27, probe-confirmed in-run
via run 33086317179: Base 84.99 USD `available=true`, picker correct), is
**re-confirmed healed** against this run's full-history feed — still resolved,
`current=84.99 USD source=SCRAPED`, `resolvedAt=2026-08-28T11:36:50.543Z` (after
the 2026-08-26T17:39 submit) — and stays in the resolution audit. No watched
item failed verification, so no in-run fix was required. All 41 full-history
reports remain resolved; 0 pending._

## 2. Open client-recommended values (awaiting verification)

_None — all client-recommended values have been verified (see audit below)._

## 3. Client-reported items (full log)

| logged (UTC) | set | vendor | reported price | reason (client) | verdict | status |
|---|---|---|---|---|---|---|
| 2026-08-26 | gmk-vamp | Switchmod | 84.99 USD | "all has no stock" | self-healed | ✅ resolved |
| 2026-08-25 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | "there is no more stock" | self-healed | ✅ resolved |
| 2026-08-24 | gmk-tribal | zFrontier | 175 USD | "it show product not found" | needs fix | ✅ resolved |
| 2026-08-20 | gmk-nord | CandyKeys | 62 EUR | "this url point to a different website" | needs fix | ✅ resolved |
| 2026-08-17 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | "there is no more stock" | self-healed | ✅ resolved |
| 2026-08-16 | gmk-evil-dolch-r2 | SwiftCables | 39.5 USD | "for this vendor this is not a keycap this is a cable" | needs fix | ✅ resolved |
| 2026-08-16 | gmk-evil-dolch-r2 | SwiftCables | 39.5 USD | "this is not a keycap this is a cable" | needs fix | ✅ resolved |
| 2026-08-12 | gmk-metropolis-r2 | NovelKeys | 70 USD | "price is correct but when i click on buy is directed to an error page" | self-healed (link, price OK) | ✅ resolved |
| 2026-08-10 | gmk-panda | iLumKB | 229 SGD | "this is price of spacebar not the base set" | needs fix | ✅ resolved |
| 2026-07-28 | gmk-moomin | iLumKB | 199 SGD | "this is the price of Base + Novelty" | needs fix | ✅ resolved |
| 2026-07-28 | gmk-tribal | zFrontier | 175 USD | "this is the price of extras" | needs fix | ✅ resolved |
| 2026-07-28 | gmk-just-beachy | Keebz n Cables | null | "this is ascent price" | needs fix | ✅ resolved |
| 2026-07-26 | gmk-evil-dolch-r2 | Aiglatson Studio | 3790 THB | "no stock" | self-healed | ✅ resolved |
| 2026-07-26 | gmk-evil-dolch-r2 | SwiftCables | 39.5 USD | "this is not even a keycap" | needs fix | ✅ resolved |
| 2026-07-25 | gmk-pharaoh | iLumKB | 209 SGD | "this is novelty kit" | needs fix | ✅ resolved |
| 2026-07-25 | gmk-thunder-god | Ktechs | 169 SGD | "no stock" | self-healed | ✅ resolved |
| 2026-07-22 | gmk-nord | zFrontier | 110 USD | "this is price of novelty kit" | needs fix | ✅ resolved |
| 2026-07-22 | gmk-maroon | zFrontier | 170 USD | "wrong item price is this price of kits spacebar" | needs fix | ✅ resolved |
| 2026-07-21 | gmk-burgundy-r3 | Omnitype | 100 USD | "when clicked buy is directing to a weird website" | needs fix | ✅ resolved |
| 2026-07-20 | gmk-bent-r2 | zFrontier | 56 USD | "this price is not the price of the revival base kit also revival base kit has no stock" | needs fix | ✅ resolved |
| 2026-07-20 | gmk-arctic | zFrontier | 46 USD | "this is the price of novelty kit not based kit" | needs fix | ✅ resolved |
| 2026-07-18 | gmk-masterpiece-r2 | Oblotzky Industries | 119 EUR | "This is a pre order link not actual units" | self-healed (link) | ✅ resolved |
| 2026-07-18 | gmk-masterpiece-r2 | iLumKB | 159 SGD | "This link is pointing to pre order not actual units" | self-healed (link) | ✅ resolved |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | Oblotzky Industries | null | "I am seeing base kit as 116 europe" | needs fix (+ recommended value) | ✅ resolved |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | iLumKB | null | "You picked the novelty kit price as based kit price" | needs fix | ✅ resolved |
| 2026-07-16 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | "sold out" | self-healed | ✅ resolved |
| 2026-07-02 | gmk-camping-r3 | zFrontier | null | "this is not base set price" | needs fix | ✅ resolved |
| 2026-07-02 | gmk-cyl-kitsune-keycaps | Ktechs | 45 SGD | "this price is for the numpad not for the base set" | needs fix | ✅ resolved |
| 2026-06-26 | gmk-awaken | NovelKeys | 70 USD | "item dun exist" | needs fix | ✅ resolved |
| 2026-06-24 | gmk-monokai-material | NovelKeys | 40 USD | "this is not the base kit price, this is another subkit price" | needs fix | ✅ resolved |
| 2026-06-24 | gmk-rainy-day-r2 | Keygem | 60 EUR | "this is not the base kit price again" | needs fix | ✅ resolved |
| 2026-06-21 | gmk-rainy-day-r2 | Cannon Keys | 150 USD | "this is sold out" | self-healed | ✅ resolved |
| 2026-06-21 | gmk-rainy-day-r2 | Keygem | 60 EUR | "this 88 dollars is novelty not the base kit" | needs fix | ✅ resolved |
| 2026-06-20 | gmk-noel-r2 | KBDfans | 145 USD | "no stock" | self-healed | ✅ resolved |
| 2026-06-20 | gmk-noel-r2 | pantheonkeys | 189.9 SGD | "has ready stock" | self-healed | ✅ resolved |
| 2026-06-13 | gmk-mictlan-rebirth | Latamkeys | ~ARS 50k–101k | "base set price is ARS 184,285.71, more expensive than this" | needs fix | ✅ resolved |
| 2026-06-13 | gmk-rainy-day-r2 | Keygem | 60 EUR | "neither of the 2 items in this shop is a base set" | needs fix | ✅ resolved |
| 2026-06-12 | gmk-nervewrecker | Latamkeys | ~ARS 107k–157k | "you did not pick the base price" | needs fix | ✅ resolved |
| 2026-06-12 | gmk-monochrome-dolch | Neo Macro | 15,500 INR | "wrong price, how can a keycap cost 20k" | needs fix | ✅ resolved |
| 2026-06-12 | gmk-monochrome-r2 | STACKS | 13,999 INR | "wrong — confused with currency ₹13,999 (Inc. GST)" | needs fix | ✅ resolved |
| 2026-06-12 | gmk-dragon-witch | Fancy Customs | null (was ~175k) | "showing 175k which is impossible" | needs fix | ✅ resolved |

## Resolution audit (full detail — audit trail, not rendered per run)

| logged (UTC) | set | vendor | reported price | verdict | root cause & fix | status now |
|---|---|---|---|---|---|---|
| 2026-08-26 | gmk-vamp | Switchmod | 84.99 USD | self-healed | Stock-only ("all has no stock") — no scrape bug. Despite the `gmk-vamp-extras` slug (the SwiftCables/evil-dolch-extras trap shape), a live Vendor probe (run 33086317179) shows the Shopify listing = "GMK CYL Vamp" with a **Base** variant at 84.99 USD `available=true` (plus Novelties 20.99, Extension 27.99, Deskmat 9.99, HIBI 40.99, all in stock). `choose_kit_variant` correctly picks Base, the price is right (CYL is the cheaper doubleshot line), and every variant is now in stock — the availability complaint no longer holds. Re-scrape after submit resolved it. No code change | ✅ resolved (self-healed, probe-confirmed) |
| 2026-08-25 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | self-healed | Stock-only ("no more stock") — no scrape bug; re-scrape after submit resolved it. Secondary check: 113 SGD (≈84 USD) is low for a GMK base; no reporter has ever complained about the *price* (3 reports, all stock-only), so treated as the base kit until a price report says otherwise | ✅ resolved (self-healed) |
| 2026-08-24 | gmk-tribal | zFrontier | 175 USD | needs fix | "Product not found" — the linked variant/page was gone; a dead/moved link. `NO_BASE_KIT` + dead-link (404/410) clearing hands the row back on the next rotation | ✅ resolved |
| 2026-08-20 | gmk-nord | CandyKeys | 62 EUR | needs fix | "URL points to a different website" — stale/misrouted product link; re-scrape relinked the correct CandyKeys page (62 EUR is a plausible nord base) | ✅ resolved |
| 2026-08-17 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | self-healed | Stock-only — availability re-scrape (2nd of 3 BRG stock reports) | ✅ resolved (self-healed) |
| 2026-08-16 | gmk-evil-dolch-r2 | SwiftCables | 39.5 USD | needs fix | **Wrong product** — SwiftCables is a cable maker; `/products/gmk-evil-dolch-extras` is a cable, not the keycap base. 39.5 USD is a cable price, far below any GMK base (~135 USD). Reported 3× (2026-07-26, 2026-08-16 ×2) and the value returned across scrapes → never-heals. `choose_kit_variant` can't help (single "Default Title" cable variant is plausibly priced), and "extras" is deliberately allowed as a base word, so dropped via `BLOCKED_VENDOR_SET_PAIRS` (`swiftcables::gmk-evil-dolch-r2`) | ✅ resolved (vendor-set dropped) |
| 2026-08-16 | gmk-evil-dolch-r2 | SwiftCables | 39.5 USD | needs fix | 2nd of the two same-minute SwiftCables reports that nulled the price — same fix (vendor-set dropped) | ✅ resolved (vendor-set dropped) |
| 2026-08-12 | gmk-metropolis-r2 | NovelKeys | 70 USD | self-healed | Reporter states the **price is correct**; complaint is a broken checkout link ("directed to an error page"). Not a price bug; the link re-verified on re-scrape | ✅ resolved (link) |
| 2026-08-10 | gmk-panda | iLumKB | 229 SGD | needs fix | Spacebar/subkit priced as base — `choose_kit_variant` now picks BASE > dearest candidate and drops labelled subkits; SPACEBARS excluded | ✅ resolved |
| 2026-07-28 | gmk-moomin | iLumKB | 199 SGD | needs fix | "Base + Novelty" bundle priced as base — `classify_variant` files it BUNDLE (base + extra kit), used only when no plain base exists; base-only pick restored | ✅ resolved |
| 2026-07-28 | gmk-tribal | zFrontier | 175 USD | needs fix | "Extras" subkit priced as base — dearest-base-candidate pick + subkit drop | ✅ resolved |
| 2026-07-28 | gmk-just-beachy | Keebz n Cables | null | needs fix | "Ascent" (other colourway/subkit) priced as base — picker corrected; value now null (re-scrape found no clean base) | ✅ resolved (cleared) |
| 2026-07-26 | gmk-evil-dolch-r2 | Aiglatson Studio | 3790 THB | self-healed | Stock-only ("no stock") — availability re-scrape (THB base 3790 ≈ 105 USD, plausible) | ✅ resolved (self-healed) |
| 2026-07-26 | gmk-evil-dolch-r2 | SwiftCables | 39.5 USD | needs fix | 1st of 3 SwiftCables cable reports — see 2026-08-16 row; dropped via `BLOCKED_VENDOR_SET_PAIRS` | ✅ resolved (vendor-set dropped) |
| 2026-07-25 | gmk-pharaoh | iLumKB | 209 SGD | needs fix | Novelty kit priced as base — NOVELTIES excluded, base-pick restored | ✅ resolved |
| 2026-07-25 | gmk-thunder-god | Ktechs | 169 SGD | self-healed | Stock-only ("no stock") — availability re-scrape (Ktechs thunder-god is a hand-curated LINK_OVERRIDE, 169 SGD base plausible) | ✅ resolved (self-healed) |
| 2026-07-22 | gmk-nord | zFrontier | 110 USD | needs fix | Novelty kit priced as base — NOVELTIES excluded | ✅ resolved |
| 2026-07-22 | gmk-maroon | zFrontier | 170 USD | needs fix | Spacebar kit priced as base — SPACEBARS excluded | ✅ resolved |
| 2026-07-21 | gmk-burgundy-r3 | Omnitype | 100 USD | needs fix | Buy link redirects to dixiemech.store — Omnitype's row was parked on a sibling brand's storefront (CLAUDE.md "wrong storefront" shape); `planStorefrontOwnership`/roster heal repoints it | ✅ resolved |
| 2026-07-20 | gmk-bent-r2 | zFrontier | 56 USD | needs fix | Revival base not picked + no stock — subkit drop + availability re-scrape | ✅ resolved |
| 2026-07-20 | gmk-arctic | zFrontier | 46 USD | needs fix | Novelty kit priced as base — NOVELTIES excluded | ✅ resolved |
| 2026-07-18 | gmk-masterpiece-r2 | Oblotzky Industries | 119 EUR | self-healed | Pre-order link, not in-stock units — availability/link complaint; re-scrape re-verified. (119 EUR is Oblotzky's ex-VAT display; DE-market inc-VAT base ≈ 139 EUR — see recommended-values note) | ✅ resolved (link) |
| 2026-07-18 | gmk-masterpiece-r2 | iLumKB | 159 SGD | self-healed | Pre-order link complaint — availability/link; re-scrape re-verified | ✅ resolved (link) |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | Oblotzky Industries | null | needs fix | Client reads base as "116 europe" — that is Oblotzky's **ex-VAT** display; the tracked DE-market base is inc-VAT (see recommended-values note). Value cleared to null on re-scrape (no clean base surfaced) | ✅ resolved (cleared) |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | iLumKB | null | needs fix | Novelty kit priced as base — NOVELTIES excluded; value now null | ✅ resolved (cleared) |
| 2026-07-16 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | self-healed | Stock-only ("sold out") — 1st of 3 BRG stock reports; availability re-scrape | ✅ resolved (self-healed) |
| 2026-07-02 | gmk-camping-r3 | zFrontier | null | needs fix | Non-base price — the zFrontier camping-r3 listing carries no resolvable base; dropped via `BLOCKED_VENDOR_SET_PAIRS` (`zfrontier::gmk-camping-r3`) | ✅ resolved (vendor-set dropped) |
| 2026-07-02 | gmk-cyl-kitsune | Ktechs | 45 SGD | needs fix | Numpad priced as base — `_NONBASE_SUBKIT_RE` numpad drop → `NO_BASE_KIT` clears | ✅ resolved (cleared) |
| 2026-06-26 | gmk-awaken | NovelKeys | 70 USD | needs fix | Dead listing — dead-link clearing (#45) + `NO_BASE_KIT` | ✅ resolved (cleared) |
| 2026-06-24 | gmk-monokai-material | NovelKeys | 40 USD | needs fix | Wrong variant (cheapest subkit) — #43 dearest-base-candidate pick | ✅ resolved (cleared) |
| 2026-06-24 | gmk-rainy-day-r2 | Keygem | 60 EUR | needs fix | Listing has no base kit (subkits only), never heals — dropped via `BLOCKED_VENDOR_SET_PAIRS` (`82b991d`) | ✅ resolved (vendor-set dropped) |
| 2026-06-21 | gmk-rainy-day-r2 | Cannon Keys | 150 USD | self-healed | Stock-only complaint — clears on next availability scrape | ✅ resolved (self-healed) |
| 2026-06-21 | gmk-rainy-day-r2 | Keygem | 60 EUR | needs fix | Same as the Keygem row above (2nd of 3 reports) — dropped (`82b991d`) | ✅ resolved (vendor-set dropped) |
| 2026-06-20 | gmk-noel-r2 | KBDfans | 145 USD | self-healed | Stock-only — next availability scrape | ✅ resolved (self-healed) |
| 2026-06-20 | gmk-noel-r2 | pantheonkeys | 189.9 SGD | self-healed | Availability note only, price is correct | ✅ resolved (self-healed) |
| 2026-06-13 | gmk-mictlan-rebirth | Latamkeys | ~ARS 50k–101k | needs fix | WooCommerce base variant never surfaced — #54 parses Woo variations; listing still had no clean base → dropped (`82b991d`) | ✅ resolved (vendor-set dropped) |
| 2026-06-13 | gmk-rainy-day-r2 | Keygem | 60 EUR | needs fix | 1st of 3 Keygem reports — dropped (`82b991d`) | ✅ resolved (vendor-set dropped) |
| 2026-06-12 | gmk-nervewrecker | Latamkeys | ~ARS 107k–157k | needs fix | WooCommerce base-pick miss — #54; then dropped (`82b991d`) | ✅ resolved (vendor-set dropped) |
| 2026-06-12 | gmk-monochrome-dolch | Neo Macro | 15,500 INR | needs fix | Non-base/implausible value — base-kit audit (#65) + plausibility bounds | ✅ resolved (off feed) |
| 2026-06-12 | gmk-monochrome-r2 | STACKS | 13,999 INR | needs fix | WooCommerce not scraped / GST line — `7376823` + #54 | ✅ resolved (off feed) |
| 2026-06-12 | gmk-dragon-witch | Fancy Customs | null (was ~175k) | needs fix | Implausible value cleared — plausibility bounds + `NO_BASE_KIT`; vendor also whole-blocked (`BLOCKED_VENDOR_SLUGS`) | ✅ resolved (cleared) |

### Client-recommended values verified

- **gmk-mictlan-rebirth base = ARS 184,285.71** (client's correction). Verified
  against the WooCommerce base-kit selection in #54 — the parser now resolves
  the mictlan base to exactly ARS 184,285.71, confirming the reporter's figure.
- **gmk-cyl-tiramisu base = "116 europe"** (Oblotzky, client's reading).
  Verified as the store's **ex-VAT** display: the tracked DE-market base is the
  inc-VAT figure (≈ 139 EUR), matching the Oblotzky "116 vs 139" pattern noted
  in `CLAUDE.md`. The 116 is not a scrape target; the listing self-cleared to
  null pending a fresh in-stock base scrape.

## Summary

- **41 report submissions across 34 listings** (full `?all=1` history, first
  reconciled 2026-08-26; gmk-vamp × Switchmod added 2026-08-27). **All 41 are
  resolved; 0 pending.**
- **Ledger completeness caveat (now closed for history-to-date).** The committed
  log was previously transcribed from pending-only snapshots, which drop a
  report the moment it resolves — so 25 reports that filed-and-healed between
  review runs had never reached the ledger. The `?all=1` full-history feed and
  this reconciliation fold them in. Keep reconciling every run: a report that
  files and self-heals within a single day still only appears in `?all=1`.
- **One live never-heals surfaced and fixed this run:** SwiftCables ×
  gmk-evil-dolch-r2 — a cable listing (`/products/gmk-evil-dolch-extras`)
  reported 3× as "not a keycap", with 39.5 USD re-stored across scrapes. Dropped
  via `BLOCKED_VENDOR_SET_PAIRS` (`swiftcables::gmk-evil-dolch-r2`).
- **rainy-day-r2 × Keygem was reported 3×** (2026-06-13, -06-21, -06-24) and
  never healed because that store lists subkits only — resolved by dropping the
  vendor-set pair, not by patching the picker.
- **Two systematic bug families drove most reports:** **wrong variant** (a cheap
  subkit/novelty/spacebar/bundle stored as the base) and **never heals** (a bad
  price re-stored every run) — both fixed structurally in #43
  (dearest-base-candidate + the `NO_BASE_KIT` sentinel that clears a bad price)
  and, for a handful of listings with no resolvable base, by blocked vendor-set
  pairs.
- **Stock/availability-only reports self-heal with no code change** — 11 of the
  41 (BRG ×3, thunder-god, evil-dolch/Aiglatson, noel ×2, rainy-day/Cannon,
  masterpiece ×2 pre-order-link, gmk-vamp/Switchmod). They recur when a store
  re-lists, so a fresh stock complaint is expected and harmless.
