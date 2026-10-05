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

> **2026-08-29 run.** Feed run 33259240054 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — again a 1:1 match with the ledger's client-reported
> log, so **no new report** has filed since the 2026-08-27 run and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod), so there was nothing to re-verify
> and no item failed verification — no in-run fix was required. gmk-vamp ×
> Switchmod remains resolved in the feed (`current=84.99 USD source=SCRAPED`,
> correct CYL base). (The full-history feed re-stamps `resolvedAt` at each sweep;
> this run reports all 41 resolved at 2026-08-29T07:15:18.736Z, the nightly
> schedule sweep that preceded this dispatch.)
>
> **This run's "watch empty / nothing failed verification" is correct as
> written and still missed four live misclassifications** — see the note
> below, filed the same day. The watch only holds items a run FLAGGED
> self-healed and has not yet confirmed; an item closed in an earlier run
> is off it, so a recurrence months later arrives with a clean sheet.

> **2026-08-29 — four "self-healed" verdicts corrected, and why the watch
> missed them.** Ktechs' GMK British Racing Green R3 was reported three times
> (2026-07-16, 2026-08-17, 2026-08-25) and its Thunder God once (2026-07-25),
> every one closed `self-healed / no code change`. None of them had healed. The
> nightly `applyVendorLinkOverrides` re-asserted `inStock: true` on existing
> rows at step 3 of `/api/cron/refresh`, before the price pass at step 5 — and
> all four reports are against the two Ktechs listings that appear in the five
> hand-curated `LINK_OVERRIDES`. That is not a coincidence; it is the whole
> cause.
>
> The listing therefore OSCILLATED: the GitHub `refresh-prices` run (every 6h)
> wrote `false`, the 16:00 UTC Vercel cron wrote `true` back, and a review
> landing in the grey half of the cycle saw a healed row. The **self-heal
> watch** is designed to catch exactly this and reported "clear" every time,
> because a point-in-time check cannot see an oscillation. **A recurrence is
> the signal the watch cannot produce: the same (set, vendor) reported twice
> for the same reason is a `needs fix`, whatever the row reads when checked.**
> BRG was reported three times in six weeks and stayed classified stock-only.
>
> Fixed in #153: the override no longer writes the flag, and discovery marks a
> row sold out from the store's own `/products.json`. Verified on production
> the same day — `ktechs / gmk-british-racing-green-r3` reads `inStock=false,
> price=113 SGD, priceSource=SCRAPED, priceUpdatedAt=2026-08-29T16:13:43Z`, and
> `ktechs / gmk-thunder-god` `inStock=false` at 07:19:17Z.

> **2026-08-30 run.** Feed run 33318671531 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod), so there was nothing to re-verify
> this run and no watched item failed verification — no in-run fix was required.
> gmk-vamp × Switchmod remains resolved in the feed (`current=84.99 USD
> source=SCRAPED`, correct CYL base, `resolvedAt=2026-08-30T05:38:19.073Z`). The
> nightly 00:30 UTC scheduled feed (run 33295132581, 05:38 sweep) re-stamped all
> 41 reports resolved at 2026-08-30T05:38:19.073Z, which this dispatch confirms.

> **2026-08-31 run.** Feed run 33406564449 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30 runs added
> nothing), so there was nothing to re-verify this run and no watched item failed
> verification — no in-run fix was required. gmk-vamp × Switchmod remains
> resolved in the feed (`current=84.99 USD source=SCRAPED`, correct CYL base,
> `resolvedAt=2026-08-31T05:52:52.223Z`, after the 2026-08-26T17:39 submit). The
> four #153-corrected Ktechs listings also still read correctly — BRG R3
> `113 SGD SCRAPED` (×3 reports) and Thunder God `169 SGD SCRAPED`, all resolved
> with no recurrence. The nightly 00:30 UTC scheduled feed (05:52 sweep)
> re-stamped all 41 reports resolved at 2026-08-31T05:52:52.223Z, which this
> dispatch confirms.

> **2026-09-01 run.** Feed run 33523745772 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 runs
> added nothing), so there was nothing to re-verify this run and no watched item
> failed verification — no in-run fix was required. gmk-vamp × Switchmod remains
> resolved in the feed (`current=84.99 USD source=SCRAPED`, correct CYL base,
> `resolvedAt=2026-09-01T05:26:22.284Z`, after the 2026-08-26T17:39 submit). The
> four #153-corrected Ktechs listings also still read correctly — BRG R3
> `113 SGD SCRAPED` (×3 reports) and Thunder God `169 SGD SCRAPED`, all resolved
> with no recurrence. The nightly 00:30 UTC scheduled feed (run 33473592479,
> 05:26 sweep) re-stamped all 41 reports resolved at 2026-09-01T05:26:22.284Z,
> which this dispatch confirms.

> **2026-09-02 run.** Feed run 33646505280 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01 runs added nothing), so there was nothing to re-verify this run and
> no watched item failed verification — no in-run fix was required. gmk-vamp ×
> Switchmod remains resolved in the feed (`current=84.99 USD source=SCRAPED`,
> correct CYL base, `resolvedAt=2026-09-02T04:52:55.985Z`, after the
> 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. The nightly 00:30 UTC
> scheduled feed (run 33592490160, 04:52 sweep) re-stamped all 41 reports
> resolved at 2026-09-02T04:52:55.985Z, which this dispatch confirms.

> **2026-09-03 run.** Feed run 33770779156 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02 runs added nothing), so there was nothing to re-verify this run
> and no watched item failed verification — no in-run fix was required. gmk-vamp ×
> Switchmod remains resolved in the feed (`current=84.99 USD source=SCRAPED`,
> correct CYL base, `resolvedAt=2026-09-03T04:50:42.343Z`, after the
> 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. The nightly 00:30 UTC
> scheduled feed (run 33716520434, 04:50 sweep) re-stamped all 41 reports
> resolved at 2026-09-03T04:50:42.343Z, which this dispatch confirms.

> **2026-09-04 run.** Feed run 33887599980 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03 runs added nothing), so there was nothing to re-verify this
> run and no watched item failed verification — no in-run fix was required.
> gmk-vamp × Switchmod remains resolved in the feed (`current=84.99 USD
> source=SCRAPED`, correct CYL base, `resolvedAt=2026-09-04T04:53:28.618Z`, after
> the 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. Two stock-only self-heals
> (gmk-evil-dolch-r2 × Aiglatson Studio, gmk-noel-r2 × pantheonkeys) carry the
> 2026-09-03T15:07:10.567Z sweep timestamp rather than the 04:53 one; both remain
> resolved. The nightly 00:30 UTC scheduled feed (run 33838465240, 04:53 sweep)
> re-stamped the rest resolved at 2026-09-04T04:53:28.618Z, which this dispatch
> confirms.

> **2026-09-05 run.** Feed run 33973687358 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04 runs added nothing), so there was nothing to re-verify
> this run and no watched item failed verification — no in-run fix was required.
> gmk-vamp × Switchmod remains resolved in the feed (`current=84.99 USD
> source=SCRAPED`, correct CYL base, `resolvedAt=2026-09-05T04:46:52.818Z`, after
> the 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. The nightly 00:30 UTC
> scheduled feed (run 33945475074, 04:46 sweep) re-stamped all 41 reports resolved
> at 2026-09-05T04:46:52.818Z, which this dispatch confirms.

> **2026-09-06 run.** Feed run 34041163727 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05 runs added nothing), so there was nothing to
> re-verify this run and no watched item failed verification — no in-run fix was
> required. gmk-vamp × Switchmod remains resolved in the feed (`current=84.99 USD
> source=SCRAPED`, correct CYL base, `resolvedAt=2026-09-06T04:56:02.128Z`, after
> the 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. The nightly 00:30 UTC
> scheduled feed (run 34012724798, 04:56 sweep) re-stamped all 41 reports resolved
> at 2026-09-06T04:56:02.128Z, which this dispatch confirms.

> **2026-09-07 run.** Feed run 34136537803 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05/-06 runs added nothing), so there was nothing to
> re-verify this run and no watched item failed verification — no in-run fix was
> required. gmk-vamp × Switchmod remains resolved in the feed (`current=84.99 USD
> source=SCRAPED`, correct CYL base, `resolvedAt=2026-09-07T05:00:17.927Z`, after
> the 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. The nightly 00:30 UTC
> scheduled feed (run 34085152568, 05:00 sweep) re-stamped all 41 reports resolved
> at 2026-09-07T05:00:17.927Z, which this dispatch confirms.

> **2026-09-08 run.** Feed run 34242646779 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05/-06/-07 runs added nothing), so there was nothing to
> re-verify this run and no watched item failed verification — no in-run fix was
> required. gmk-vamp × Switchmod remains resolved in the feed (`current=84.99 USD
> source=SCRAPED`, correct CYL base, `resolvedAt=2026-09-08T04:58:33.141Z`, after
> the 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. Two zFrontier base-kit-picker
> resolutions now show their corrected base prices rather than the sub-kit values
> first reported — gmk-bent-r2 `150 USD` (reported 56) and gmk-arctic `145 USD`
> (reported 46), both `SCRAPED` and resolved, confirming the dearest-base-candidate
> pick. The nightly 00:30 UTC scheduled feed (run 34188881823, 04:58 sweep)
> re-stamped all 41 reports resolved at 2026-09-08T04:58:33.141Z, which this
> dispatch confirms.

> **2026-09-09 run.** Feed run 34368067632 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05/-06/-07/-08 runs added nothing), so there was nothing
> to re-verify this run and no watched item failed verification — no in-run fix was
> required. gmk-vamp × Switchmod remains resolved in the feed (`current=84.99 USD
> source=SCRAPED`, correct CYL base, `resolvedAt=2026-09-09T04:57:58.929Z`, after
> the 2026-08-26T17:39 submit). The four #153-corrected Ktechs listings also still
> read correctly — BRG R3 `113 SGD SCRAPED` (×3 reports) and Thunder God
> `169 SGD SCRAPED`, all resolved with no recurrence. The two zFrontier
> base-kit-picker resolutions still show their corrected base prices, not the
> sub-kit values first reported — gmk-bent-r2 `150 USD` (reported 56) and
> gmk-arctic `145 USD` (reported 46), both `SCRAPED` and resolved. Every one of
> the 41 reports carries `resolvedAt=2026-09-09T04:57:58.929Z` — the nightly
> 00:30 UTC scheduled feed sweep (run 34312994687, 04:57) that preceded this
> dispatch — which post-dates every submission, confirming nothing reverted.

> **2026-09-10 run.** Feed run 34493425965 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05/-06/-07/-08/-09 runs added nothing), so there was
> nothing to re-verify this run and no watched item failed verification — no
> in-run fix was required. gmk-vamp × Switchmod remains resolved in the feed
> (`current=84.99 USD source=SCRAPED`, correct CYL base,
> `resolvedAt=2026-09-10T05:01:22.737Z`, after the 2026-08-26T17:39 submit). The
> four #153-corrected Ktechs listings also still read correctly — BRG R3
> `113 SGD SCRAPED` (×3 reports) and Thunder God `169 SGD SCRAPED`, all resolved
> with no recurrence. The two zFrontier base-kit-picker resolutions still show
> their corrected base prices, not the sub-kit values first reported —
> gmk-bent-r2 `150 USD` (reported 56) and gmk-arctic `145 USD` (reported 46),
> both `SCRAPED` and resolved. Every one of the 41 reports carries
> `resolvedAt=2026-09-10T05:01:22.737Z` — the nightly 00:30 UTC scheduled feed
> sweep (run 34439410951, 05:01) that preceded this dispatch — which post-dates
> every submission, confirming nothing reverted.

> **2026-09-11 run.** Feed run 34614128533 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05/-06/-07/-08/-09/-10 runs added nothing), so there was
> nothing to re-verify this run and no watched item failed verification — no
> in-run fix was required. gmk-vamp × Switchmod remains resolved in the feed
> (`current=84.99 USD source=SCRAPED`, correct CYL base,
> `resolvedAt=2026-09-11T04:57:46.993Z`, after the 2026-08-26T17:39 submit). The
> four #153-corrected Ktechs listings also still read correctly — BRG R3
> `113 SGD SCRAPED` (×3 reports) and Thunder God `169 SGD SCRAPED`, all resolved
> with no recurrence. The two zFrontier base-kit-picker resolutions still show
> their corrected base prices, not the sub-kit values first reported —
> gmk-bent-r2 `150 USD` (reported 56) and gmk-arctic `145 USD` (reported 46),
> both `SCRAPED` and resolved. Every one of the 41 reports carries
> `resolvedAt=2026-09-11T04:57:46.993Z` — the nightly 00:30 UTC scheduled feed
> sweep (run 34564134770, 04:57) that preceded this dispatch — which post-dates
> every submission, confirming nothing reverted.

> **2026-09-12 run.** Feed run 34701109643 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05/-06/-07/-08/-09/-10/-11 runs added nothing), so there
> was nothing to re-verify this run and no watched item failed verification — no
> in-run fix was required. gmk-vamp × Switchmod remains resolved in the feed
> (`current=84.99 USD source=SCRAPED`, correct CYL base,
> `resolvedAt=2026-09-12T04:50:31.259Z`, after the 2026-08-26T17:39 submit). The
> four #153-corrected Ktechs listings also still read correctly — BRG R3
> `113 SGD SCRAPED` (×3 reports) and Thunder God `169 SGD SCRAPED`, all resolved
> with no recurrence. The two zFrontier base-kit-picker resolutions still show
> their corrected base prices, not the sub-kit values first reported —
> gmk-bent-r2 `150 USD` (reported 56) and gmk-arctic `145 USD` (reported 46),
> both `SCRAPED` and resolved. Every one of the 41 reports carries
> `resolvedAt=2026-09-12T04:50:31.259Z` — the nightly 00:30 UTC scheduled feed
> sweep (run 34674055986, 04:50) that preceded this dispatch — which post-dates
> every submission, confirming nothing reverted.

> **2026-09-13 run.** Feed run 34764508418 (`?all=1`) returns **41 submissions,
> all resolved, 0 pending** — a 1:1 match with the ledger's client-reported log,
> so **no new report** has filed since the 2026-08-27 run (the most recent
> submission is still **gmk-vamp × Switchmod**, 2026-08-26T17:39) and nothing is
> appended. The incoming **Self-heal watch was empty** (the 2026-08-28 run
> confirmed and cleared gmk-vamp × Switchmod, and the 2026-08-29/-30/-31 and
> 2026-09-01/-02/-03/-04/-05/-06/-07/-08/-09/-10/-11/-12 runs added nothing), so
> there was nothing to re-verify this run and no watched item failed verification
> — no in-run fix was required. gmk-vamp × Switchmod remains resolved in the feed
> (`current=84.99 USD source=SCRAPED`, correct CYL base,
> `resolvedAt=2026-09-13T05:08:11.559Z`, after the 2026-08-26T17:39 submit). The
> two zFrontier base-kit-picker resolutions still show their corrected base
> prices, not the sub-kit values first reported — gmk-bent-r2 `150 USD` (reported
> 56) and gmk-arctic `145 USD` (reported 46), both `SCRAPED` and resolved. The
> four #153-corrected Ktechs listings still read correctly, with **BRG R3 now
> `139 SGD SCRAPED`** (a re-scrape lifted it from the earlier 113 SGD — ≈103 USD,
> a more plausible GMK base; the BRG reports were stock-only, so the value was
> never disputed and this is an improvement, not a regression) and Thunder God
> `169 SGD SCRAPED`; all resolved with no recurrence. Every one of the 41 reports
> carries `resolvedAt=2026-09-13T05:08:11.559Z` — the nightly 00:30 UTC scheduled
> feed sweep (run 34739546170, 05:08) that preceded this dispatch — which
> post-dates every submission, confirming nothing reverted.

