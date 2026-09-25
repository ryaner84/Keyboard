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

## 1. Open wrong-price reports (unresolved only)

_None. All 41 full-history reports are resolved; 0 pending. The last open item —
gmk-bent-r2 × zFrontier — was fixed 2026-09-16 (commit `633581d`) and **confirmed
healed on 2026-09-17** (feed reads `150 USD SCRAPED`, 56 did not return)._

## 1b. Self-heal watch (pending next-day confirmation)

Every item a run marks **self-healed** lands here and stays until the *next*
run proves it. A nightly scrape runs between review runs, so by the next run
each row must be confirmed **healed** (report resolved, wrong value gone) or,
if it did not heal (still pending after a scrape, wrong value returned, or the
same listing was re-reported), reclassified **needs fix** and **fixed in that
run** — the scheduler owns the fix (see routine step 2). A confirmed row moves
to the resolution audit and drops out of this table.

_None. The watch is empty. The one item it held — gmk-bent-r2 × zFrontier
(fixed 2026-09-16, commit `633581d`) — was **confirmed healed on 2026-09-17**
(feed `current=150 USD SCRAPED`, `resolvedAt=2026-09-17T05:05:53.901Z` post-dating
the deployed-code scrape; 56 did not return) and moved to the resolution audit._

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

### 4b. Open — reported to owner (15 flags, awaiting decision)

These are genuinely ambiguous or architecturally significant; the review
session does not merge/delete catalog rows or demote GB status on its own.

| slug(s) | issue | flagged | inspector state | why open / recommendation |
|---|---|---|---|---|
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
  reconciled 2026-08-26; gmk-vamp × Switchmod added 2026-08-27; unchanged through
  the 2026-09-13 run). **All 41 are resolved; 0 pending.**
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
