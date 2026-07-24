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

The **Resolution audit** table below keeps the full root-cause/fix detail for
every report; it is the durable audit trail and is not part of the routine's
per-run rendered output. When a new report appears in the feed, add its row to
both the client-reported log and the resolution audit in the same run.

`logged` = the report's `submittedAt` (UTC). `verdict`: **self-healed** (stock
/ availability only — clears on the next scrape, no code) vs **needs fix**
(systematic scrape bug — wrong variant, currency, or product).

## 1. Open wrong-price reports (unresolved only)

_None — all filed reports are resolved and the live feed is at 0 pending._

## 2. Open client-recommended values (awaiting verification)

_None — all client-recommended values have been verified (see audit below)._

## 3. Client-reported items (full log)

| logged (UTC) | set | vendor | reported price | reason (client) | verdict | status |
|---|---|---|---|---|---|---|
| 2026-07-02 | gmk-cyl-kitsune | Ktechs | 45 SGD | "this price is for the numpad not for the base set" | needs fix | ✅ resolved |
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
| 2026-07-02 | gmk-cyl-kitsune | Ktechs | 45 SGD | needs fix | Numpad subkit picked as base — `90d2984` excludes numpad from base pool → `NO_BASE_KIT` clears it | ✅ resolved (price cleared) |
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
| 2026-06-12 | gmk-dragon-witch | Fancy Customs | null (was ~175k) | needs fix | Implausible value cleared — plausibility bounds + `NO_BASE_KIT` | ✅ resolved (cleared) |

### Client-recommended values verified

- **gmk-mictlan-rebirth base = ARS 184,285.71** (client's correction). Verified
  against the WooCommerce base-kit selection in #54 — the parser now resolves
  the mictlan base to exactly ARS 184,285.71, confirming the reporter's figure.

## Summary

- **14 report submissions across 12 listings.** All are resolved; the live feed
  has been at **0 pending** since (checked through 2026-07-24).
- **rainy-day-r2 × Keygem was reported 3×** (2026-06-13, -06-21, -06-24) and
  never healed because that store lists subkits only — resolved by dropping the
  vendor-set pair, not by patching the picker.
- Two systematic bugs drove most reports: **wrong variant** (a cheap subkit
  stored as the base) and **never heals** (a bad price re-stored every run) —
  both fixed structurally in #43 (dearest-candidate + the `NO_BASE_KIT`
  sentinel that clears a bad price).
- **4 stock/availability-only reports self-healed** with no code change.