> **2026-09-14 run.** Price feed run 34859877107 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed since the 2026-08-27 run (most recent
> submission still **gmk-vamp × Switchmod**, 2026-08-26T17:39;
> `resolvedAt=2026-09-14T05:15:46.122Z`). The **Self-heal watch was empty**, so
> no price item needed re-verification and none failed. BRG R3 now reads
> `139 SGD SCRAPED` (as of 2026-09-13); gmk-bent-r2 `150 USD` and gmk-arctic
> `145 USD` still show their corrected base-kit prices.
>
> **This run also worked the visitor inbox** (feed run 34859880766) for the
> first full triage since the 2026-09-13 commit that added the inbox step —
> **31 unresolved `LISTING_FLAG`s + 1 FEEDBACK**. A read-only catalog inspector
> (`scripts/listing-flags-inspect.mjs`, new this run, dispatched as **Listing
> flags inspect** run 34860750705) gave ground truth on every flagged slug.
> **16 flags were confirmed resolved and cleared** (via the new **Resolve
> listing flags** workflow, run 34861241779):
> - **`obl-test-product-do-not-buy` ×8** — the `purgeTestProductListings` fix
>   (#d962ac3, 2026-09-13) actually removed the row; the inspector confirms **NO
>   GroupBuy row** with that slug. The most-reported item on the site, now gone.
> - **`gmk-cyl-masterpiece-r2-keycaps`, `gmk-cyl-windbreaker-keycaps`,
>   `gmk-cyl-hi-viz-r2-keycaps` (the CYL orphans) ×3** — **NO ROW**;
>   `mergeDuplicateKeycapSets` folded each into its `gmk-*` twin. Their survivors
>   (`gmk-masterpiece-r2`, `gmk-windbreaker`, `gmk-hi-viz-r2`) each show **no twin
>   shares their identity** — dedup complete, so their three `duplicate` flags
>   were cleared too.
> - **`gmk-cyl-kitsune-keycaps` (wrong_price) ×1** — **NO ROW** (orphan merged /
>   numpad-drop cleared, per the resolution audit). 
> - **`gh-110579` (inactive) ×1** — **NO ROW** (already removed).
>
> **15 flags remain open and are reported to the owner** (see §4) — all
> genuinely ambiguous or architecturally significant: two DELETE-level merge
> judgements the auto-merge deliberately won't make, empty duplicate keyboard
> rows (keyboards carry no auto-dedup by design), and stale / miscategorised
> geekhack GB rows. `kt-dyad-tkl`'s `wrong_vendor` cause is already fixed in code
> (#079b45f, Ktechs → SGD/SG) but its stored row still reads US pending a
> keyboard re-import, so it is held rather than cleared. The FEEDBACK item
> (collection display, 2026-06-24) is left for the owner.

> **2026-09-15 run.** Price feed run 34986060403 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39; `resolvedAt=2026-09-15T05:07:23.459Z`).
> The visitor inbox (feed run 34986063552) holds **15 `LISTING_FLAG`s + 1
> FEEDBACK — the SAME items already triaged and reported to the owner on
> 2026-09-14** (§4b); no new flags, nothing auto-resolvable, so the open set is
> unchanged. STORE_LINK / PRICE_REPORT / PHOTO_REPORT channels are all empty.
> The incoming **Self-heal watch was empty**, so no watched item needed
> re-verification.
>
> **One reversion surfaced and is reclassified `needs fix` (held for owner).**
> **gmk-bent-r2 × zFrontier** read `150 USD` in every feed from 2026-09-08
> through the 2026-09-14 run (run 34859877107 confirms `current=150 USD`); this
> run it reads **`56 USD` — the exact sub-kit value the 2026-07-20 reporter
> flagged** ("this price is not the price of the revival base kit; revival base
> kit has no stock"). A value that reverts across a scrape is the *never-heals*
> case (routine step 2), not a heal.
>
> Root cause traced (Vendor probe run 34986483070, `en.zfrontier.com` — an
> ordinary USD Shopify store, NOT the unreadable `www.zfrontier.com` SPA): the
> `[In Stock] GMK Bentō R2` listing has 10 variants, **none titled "base"** —
> `Traditional` 150 (available=**false**), `Revival` 150 (**false**), `Latin`
> 90, `Sakana` 73, `RAMA-Kanji` 73 (**true**), `Salmon` **56** (**true**),
> `Seafood` 56, `Chopsticks` 37, … The two real base colourways (150) are now
> **out of stock**; only cheaper alternate kits are in stock. Both variant
> pickers (`choose_kit_variant` in `scrape.py`, `pickBaseVariant` in
> `kit-variants.ts`) correctly return the **dearest base candidate = 150**
> regardless of stock — so the nightly scrape and every runner-IP price pass
> store 150. **The 56 comes from the JSON-LD/OpenGraph fallback**
> (`fetchJsonLdPrice`): when the Shopify `product.json` fetch is blocked or
> transient, the caller falls through to it, and this page's JSON-LD collapses
> to a single `ProductGroup` + representative `Offer` = **56** (`OG PRICE |
> 56.00 USD`, the cheapest in-stock variant). With no base-named sibling offer,
> the "ambiguous aggregate" guard does not fire, so 56 is stored — **bypassing
> the base-kit picker.**
>
> **Held for owner decision, not fixed in-run:** the repair touches the
> **shared Shopify→JSON-LD fallback used by the whole vendor roster**
> (`fetchJsonLdPrice` + the `generic_price` mirror in `scrape.py`), the exact
> production trigger (which IP/pass writes the 56, and how often) could not be
> reproduced or pinned from this environment, and the fix carries a genuine
> design choice (recognise a Shopify `ProductGroup` as a multi-variant marker
> and then **preserve** the last good picker price vs **clear** to
> `NO_BASE_KIT`) that interacts with `linkFailures`/back-off and every other
> Shopify store. Per the routine's genuine-ambiguity / architecturally-significant
> exception, this is brought to the owner with a recommended patch (below) rather
> than shipped speculatively. Recommendation: in `fetchJsonLdPrice` (and its
> `scrape.py` mirror), when the JSON-LD graph carries a `ProductGroup` and no
> base-named offer is identifiable, treat the lone representative `Offer` as an
> ambiguous aggregate and **return `null` (preserve the last good 150) rather
> than store the representative 56** — the Shopify `product.json` path remains
> the authority and a blocked run should not overwrite it downward.

> **2026-09-16 run.** Price feed run 35112937473 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39; `resolvedAt=2026-09-16T05:03:14.809Z`).
> Visitor inbox run 35112940830: the SAME **15 `LISTING_FLAG`s + 1 FEEDBACK**
> already triaged and reported to the owner on 2026-09-14 (§4b); no new flags,
> nothing auto-resolvable. STORE_LINK / PRICE_REPORT / PHOTO_REPORT channels are
> all empty.
>
> **gmk-bent-r2 × zFrontier — reversion confirmed as an OSCILLATION, root-caused,
> and FIXED in-run.** The item was reopened `needs fix` and held on 2026-09-15
> after reverting 150→56. This run the feed reads it back at **`150 USD SCRAPED`**
> — the value has now moved 150 (2026-09-08…-14) → 56 (2026-09-15) → 150
> (2026-09-16). A value that reverts across a scrape is the never-heals case
> (routine step 2), and a second data point confirms the diagnosis: the 56 is
> written by the JSON-LD/OpenGraph fallback whenever the Shopify `product.json`
> fetch is transiently blocked, so the row flips between the picker's 150 and the
> OG representative 56 run to run.
>
> The 2026-09-15 note held this as architecturally significant because the
> "preserve vs clear" design choice was unsettled and the trigger was
> unconfirmed. Both are now resolved: the oscillation confirms the mechanism, and
> the correct answer is unambiguously **preserve** (clearing would hide the
> listing on a released set). The resulting fix is minimal and **one-directional**
> — it can only make the OG fallback DECLINE to overwrite, never store a new
> number, clear a good one, or hide a listing — so it is no longer the risky
> shared-path change the hold was written for. Fixed this run (commit `633581d`):
> `htmlDeclaresVariantProductGroup` (in the pure, unit-tested `kit-variants`
> module) detects Shopify's multi-variant ProductGroup marker, and
> `fetchJsonLdPrice`'s OpenGraph branch preserves the last good base price when it
> is set. scrape.py needs no mirror (its `run_prices` uses `shopify_price` with a
> real browser, and `generic_price` has no OG `product:price` fallback for
> generic products, so the leak is TS-only). `test:kit-variants` extended; 201
> Python tests, all 20 npm suites, `tsc --noEmit` and `next lint` clean.
>
> The feed still auto-resolves the report each sweep (its `priceUpdatedAt`
> post-dates the 2026-07-20 submission), so **reversion — not the feed — remains
> the signal**. gmk-bent-r2 is placed on the Self-heal watch (§1b) so the next
> run confirms 150 holds and 56 does not return.
>
> The incoming **Self-heal watch was empty** apart from the held gmk-bent-r2,
> which this run fixed. gmk-vamp × Switchmod remains resolved
> (`current=84.99 USD source=SCRAPED`); the two other zFrontier base-kit
> resolutions still read correctly (gmk-arctic `145 USD`, gmk-tribal `175 USD`);
> the four #153-corrected Ktechs listings read `139/169 SGD SCRAPED`.

> **2026-09-17 run.** Price feed run 35238032205 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39; `resolvedAt=2026-09-17T05:05:53.901Z`,
> the nightly 00:30 UTC scheduled sweep, run 35184394541, that preceded this
> dispatch). Visitor inbox run 35238034954: the SAME **15 `LISTING_FLAG`s + 1
> FEEDBACK** already triaged and reported to the owner on 2026-09-14 (§4b); no new
> flags, nothing auto-resolvable. STORE_LINK / PRICE_REPORT / PHOTO_REPORT
> channels are all empty.
>
> **gmk-bent-r2 × zFrontier — fix CONFIRMED healed and cleared off the watch.**
> The incoming Self-heal watch held one item: the 2026-09-16 oscillation fix
> (commit `633581d`, `htmlDeclaresVariantProductGroup` + the OG-fallback
> preserve). This run the feed reads it **`current=150 USD source=SCRAPED`**, and
> its `resolvedAt=2026-09-17T05:05:53.901Z` post-dates both the fix commit and the
> nightly scrape — so the deployed code ran a scrape and the value held at the
> picker's 150; **56 did not return.** The oscillation (150→56→150) has not
> recurred: the value has now read 150 across the 2026-09-16 and 2026-09-17 feeds.
> The item is confirmed **resolved**, moved to the resolution audit, and dropped
> from the watch — which is now **empty**.
>
> The other prior resolutions still read correctly: gmk-vamp × Switchmod
> `84.99 USD SCRAPED` (correct CYL base); gmk-arctic `145 USD`, gmk-tribal
> `175 USD` (zFrontier base-kit picks); the #153-corrected Ktechs listings BRG R3
> `139 SGD SCRAPED` and Thunder God `169 SGD SCRAPED`. No item failed
> verification and no fresh report needs a fix, so no code change was required
> this run.

> **2026-09-18 run.** Price feed run 35360264326 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39; `resolvedAt=2026-09-18T04:58:26.177Z`,
> the nightly 00:30 UTC scheduled sweep that preceded this dispatch). Visitor
> inbox run 35360266667: the SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** already
> triaged and reported to the owner on 2026-09-14 (§4b); no new flags, nothing
> auto-resolvable. STORE_LINK / PRICE_REPORT / PHOTO_REPORT channels are all
> empty.
>
> The incoming **Self-heal watch was empty** — the one item it had held
> (gmk-bent-r2 × zFrontier) was confirmed healed and cleared on 2026-09-17 — so
> there was nothing to re-verify this run and no watched item failed
> verification. gmk-bent-r2 × zFrontier still reads **`current=150 USD
> source=SCRAPED`** in this feed: the picker's 150 held and **56 did not
> return**, so the 2026-09-16 oscillation fix (`633581d`) continues to hold two
> feeds past its confirmation. The other prior resolutions all still read
> correctly: gmk-vamp × Switchmod `84.99 USD SCRAPED` (correct CYL base);
> gmk-arctic `145 USD`, gmk-tribal `175 USD` (zFrontier base-kit picks); the
> #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED` and Thunder God
> `169 SGD SCRAPED`. No fresh report needs a fix, so no code change was required
> this run.

> **2026-09-19 run.** Price feed run 35450682557 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39). Every one of the 41 carries
> `resolvedAt=2026-09-19T04:51:03.046Z` — the nightly 00:30 UTC scheduled sweep
> (run 35422385674, 04:50) that preceded this dispatch — which post-dates every
> submission, confirming nothing reverted. Visitor inbox run 35450683533: the
> SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** already triaged and reported to the
> owner on 2026-09-14 (§4b); no new flags, nothing auto-resolvable. STORE_LINK /
> PRICE_REPORT / PHOTO_REPORT channels are all empty.
>
> The incoming **Self-heal watch was empty** (gmk-bent-r2 × zFrontier was
> confirmed healed and cleared on 2026-09-17), so there was nothing to re-verify
> this run and no watched item failed verification. gmk-bent-r2 × zFrontier still
> reads **`current=150 USD source=SCRAPED`**: the picker's 150 held and **56 did
> not return**, so the 2026-09-16 oscillation fix (`633581d`), further hardened
> by #186 (`b3f7076`, the unnamed-offer-list guard) landed since the last run,
> continues to hold. The other prior resolutions all still read correctly:
> gmk-vamp × Switchmod `84.99 USD SCRAPED` (correct CYL base); gmk-arctic
> `145 USD`, gmk-tribal `175 USD` (zFrontier base-kit picks); the #153-corrected
> Ktechs listings BRG R3 `139 SGD SCRAPED` and Thunder God `169 SGD SCRAPED`. No
> fresh report needs a fix, so no code change was required this run.

> **2026-09-20 run.** Price feed run 35518742559 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39). Every one of the 41 carries
> `resolvedAt=2026-09-20T05:09:46.581Z` — the nightly 00:30 UTC scheduled sweep
> (run 35490963760, 05:09) that preceded this dispatch — which post-dates every
> submission, confirming nothing reverted. Visitor inbox run 35518744142: the
> SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** already triaged and reported to the
> owner on 2026-09-14 (§4b); no new flags, nothing auto-resolvable. STORE_LINK /
> PRICE_REPORT / PHOTO_REPORT channels are all empty.
>
> The incoming **Self-heal watch was empty** (gmk-bent-r2 × zFrontier was
> confirmed healed and cleared on 2026-09-17), so there was nothing to re-verify
> this run and no watched item failed verification. gmk-bent-r2 × zFrontier still
> reads **`current=150 USD source=SCRAPED`**: the picker's 150 held and **56 did
> not return**, so the 2026-09-16 oscillation fix (`633581d`), hardened by #186
> (`b3f7076`, the unnamed-offer-list guard), continues to hold. The other prior
> resolutions all still read correctly: gmk-vamp × Switchmod `84.99 USD SCRAPED`
> (correct CYL base); gmk-arctic `145 USD`, gmk-tribal `175 USD` (zFrontier
> base-kit picks); the #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED`
> and Thunder God `169 SGD SCRAPED`. No fresh report needs a fix, so no code
> change was required this run.

> **2026-09-21 run.** Price feed run 35617267838 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39). Every one of the 41 carries
> `resolvedAt=2026-09-21T05:15:23.447Z` — the nightly 00:30 UTC scheduled sweep
> (run 35563878328, 05:15) that preceded this dispatch — which post-dates every
> submission, confirming nothing reverted. Visitor inbox run 35617271419: the
> SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** already triaged and reported to the
> owner on 2026-09-14 (§4b); no new flags, nothing auto-resolvable. STORE_LINK /
> PRICE_REPORT / PHOTO_REPORT channels are all empty.
>
> The incoming **Self-heal watch was empty** (gmk-bent-r2 × zFrontier was
> confirmed healed and cleared on 2026-09-17), so there was nothing to re-verify
> this run and no watched item failed verification. gmk-bent-r2 × zFrontier still
> reads **`current=150 USD source=SCRAPED`**: the picker's 150 held and **56 did
> not return**, so the 2026-09-16 oscillation fix (`633581d`), hardened by #186
> (`b3f7076`, the unnamed-offer-list guard), continues to hold. The other prior
> resolutions all still read correctly: gmk-vamp × Switchmod `84.99 USD SCRAPED`
> (correct CYL base); gmk-arctic `145 USD`, gmk-tribal `175 USD` (zFrontier
> base-kit picks); the #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED`
> and Thunder God `169 SGD SCRAPED`.
>
> One benign change of record: **gmk-monochrome-dolch × Neo Macro** now reports
> `source=LOCKED` (was resolved off-feed via plausibility bounds). neomacro.in
> is newly recognised as a closed/frozen storefront by #187 (password gate) and
> #188 (402 non-payment freeze), so its stored `15500 INR` no longer counts as a
> live SCRAPED price. The report is **resolved, not pending, and not on the
> watch** — nothing to act on this run. No fresh report needs a fix, so no code
> change was required this run.

> **2026-09-22 run.** Price feed run 35745601228 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39). Every one of the 41 carries
> `resolvedAt=2026-09-22T05:13:45.060Z` — the nightly 00:30 UTC scheduled sweep
> (run 35689881159, 05:13) that preceded this dispatch — which post-dates every
> submission, confirming nothing reverted. Visitor inbox run 35745607064: the
> SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** already triaged and reported to the
> owner on 2026-09-14 (§4b); no new flags, nothing auto-resolvable. STORE_LINK /
> PRICE_REPORT / PHOTO_REPORT channels are all empty.
>
> The incoming **Self-heal watch was empty** (gmk-bent-r2 × zFrontier was
> confirmed healed and cleared on 2026-09-17), so there was nothing to re-verify
> this run and no watched item failed verification. gmk-bent-r2 × zFrontier still
> reads **`current=150 USD source=SCRAPED`**: the picker's 150 held and **56 did
> not return**, so the 2026-09-16 oscillation fix (`633581d`), hardened by #186
> (`b3f7076`, the unnamed-offer-list guard), continues to hold. The other prior
> resolutions all still read correctly: gmk-vamp × Switchmod `84.99 USD SCRAPED`
> (correct CYL base); gmk-arctic `145 USD`, gmk-tribal `175 USD` (zFrontier
> base-kit picks); the #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED`
> and Thunder God `169 SGD SCRAPED`.
>
> One benign change of record: **gmk-monochrome-dolch × Neo Macro** reads
> `15500 INR source=SCRAPED` again this run (it had shown `source=LOCKED` on
> 2026-09-21, when neomacro.in was seen as a frozen/closed storefront). 15,500 INR
> ≈ 186 USD is a plausible GMK base within `KIT_BOUNDS`, the report is **resolved,
> not pending, and not on the watch**, and the flip back to SCRAPED just means the
> store answered a real scrape — nothing to act on. No fresh report needs a fix,
> so no code change was required this run.

> **2026-09-23 run.** Price feed run 35880192976 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39). Every one of the 41 carries
> `resolvedAt=2026-09-23T04:58:15.125Z` — the nightly 00:30 UTC scheduled sweep
> (run 35820474021, 04:58) that preceded this dispatch — which post-dates every
> submission, confirming nothing reverted. Visitor inbox run 35880198466: the
> SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** already triaged and reported to the
> owner on 2026-09-14 (§4b); no new flags, nothing auto-resolvable. STORE_LINK /
> PRICE_REPORT / PHOTO_REPORT channels are all empty.
>
> The incoming **Self-heal watch was empty** (gmk-bent-r2 × zFrontier was
> confirmed healed and cleared on 2026-09-17), so there was nothing to re-verify
> this run and no watched item failed verification. gmk-bent-r2 × zFrontier still
> reads **`current=150 USD source=SCRAPED`**: the picker's 150 held and **56 did
> not return**, so the 2026-09-16 oscillation fix (`633581d`), hardened by #186
> (`b3f7076`, the unnamed-offer-list guard), continues to hold. The other prior
> resolutions all still read correctly: gmk-vamp × Switchmod `84.99 USD SCRAPED`
> (correct CYL base); gmk-arctic `145 USD`, gmk-tribal `175 USD` (zFrontier
> base-kit picks); the #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED`
> and Thunder God `169 SGD SCRAPED`.
>
> One benign change of record recurs: **gmk-monochrome-dolch × Neo Macro** reads
> `source=LOCKED` this run (it had shown `15500 INR SCRAPED` on 2026-09-22 and
> `LOCKED` on 2026-09-21). neomacro.in flips between a live SCRAPED price and the
> closed/frozen-storefront verdict (#187 password gate / #188 402 freeze) run to
> run depending on whether the store answered a real scrape; either way the
> stored 15,500 INR ≈ 186 USD is a plausible GMK base within `KIT_BOUNDS`. The
> report is **resolved, not pending, and not on the watch** — nothing to act on.
> No fresh report needs a fix, so no code change was required this run.

> **2026-09-24 run.** Price feed run 36018872234 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39). Every one of the 41 carries
> `resolvedAt=2026-09-24T05:09:03.623Z` — the nightly 00:30 UTC scheduled sweep
> (run 35958667688, 05:08) that preceded this dispatch — which post-dates every
> submission, confirming nothing reverted. Visitor inbox run 36018876149: the
> SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** already triaged and reported to the
> owner on 2026-09-14 (§4b); no new flags, nothing auto-resolvable. STORE_LINK /
> PRICE_REPORT / PHOTO_REPORT channels are all empty.
>
> The incoming **Self-heal watch was empty** (gmk-bent-r2 × zFrontier was
> confirmed healed and cleared on 2026-09-17), so there was nothing to re-verify
> this run and no watched item failed verification. gmk-bent-r2 × zFrontier still
> reads **`current=150 USD source=SCRAPED`**: the picker's 150 held and **56 did
> not return**, so the 2026-09-16 oscillation fix (`633581d`), hardened by #186
> (`b3f7076`, the unnamed-offer-list guard), continues to hold. The other prior
> resolutions all still read correctly: gmk-vamp × Switchmod `84.99 USD SCRAPED`
> (correct CYL base); gmk-arctic `145 USD`, gmk-tribal `175 USD` (zFrontier
> base-kit picks); the #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED`
> and Thunder God `169 SGD SCRAPED`.
>
> The **gmk-monochrome-dolch × Neo Macro** change of record continues to flip:
> this run it reads `15500 INR source=SCRAPED` again (it had shown `source=LOCKED`
> on 2026-09-23). neomacro.in flips between a live SCRAPED price and the
> closed/frozen-storefront verdict (#187 password gate / #188 402 freeze) run to
> run depending on whether the store answered a real scrape; either way the stored
> 15,500 INR ≈ 186 USD is a plausible GMK base within `KIT_BOUNDS`. The report is
> **resolved, not pending, and not on the watch** — nothing to act on. No fresh
> report needs a fix, so no code change was required this run.

> **2026-09-25 run.** Price feed run 36152515909 (`?all=1`) returns **41
> submissions, all resolved, 0 pending** — a 1:1 match with the client-reported
> log, so **no new price report** has filed (most recent submission still
> **gmk-vamp × Switchmod**, 2026-08-26T17:39). Every one of the 41 carries
> `resolvedAt=2026-09-25T05:11:00.983Z` — the nightly 00:30 UTC scheduled sweep
> that preceded this dispatch — which post-dates every submission, confirming
> nothing reverted.
>
> The incoming **Self-heal watch was empty** (gmk-bent-r2 × zFrontier was
> confirmed healed and cleared on 2026-09-17), so there was nothing to re-verify
> this run and no watched item failed verification. gmk-bent-r2 × zFrontier still
> reads **`current=150 USD source=SCRAPED`**: the picker's 150 held and **56 did
> not return**, so the 2026-09-16 oscillation fix (`633581d`), hardened by #186
> (`b3f7076`, the unnamed-offer-list guard), continues to hold. The other prior
> resolutions all still read correctly: gmk-vamp × Switchmod `84.99 USD SCRAPED`
> (correct CYL base); gmk-arctic `145 USD`, gmk-tribal `175 USD` (zFrontier
> base-kit picks); the #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED`
> and Thunder God `169 SGD SCRAPED`. The **gmk-monochrome-dolch × Neo Macro**
> change of record continues to flip: this run it reads `source=LOCKED` (it had
> shown `15500 INR SCRAPED` on 2026-09-24). neomacro.in flips between a live
> SCRAPED price and the closed/frozen-storefront verdict (#187 password gate /
> #188 402 freeze) run to run; either way the stored 15,500 INR ≈ 186 USD is a
> plausible GMK base within `KIT_BOUNDS`. The report is **resolved, not pending,
> and not on the watch** — nothing to act on.
>
> **Visitor inbox run 36152519119: one NEW `LISTING_FLAG`, triaged and cleared
> in-run — the other 15 are the known open set unchanged.** The feed returned
> **16 `LISTING_FLAG`s + 1 FEEDBACK**; STORE_LINK / PRICE_REPORT / PHOTO_REPORT
> all empty. The new flag is **`obl-test-product-do-not-buy` (issue=other,
> flagged 2026-09-25**, note "this is a test product why you even list it",
> id=cmugqgpw9000004jtiko7npy4) — a **re-report of the item this ledger already
> closed on 2026-09-14** (`purgeTestProductListings` + `isTestProduct`, #d962ac3,
> cleared ×8). Routine step 2 treats a re-report of a closed item as a "did NOT
> heal → investigate now", so it was inspected rather than assumed: the read-only
> inspector (run 36152737146) confirms **NO GroupBuy row with this slug** — the
> fix is **holding**, the row is genuinely gone, and this is a stale re-report
> filed against the memory of the old listing, **not a regression**. No scraper
> fix is warranted (both dedup halves are correct and in place). The flag was
> cleared by id via the **Resolve listing flags** workflow (run 36152863577,
> "Resolved 1 flag(s)") and recorded in §4a. The remaining **15 flags are
> byte-for-byte the same open set triaged and reported to the owner on 2026-09-14**
> (§4b) — no new flags among them, nothing auto-resolvable, inspector states
> unchanged. The FEEDBACK item (collection display, 2026-06-24) remains for the
> owner. No price/scraper code change was required this run.
> **2026-09-26 run — SIX new pending reports, all filed by the released deals
> audit (batch 1, #194).** Price feed run 36230256871 (`?all=1`) returns **47
> submissions, 41 resolved + 6 PENDING**. The 41 resolved are a 1:1 match with the
> prior client-reported log; the 6 pending all carry `submittedAt=2026-09-26T06:24`
> and were filed by the **released deals audit** (`scripts/released-deals-audit.mjs`,
> audit run 36223373383, reports run 36223666503 — see
> `docs/released-deals-audit-ledger.md`), not by an end user. Visitor inbox run
> 36230260348 echoes the same 6 in its PRICE_REPORT channel; its LISTING_FLAG block
> is the **same 15 flags + 1 FEEDBACK** triaged and reported to the owner on
> 2026-09-14 (§4b), byte-for-byte unchanged — no new flags, nothing auto-resolvable.
> STORE_LINK / PHOTO_REPORT empty. The incoming **Self-heal watch was empty**, so
> nothing prior needed re-verification and nothing failed.
>
> The 6 pending split into three dispositions:
>
> - **gmk-teradrive × Mekibo (210 USD) and gmk-monarch × Mekibo (200 USD) — wrong
>   variant, ALREADY FIXED in current codebase (#194, commit `856f1df`).** The
>   audit found Mekibo's `[Bundle] Base + JIS Mod` (210) and `[Bundle] Base + Core`
>   (200) priced as base against plain Base Kits of 165 and 145. #194 added
>   `\bcore\b`/`\bjis\b` to `BUNDLE_EXTRA_RE` **and** made a title that calls itself
>   a bundle classify BUNDLE (`BUNDLE_WORD_RE`), in both `kit-variants.ts` and
>   `scrape.py` (pinned in both suites). Verified the diff: both variants now
>   classify BUNDLE, so `pickBaseVariant`/`choose_kit_variant` return the plain
>   Base Kit. The fix is deployed on `main`; the stored 210/200 will correct to
>   165/145 on the next scrape. **No new code needed** — placed on the Self-heal
>   watch (§1b) to confirm the re-scrape lands the base prices. Recommended values
>   (165 / 145 USD) verified: both within `KIT_BOUNDS` and exactly what the picker
>   now returns.
>
> - **gmk-hazakura × DeskHero (246 CAD) and gmk-panda × iLumKB (229 SGD) —
>   stock-only, self-heal.** Both prices are correct (the audit's Vendor probe,
>   run 36223526130, confirms them); the complaint is that the base variant is
>   sold out at the store while the site shows it in stock. DeskHero: plain "Base
>   Kit" (246) sold out qty 0, "Base Kit - Hiragana" (246) in stock — a purchasable
>   base at the same price still exists. iLumKB: "Base" (229) `available=false`,
>   only Spacebars + the 329 bundle buyable. The price pass reads the actual base
>   variant's availability and is the sole authority for `inStock=true` (#153), so
>   the next availability scrape marks the row correctly. No code cause (not a
>   `LINK_OVERRIDES` row, no override re-asserting stock). Placed on the Self-heal
>   watch to confirm.
>
> - **gmk-monochrome-dolch × Neo Macro (15,500 INR) and gmk-black-snail × Neo Macro
>   (6,500 INR) — closed store shown as a live deal; NEEDS FIX, held for owner
>   (architecturally significant).** Both read `source=LOCKED`: neomacro.in is
>   password-gated (#187 gate / #188 402 freeze), so the store cannot sell anything
>   right now. But a LOCKED row deliberately keeps `inStock=true` and its
>   `compareAtPrice` markdown (CLAUDE.md: LOCKED rows stay visible because the store
>   reopens), so it still satisfies `ON_SALE_FILTER` (`price != null AND
>   compareAtPrice != null AND inStock=true`) and surfaces on `/released?deals=1`
>   and the "On sale now" rail as an in-stock discount ("was 17000, now 15500"). The
>   prices themselves are plausible (15,500 INR ≈ 186 USD, 6,500 INR ≈ 78 USD, both
>   in `KIT_BOUNDS`) and the feed auto-resolves the report each sweep, so this is a
>   **never-heals-via-feed** display bug, not a price bug. The `ON_SALE_FILTER`'s
>   own comment states its intent — "a discount on a listing nobody can buy is a
>   price-history footnote, not a deal" — and a LOCKED store is exactly a listing
>   nobody can buy, so excluding LOCKED from the deals surface *completes* that
>   intent. **Held for the owner** rather than shipped: (a) the #194 deals-audit
>   author explicitly deferred this exact decision hours earlier
>   (`docs/released-deals-audit-ledger.md`: "Worth deciding whether a LOCKED row
>   should drop out of the deals filter"); (b) it is a display-policy change on a
>   newly-shipped feature spanning multiple surfaces (`ON_SALE_FILTER`, the
>   `bundleSetIds` raw-SQL scan, the markdowns rail, the savings/`AVAILABLE_FILTER`
>   rail, the home page and `SetCard`) that must move together to be consistent;
>   and (c) the correct SCOPE is genuinely open — deals-rail-only vs treating LOCKED
>   as not-buyable everywhere, the latter conflicting with CLAUDE.md's deliberate
>   rule that LOCKED rows stay visible on set pages. Per the routine's
>   genuine-ambiguity / architecturally-significant exception, this is brought to
>   the owner with a recommended minimal patch (below) rather than committed
>   speculatively over a peer session's explicit deferral.
>
>   **Recommended patch (owner to approve):** add `priceSource: { not: "LOCKED" }`
>   to the `some` block of `ON_SALE_FILTER` (and mirror it in the `bundleSetIds`
>   SQL as `AND vk."priceSource" IS DISTINCT FROM 'LOCKED'`) so a closed store's
>   markdown stops counting as a buyable deal, while its row stays visible on the
>   set page exactly as today. Scope the change to the deals surfaces only; do not
>   touch `PURCHASABLE_VENDOR_KIT_WHERE`.
>
>   **UPDATE — owner approved, FIXED this run.** The owner reviewed the two
>   dispositions and said "follow your recommendation," so the recommended patch
>   was implemented in `src/app/api/released/route.ts`: `ON_SALE_FILTER`'s `some`
>   now carries `priceSource: { not: "LOCKED" }` (Prisma's `not` still returns
>   null-priceSource rows, so ordinary scraped listings stay), and the
>   `bundleSetIds` raw SQL now carries `AND vk."priceSource" IS DISTINCT FROM
>   'LOCKED'` (which likewise keeps null rows, matching the Prisma half). Scope is
>   the two deals surfaces only — `PURCHASABLE_VENDOR_KIT_WHERE` and the set page
>   are untouched, so a LOCKED listing still shows on its set page as before, it
>   just stops being counted as an in-stock deal on `/released?deals=1` and the
>   "On sale now" / bundles rails. `tsc --noEmit`, `next lint`, and the JS unit
>   suites all pass; no suite covers the released route directly, so the type
>   check + lint are the gate. Both Neo Macro rows move to the Self-heal watch to
>   confirm they drop off the deals rail on the next `/released?deals=1` load.
>
> The other prior resolutions all still read correctly in this feed: gmk-vamp ×
> Switchmod `84.99 USD SCRAPED`; gmk-bent-r2 × zFrontier `150 USD SCRAPED` (56 has
> not returned since the `633581d` fix); gmk-arctic `145 USD`, gmk-tribal
> `175 USD`; the #153-corrected Ktechs listings BRG R3 `139 SGD SCRAPED` and
> Thunder God `169 SGD SCRAPED`.

> **2026-09-26 confirmation run (15:11 UTC dispatch).** Price feed run 36251045585
> (`?all=1`) returns **47 submissions, all resolved, 0 PENDING** — the 6
> deals-audit reports filed on the earlier 2026-09-26 run have all auto-resolved.
> Visitor inbox run 36251049494: STORE_LINK / PRICE_REPORT / PHOTO_REPORT all
> empty; **15 `LISTING_FLAG`s + 1 FEEDBACK**, byte-for-byte the same open set
> triaged and reported to the owner on 2026-09-14 (§4b) — no new flags, nothing
> auto-resolvable.
>
> **All six Self-heal-watch items (added the earlier 2026-09-26 run) are
> CONFIRMED healed and cleared** — a price scrape ran after the #194 / deals-filter
> deploys and the feed proves each one:
>
> - **gmk-teradrive × Mekibo — healed.** Feed reads `current=165 USD source=SCRAPED`
>   (was the `[Bundle] Base + JIS Mod` 210). The #194 bundle-classification fix
>   (`856f1df`) re-scraped the plain Base Kit exactly as predicted. Recommended
>   value USD 165 now stored, not just verified in the diff.
> - **gmk-monarch × Mekibo — healed.** Feed reads `current=145 USD source=SCRAPED`
>   (was the `[Bundle] Base + Core` 200). Same #194 fix; USD 145 now stored.
> - **gmk-hazakura × DeskHero — healed (stock).** `246 CAD SCRAPED`, resolved after
>   a scrape post-dating the submit; the base price was correct throughout and an
>   in-stock base (the Hiragana variant, same 246) exists, so the availability
>   complaint no longer holds. Not a `LINK_OVERRIDES` row.
> - **gmk-panda × iLumKB — healed (stock).** `229 SGD SCRAPED`, resolved; the base
>   price is correct and unchanged (the 2026-08-10 spacebar report already fixed the
>   pick to 229). The price pass is the sole authority for `inStock` (#153), so the
>   availability scrape settles it.
> - **gmk-monochrome-dolch × Neo Macro — healed (deals filter).** Feed reads
>   `15500 INR source=LOCKED`. The deals-filter fix (`00d138a`) is deployed —
>   production served both this run's feeds at `head_sha=00d138a` — and
>   `ON_SALE_FILTER` + the `bundleSetIds` scan now exclude `priceSource=LOCKED`
>   unconditionally, so a LOCKED row cannot surface on `/released?deals=1` or the
>   "On sale now" / bundles rails by construction. The set page still shows the
>   vendor row (unchanged `PURCHASABLE_VENDOR_KIT_WHERE`). Production's live deals
>   payload was not fetched directly (this session's egress to production is
>   blocked; runners are the reachable path and already proved the deployed
>   `head_sha`) — the confirmation is the deterministic code guarantee, which is
>   stronger than a scrape outcome.
> - **gmk-black-snail × Neo Macro — healed (deals filter).** Same as above,
>   `6500 INR source=LOCKED`, excluded from the deals surfaces by the same fix.
>
> **No item failed verification, no fresh report is pending, and no new listing
> flag arrived, so no code change was required this run.** The watch is now empty.
> The other prior resolutions still read correctly: gmk-vamp × Switchmod
> `84.99 USD SCRAPED`; gmk-bent-r2 × zFrontier `150 USD SCRAPED` (56 not returned
> since `633581d`); gmk-arctic `145 USD`, gmk-tribal `175 USD`; the #153-corrected
> Ktechs listings BRG R3 `139 SGD SCRAPED` and Thunder God `169 SGD SCRAPED`.

> **2026-09-27 run — TWO new reports (both filed by the deals audit batch 2, #195),
> both already fixed/self-healing; watch to confirm.** Price feed run 36328618481
> (`?all=1`) returns **49 submissions, all resolved, 0 PENDING**. The 47 prior are a
> 1:1 match with the client-reported log; the **2 new** both carry
> `submittedAt=2026-09-27T01:55` and were filed by the **released deals audit batch 2**
> (`#195`, commit `6ca0d95`), not by an end user, and both auto-resolved via the
> feed (`resolvedAt=2026-09-27T14:41:27.261Z`, a scrape post-dating the submit).
> Visitor inbox run 36328620218: STORE_LINK / PRICE_REPORT / PHOTO_REPORT all
> empty; **15 `LISTING_FLAG`s + 1 FEEDBACK**, byte-for-byte the same open set
> triaged and reported to the owner on 2026-09-14 (§4b) — no new flags, nothing
> auto-resolvable. The incoming **Self-heal watch was empty** (the six 2026-09-26
> items were all confirmed healed on the 2026-09-26 confirmation run), so nothing
> prior needed re-verification and nothing failed.
>
> The 2 new reports:
>
> - **gmk-panda × iLumKB (229 SGD) — RECURRENCE (3rd report: 2026-08-10, 2026-09-26,
>   2026-09-27), root cause ALREADY FIXED in #195 (`6ca0d95`).** The store's plain
>   "Base" (SGD 229) is sold out beside an in-stock "Base+Nov+Space" bundle (SGD 329).
>   `nov`/`space` named no extra the bundle vocabulary knew, so the bundle classified
>   BASE; stock is read across every BASE variant, so the sold-out base kit showed as
>   buyable on `/released`. Per routine step 3 a recurrence for the same reason is a
>   `needs fix` whatever the row reads — but #195 already root-caused and fixed it:
>   `nov`/`space` joined `BUNDLE_EXTRA_RE` in **both** `kit-variants.ts` and
>   `scrape.py` (verified in code this run), and the fix is pinned in both suites
>   (`Base+Nov+Space` → BUNDLE). The price 229 SGD itself is correct and was never
>   disputed — the complaint is stock. The fix is deployed on `main`; the price pass
>   is the sole authority for `inStock` (#153), so the next availability scrape reads
>   only the real (sold-out) Base variant and marks the row `inStock=false`. **No new
>   code needed** — placed on the Self-heal watch (§1b) to confirm the re-scrape marks
>   the base sold out and it does not recur a 4th time.
>
> - **gmk-zm × SwitchKeys (229.99 AUD) — dead link (404), self-heals.** The deals
>   audit found switchkeys.com.au answers **404** for `gmik-zimo-group-buy` (and for
>   `/products/gmk-zimo-group-buy` and `gmk-cyl-zimo`), yet the row still reads
>   `229.99 AUD SCRAPED` from the last good scrape. A 404 is handled by the existing
>   dead-link machinery: the price pass marks the row `DEAD_LINK`, clears the price to
>   null, and hands it back on the next discovery rotation (CLAUDE.md link-health).
>   The report re-queued the listing (cleared `priceUpdatedAt`), so the next price
>   pass reaches the 404 and clears it. **No code change** — placed on the Self-heal
>   watch to confirm the price clears / the row goes dead. If it never heals (value
>   survives across scrapes, or it recurs), a future run treats it as a never-heals
>   and drops the vendor-set pair.
>
> The other prior resolutions all still read correctly in this feed: gmk-vamp ×
> Switchmod `84.99 USD SCRAPED`; gmk-bent-r2 × zFrontier `150 USD SCRAPED` (56 not
> returned since `633581d`); gmk-arctic `145 USD`, gmk-tribal `175 USD`; the two
> Mekibo #194 fixes `165`/`145 USD SCRAPED`; the #153-corrected Ktechs listings
> BRG R3 `139 SGD SCRAPED` and Thunder God `169 SGD SCRAPED`. The two Neo Macro
> deals-filter rows remain resolved (`00d138a`).

> **2026-09-28 run — THREE new deals-audit reports (batch 3, #198), all healed;
> both prior watch items resolved (one via deep investigation).** Price feed run
> 36441926692 (`?all=1`) returns **52 submissions, all resolved, 0 PENDING**. The
> 49 prior match the client-reported log; the **3 new** all carry
> `submittedAt=2026-09-28T01:55` and were filed by the **released deals audit
> batch 3** (`#198`, commit `6f36882`), not an end user. Visitor inbox run
> 36441929944: STORE_LINK / PRICE_REPORT / PHOTO_REPORT all empty; **15
> `LISTING_FLAG`s + 1 FEEDBACK**, byte-for-byte the same open set triaged and
> reported to the owner on 2026-09-14 (§4b) — no new flags, nothing
> auto-resolvable.
>
> The 3 new reports (all healed this run):
>
> - **gmk-black-snail × Neo Macro (was 6,500 INR) and
>   gmk-black-snail---red-cyrillic-addon × Neo Macro — wrong variant, FIXED #198
>   (`6f36882`).** neomacro.in sells no base kit for Black Snail; the picker took
>   the dearest unlabeled line, the **U9 Modifier Kit** (INR 6500). #198 added
>   `modifier` and `retro point` to `NONBASE_SUBKIT_RE` (and the TS bundle
>   vocabulary; scrape.py composes its copy from the mirror) — verified present in
>   both `src/lib/kit-variants.ts` and `scraper/scrape.py` this run. The row now
>   clears to `NO_BASE_KIT`: the feed reads **`current=null`** for both rows,
>   `resolvedAt` post-dating the submit. Healed.
> - **gmk-mothman × GEONWORKS (was USD 150) — dead link (front-door redirect),
>   self-healed.** `geon.works/products/group-buy-gmk-cyl-mothman` 302s to
>   `geon.works/` (no product). `isGoneRedirect` marks it `DEAD_LINK` and clears
>   the price; the feed reads **`current=null USD`**. Healed.
>
> **Incoming Self-heal watch (added 2026-09-27) — both resolved:**
>
> - **gmk-panda × iLumKB — CONFIRMED healed (#195).** Vendor probe (run
>   36441929944… i.e. 36442068057) confirms the store's plain **Base (SGD 229) is
>   `available=false` (sold out)**, with only Spacebars and the in-stock
>   **Base+Nov+Space bundle (SGD 329)** buyable. #195 (`6ca0d95`) classifies the
>   `nov`/`space` bundle as BUNDLE (verified in both halves), so the picker returns
>   the real (sold-out) Base and the price pass — sole authority for `inStock`
>   (#153) — marks the row sold out. Price 229 SGD is correct and was never
>   disputed. **No 4th recurrence** (latest report still 2026-09-27). Resolved,
>   dropped from the watch.
> - **gmk-zm × SwitchKeys — NOT a dead link; the "dead link" report was a FALSE
>   POSITIVE. Listing is LIVE, priced 229.99 AUD; a relink nuance is raised for the
>   owner.** The 2026-09-27 deals-audit report ("switchkeys.com.au 404s the product
>   URL") did not self-heal — the row still read `229.99 AUD SCRAPED` a full day and
>   a nightly scrape later, and a FORCE refresh (`36443092241`, `dead=1070`) did not
>   clear it. Root-caused: the reporter/audit tested the **collection-scoped** URL
>   (`/collections/current-group-buys/products/gmik-zimo-group-buy`, which 404s
>   because the product was removed from that collection) and the *corrected* handle
>   `/products/gmk-zimo-group-buy` (also 404). But the price pass strips the
>   collection prefix (`normalizeShopifyUrl`) to the **stored typo handle**
>   `/products/gmik-zimo-group-buy`, which a probe (run 36444934333) shows
>   **301-redirects → `/products/gmik-zimo` → `/products/gmk-zimo` (200)** — a
>   **live product, "GMK Zimo"**. A targeted re-scrape by VendorKit id
>   (`cmq585yjj03j0b17dsjv05k5w`, run 36445670318) returned **`attempted=1
>   updated=1 dead=0`** and re-stored a valid price (229.99 AUD ≈ USD 150, within
>   `KIT_BOUNDS`). So the row is **live and plausibly priced**, not dead — there is
>   no scrape bug and nothing to clear. Why it never cleared before: the report
>   re-queued it (`priceUpdatedAt=null`), but the pass that reached it read the live
>   product (kept the price) rather than a 404, and the 2000-row FORCE batch
>   (nulls-first, `limit=2000`) did not include it among the null backlog — so only
>   a targeted `PRICE_REFRESH_IDS` re-scrape reliably reaches it. **Open owner
>   item (genuine ambiguity):** the probe also shows the store's *current in-stock*
>   "GMK Zimo" is `/products/gmk-zimo` with a **Base at 165 AUD**, a DIFFERENT
>   product from the one the row prices (229.99). Discovery will not auto-relink a
>   *priced* row (CLAUDE.md: a link the price pass reads successfully is not a
>   homepage anchor's to replace), so the row stays on the old GB product. Whether
>   to relink it to `/products/gmk-zimo` (showing the current 165 AUD in-stock
>   price) or keep the 229.99 GB SKU is a discovery/catalog judgment with two real
>   SKUs in play — brought to the owner rather than forced. Dropped from the
>   auto-watch (live + stable); tracked as an open owner item (§1).
>
> **Tooling:** the price-reports feed now prints the VendorKit `id` on each line
> (commit `cf67ecb`), so the routine can force a re-scrape of one specific reported
> listing via `refresh-prices`' `PRICE_REFRESH_IDS` — which is what settled gmk-zm.
>
> The other prior resolutions still read correctly in this feed: gmk-vamp ×
> Switchmod `84.99 USD SCRAPED`; gmk-bent-r2 × zFrontier `150 USD SCRAPED` (56 not
> returned since `633581d`); gmk-arctic `145 USD`, gmk-tribal `175 USD`; the two
> Mekibo #194 fixes `165`/`145 USD SCRAPED`; the #153-corrected Ktechs listings BRG
> R3 `139 SGD SCRAPED` and Thunder God `169 SGD SCRAPED`; the two Neo Macro
> deals-filter rows remain resolved (`00d138a`).

> **2026-09-30 run.** Price feed run 36734965401 (`?all=1`) returns **0 pending,
> 56 resolved** — every report auto-resolves each sweep, so RECURRENCE and the
> stored value, not the feed, are the signals. This run reconciled the reports
> the deals audit filed as batches 4 (2026-09-29, #199) and 5 (2026-09-30, #200),
> four in all. Visitor inbox run 36734974715: STORE_LINK 0, PRICE_REPORT 0,
> **LISTING_FLAG 15 + FEEDBACK 1 — the SAME items triaged and reported to the
> owner on 2026-09-14** (§4b), no new flags and nothing auto-resolvable;
> PHOTO_REPORT 0. Incoming **Self-heal watch was empty** (both 2026-09-27 items
> cleared on the 2026-09-28 run).
>
> **One needs-fix, root-caused and FIXED in-run (#201, `95e1e0d`).**
> **gmk-botanical-r2 × Oblotzky** read `159 EUR SCRAPED` — the value the
> 2026-09-29 reporter flagged as the "Standard Base + Hibi & Botanical Leaf"
> bundle, still there after the next scrape (never-heals). Vendor probe (run
> 36735257689, `/products/gmk-cyl-botanical-2`) confirmed the real base is
> **"Standard" 139 EUR, in stock**, beside two "Standard Base + Hibi & …" bundles
> at 159. Root cause in the shared picker: the bundle names artisan kits
> ("Hibi", "Botanical Leaf") no `BUNDLE_EXTRA_RE` lists and no literal "bundle",
> so `classifyVariant` fell through to BASE — and because the real base "Standard"
> carries no "base" word (→ OTHERS), the "… Base + …" bundle was the ONLY variant
> classified BASE, so `pickBaseVariant`'s `titledBase` returned it. Fixed by
> adding the **"+ after base" shape** as a third bundle signal (`basePlusExtra` /
> `_base_plus_extra`), narrower than a bare joiner: "Teal & White Base" joins
> before "base" and "Two Base（Teal + White）" has its "+" inside a parenthetical
> colourway spec (both stay BASE). With the bundle reclassified, the picker
> returns the dearest real base = "Standard" 139. A targeted re-scrape (id
> `cmq585ux202a0b17d1q505hsa`, run 36736521078, `updated=1`) landed it: the
> confirmation feed (run 36736657805) reads **`current=139 EUR SCRAPED`.** 215
> Python tests, all 24 npm suites, tsc and next lint clean. On the Self-heal
> watch to confirm 139 holds.
>
> **Two stock self-heals, probe-confirmed and added to the watch.**
> **gmk-varenye × iLumKB** ("shown SOLD OUT, Full Base 209 available") — probe
> shows Full Base 209 **available=true** (TKL Base 179 too); the picker's 209 SGD
> pick is correct and the availability scrape clears the sold-out display.
> **gmk-masterpiece-r2 × Oblotzky** ("shown SOLD OUT, Origin Base 119 available")
> — probe shows Origin Base 119 **available=true** (pre-order tag); 119 EUR pick
> correct. Both prices were never disputed; watched for next-run confirmation.
>
> **One false-positive report, no fix.** **gmk-wasabi-r2 × SwitchKeys** ("site
> shows AUD 199 … link lands on Wasabi Base 143") — batch 5 already established
> 199 AUD is correct (matches the store's own `.js`); the 143 came from the
> geo-converted `.json`. Feed reads `199 AUD SCRAPED`. No scrape bug.
>
> The other prior resolutions still read correctly: gmk-vamp × Switchmod
> `84.99 USD`; gmk-bent-r2 × zFrontier `150 USD` (56 not returned since `633581d`);
> gmk-arctic `145`, gmk-tribal `175`; the two Mekibo #194 fixes `165`/`145 USD`;
> the #153 Ktechs listings BRG R3 `139 SGD`, Thunder God `169 SGD`; the two Neo
> Macro deals-filter rows resolved (`00d138a`). gmk-zm × SwitchKeys stays the one
> open owner item (§1): live and priced 229.99 AUD, but relinking to the current
> in-stock `/products/gmk-zimo` (165 AUD) is an owner/discovery judgment.

> **2026-10-01 run.** Price feed run 36882423486 (`?all=1`) returns **0 pending,
> 64 resolved** — the feed now carries the **8 batch-6 reports** filed by the
> released deals audit (#202, run 36803622470, 2026-10-01T01:58), which this
> ledger had not yet recorded (#202 logged them only in
> `released-deals-audit-ledger.md`). Visitor inbox run 36882428168: the SAME **15
> `LISTING_FLAG`s + 1 FEEDBACK** already triaged and reported to the owner since
> 2026-09-14 (§4b); no new flags, nothing auto-resolvable; STORE_LINK /
> PRICE_REPORT / PHOTO_REPORT channels empty.
>
> **Incoming Self-heal watch (3, from 2026-09-30) — all three CONFIRMED healed
> and cleared.** gmk-botanical-r2 × Oblotzky reads `139 EUR SCRAPED` (#201 holds;
> 159 bundle not returned); gmk-varenye × iLumKB `209 SGD SCRAPED`;
> gmk-masterpiece-r2 × Oblotzky `119 EUR SCRAPED`. All post-date their submits;
> moved to the resolution audit.
>
> **Batch 6 — two groups.** Group A (proto[Typist] wrong-variant regression from
> #201) was already fixed in #202's picker change and reads corrected:
> dcs-handarbeit `95 GBP`, dcs-dream-alert `105.83 GBP`. On the watch to confirm.
>
> **Group B — Keebz n Cables ×4 + KeyBay ×2: a geo-converted `.json` price;
> root-caused and FIXED in-run (`abc3021`).** #202 handed this to the review
> ("the home-market pin does not reach them; reading `.js` first would. Worth
> checking in the price-report review"). The reports read the corrected values
> now (Keebz 180/180/19/211 AUD, KeyBay 209/209 CAD), but a wrong-currency reason
> does NOT self-heal (routine step 3) — the correct read is the oscillation trap.
> **Ground truth, Vendor probe run 36883084292 (US runner):** `/products/<h>.json`
> (plain) serves the geo-CONVERTED figure — KeyBay Base `158`, Keebz Teal/White
> Base `143.68`, Alt Grrrrr `12.77/15.17` — while `/products/<h>.js` carries the
> store's shelf price — `209 CAD`, `180 AUD`, `16/19 AUD`, `211 AUD` — the exact
> values the reports call correct. The price pass reads price from the
> **geo-localizable `.json`** and defends only with a `cart_currency`/
> `localization` cookie, which Shopify Markets honours *only when `/meta.json`
> lands*; when it misses (a datacenter-IP block), `.json` returns the US-geo
> conversion stored under the shop's own currency code — AUD 180 → 144, CAD 209 →
> 158 — plus a compare-at the store never shows. A targeted re-scrape (run
> 36883078790, `updated=6`) happened to land the cookie and re-stored the correct
> values, which is exactly the run-to-run flip the audit caught. The deals
> auditor's own `readShopify` has read price from `.js` since 2026-09-28 for this
> reason; the two price passes had not.
>
> **Fix (`abc3021`):** `shelfPriceById` + `applyShelfPrices` (pure, in
> `kit-variants.ts`; mirrored as `_shelf_prices_by_id`/`_apply_shelf_prices` in
> `scrape.py`) overwrite each variant's `.json` price with the un-localized `.js`
> shelf price when `.js` answered for that variant id, keeping `.json`'s
> titles/order and falling back to the `.json` price when `.js` is blocked. It is
> **one-directional**: for a store Shopify Markets does not convert, `.js` and
> `.json` carry the same base-currency price so nothing moves; it only ever
> replaces a geo-converted number with the shelf price, never a correct number
> with a wrong one, and it also drops the fake `.json` compare-at. Both price
> passes already fetched `.js` (for availability), so no new request. 232 Python
> tests, all 24 npm suites, `tsc --noEmit` and `next lint` clean. All six Group B
> rows are on the Self-heal watch; a post-deploy re-scrape makes the correct value
> deterministic (no longer dependent on the cookie landing).

> **2026-10-02 run.** Price feed run 37025316904 (`?all=1`) returns **0 pending,
> 65 resolved** — one more than the ledger's 64, the single new submission being
> **gmk-varenye × GEONWORKS** (2026-10-02T01:50:51Z, batch 7 / #204). Visitor
> inbox run 37025320480: STORE_LINK 0, PRICE_REPORT 0, PHOTO_REPORT 0, and the
> SAME **15 `LISTING_FLAG`s + 1 FEEDBACK** triaged and reported to the owner
> since 2026-09-14 (§4b) — no new flags, nothing auto-resolvable.
>
> **Incoming Self-heal watch (8, from 2026-10-01 / batch 6) — all eight CONFIRMED
> healed and cleared.** Every one reads its corrected value in the feed, each
> `resolvedAt` post-dating its submit:
> - proto[Typist] wrong-variant (#202 `86c4eef`): dcs-handarbeit `95 GBP SCRAPED`,
>   dcs-dream-alert `105.83 GBP SCRAPED`. A picker fix is stable once deployed —
>   nothing to oscillate — and the 15.83 / 15 GBP subkit values did not return.
> - Group B geo-converted `.json` (#203 `69451ae`): Keebz n Cables
>   gmk-cyl-finer-things-r2 `180 AUD`, gmk-finer-things `180 AUD`,
>   gmk-alt-grrrrr-addon `19 AUD`, gmk-orange-alert `211 AUD`; KeyBay gmk-kitsune
>   `209 CAD`, gmk-manta `209 CAD` — all `SCRAPED`. The `.js`-shelf fix reads the
>   un-localized shelf price, so the value no longer depends on the
>   `cart_currency` cookie landing; today's 05:58 UTC nightly sweep (run
>   36971340167, on deployed `9d2262f`) re-stored each correct figure, and the
>   geo-converted numbers the reports flagged (144.12 / 15.21 / 168.95 AUD, 158
>   CAD) did not return. This is the deterministic-fix confirmation (same shape as
>   gmk-bent-r2's reversion check), not a point-in-time read. All eight moved to
>   the resolution audit.
>
> **One new report — gmk-varenye × GEONWORKS — self-heal (dead link), no code.**
> GEONWORKS 302s `geon.works/products/group-buy-gmk-cyl-varenye` to its front
> page `geon.works/` (the `gmk-cyl-varenye` and `gmk-varenye` handles 404), so
> `isGoneRedirect` recognises the root-redirect and clears the price. The feed
> reads `current=null USD source=SCRAPED`, `resolvedAt=2026-10-02T06:42:34.892Z`
> (post-dating the 01:50 submit) — the designed dead-link behaviour, identical to
> **gmk-mothman × GEONWORKS** (2026-09-28, resolved the same way). An unpriced row
> is hidden on the released set, which is correct for a dead link; the deals-rail
> "USD 150 in stock" the reporter saw is a stale point-in-time artifact the next
> deploy/scrape propagation clears. No scrape bug. Placed on the Self-heal watch
> (§1b) so the next run confirms the null holds.
>
> The other prior resolutions still read correctly: gmk-vamp × Switchmod
> `84.99 USD`; gmk-bent-r2 × zFrontier `150 USD` (56 not returned since `633581d`);
> gmk-arctic `145`, gmk-tribal `175`; the #194 Mekibo fixes `165`/`145 USD`; the
> #201 gmk-botanical-r2 `139 EUR`; the #153 Ktechs listings BRG R3 `139 SGD`,
> Thunder God `169 SGD`. gmk-zm × SwitchKeys stays the one open owner item (§1):
> live and priced 229.99 AUD, with a relink to the in-stock `/products/gmk-zimo`
> (165 AUD) an owner/discovery judgment. No in-run code fix was required.

> **2026-10-03 run.** Price feed run 37132372410 (`?all=1`) returns **0 pending,
> 67 resolved** — two more than the ledger's 65, the two new submissions being the
> batch 8 / #205 pair on **gmk-2pack-add-on** (filed 2026-10-03T01:51 UTC through
> the price-report button). Visitor inbox run 37132376585: STORE_LINK 0,
> PRICE_REPORT 0, PHOTO_REPORT 0, and the SAME **15 `LISTING_FLAG`s + 1 FEEDBACK**
> triaged and reported to the owner since 2026-09-14 (§4b) — no new flags, nothing
> auto-resolvable.
>
> **Incoming Self-heal watch (1, from 2026-10-02 / batch 7) — CONFIRMED healed and
> cleared.** gmk-varenye × GEONWORKS reads `current=null USD SCRAPED` in the feed,
> `resolvedAt=2026-10-03T05:33:28.602Z` (post-dating the 2026-10-02T01:50 submit) —
> the null held across the nightly scrape, so the dead-link redirect behaviour is
> stable (the row stays correctly hidden on the released set, not relinked). This
> is the deterministic dead-link confirmation (same shape as gmk-mothman ×
> GEONWORKS), not a point-in-time read. Moved to the resolution audit.
>
> **One new report self-heals (stock); one is held for the owner (wrong vendor).**
> - **gmk-2pack-add-on × Oblotzky Industries** (32 EUR) — **stock-only self-heal.**
>   The site showed the listing sold out, but the store's "GMK CYL 2 Pack" base is
>   EUR 32, `available=true` (pre-order), confirmed from a runner by the batch-8
>   Vendor probe 37087613361. The price (32 EUR) is correct and was never
>   disputed; the price pass is sole authority for `inStock` (#153), so the next
>   availability scrape flips the display in stock. No code change. Placed on the
>   Self-heal watch (§1b) to confirm the in-stock flip.
> - **gmk-2pack-add-on × Swagkeys** (44.99 AUD) — **wrong vendor; held for the
>   owner.** The Swagkeys row (a Korean store, `swagkeys.com` / `swagkey.kr`)
>   carries a listing whose link and AUD 44.99 price are **SwitchKeys'**
>   (`switchkeys.com.au/products/gmk-2pack`, an Australian store). The price itself
>   is a correct read of the SwitchKeys listing — this is **not** a price-scrape
>   bug (no wrong currency/product/variant), so re-scraping only re-reads the same
>   URL under the same vendor and the feed's auto-resolution (both rows stamped
>   `resolvedAt=2026-10-03T06:03:12.839Z`) is spurious: the mis-attribution
>   persists. Swagkeys and SwitchKeys are two **genuinely distinct real shops**
>   whose names look alike, so the repair is a targeted **VendorKit reassignment**
>   (move the listing to the SwitchKeys vendor row, or drop it from Swagkeys since
>   discovery links SwitchKeys' own catalogue) — a catalog / vendor-identity
>   decision no price-scraper code and no automated heal/seed pass performs
>   (`planStorefrontOwnership` fixes a vendor's `websiteUrl`, never a single
>   listing's vendor), and one needing production DB access this session lacks.
>   Per the routine's genuine-ambiguity / architecturally-significant exception it
>   is brought to the owner (§1), in the same class as the `kt-dyad-tkl`
>   `wrong_vendor` flag and the gmk-zm relink, not fixed speculatively.
>
> The other prior resolutions still read correctly: gmk-vamp × Switchmod
> `84.99 USD`; gmk-bent-r2 × zFrontier `150 USD` (56 not returned since `633581d`);
> gmk-arctic `145`, gmk-tribal `175`; the #194 Mekibo fixes `165`/`145 USD`; the
> #201 gmk-botanical-r2 `139 EUR`; the #202 proto[Typist] `95`/`105.83 GBP`; the
> `abc3021`/#203 Keebz n Cables `180`/`19`/`211 AUD` and KeyBay `209 CAD`; the #153
> Ktechs listings BRG R3 `139 SGD`, Thunder God `169 SGD`. gmk-zm × SwitchKeys
> stays the one prior open owner item (§1): live and priced 229.99 AUD, with a
> relink to the in-stock `/products/gmk-zimo` (165 AUD) an owner/discovery
> judgment.

> **2026-10-04 run.** Price feed run 37212048772 (`?all=1`) returns **0 pending,
> 68 resolved** — one more than the ledger's 67, the single new submission being
> the batch 9 / #206 report on **gmk-black-snail---red-cyrillic-addon × Neo Macro**
> (filed 2026-10-04T01:59:28 UTC through the price-report button). Visitor inbox
> run 37212052961: STORE_LINK 0, PRICE_REPORT 0, PHOTO_REPORT 0, and the SAME
> **15 `LISTING_FLAG`s + 1 FEEDBACK** triaged and reported to the owner since
> 2026-09-14 (§4b) — no new flags, nothing auto-resolvable.
>
> **Incoming Self-heal watch (1, from 2026-10-03 / batch 8) — CONFIRMED healed and
> cleared.** gmk-2pack-add-on × Oblotzky Industries reads `current=32 EUR
> SCRAPED`, `resolvedAt=2026-10-04T06:09:27.742Z` (post-dating the 2026-10-03T01:51
> submit); the batch-9 deals audit independently observed the site showing "EUR 32,
> in stock" and recorded the row "healed". The price (32 EUR) was never disputed —
> the stock-only complaint healed on the availability scrape, exactly as a #153
> price-pass-owns-`inStock` flip predicts. Moved to the resolution audit.
>
> **One new report — a RECURRENCE, reclassified `needs fix`, root-caused, and
> HELD for the owner (architecturally significant).**
> **gmk-black-snail---red-cyrillic-addon × Neo Macro** was reported 2026-09-28,
> fixed by #198 (`6f36882` added `\bmodifiers?\b|retro\s*points?\b` to
> `NONBASE_SUBKIT_RE` so the modifier kits clear), and is now reported again:
> the site shows INR 6500 in stock, the **U9 Modifier Kit** value #198 was written
> to exclude. A value that comes back across the #198 scrape is the never-heals
> case (routine step 2), so this is `needs fix`, not a self-heal — and the feed's
> auto-resolution (the report's listing join returns empty, `id=?`, so the sweep
> stamps it resolved) is spurious.
>
> **Root cause (probe run 37212339509, `neomacro.in/products/gmk-black-snail`,
> READABLE Shopify, 8 variants all `available=true`, INR):** L9 Modifier 6000,
> **U9 Modifier 6500**, 40s Ortho linear 4900, GMK Retro Point 600, **Red Cyrillic
> Alphas 9900**, 9009 Accents 3000, Numpad 2500, Cherry Accents 1900 — and **no
> variant titled "Base"**. The set name contains "Addon" (and "Cyrillic"), so
> `isSubkitSetName` is **true** and the pickers (`pickBaseVariant` in
> `kit-variants.ts`, `choose_kit_variant` in `scrape.py`) are called with
> `allowSubkits=true`. That flag exists for legitimate subkit sets (DCS 40s / Bae
> Addon / 10U Spacebars), and it **bypasses the `NONBASE_SUBKIT_RE` exclusion**
> (`kit-variants.ts:187`, `scrape.py:1491`) — so #198's modifier-kit exclusion
> never fires on THIS row. With no "Base" variant, and "Red Cyrillic Alphas"
> classified **ALPHA** (so excluded from the base pool), the dearest remaining
> OTHERS variant is **U9 Modifier (6500)** → the wrong value is picked. #198 was
> never wrong; the subkit-set exception re-opens the hole for this one set.
>
> **Held for owner decision — the correct OUTCOME is contested and the repair is
> roster-wide.** Two mutually-exclusive repairs exist and neither is a safe,
> one-directional change this unattended run should ship:
> 1. **Keep the set and price it at the Red Cyrillic Alphas variant (INR 9900)** —
>    requires a NEW name-match heuristic in the shared `pickBaseVariant` /
>    `choose_kit_variant` (prefer the variant whose title matches the subkit set's
>    own add-on name), mirrored across both halves and all four call sites, and
>    **propagated nightly by the price audit that overwrites stored prices**. That
>    has real regression surface across every subkit set and also needs the
>    ALPHA-classification of "Red Cyrillic Alphas" revisited. This is exactly the
>    shared-picker blast radius the genuine-ambiguity exception is for.
> 2. **Remove / merge the row as a near-duplicate of `gmk-black-snail`** — both set
>    rows point at the SAME Neo Macro product (same URL, same variant list); the
>    parent `gmk-black-snail` row correctly clears to null under #198 because it is
>    not a subkit set. The batch-9 audit noted the VendorKit
>    (`cmuslcupj000n04igkpdo3hmn`) may have been re-created rather than re-priced.
>    A DELETE/merge is a catalog-identity decision no price-scraper or automated
>    heal pass performs, and one needing production DB access this session lacks.
>
> **Recommendation:** option 1 if the owner wants to keep `-red-cyrillic-addon`
> as a trackable add-on set (its Red Cyrillic Alphas kit genuinely is for sale at
> 9900), otherwise option 2 (remove the near-duplicate). Note the **live harm**:
> the row currently displays INR 6500 as a marked-down "base kit" on `/released`,
> a visible wrong price, until one of the two is applied. Per the routine's
> genuine-ambiguity / architecturally-significant exception this is brought to the
> owner (§1), in the same class as the Swagkeys wrong-vendor and gmk-zm relink
> items, not fixed speculatively.
>
> The other prior resolutions still read correctly: gmk-vamp × Switchmod
> `84.99 USD`; gmk-bent-r2 × zFrontier `150 USD`; gmk-arctic `145`, gmk-tribal
> `175`; the #194 Mekibo `165`/`145 USD`; #201 gmk-botanical-r2 `139 EUR`; #202
> proto[Typist] `95`/`105.83 GBP`; `abc3021`/#203 Keebz n Cables `180`/`19`/`211
> AUD` and KeyBay `209 CAD`; #153 Ktechs BRG R3 `139 SGD`, Thunder God `169 SGD`.
> The incoming Self-heal watch is now empty (the one healed item moved to the
> audit; the red-cyrillic recurrence is an owner item, not a self-heal). gmk-zm ×
> SwitchKeys and gmk-2pack-add-on × Swagkeys remain the prior open owner items (§1).

> **2026-10-05 run.** Price feed run 37330934240 (`?all=1`) returns **0 pending,
> 68 resolved** — a 1:1 match with the client-reported log, so **no new price
> report** has filed since the 2026-10-04 submission
> (gmk-black-snail---red-cyrillic-addon × Neo Macro, 2026-10-04T01:59:28). That
> red-cyrillic report now shows `resolvedAt=2026-10-05T06:01:13.839Z`,
> `current=null`, `id=?` — the **spurious feed auto-resolution** the 2026-10-04
> note predicted (the listing join returns empty), not a real heal; it stays the
> open owner item in §1. Visitor inbox run 37330943638: STORE_LINK 0,
> PRICE_REPORT 0, PHOTO_REPORT 0, 1 FEEDBACK (the 2026-06-24 collection-display
> item), and **17 `LISTING_FLAG`s** — the 15 already reported to the owner since
> 2026-09-14 (§4b) plus **two new `duplicate` flags filed 2026-10-05 by the
> deals-audit batch 10** (#207, vendor probe 37252951369):
> - **gmk-finer-things** (`duplicate`, id `cmuulevsi000004lbc4mdapdg`) — the R1
>   set row carries the **R2 product's** listings (every priced listing resolves
>   to "GMK Finer Things R2", also sitting on `gmk-cyl-finer-things-r2-keycaps`).
>   The 2026-10-01 price report (`abc3021`) fixed only the *price* half; the
>   wrong-product half is a **set-identity merge** decision. → owner (§4b).
> - **gmk-cyl-finer-things-r2-keycaps + gmk-finer-things** (`duplicate`, id
>   `cmuulewnq000104lbsfwahwvl`) — **Mecha MY** (`mecha.com.my`) and
>   **Mecha.store** are one shop on two Vendor rows (`mecha.store/products/…`
>   301s to `www.mecha.com.my/…`). `mergeDuplicateVendorRows` cannot fold the
>   pair until a roster entry in `src/data/seed/vendors.json` carries both slugs
>   as `aliases`, and a DELETE-level vendor merge is the "only the roster may
>   declare two slugs one shop" case CLAUDE.md reserves — architecturally
>   significant. → owner (§4b).
>
> Both new flags are catalog **identity** decisions (a set merge, a vendor-row
> merge), not scraper-pricing bugs, so — exactly as every prior `duplicate` flag
> — they are reported to the owner, not auto-resolved or cleared. `LISTING_FLAG`
> has no auto-resolution, so they persist in the inbox until the owner acts.
>
> **Incoming Self-heal watch was empty** (the 2026-10-04 run confirmed and moved
> gmk-2pack-add-on × Oblotzky to the audit; the red-cyrillic recurrence is an
> owner item, not a self-heal), so there was nothing to re-verify and **no
> watched item failed verification** — no in-run fix was required. The three §1
> owner items are unchanged and still correctly held:
> red-cyrillic-addon × Neo Macro (wrong variant; contested shared-picker vs
> catalog-merge repair), gmk-2pack-add-on × Swagkeys (wrong vendor; VendorKit
> reassignment), gmk-zm × SwitchKeys (relink judgment). The deals-audit batch 10
> independently re-confirmed all three still live (red-cyrillic INR 6500 shown,
> Swagkeys AUD 44.99 on the wrong row, gmk-zm stale handle redirecting). No
> safely one-directional code fix exists for any item surfaced this run, so none
> was shipped. Prior resolutions still read correctly in the feed: gmk-vamp ×
> Switchmod `84.99 USD`, gmk-bent-r2 `150 USD`, gmk-arctic `145`, gmk-tribal
> `175`; #194 Mekibo `165`/`145 USD`; #201 gmk-botanical-r2 `139 EUR`; #202
> proto[Typist] `95`/`105.83 GBP`; `abc3021` Keebz/KeyBay `180`/`19`/`211 AUD` /
> `209 CAD`; #153 Ktechs BRG R3 `139 SGD`, Thunder God `169 SGD`.

## 1. Open wrong-price reports (unresolved only)

_Three owner items this run._

_**gmk-black-snail---red-cyrillic-addon × Neo Macro** (new 2026-10-04, batch 9 /
#206) — **wrong variant, recurrence of 2026-09-28; held for owner (architecturally
significant).** The Neo Macro product (`neomacro.in/products/gmk-black-snail`,
probe-confirmed READABLE Shopify, 8 variants all in stock) sells **no base kit**;
its dearest non-alpha subkit, the **U9 Modifier Kit (INR 6500)**, is what the row
displays as a marked-down base on `/released`. #198 added the modifier kits to
`NONBASE_SUBKIT_RE`, but this set's name contains "Addon"/"Cyrillic" →
`isSubkitSetName` = true → the pickers run with `allowSubkits=true`, which bypasses
that exclusion. The variant this set actually names, "Red Cyrillic Alphas" (9900),
classifies ALPHA and is excluded from the base pool, so the dearest OTHERS (U9
Modifier 6500) wins. The correct repair is contested — either (1) keep the set and
price it at the Red Cyrillic Alphas 9900 via a NEW name-match heuristic in the
SHARED `pickBaseVariant`/`choose_kit_variant` (roster-wide risk, propagated by the
nightly audit, both halves + four call sites, and the ALPHA classification must be
revisited), or (2) remove/merge the row as a near-duplicate of `gmk-black-snail`
(same product URL + variant list; the parent correctly clears to null; catalog
decision needing production DB access). Not a safe one-directional change for an
unattended run; held for owner with a recommended patch (see the 2026-10-04 run
note). Live harm: INR 6500 shows as a fake base price until repaired._

_**gmk-2pack-add-on × Swagkeys** (new 2026-10-03, batch 8 / #205) — **wrong
vendor**, not a wrong price. The Swagkeys row (Korean, `swagkeys.com`) carries
SwitchKeys' listing (`switchkeys.com.au/products/gmk-2pack`, AUD 44.99). The
price is a correct read of the SwitchKeys listing; the row attribution is wrong.
Two distinct real shops, so the fix is a VendorKit reassignment to the SwitchKeys
vendor (or a drop from Swagkeys) — a catalog/vendor-identity decision no
price-scraper code or automated heal pass makes, and one needing production DB
access. Held for owner; not a scrape bug, so the feed's auto-resolution is
spurious and the mis-attribution persists until reassigned._

_One prior owner item: **gmk-zm × SwitchKeys** — not a wrong price and not a dead link
(the row is live and priced 229.99 AUD ≈ USD 150, confirmed by a targeted
re-scrape `updated=1`), but the row points at the store's **old GB product**
while the current in-stock listing is the renamed `/products/gmk-zimo` (Base
**165 AUD**). Discovery won't auto-relink a priced row, so this needs an owner
decision: relink to `/products/gmk-zimo` for the current in-stock price, or keep
the 229.99 GB SKU. Not forced (two real SKUs; discovery/catalog judgment)._

_The two Neo Macro closed-store-in-deals reports (gmk-monochrome-dolch,
gmk-black-snail) shipped their owner-approved deals-filter fix (`00d138a`,
`ON_SALE_FILTER` + `bundleSetIds` now exclude `priceSource=LOCKED`) and were
**confirmed on the 2026-09-26 confirmation run** — both read `source=LOCKED` and
are excluded from the deals rail by construction. The four other 2026-09-26
watch items (Mekibo ×2 wrong-variant, DeskHero + iLumKB stock) are likewise
confirmed healed. The prior last open item — gmk-bent-r2 × zFrontier — was fixed
2026-09-16 (`633581d`) and confirmed healed 2026-09-17._

## 1b. Self-heal watch (pending next-day confirmation)

Every item a run marks **self-healed** lands here and stays until the *next*
run proves it. A nightly scrape runs between review runs, so by the next run
each row must be confirmed **healed** (report resolved, wrong value gone) or,
if it did not heal (still pending after a scrape, wrong value returned, or the
same listing was re-reported), reclassified **needs fix** and **fixed in that
run** — the scheduler owns the fix (see routine step 2). A confirmed row moves
to the resolution audit and drops out of this table.

**Currently on the watch: none.** The red-cyrillic-addon recurrence surfaced this
run is an owner item (§1), not a self-heal, so it is not watched; it is tracked in
§1 and the client-reported log until the owner applies one of the two repairs.

**Prior watch (added 2026-10-03, batch 8 / #205) — CONFIRMED healed on the
2026-10-04 run and moved to the resolution audit:**

| set | vendor | flagged | reason | confirmation (2026-10-04) |
|---|---|---|---|---|
| gmk-2pack-add-on | Oblotzky Industries | 2026-10-03 | stock wrong — site showed SOLD OUT, but the store's "GMK CYL 2 Pack" base is EUR 32, `available=true` (pre-order) | ✅ feed `32 EUR SCRAPED`, `resolvedAt=2026-10-04T06:09:27.742Z` (post-dating the 2026-10-03T01:51 submit); batch-9 deals audit independently observed the site showing "EUR 32, in stock" — the in-stock flip happened on the availability scrape, price 32 EUR correct and unchanged (#153 price-pass-owns-`inStock`) |

**Prior watch (added 2026-10-02, batch 7 / #204) — CONFIRMED healed on the
2026-10-03 run and moved to the resolution audit:**

| set | vendor | flagged | reason | confirmation (2026-10-03) |
|---|---|---|---|---|
| gmk-varenye | GEONWORKS | 2026-10-02 | dead link — `geon.works/products/group-buy-gmk-cyl-varenye` 302s to the store front page; handles 404. Site still showed USD 150 in stock | ✅ feed `null USD SCRAPED`, `resolvedAt=2026-10-03T05:33:28.602Z` (post-dating the 01:50 submit); null held across the nightly scrape — `isGoneRedirect` dead-link behaviour stable, row correctly hidden, not relinked |

**Prior watch (added 2026-10-01, batch 6 / #202) — all eight CONFIRMED healed on
the 2026-10-02 run and moved to the resolution audit:**

| set | vendor | flagged | reason | confirmation (2026-10-02) |
|---|---|---|---|---|
| gmk-cyl-finer-things-r2-keycaps | Keebz n Cables | 2026-10-01 | wrong price (geo-converted `.json`) + fake markdown, fixed #203 | ✅ feed `180 AUD SCRAPED`; 144.12 not returned — `.js`-shelf fix deterministic |
| gmk-finer-things | Keebz n Cables | 2026-10-01 | R1→R2 product + geo `.json`, fixed #203 | ✅ feed `180 AUD SCRAPED` |
| gmk-alt-grrrrr-addon | Keebz n Cables | 2026-10-01 | geo `.json` + fake markdown, fixed #203 | ✅ feed `19 AUD SCRAPED`; 15.21 not returned |
| gmk-orange-alert | Keebz n Cables | 2026-10-01 | geo `.json`, fixed #203 | ✅ feed `211 AUD SCRAPED`; 168.95 not returned (TKL Base sold out) |
| gmk-kitsune | KeyBay | 2026-10-01 | geo `.json`, fixed #203 | ✅ feed `209 CAD SCRAPED`; 158 not returned |
| gmk-manta | KeyBay | 2026-10-01 | geo `.json`, fixed #203 | ✅ feed `209 CAD SCRAPED`; 158 not returned |
| dcs-handarbeit | proto[Typist] | 2026-10-01 | wrong variant (#201 regression), fixed #202 | ✅ feed `95 GBP SCRAPED`; 15.83 WASD-kit value not returned |
| dcs-dream-alert | proto[Typist] | 2026-10-01 | wrong variant (#201 regression), fixed #202 | ✅ feed `105.83 GBP SCRAPED`; 15 subkit value not returned |

_gmk-wasabi-r2 × SwitchKeys (2026-09-29) is NOT watched: a false-positive report
— 199 AUD is correct (matches the store's `.js`; the 143 was a geo-converted
`.json` reading), already established by deals-audit batch 5. No oscillation to
track._

**Prior watch (added 2026-09-30) — all three CONFIRMED healed on the 2026-10-01
run and moved to the resolution audit:**

| set | vendor | flagged | reason | confirmation (2026-10-01) |
|---|---|---|---|---|
| gmk-botanical-r2 | Oblotzky | 2026-09-30 | wrong variant, fixed #201 | ✅ feed `139 EUR SCRAPED`; 159 bundle not returned — #201 holds |
| gmk-varenye | iLumKB | 2026-09-30 | stock-only (Full Base 209 available) | ✅ feed `209 SGD SCRAPED`, resolved; price correct & unchanged |
| gmk-masterpiece-r2 | Oblotzky | 2026-09-30 | stock-only (Origin Base 119 pre-order available) | ✅ feed `119 EUR SCRAPED`, resolved; price correct & unchanged |

**Prior watch (added 2026-09-27) — both resolved on the 2026-09-28 run:**

| set | vendor | flagged | reason | resolution (2026-09-28) |
|---|---|---|---|---|
| gmk-panda | iLumKB | 2026-09-27 | recurrence (3rd); "Base+Nov+Space" bundle classified BASE → sold-out base shown in stock | ✅ **healed (#195, `6ca0d95`).** Probe (run 36442068057) confirms Base (SGD 229) `available=false`; the `nov`/`space` bundle now classifies BUNDLE, so the picker returns the sold-out Base and the price pass marks `inStock=false`. Price 229 SGD correct; **no 4th recurrence.** Moved to the resolution audit |
| gmk-zm | SwitchKeys | 2026-09-27 | reported "dead link — 404, row reads `229.99 AUD SCRAPED`" | ⚠️ **not a dead link — false-positive report; listing LIVE.** Only the collection-scoped URL 404s; the stored typo handle `/products/gmik-zimo-group-buy` 301-redirects to the live `/products/gmk-zimo` (probe run 36444934333). A targeted re-scrape (id `cmq585yjj03j0b17dsjv05k5w`, run 36445670318) returned `updated=1 dead=0`, re-storing a valid 229.99 AUD (≈USD 150, in `KIT_BOUNDS`). No scrape bug. Open owner item (§1): the store's current in-stock product is `/products/gmk-zimo` at **165 AUD** — relink is an owner/discovery judgment (two real SKUs), not forced. Dropped from the auto-watch |

_**Prior watch (added 2026-09-27) held the two rows above; both are resolved this
run, so the watch is now empty.** The six items added the earlier 2026-09-26
run were all **confirmed healed on the 2026-09-26 confirmation run (15:11 UTC,
feed 36251045585)** and moved to the resolution audit:_

| set | vendor | flagged | reason | confirmation |
|---|---|---|---|---|
| gmk-teradrive | Mekibo | 2026-09-26 | wrong variant (bundle as base), fixed #194 | ✅ feed `165 USD SCRAPED` — re-scrape landed the plain Base Kit (was 210) |
| gmk-monarch | Mekibo | 2026-09-26 | wrong variant (bundle as base), fixed #194 | ✅ feed `145 USD SCRAPED` — re-scrape landed the plain Base Kit (was 200) |
| gmk-hazakura | DeskHero | 2026-09-26 | stock-only (base sold out, Hiragana base in stock) | ✅ `246 CAD SCRAPED`, resolved post-scrape; price correct, in-stock Hiragana base holds |
| gmk-panda | iLumKB | 2026-09-26 | stock-only (base `available=false`) | ✅ `229 SGD SCRAPED`, resolved; price correct & unchanged |
| gmk-monochrome-dolch | Neo Macro | 2026-09-26 | LOCKED store on deals rail, fixed `00d138a` | ✅ `15500 INR LOCKED`; deals filter (deployed at `head_sha=00d138a`) excludes LOCKED — off the deals rail by construction; set page unchanged |
| gmk-black-snail | Neo Macro | 2026-09-26 | LOCKED store on deals rail, fixed `00d138a` | ✅ `6500 INR LOCKED`; same deals-filter exclusion |

The two Mekibo re-scrapes landed exactly the picker's predicted 165/145, so the
#194 classification fix is proven in production, not just in the diff. The two
stock rows resolved on a scrape post-dating the submit with correct, unchanged
base prices. The two Neo Macro rows are the deals-filter display fix: their price
reports keep auto-resolving via the feed, so the signal is the deterministic
deals-rail exclusion (both read `source=LOCKED`, and the deployed filter drops
LOCKED unconditionally) rather than the feed — the same shape as gmk-bent-r2's
reversion check. Production's live deals payload was not fetched directly (this
session's egress to production is blocked; runners are the reachable path and
already proved the deployed `head_sha`).

_Prior watch was empty on entry. gmk-bent-r2 × zFrontier (fixed 2026-09-16,
commit `633581d`) was confirmed healed 2026-09-17 (feed `150 USD SCRAPED`,
`resolvedAt` post-dating the deployed-code scrape; 56 did not return) and is in
the resolution audit._

gmk-vamp × Switchmod (flagged 2026-08-27, probe-confirmed in-run via run
33086317179: Base 84.99 USD `available=true`, picker correct; re-confirmed
healed 2026-08-28) remains resolved in the full-history feed —
`current=84.99 USD source=SCRAPED`, `resolvedAt=2026-09-17T05:05:53.901Z` — and
stays in the resolution audit.

## 2. Open client-recommended values (awaiting verification)

_None — all client-recommended values have been verified (see audit below)._

## 3. Client-reported items (full log)

| logged (UTC) | set | vendor | reported price | reason (client) | verdict | status |
|---|---|---|---|---|---|---|
| 2026-08-26 | gmk-vamp | Switchmod | 84.99 USD | "all has no stock" | self-healed | ✅ resolved |
| 2026-08-25 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | "there is no more stock" | needs fix | ✅ resolved (#153) |
| 2026-08-24 | gmk-tribal | zFrontier | 175 USD | "it show product not found" | needs fix | ✅ resolved |
| 2026-08-20 | gmk-nord | CandyKeys | 62 EUR | "this url point to a different website" | needs fix | ✅ resolved |
| 2026-08-17 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | "there is no more stock" | needs fix | ✅ resolved (#153) |
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
| 2026-07-25 | gmk-thunder-god | Ktechs | 169 SGD | "no stock" | needs fix | ✅ resolved (#153) |
| 2026-07-22 | gmk-nord | zFrontier | 110 USD | "this is price of novelty kit" | needs fix | ✅ resolved |
| 2026-07-22 | gmk-maroon | zFrontier | 170 USD | "wrong item price is this price of kits spacebar" | needs fix | ✅ resolved |
| 2026-07-21 | gmk-burgundy-r3 | Omnitype | 100 USD | "when clicked buy is directing to a weird website" | needs fix | ✅ resolved |
| 2026-07-20 | gmk-bent-r2 | zFrontier | 56 USD | "this price is not the price of the revival base kit also revival base kit has no stock" | needs fix | ✅ resolved (`633581d`; confirmed 2026-09-17 — 150 holds) |
| 2026-07-20 | gmk-arctic | zFrontier | 46 USD | "this is the price of novelty kit not based kit" | needs fix | ✅ resolved |
| 2026-07-18 | gmk-masterpiece-r2 | Oblotzky Industries | 119 EUR | "This is a pre order link not actual units" | self-healed (link) | ✅ resolved |
| 2026-07-18 | gmk-masterpiece-r2 | iLumKB | 159 SGD | "This link is pointing to pre order not actual units" | self-healed (link) | ✅ resolved |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | Oblotzky Industries | null | "I am seeing base kit as 116 europe" | needs fix (+ recommended value) | ✅ resolved |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | iLumKB | null | "You picked the novelty kit price as based kit price" | needs fix | ✅ resolved |
| 2026-07-16 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | "sold out" | needs fix | ✅ resolved (#153) |
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
| 2026-09-26 | gmk-teradrive | Mekibo | 210 USD | "Wrong variant: USD 210 is '[Bundle] Base + JIS Mod'; Base Kit alone is USD 165" (deals audit) | needs fix | ✅ resolved (#194; re-scrape landed **165 USD**, confirmed 2026-09-26) |
| 2026-09-26 | gmk-monarch | Mekibo | 200 USD | "Wrong variant: USD 200 is '[Bundle] Base + Core'; Base Kit alone is USD 145" (deals audit) | needs fix | ✅ resolved (#194; re-scrape landed **145 USD**, confirmed 2026-09-26) |
| 2026-09-26 | gmk-hazakura | DeskHero | 246 CAD | "Stock: plain 'Base Kit' (CAD 246) sold out; only 'Base Kit - Hiragana' (246) in stock" (deals audit) | self-healed (stock) | ✅ resolved (stock scrape; 246 CAD correct, confirmed 2026-09-26) |
| 2026-09-26 | gmk-panda | iLumKB | 229 SGD | "Sold out: 'Base' (SGD 229) available=false; only Spacebars + bundle (329) buyable" (deals audit) | self-healed (stock) | ✅ resolved (stock scrape; 229 SGD correct, confirmed 2026-09-26) |
| 2026-09-26 | gmk-monochrome-dolch | Neo Macro | 15,500 INR | "Store closed: neomacro.in /password gate, but shown as in-stock deal (was 17000)" (deals audit) | needs fix (display) | ✅ resolved (deals filter `00d138a`; LOCKED off deals rail, confirmed 2026-09-26) |
| 2026-09-26 | gmk-black-snail | Neo Macro | 6,500 INR | "Store closed: neomacro.in /password gate, but shown as in-stock deal (was 7500)" (deals audit) | needs fix (display) | ✅ resolved (deals filter `00d138a`; LOCKED off deals rail, confirmed 2026-09-26) |
| 2026-09-27 | gmk-panda | iLumKB | 229 SGD | "shown in stock at SGD 229, but Base is SOLD OUT (only 329 Base+Nov+Space bundle in stock); 2nd occurrence after 2026-09-26" (deals audit) | needs fix (recurrence) | ✅ resolved (#195 `6ca0d95`; probe-confirmed 2026-09-28 base sold out, no 4th recurrence) |
| 2026-09-27 | gmk-zm | SwitchKeys | 229.99 AUD | "link is dead — switchkeys.com.au 404s the product URL, yet row shows AUD 229.99 in stock" (deals audit) | false positive (listing live) | ✅ resolved 2026-09-28 — NOT dead: stored handle 301-redirects to a live product; targeted re-scrape `updated=1`. Owner item (§1): relink to `/products/gmk-zimo` (165 AUD) is an open judgment |
| 2026-09-28 | gmk-black-snail | Neo Macro | 6,500 INR | "wrong variant: no base kit; INR 6500 is the U9 Modifier Kit" (deals audit) | needs fix | ✅ resolved (#198 `6f36882`; `modifier`/`retro point` → NONBASE, row cleared to null) |
| 2026-09-28 | gmk-black-snail---red-cyrillic-addon | Neo Macro | 6,500 INR | "wrong variant: INR 6500 is the U9 Modifier Kit, not a base kit" (deals audit) | needs fix | ⚠️ **recurred 2026-10-04** — #198's `NONBASE_SUBKIT_RE` fix does NOT reach this row (its name → `isSubkitSetName`→`allowSubkits` bypasses the exclusion), so the U9 Modifier (6500) is picked again. Reopened as an owner item (§1); see the 2026-10-04 report row |
| 2026-09-28 | gmk-mothman | GEONWORKS | 150 USD | "dead link: geon.works product URL 302s to the front page" (deals audit) | self-healed (dead link) | ✅ resolved (dead-link redirect cleared price to null) |
| 2026-09-29 | gmk-wasabi-r2 | SwitchKeys | 199 AUD | "wrong price: site shows AUD 199, link lands on Wasabi Base 143" (deals audit) | false positive | ✅ resolved 2026-09-30 — 199 AUD correct (matches store `.js`); 143 was a geo-converted `.json` reading (deals-audit batch 5) |
| 2026-09-29 | gmk-botanical-r2 | Oblotzky Industries | 159 EUR | "wrong variant: EUR 159 is the 'Standard Base + Hibi & Botanical Leaf' bundle; base 'Standard' is EUR 139" (deals audit) | needs fix | ✅ resolved (#201 `95e1e0d`; "+ after base" → BUNDLE; re-scrape landed **139 EUR**) |
| 2026-09-30 | gmk-masterpiece-r2 | Oblotzky Industries | 119 EUR | "stock wrong: shown SOLD OUT, but 'Origin Base' EUR 119 available (pre-order)" (deals audit) | self-healed (stock) | ✅ resolved (stock/pre-order scrape; 119 EUR correct, probe-confirmed available) — on watch |
| 2026-09-30 | gmk-varenye | iLumKB | 209 SGD | "stock wrong: shown SOLD OUT, but 'Full Base' SGD 209 available" (deals audit) | self-healed (stock) | ✅ resolved (stock scrape; 209 SGD correct, probe-confirmed available; confirmed healed 2026-10-01) |
| 2026-10-01 | dcs-handarbeit | proto[Typist] | 95 GBP | "wrong variant: GBP 15.83 is the 'WASD' kit; base is 'Base Kit + UKISO' GBP 95 (#201 regression)" (deals audit) | needs fix | ✅ resolved (#202 `86c4eef`; picker drops a cheap unlabelled subkit under half the bundle; feed `95 GBP`; confirmed 2026-10-02) |
| 2026-10-01 | dcs-dream-alert | proto[Typist] | 105.83 GBP | "wrong variant: GBP 15 is the '6.25u Kit'; base is 'Base Kit + UKISO' GBP 105.83 (#201 regression)" (deals audit) | needs fix | ✅ resolved (#202 `86c4eef`; same picker fix; feed `105.83 GBP`; confirmed 2026-10-02) |
| 2026-10-01 | gmk-cyl-finer-things-r2-keycaps | Keebz n Cables | 180 AUD | "wrong price + fake markdown: site AUD 144.12 (was 176.15); store base 180, no compare-at (geo-converted .json)" (deals audit) | needs fix | ✅ resolved (`abc3021`; `.js` shelf price preferred over geo-localizable `.json`; feed `180 AUD`; confirmed 2026-10-02) |
| 2026-10-01 | gmk-finer-things | Keebz n Cables | 180 AUD | "wrong product and price: R1 set links to the R2 product; site AUD 144.12, store base 180" (deals audit) | needs fix | ✅ resolved (`abc3021`; `.js` shelf price; feed `180 AUD`; confirmed 2026-10-02) |
| 2026-10-01 | gmk-alt-grrrrr-addon | Keebz n Cables | 19 AUD | "wrong price + fake markdown: site AUD 15.21; store .js Dolch 16 / Evil Dolch 19 (geo-converted .json)" (deals audit) | needs fix | ✅ resolved (`abc3021`; `.js` shelf price; feed `19 AUD`; confirmed 2026-10-02) |
| 2026-10-01 | gmk-orange-alert | Keebz n Cables | 211 AUD | "wrong price: site AUD 168.95; store 'TKL Base' 211 sold out (geo-converted .json)" (deals audit) | needs fix | ✅ resolved (`abc3021`; `.js` shelf price; feed `211 AUD`; confirmed 2026-10-02) |
| 2026-10-01 | gmk-kitsune | KeyBay | 209 CAD | "wrong price: site CAD 158; store 'Base' CAD 209 (geo-converted .json served to a US visitor)" (deals audit) | needs fix | ✅ resolved (`abc3021`; `.js` shelf price; feed `209 CAD`; confirmed 2026-10-02) |
| 2026-10-01 | gmk-manta | KeyBay | 209 CAD | "wrong price: site CAD 158; store 'Base' CAD 209 (geo-converted .json)" (deals audit) | needs fix | ✅ resolved (`abc3021`; `.js` shelf price; feed `209 CAD`; confirmed 2026-10-02) |
| 2026-10-02 | gmk-varenye | GEONWORKS | null USD | "dead link: geon.works/products/group-buy-gmk-cyl-varenye 302s to the store front page, no product; gmk-cyl-varenye/gmk-varenye handles 404. Site still shows USD 150 in stock" (deals audit) | self-healed (dead link) | ✅ resolved 2026-10-02 — `isGoneRedirect` cleared price to null (feed `null USD SCRAPED`); confirmed healed 2026-10-03 (null held). Same as gmk-mothman × GEONWORKS |
| 2026-10-03 | gmk-2pack-add-on | Oblotzky Industries | 32 EUR | "Stock is wrong: the site shows this listing sold out, but the store's product (GMK CYL 2 Pack, EUR 32, tagged pre-order) is available to buy (product.js available=true, checked 2026-10-03 from a runner)." (deals audit batch 8) | self-healed (stock) | ✅ resolved 2026-10-03 — stock-only; 32 EUR correct & unchanged; **confirmed healed 2026-10-04** (feed `32 EUR SCRAPED`; batch-9 audit saw site "EUR 32, in stock" — the in-stock flip happened) |
| 2026-10-03 | gmk-2pack-add-on | Swagkeys | 44.99 AUD | "Wrong vendor: this row is labelled Swagkeys (a Korean store, swagkeys.com) but its link and AUD 44.99 price are SwitchKeys' listing (switchkeys.com.au/products/gmk-2pack). The listing belongs on the SwitchKeys vendor row, not Swagkeys." (deals audit batch 8) | wrong vendor (held for owner) | ⚠️ open owner item (§1) — not a price-scrape bug; price 44.99 AUD is a correct read of the SwitchKeys listing, but on the wrong vendor row. Needs a VendorKit reassignment to SwitchKeys (or drop from Swagkeys); two distinct real shops, so a catalog/vendor-identity decision. Feed auto-resolution spurious |
| 2026-10-04 | gmk-black-snail---red-cyrillic-addon | Neo Macro | 6,500 INR | "Wrong variant (recurrence of 2026-09-28): site shows INR 6500 (was 7500) in stock, which is the U9 Modifier Kit. neomacro.in/products/gmk-black-snail sells no base kit; the Red Cyrillic add-on this set names is the 'Red Cyrillic Alphas' variant, INR 9900, available. Likely cause: the set name contains 'Addon', so isSubkitSetName lets subkits through and the dearest-unlabeled pick takes the modifier kit" (deals audit batch 9 / #206) | needs fix (recurrence; held for owner) | ⚠️ open owner item (§1) — recurrence of the 2026-09-28 report; #198 does not reach this row because `isSubkitSetName`→`allowSubkits` bypasses `NONBASE_SUBKIT_RE`, and "Red Cyrillic Alphas" (the correct 9900 variant) classifies ALPHA. Repair is contested (price at 9900 via a shared-picker name-match vs remove the near-duplicate row) → architecturally significant, held per routine step 4. Probe run 37212339509 |

## 4. Listing-flag triage (visitor inbox — `ListingReport`)

The "report a listing" flag posts to `ListingReport`, a separate channel from
the wrong-price flag. It has **no derivable auto-resolution**, so each flag is
triaged against the read-only inspector's catalog state and cleared by id when
dealt with (`scripts/resolve-listing-flags.mjs`). First full triage: 2026-09-14.

### 4a. Resolved flags (cleared by id)

| slug | issue | flagged | inspector state | resolution |
|---|---|---|---|---|
| obl-test-product-do-not-buy | other | 2026-09-25 | NO ROW (run 36152737146) | **re-report of the 2026-09-14-closed item; fix holding.** Cleared 2026-09-25 (run 36152863577). The row stays purged by `purgeTestProductListings`/`isTestProduct` — a stale flag against the old listing, no regression |
| obl-test-product-do-not-buy | other/inactive ×8 | 2026-06-23 … 2026-09-13 | NO ROW | `purgeTestProductListings` (#d962ac3) removed it; confirmed gone (cleared 2026-09-14) |
| gmk-cyl-masterpiece-r2-keycaps | duplicate | 2026-07-21 | NO ROW | CYL orphan folded into `gmk-masterpiece-r2` by `mergeDuplicateKeycapSets` |
| gmk-masterpiece-r2 | duplicate | 2026-07-21 | exists, no twin | dedup complete — no duplicate remains |
| gmk-cyl-windbreaker-keycaps | duplicate | 2026-07-21 | NO ROW | CYL orphan folded into `gmk-windbreaker` |
| gmk-windbreaker | duplicate | 2026-07-21 | exists, no twin | dedup complete |
| gmk-cyl-hi-viz-r2-keycaps | duplicate | 2026-07-21 | NO ROW | CYL orphan folded into `gmk-hi-viz-r2` |
| gmk-hi-viz-r2 | duplicate | 2026-07-21 | exists, no twin | dedup complete |
| gmk-cyl-kitsune-keycaps | wrong_price | 2026-07-06 | NO ROW | orphan merged / numpad-drop cleared (see resolution audit) |
| gh-110579 | inactive | 2026-06-16 | NO ROW | row already removed |

### 4b. Open — reported to owner (17 flags, awaiting decision)

These are genuinely ambiguous or architecturally significant; the review
session does not merge/delete catalog rows or demote GB status on its own.

| slug(s) | issue | flagged | inspector state | why open / recommendation |
|---|---|---|---|---|
| gmk-finer-things | duplicate | 2026-10-05 | R1 set row carries the R2 product's listings (probe 37252951369, batch 10) | **set-identity merge.** Every priced listing on the R1 set resolves to "GMK Finer Things R2" (Keebz n Cables "[Pre-order] GMK Finer Things R2", Teal/White Base AUD 180 in stock), which also sit on `gmk-cyl-finer-things-r2-keycaps`. The 2026-10-01 price report (`abc3021`) fixed the price only; the wrong-product half is a DELETE/merge decision the auto-pass won't make — owner decide merge R1→R2 or re-point the listings |
| gmk-cyl-finer-things-r2-keycaps (+ gmk-finer-things) | duplicate | 2026-10-05 | Mecha MY (mecha.com.my) + Mecha.store, one shop on two Vendor rows (probe 37252951369, batch 10) | **vendor-row merge.** `mecha.store/products/group-buy-gmk-finer-things-r2` 301s to `www.mecha.com.my/…` — the Toro Studio/Toro Studios shape. `mergeDuplicateVendorRows` cannot fold the pair until `src/data/seed/vendors.json` gains a roster entry carrying both slugs as `aliases`; "only the roster may declare two slugs one shop" (CLAUDE.md), a DELETE-level decision — owner decide whether to add the roster entry / merge |
| gmk-ramune-tkl + gmk-cyl-ramune | duplicate ×2 | 2026-07-21 | both live keycap rows; identities `gmk::ramune tkl` vs `gmk::ramune` (auto-merge won't fold — "TKL" differs); designers read Hatoworks / blank (GMK Ramune is biip's) | DELETE-level judgement: is "GMK Ramune TKL" a distinct product or a mis-named/mis-slugged duplicate? If duplicate, needs a manual merge the auto-pass deliberately refuses |
| kbd-rf-8x + kt-rf-8x | duplicate ×4 | 2026-06-27 … 2026-07-21 | both KEYBOARD "RF-8X"; KBDfans row 1 priced link, Ktechs row 0 links | one keyboard, two vendor rows; keyboards carry no auto-dedup (editions kept separate by design) — owner decide merge / drop the empty Ktechs row |
| kt-vs06 | inactive + duplicate ×2 | 2026-06-28 … 2026-08-26 | KEYBOARD, ACTIVE_GB, 0 links, no twin found | empty stale Ktechs keyboard row; twin (if any) already gone — owner decide retire/remove |
| kt-dyad-tkl | wrong_vendor | 2026-07-21 | KEYBOARD, region=US, 0 links | cause fixed in code (#079b45f: Ktechs → SGD/SG); stored row still US pending a keyboard re-import — verify re-import corrects it, then clear |
| gh-125085 | other + inactive ×2 | 2026-06-16 … 2026-07-18 | "[GB] DIVERSITY" KEYBOARD, ACTIVE_GB, 0 links, GB long over | stale GB status never demoted — owner decide mark ENDED/DEAD or remove |
| gh-125620 | inactive | 2026-06-16 | "[GB] KAT Retrobytes — Live till Oct 5th 2025" KEYCAPS, ACTIVE_GB, 0 links | GB window past; stale ACTIVE_GB — demote/remove |
| gh-113443 | inactive | 2026-06-16 | "[GB] KAT Great Wave" KEYCAPS, ACTIVE_GB, 1 priced link | GB likely over but still ACTIVE_GB — verify against source, demote if ended |
| gh-121033 | wrong_category | 2026-06-23 | "[GB] MKC75 … In-Stock Sale" KEYBOARD, IN_STOCK, 0 links, designer="Limited In-Stock Sale" (garbage parse) | in-stock keyboard sale mis-imported as a GB; designer field is junk — owner decide category/remove |
| gh-113651 | wrong_category | 2026-06-23 | "[GB]MOBULA80 in-stock buy … TKL" KEYBOARD, IN_STOCK, 0 links | same shape as gh-121033 — in-stock keyboard sale, not a GB |

**FEEDBACK (not a listing flag):** 2026-06-24, collection display ("the person
uploaded 2 builds but the mai…") — left for the owner.

## Resolution audit (full detail — audit trail, not rendered per run)

| logged (UTC) | set | vendor | reported price | verdict | root cause & fix | status now |
|---|---|---|---|---|---|---|
| 2026-08-26 | gmk-vamp | Switchmod | 84.99 USD | self-healed | Stock-only ("all has no stock") — no scrape bug. Despite the `gmk-vamp-extras` slug (the SwiftCables/evil-dolch-extras trap shape), a live Vendor probe (run 33086317179) shows the Shopify listing = "GMK CYL Vamp" with a **Base** variant at 84.99 USD `available=true` (plus Novelties 20.99, Extension 27.99, Deskmat 9.99, HIBI 40.99, all in stock). `choose_kit_variant` correctly picks Base, the price is right (CYL is the cheaper doubleshot line), and every variant is now in stock — the availability complaint no longer holds. Re-scrape after submit resolved it. No code change | ✅ resolved (self-healed, probe-confirmed) |
| 2026-08-25 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | needs fix | **Not self-healed** — the nightly override re-asserted stock. `linkVendorKit` wrote `inStock: true` on existing rows from `/api/cron/refresh` step 3, before the price pass at step 5, and this listing is one of the five hand-curated `LINK_OVERRIDES`. The GitHub price run (every 6h) wrote `false`; the 16:00 UTC cron wrote `true` back; whoever checked next saw whichever half of the cycle they landed in — which is why the self-heal watch kept passing it. Fixed in #153 (the override no longer writes the flag; discovery now marks a row sold out from the store's own feed). 3rd of 3 BRG stock reports. The price itself was never disputed: 113 SGD (≈84 USD) is low for a GMK base but no reporter has complained about it, so it stays treated as the base kit | ✅ resolved (#153) |
| 2026-08-24 | gmk-tribal | zFrontier | 175 USD | needs fix | "Product not found" — the linked variant/page was gone; a dead/moved link. `NO_BASE_KIT` + dead-link (404/410) clearing hands the row back on the next rotation | ✅ resolved |
| 2026-08-20 | gmk-nord | CandyKeys | 62 EUR | needs fix | "URL points to a different website" — stale/misrouted product link; re-scrape relinked the correct CandyKeys page (62 EUR is a plausible nord base) | ✅ resolved |
| 2026-08-17 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | needs fix | 2nd of 3 BRG stock reports — same cause as the 2026-08-25 row: the override re-asserted stock nightly, so the re-scrape "fix" lasted until 16:00 UTC | ✅ resolved (#153) |
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
| 2026-07-25 | gmk-thunder-god | Ktechs | 169 SGD | needs fix | **Not self-healed** — the nightly override re-asserted stock. `linkVendorKit` wrote `inStock: true` on existing rows from `/api/cron/refresh` step 3, before the price pass at step 5, and this listing is one of the five hand-curated `LINK_OVERRIDES`. The GitHub price run (every 6h) wrote `false`; the 16:00 UTC cron wrote `true` back; whoever checked next saw whichever half of the cycle they landed in — which is why the self-heal watch kept passing it. Fixed in #153 (the override no longer writes the flag; discovery now marks a row sold out from the store's own feed). The note on this row already said "Ktechs thunder-god is a hand-curated LINK_OVERRIDE" — that was the cause, recorded as a parenthetical | ✅ resolved (#153) |
| 2026-07-22 | gmk-nord | zFrontier | 110 USD | needs fix | Novelty kit priced as base — NOVELTIES excluded | ✅ resolved |
| 2026-07-22 | gmk-maroon | zFrontier | 170 USD | needs fix | Spacebar kit priced as base — SPACEBARS excluded | ✅ resolved |
| 2026-07-21 | gmk-burgundy-r3 | Omnitype | 100 USD | needs fix | Buy link redirects to dixiemech.store — Omnitype's row was parked on a sibling brand's storefront (CLAUDE.md "wrong storefront" shape); `planStorefrontOwnership`/roster heal repoints it | ✅ resolved |
| 2026-07-20 | gmk-bent-r2 | zFrontier | 56 USD | needs fix | Revival base not picked + no stock. Picker fix held 150 USD 2026-09-08…-14, then **reverted to 56 on 2026-09-15**. Probe run 34986483070: `en.zfrontier.com` (ordinary USD Shopify) `[In Stock] GMK Bentō R2`, 10 variants, none titled "base"; base colourways Traditional/Revival 150 both `available=false`, cheapest in-stock Salmon 56. Both pickers correctly return 150 (dearest base candidate, stock-independent), so the 56 is written by the JSON-LD/OG fallback (`fetchJsonLdPrice`) when Shopify `product.json` blocks: the page's JSON-LD is a lone `ProductGroup`+`Offer` at 56 (OG price), no base-named offer, so the ambiguous-aggregate guard misses it. **Fixed 2026-09-16 (`633581d`)**: the 2026-09-16 feed read it back at 150, confirming an OSCILLATION (150→56→150) — which settled both questions the hold rested on. The trigger is real (intermittent `product.json` block) and the answer is unambiguously PRESERVE (clearing hides the listing on a released set), so the fix is one-directional and cannot store, clear or hide: `htmlDeclaresVariantProductGroup` (pure, unit-tested `kit-variants` module) detects Shopify's multi-variant ProductGroup marker and `fetchJsonLdPrice`'s OpenGraph branch declines to store its representative price, preserving the picker's 150. scrape.py needs no mirror (`generic_price` has no OG `product:price` fallback; `run_prices` reads `product.json` via a real browser). `test:kit-variants` extended. **Confirmed healed 2026-09-17** (feed run 35238032205: `current=150 USD SCRAPED`, `resolvedAt` post-dating the deployed-code scrape; 56 did not return, oscillation not recurred) | ✅ resolved (`633581d`; confirmed 2026-09-17) |
| 2026-07-20 | gmk-arctic | zFrontier | 46 USD | needs fix | Novelty kit priced as base — NOVELTIES excluded | ✅ resolved |
| 2026-07-18 | gmk-masterpiece-r2 | Oblotzky Industries | 119 EUR | self-healed | Pre-order link, not in-stock units — availability/link complaint; re-scrape re-verified. (119 EUR is Oblotzky's ex-VAT display; DE-market inc-VAT base ≈ 139 EUR — see recommended-values note) | ✅ resolved (link) |
| 2026-07-18 | gmk-masterpiece-r2 | iLumKB | 159 SGD | self-healed | Pre-order link complaint — availability/link; re-scrape re-verified | ✅ resolved (link) |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | Oblotzky Industries | null | needs fix | Client reads base as "116 europe" — that is Oblotzky's **ex-VAT** display; the tracked DE-market base is inc-VAT (see recommended-values note). Value cleared to null on re-scrape (no clean base surfaced) | ✅ resolved (cleared) |
| 2026-07-18 | gmk-cyl-tiramisu-keycaps | iLumKB | null | needs fix | Novelty kit priced as base — NOVELTIES excluded; value now null | ✅ resolved (cleared) |
| 2026-07-16 | gmk-british-racing-green-r3 | Ktechs | 113 SGD | needs fix | 1st of 3 BRG stock reports — same cause; closing it as self-healed is what let it recur twice over the next six weeks | ✅ resolved (#153) |
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
| 2026-09-26 | gmk-teradrive | Mekibo | 210 USD | needs fix | **Wrong variant, already fixed #194 (`856f1df`).** `[Bundle] Base + JIS Mod` (210) priced as base; plain Base Kit is 165. #194 added `\bcore\b`/`\bjis\b` to `BUNDLE_EXTRA_RE` and made a self-described bundle classify BUNDLE (`BUNDLE_WORD_RE`) in both `kit-variants.ts` and `scrape.py` (both suites pinned). Diff verified: the variant now classifies BUNDLE, so the picker returns the plain Base Kit. Deployed on `main`; stored 210 corrects to 165 on next scrape. **Confirmed 2026-09-26** (feed 36251045585): re-scrape landed `165 USD SCRAPED` | ✅ resolved (#194; confirmed 2026-09-26) |
| 2026-09-26 | gmk-monarch | Mekibo | 200 USD | needs fix | Same cause/fix as gmk-teradrive: `[Bundle] Base + Core` (200) priced as base; plain Base Kit is 145. #194 fix applies. **Confirmed 2026-09-26**: re-scrape landed `145 USD SCRAPED` | ✅ resolved (#194; confirmed 2026-09-26) |
| 2026-09-26 | gmk-hazakura | DeskHero | 246 CAD | self-healed (stock) | Stock-only. Vendor probe (run 36223526130): plain "Base Kit" (CAD 246) sold out qty 0, "Base Kit - Hiragana" (246) in stock — price correct, an in-stock base at the same price exists. Not a `LINK_OVERRIDES` row; the price pass is sole authority for `inStock` (#153), so the availability scrape resolves it. **Confirmed 2026-09-26**: `246 CAD SCRAPED`, resolved after a post-submit scrape | ✅ resolved (self-healed; confirmed 2026-09-26) |
| 2026-09-26 | gmk-panda | iLumKB | 229 SGD | self-healed (stock) | Stock-only. Base variant (SGD 229, correct base price) `available=false`; only Spacebars + a 329 bundle buyable. Price unchanged & correct (prior 2026-08-10 spacebar report already fixed the base pick to 229). Availability scrape marks `inStock=false`. **Confirmed 2026-09-26**: `229 SGD SCRAPED`, resolved | ✅ resolved (self-healed; confirmed 2026-09-26) |
| 2026-09-26 | gmk-monochrome-dolch | Neo Macro | 15,500 INR | needs fix (display) | **Closed store shown as a live deal — FIXED (owner-approved, `00d138a`).** `source=LOCKED` (neomacro.in password-gated, #187/#188), but a LOCKED row keeps `inStock=true` + `compareAtPrice`, so it satisfied `ON_SALE_FILTER` and surfaced on `/released?deals=1` + the "On sale now" rail. Price (≈186 USD) is plausible and the feed auto-resolves it, so it never heals without a display fix. First held (architecturally significant: multi-surface deals policy on a new feature; scope open; conflicts with CLAUDE.md LOCKED-visibility rule; deferred by the #194 deals-audit author); the owner then approved the recommendation. Shipped in `src/app/api/released/route.ts`: `priceSource: { not: "LOCKED" }` on `ON_SALE_FILTER`'s `some` and `AND vk."priceSource" IS DISTINCT FROM 'LOCKED'` in `bundleSetIds` SQL (both keep null-priceSource rows). `PURCHASABLE_VENDOR_KIT_WHERE` untouched, so the set page still shows the row. tsc/lint/unit suites green. **Confirmed 2026-09-26** (feed 36251045585 served by production at `head_sha=00d138a`): row reads `source=LOCKED`, so the deployed filter excludes it from the deals rail by construction | ✅ resolved (deals filter; confirmed 2026-09-26) |
| 2026-09-26 | gmk-black-snail | Neo Macro | 6,500 INR | needs fix (display) | Same LOCKED-in-deals cause and fix as gmk-monochrome-dolch (≈78 USD, plausible). Fixed `00d138a`. **Confirmed 2026-09-26**: `source=LOCKED`, excluded from the deals rail | ✅ resolved (deals filter; confirmed 2026-09-26) |
| 2026-09-27 | gmk-panda | iLumKB | 229 SGD | needs fix (recurrence) | **3rd report (2026-08-10, 2026-09-26, 2026-09-27); root cause fixed #195 (`6ca0d95`).** iLumKB's plain "Base" (SGD 229) is sold out beside an in-stock "Base+Nov+Space" bundle (SGD 329). `nov`/`space` named no extra `BUNDLE_EXTRA_RE` knew, so the bundle classified BASE; stock is read across every BASE variant, so the sold-out base showed buyable on `/released`. #195 added `\bnovs?\b`/`\bspaces?\b` to `BUNDLE_EXTRA_RE` in both `kit-variants.ts` and `scrape.py` (both suites pin `Base+Nov+Space` → BUNDLE) — verified in code this run. Price 229 SGD is correct (never disputed; the base pick was fixed to 229 by the 2026-08-10 spacebar report). The price pass is sole authority for `inStock` (#153). **Confirmed healed 2026-09-28**: Vendor probe (run 36442068057) shows Base (SGD 229) `available=false`; no 4th recurrence | ✅ resolved (#195; confirmed 2026-09-28) |
| 2026-09-27 | gmk-zm | SwitchKeys | 229.99 AUD | false positive (listing live) | **NOT a dead link — the report was a false positive.** The audit tested the collection-scoped URL (`/collections/current-group-buys/products/gmik-zimo-group-buy`, a 404 because the product was removed from that collection) and the corrected handle `/products/gmk-zimo-group-buy` (also 404). But the price pass strips the collection prefix (`normalizeShopifyUrl`) to the **stored typo handle** `/products/gmik-zimo-group-buy`, which **301-redirects → `/products/gmik-zimo` → `/products/gmk-zimo` (200)**, a live product (probe run 36444934333). A FORCE refresh (36443092241, `dead=1070`) did not clear it, and a targeted re-scrape by id `cmq585yjj03j0b17dsjv05k5w` (run 36445670318) returned `attempted=1 updated=1 dead=0`, re-storing a valid 229.99 AUD (≈USD 150, in `KIT_BOUNDS`). So the listing is **live and plausibly priced** — no scrape bug, nothing to clear. The stuck-stale state came from the report re-queue reaching the live product (kept the price) while the 2000-row FORCE batch (`limit=2000`, nulls-first) never included it; only `PRICE_REFRESH_IDS` reliably reaches it — which is why the feed now prints the id (`cf67ecb`). **Open owner item (§1):** the store's current in-stock "GMK Zimo" is `/products/gmk-zimo` at Base **165 AUD**, a different SKU from the row's 229.99 GB product; discovery won't auto-relink a priced row, so relinking is an owner/catalog judgment (two real SKUs), brought to the owner not forced | ✅ resolved (false positive; live 229.99 AUD; relink is an open owner item) |
| 2026-09-28 | gmk-black-snail | Neo Macro | 6,500 INR | needs fix | **Wrong variant, fixed #198 (`6f36882`).** neomacro.in sells no base kit for Black Snail; the picker took the dearest unlabeled line, the **U9 Modifier Kit** (INR 6500). #198 added `modifier` and `retro point` to `NONBASE_SUBKIT_RE` in `kit-variants.ts` (scrape.py composes its copy from the mirror) — verified present in both halves this run. The row clears to `NO_BASE_KIT`; the feed reads `current=null`. Filed by the deals audit batch 3 | ✅ resolved (#198; row cleared to null) |
| 2026-09-28 | gmk-black-snail---red-cyrillic-addon | Neo Macro | 6,500 INR | needs fix | ⚠️ **#198 did NOT reach this row — recurred 2026-10-04.** The 2026-09-28 note assumed the same fix as gmk-black-snail, but that set is NOT a subkit set while this one IS: its name contains "Addon"/"Cyrillic", so `isSubkitSetName` is true, the pickers run with `allowSubkits=true`, and that flag bypasses the `NONBASE_SUBKIT_RE` exclusion #198 relies on. So the modifier kits were never excluded here and the U9 Modifier (6500) was picked again. Reopened as an owner item — see the 2026-10-04 audit row below | ⚠️ reopened (see 2026-10-04 row) |
| 2026-09-28 | gmk-mothman | GEONWORKS | 150 USD | self-healed (dead link) | `geon.works/products/group-buy-gmk-cyl-mothman` 302s to `geon.works/` (front page, no product). `isGoneRedirect` marks the row `DEAD_LINK` and clears the price; the feed reads `current=null USD`. Filed by the deals audit batch 3 | ✅ resolved (dead-link redirect; cleared to null) |
| 2026-09-29 | gmk-wasabi-r2 | SwitchKeys | 199 AUD | false positive | **Not a wrong price.** Deals-audit batch 5 established AUD 199 is correct (matches switchkeys.com.au's own `.js`); the 143 the batch-4 report cited came from the store's geo-converted `.json`. The stored collection URL 404s but `normalizeShopifyUrl` strips it to `/products/gmk-wasabi-v2-group-buy`, which 301s to the live `/products/gmk-wasabi-v2`; the price reads 199 AUD SCRAPED. No scrape bug | ✅ resolved (false positive; 199 AUD correct) |
| 2026-09-29 | gmk-botanical-r2 | Oblotzky Industries | 159 EUR | needs fix | **Wrong variant, fixed #201 (`95e1e0d`).** Vendor probe (run 36735257689, `/products/gmk-cyl-botanical-2`): real base "Standard" 139 EUR `available=true`, beside "Standard Base + Hibi & Botanical Leaf"/"… Succulent" bundles at 159. The bundle names artisan kits ("Hibi", "Botanical Leaf") no `BUNDLE_EXTRA_RE` lists and no literal "bundle", so `classifyVariant` fell through to BASE — and the real base "Standard" carries no "base" word (→ OTHERS), so the "… Base + …" bundle was the only variant classified BASE and `titledBase` returned it. #201 adds the "+ after base" shape (`basePlusExtra` / `_base_plus_extra`) as a third bundle signal, stripping parenthetical colourway specs so "Teal & White Base" and "Two Base（Teal + White）" stay BASE. The picker then returns the dearest real base = "Standard" 139. Targeted re-scrape (id `cmq585ux202a0b17d1q505hsa`, run 36736521078, `updated=1`); confirmation feed (run 36736657805) reads `139 EUR SCRAPED`. `test:kit-variants` + Python suite pin both halves | ✅ resolved (#201; 139 EUR) — on watch |
| 2026-09-30 | gmk-masterpiece-r2 | Oblotzky Industries | 119 EUR | self-healed (stock) | Stock/pre-order. Vendor probe (run 36735257689): "Origin Base" 119 EUR `available=true` (product tag "pre-order"), beside "Roman Base" 139. The picker's 119 (first titled base, the cheaper colourway) is correct and was never disputed; the report was that the tracker showed it SOLD OUT. Availability scrape clears the display; the price pass is sole authority for `inStock` (#153). Recurs as a pre-order/stock note (cf. the 2026-07-18 masterpiece pre-order reports) | ✅ resolved (self-healed; on watch) |
| 2026-09-30 | gmk-varenye | iLumKB | 209 SGD | self-healed (stock) | Stock. Vendor probe (run 36735257689): "Full Base" 209 SGD `available=true` (TKL Base 179, Extension 76, Alt Mods 132). The picker's 209 (dearest titled base) is correct and was never disputed; the report was that the tracker showed it SOLD OUT. Availability scrape clears it. **Confirmed healed 2026-10-01** (feed `209 SGD SCRAPED`) | ✅ resolved (self-healed; confirmed 2026-10-01) |
| 2026-10-01 | dcs-handarbeit | proto[Typist] | 95 GBP | needs fix | **Wrong variant, already fixed #202 (`86c4eef`).** proto[Typist] sells its only base as "DCS Handarbeit - Base Kit + UKISO" (GBP 95) beside "WASD" (15.83), "BAE", "10U". #201's "+ after base" rule correctly classified the base as a BUNDLE — but with no plain base left, `pickBaseVariant` fell back to the dearest UNLABELLED line, and the cheap WASD subkit won. #202 drops an unlabelled candidate priced under HALF the cheapest bundle (a bundle is a base plus something, so the base inside it costs well over half), so the bundle is used. Re-scrape landed the base; feed reads `95 GBP SCRAPED`. Filed by the deals audit batch 6 | ✅ resolved (#202; 95 GBP; confirmed 2026-10-02) |
| 2026-10-01 | dcs-dream-alert | proto[Typist] | 105.83 GBP | needs fix | Same cause/fix as dcs-handarbeit: "6.25u Kit" (GBP 15) priced as base; the base is "Base Kit + UKISO Kit" GBP 105.83 (sold out). #202 half-the-bundle rule; feed reads `105.83 GBP SCRAPED` | ✅ resolved (#202; 105.83 GBP; confirmed 2026-10-02) |
| 2026-10-01 | gmk-cyl-finer-things-r2-keycaps | Keebz n Cables | 180 AUD | needs fix | **Geo-converted `.json` price, fixed in-run (`abc3021`).** Vendor probe run 36883084292: `/products/<h>.json` (plain, no cookie) served "Teal Base"/"White Base" **143.68** with a fake 176.15 compare-at, while `/products/<h>.js` carries the shelf price **180 AUD** (available=true, no compare-at). `/products/<handle>.json` is geo-localizable by Shopify Markets: a datacenter IP whose home-market pin misses (`/meta.json` blocked, or Markets ignoring the `cart_currency`/`localization` cookie) is served the US-geo conversion, stored under the shop's own currency code; `.js` is never localized. #202 handed this to the review. Both price passes now prefer the `.js` shelf price per variant id (`shelfPriceById`/`applyShelfPrices` in `kit-variants.ts`, mirrored `_shelf_prices_by_id`/`_apply_shelf_prices` in `scrape.py`), falling back to `.json` when `.js` is blocked — one-directional: an unconverted store serves the same price on both endpoints. The fake `.json` compare-at is dropped too. The deals auditor's `readShopify` has read `.js` since 2026-09-28; this brings the price passes into line. `test:kit-variants` + Python suite pin both halves. Feed reads `180 AUD SCRAPED` | ✅ resolved (`abc3021`; 180 AUD; confirmed 2026-10-02) |
| 2026-10-01 | gmk-finer-things | Keebz n Cables | 180 AUD | needs fix | Same vendor/product/fix as gmk-cyl-finer-things-r2 (the R1 set links to the R2 product page). `.js` shelf price 180 AUD; feed `180 AUD SCRAPED` | ✅ resolved (`abc3021`; 180 AUD; confirmed 2026-10-02) |
| 2026-10-01 | gmk-alt-grrrrr-addon | Keebz n Cables | 19 AUD | needs fix | Same cause/fix. Probe: `.json` Dolch 12.77 / Evil Dolch 15.17 (converted); `.js` Dolch 16 / Evil Dolch 19 (shelf, available=true, no compare-at). `.js`-shelf-price fix; feed `19 AUD SCRAPED` | ✅ resolved (`abc3021`; 19 AUD; confirmed 2026-10-02) |
| 2026-10-01 | gmk-orange-alert | Keebz n Cables | 211 AUD | needs fix | Same cause/fix. Probe: `.json` "TKL Base" 168.43 (converted); `.js` 211 AUD, `available=false` (sold out both sides). `.js`-shelf-price fix; feed `211 AUD SCRAPED` | ✅ resolved (`abc3021`; 211 AUD; confirmed 2026-10-02) |
| 2026-10-01 | gmk-kitsune | KeyBay | 209 CAD | needs fix | Same cause/fix, KeyBay (CA store). Probe: `.json` "Base" 158 (US-geo conversion stored as CAD); `.js` "Base" 209 CAD, available=true. `.js`-shelf-price fix; feed `209 CAD SCRAPED` | ✅ resolved (`abc3021`; 209 CAD; confirmed 2026-10-02) |
| 2026-10-01 | gmk-manta | KeyBay | 209 CAD | needs fix | Same cause/fix as gmk-kitsune. `.json` 158, `.js` 209 CAD; feed `209 CAD SCRAPED` | ✅ resolved (`abc3021`; 209 CAD; confirmed 2026-10-02) |
| 2026-10-02 | gmk-varenye | GEONWORKS | null USD | self-healed (dead link) | `geon.works/products/group-buy-gmk-cyl-varenye` 302s to `geon.works/` (front page, no product); the `gmk-cyl-varenye`/`gmk-varenye` handles 404. `isGoneRedirect` recognises the root-redirect, marks the row `DEAD_LINK` and clears the price; the feed reads `current=null USD SCRAPED`, `resolvedAt=2026-10-02T06:42:34.892Z` (post-dating the 01:50 submit). Identical designed behaviour to gmk-mothman × GEONWORKS (2026-09-28) — GEONWORKS 302s removed products to its front page store-wide. The unpriced row is correctly hidden on the released set; the deals-rail "USD 150 in stock" the reporter saw is a stale point-in-time artifact cleared by deploy/scrape propagation. No code change. Filed by the deals audit batch 7 (#204). **Confirmed healed 2026-10-03** (feed `null USD SCRAPED`, `resolvedAt=2026-10-03T05:33:28.602Z` post-dating the submit; null held across the nightly scrape) | ✅ resolved (self-healed; confirmed 2026-10-03) |
| 2026-10-03 | gmk-2pack-add-on | Oblotzky Industries | 32 EUR | self-healed (stock) | Stock-only. Site showed the listing SOLD OUT; the store's "GMK CYL 2 Pack" base is EUR 32, `available=true` (product tag "pre-order"), confirmed from a runner by the batch-8 Vendor probe (run 37087613361). Price 32 EUR is correct and was never disputed; the price pass is sole authority for `inStock` (#153), so the next availability scrape flips the display in stock. No code change. Filed by the deals audit batch 8 (#205). **Confirmed healed 2026-10-04** (feed `32 EUR SCRAPED`; batch-9 deals audit independently observed the site "EUR 32, in stock" — the in-stock flip happened) | ✅ resolved (self-healed; confirmed 2026-10-04) |
| 2026-10-03 | gmk-2pack-add-on | Swagkeys | 44.99 AUD | wrong vendor (held for owner) | **Not a wrong price — wrong vendor attribution.** The Swagkeys row (a Korean store, `swagkeys.com` / `swagkey.kr`; two seed rows `swagkeys` + `swagkeys-kr`) carries a VendorKit whose `productUrl` and AUD 44.99 price are **SwitchKeys'** (`switchkeys.com.au/products/gmk-2pack`, an Australian store, confirmed by batch-8 probe 37087613361). The price pass reads the SwitchKeys listing correctly — no wrong currency/product/variant — so this is not a price-scrape bug and re-scraping re-reads the same URL under the same vendor (the feed's `resolvedAt=2026-10-03T06:03:12.839Z` auto-resolution is spurious). Swagkeys and SwitchKeys are two genuinely distinct real shops with look-alike names (SwitchKeys exists in production — it is the gmk-zm owner item's vendor — but is not in `src/data/seed/vendors.json`); the listing is almost certainly a one-off upstream KeycapLendar mis-attribution, not a systematic matcher bug (neither Swagkeys `websiteUrl` points at switchkeys.com.au, so discovery did not crawl it there). The repair is a targeted **VendorKit reassignment** to the SwitchKeys vendor row (or a drop from Swagkeys, since discovery links SwitchKeys' own catalogue) — a catalog / vendor-identity decision no price-scraper code and no automated heal/seed pass performs (`planStorefrontOwnership` fixes a vendor's `websiteUrl`, never a single listing's vendor), needing production DB access this session lacks. **Held for the owner** per the routine's genuine-ambiguity / architecturally-significant exception (same class as the `kt-dyad-tkl` `wrong_vendor` flag §4b and the gmk-zm relink §1). Filed by the deals audit batch 8 (#205) | ⚠️ open owner item (§1) — awaiting reassignment |
| 2026-10-04 | gmk-black-snail---red-cyrillic-addon | Neo Macro | 6,500 INR | needs fix (recurrence; held for owner) | **Wrong variant, recurrence of 2026-09-28; #198 does not reach this row.** Vendor probe run 37212339509 (`neomacro.in/products/gmk-black-snail`, READABLE Shopify, 8 variants all `available=true`, INR): L9 Modifier 6000, **U9 Modifier 6500**, 40s Ortho linear 4900, GMK Retro Point 600, **Red Cyrillic Alphas 9900**, 9009 Accents 3000, Numpad 2500, Cherry Accents 1900 — **no "Base" variant**. The set name contains "Addon"/"Cyrillic" → `isSubkitSetName` true → pickers run `allowSubkits=true`, which bypasses the `NONBASE_SUBKIT_RE` exclusion (`kit-variants.ts:187`, `scrape.py:1491`), so #198's modifier exclusion never fires. "Red Cyrillic Alphas" (the variant this set actually names, 9900) classifies ALPHA → excluded from the base pool, so the dearest OTHERS = U9 Modifier (6500) is picked. The correct outcome is contested and the repair is roster-wide: (1) keep the set and price it at Red Cyrillic Alphas 9900 via a NEW name-match heuristic in the shared `pickBaseVariant`/`choose_kit_variant` (both halves, 4 call sites, propagated nightly by the price audit, + the ALPHA classification must be revisited) — architecturally significant; or (2) remove/merge the near-duplicate row (same product URL + variant list as `gmk-black-snail`, which correctly clears to null; VendorKit `cmuslcupj000n04igkpdo3hmn` may have been re-created per the batch-9 audit) — a catalog decision needing production DB access. Neither clear-to-null nor block-the-pair is correct (the Red Cyrillic Alphas kit genuinely is for sale). **Held for the owner** per routine step 4; recommendation: option 1 if keeping the set, else option 2. Live harm: INR 6500 shows as a fake base price on `/released` until repaired. Filed by the deals audit batch 9 (#206) | ⚠️ open owner item (§1) — awaiting decision |

### Client-recommended values verified

- **gmk-mictlan-rebirth base = ARS 184,285.71** (client's correction). Verified
  against the WooCommerce base-kit selection in #54 — the parser now resolves
  the mictlan base to exactly ARS 184,285.71, confirming the reporter's figure.
- **gmk-cyl-tiramisu base = "116 europe"** (Oblotzky, client's reading).
  Verified as the store's **ex-VAT** display: the tracked DE-market base is the
  inc-VAT figure (≈ 139 EUR), matching the Oblotzky "116 vs 139" pattern noted
  in `CLAUDE.md`. The 116 is not a scrape target; the listing self-cleared to
  null pending a fresh in-stock base scrape.
- **gmk-teradrive base = USD 165 / gmk-monarch base = USD 145** (Mekibo, deals
  audit's correction). Verified: both are within `KIT_BOUNDS`, both are the plain
  "Base Kit" the store lists in stock, and both are exactly what
  `pickBaseVariant`/`choose_kit_variant` now return after #194 reclassified the
  `[Bundle] Base + …` variants as BUNDLE. **Confirmed stored 2026-09-26**: the
  feed reads gmk-teradrive `165 USD SCRAPED` and gmk-monarch `145 USD SCRAPED`.
- **gmk-botanical-r2 base = EUR 139** (Oblotzky, deals audit's correction).
  Verified against the probe (run 36735257689): "Standard" is the plain base at
  EUR 139, in stock, and within `KIT_BOUNDS`; the 159 the reporter flagged is the
  "Standard Base + Hibi & Botanical Leaf" bundle. **Confirmed stored 2026-09-30**
  after #201: the feed reads `139 EUR SCRAPED`.
- **Keebz n Cables AUD / KeyBay CAD shelf prices** (deals audit batch 6's
  correction): gmk-cyl-finer-things-r2 / gmk-finer-things **180 AUD**,
  gmk-alt-grrrrr-addon **19 AUD**, gmk-orange-alert **211 AUD** (sold out),
  gmk-kitsune / gmk-manta **209 CAD**. Verified against the Vendor probe (run
  36883084292): each is the store's own `/products/<handle>.js` shelf price in
  the shop's base currency (the reported wrong figures — 144.12 / 15.21 / 168.95
  AUD, 158 CAD — were the geo-converted `/products/<handle>.json` a US runner is
  served). The `.js`-shelf-price fix stores these deterministically.
- **dcs-handarbeit base = GBP 95 / dcs-dream-alert base = GBP 105.83**
  (proto[Typist], deals audit batch 6's correction). Verified: both are the
  store's "Base Kit + UKISO" variant, within `KIT_BOUNDS`, and exactly what the
  picker returns after #202 stops a cheap unlabelled subkit outranking the only
  bundle. Feed reads `95 GBP` / `105.83 GBP SCRAPED`.

## Summary

- **68 report submissions across ~52 listings** (full `?all=1` history, first
  reconciled 2026-08-26; gmk-vamp × Switchmod added 2026-08-27; 6 added
  2026-09-26, 2 added 2026-09-27, 3 added 2026-09-28, 2 added 2026-09-29, 2 added
  2026-09-30, 8 added 2026-10-01, 1 added 2026-10-02 (batch 7, #204:
  gmk-varenye × GEONWORKS — dead-link redirect self-heal, price cleared to null,
  identical to gmk-mothman × GEONWORKS; confirmed healed 2026-10-03), and **2
  added 2026-10-03** (batch 8, #205, both on gmk-2pack-add-on: × Oblotzky — a
  stock-only self-heal, EUR 32 base available pre-order, on watch; × Swagkeys — a
  **wrong-vendor** attribution, a SwitchKeys listing on the Korean Swagkeys row,
  held for the owner as a VendorKit-reassignment catalog decision, not a
  price-scrape bug), and **1 added 2026-10-04** (batch 9, #206:
  gmk-black-snail---red-cyrillic-addon × Neo Macro — a **recurrence** of the
  2026-09-28 report; #198's `NONBASE_SUBKIT_RE` does not reach this row because
  its name trips `isSubkitSetName` → `allowSubkits` bypasses the exclusion, so
  the U9 Modifier Kit INR 6500 is picked again; held for the owner as a contested
  shared-picker-heuristic vs catalog-merge repair, architecturally significant).
  The 8 added 2026-10-01 (batch 6, #202 +
  the `.js` shelf-price fix #203), all confirmed healed on the 2026-10-02 run: dcs-handarbeit / dcs-dream-alert × proto[Typist] (#201
  wrong-variant regression, fixed **#202** — a cheap unlabelled subkit no longer
  outranks the only bundle) and four Keebz n Cables + two KeyBay rows
  (geo-converted `.json` price, fixed this run by preferring the un-localized
  `.js` shelf price). The earlier batches: **2 added 2026-09-29**
  (batch 4, #199: gmk-wasabi-r2 × SwitchKeys — false positive, 199 AUD correct;
  gmk-botanical-r2 × Oblotzky — wrong variant, fixed **#201**) and **2 added
  2026-09-30** (batch 5, #200: gmk-masterpiece-r2 × Oblotzky and gmk-varenye ×
  iLumKB, both stock-only self-heals with correct prices, confirmed healed
  2026-10-01) by the
  released deals audit. The 3 added 2026-09-28 were batch 3, #198:
  gmk-black-snail × Neo Macro and its red-cyrillic
  add-on (wrong variant = the U9 Modifier Kit, fixed #198 → both cleared to
  null) and gmk-mothman × GEONWORKS (dead-link redirect, cleared to null), all
  healed. The 2 added 2026-09-27 (batch 2, #195) both resolved on
  2026-09-28: gmk-panda × iLumKB (recurrence, #195 — probe-confirmed base sold
  out, no 4th recurrence) and gmk-zm × SwitchKeys (the "dead link" was a FALSE
  POSITIVE — only the collection URL 404s; the stored handle 301-redirects to a
  live product, targeted re-scrape `updated=1` at a plausible 229.99 AUD; a
  relink to the current in-stock `/products/gmk-zimo` at 165 AUD is an open
  owner item).
  The 6 added 2026-09-26 were: 2 Mekibo wrong-variant
  (fixed #194), 2 stock-only self-heals (DeskHero, iLumKB), and 2 Neo Macro
  closed-store-in-deals (owner-approved deals-filter LOCKED exclusion in
  `src/app/api/released/route.ts`, `00d138a`). **All 6 were CONFIRMED healed on
  the 2026-09-26 confirmation run** — the two Mekibo re-scrapes landed exactly
  165/145 USD, the two stock rows resolved with correct prices, and the two Neo
  Macro rows read `source=LOCKED` and are excluded from the deals rail by the
  deployed filter. On **2026-09-27** the deals audit batch 2 (#195) filed 2 more
  — gmk-panda × iLumKB (recurrence, root-caused and fixed in #195: `nov`/`space`
  added to `BUNDLE_EXTRA_RE`) and gmk-zm × SwitchKeys (dead-link self-heal) — both
  now on the Self-heal watch for next-run confirmation. The 2026-09-26 run was the
  first since 2026-08-27 to surface a pending report, and the first ever sourced
  from the deals audit rather than an end user.
- **New systematic surface: the deals rail (`/released`).** `ON_SALE_FILTER` and
  the `bundleSetIds` scan counted a `LOCKED` (closed-store) row as a buyable
  in-stock deal because a LOCKED row deliberately keeps `inStock=true` +
  `compareAtPrice`. Both now exclude `priceSource=LOCKED`, completing the filter's
  own "a discount on a listing nobody can buy is not a deal" intent, without
  touching set-page visibility.
- **Wrong-variant family extended: a base named without the word "base".**
  #194/#195/#198 fixed bundles that named an extra the vocabulary did not know.
  #201 (`95e1e0d`) closes the harder shape behind it: Oblotzky's GMK Botanical
  sells the plain base as "Standard" (no "base" word → OTHERS) beside a "Standard
  Base + Hibi & Botanical Leaf" bundle whose only "base"-classified sibling made
  it the picker's `titledBase`. The "+ after base" shape (`basePlusExtra`) marks
  it a bundle without a per-set vocabulary, and parenthetical colourway specs are
  stripped so "Two Base（Teal + White）" stays a base. `159 → 139 EUR` confirmed.
- **New systematic surface: the geo-localized `.json` price.** Both price passes
  read a Shopify listing's price from `/products/<handle>.json`, which Shopify
  Markets converts to the requester's geo (a US datacenter IP) whenever the
  `cart_currency`/`localization` cookie's pin misses — storing the US conversion
  under the shop's own currency code, visibly cheapest, with a compare-at the
  store never shows. The row oscillates run to run depending on whether the pin
  lands. `/products/<handle>.js` is never localized and carries the store's own
  shelf price; both passes now prefer it per variant id (`shelfPriceById` /
  `applyShelfPrices`, mirrored in `scrape.py`), falling back to `.json` when `.js`
  is blocked. One-directional — an unconverted store serves the same price on
  both endpoints — and it matches what the deals auditor's `readShopify` has done
  since 2026-09-28. Fixed this run for six rows (Keebz n Cables AUD ×4, KeyBay
  CAD ×2). The complementary wrong-variant regression (proto[Typist] ×2, #201's
  "+ after base" left a cheap unlabelled subkit outranking the only bundle) was
  fixed in **#202 (`86c4eef`)**.
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
