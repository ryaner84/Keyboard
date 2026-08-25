# Price-report review routine

Canonical instructions for the recurring **wrong-price report** review of the
GMK group-buy tracker. The scheduled routine prompt should point here so the
procedure stays versioned with the code it acts on.

Work on the `main` branch.

## Scheduled prompt (paste this verbatim into the scheduler)

The recurring scheduled task must **point at this file** rather than restate an
abbreviated copy of the steps — an inlined prompt drifts out of sync with the
procedure the moment either changes (e.g. it silently stops rendering the three
ledger tables). Use exactly:

> Run the wrong-price report review for the GMK group-buy tracker exactly as
> specified in `docs/price-report-review-routine.md`. Read that file first and
> follow every step, including re-verifying every prior self-healed item
> against the Self-heal watch and rendering all ledger tables from
> `price-report-ledger.md` on every run — even when there are zero pending
> reports. Work on the `main` branch. When a report needs a fix — a fresh
> "needs fix" report, or a watched item that did not actually self-heal — trace
> it to its root cause per the doc, implement and commit the fix on `main`
> yourself, and only pause for me when a fix is genuinely ambiguous or
> architecturally significant. Do not wait for per-report approval.

If the stored prompt ever diverges from the steps below, the prompt is wrong,
not the doc — repoint it here.

## Procedure

1. Dispatch the **Price reports feed** workflow (`price-reports-feed.yml`) on
   `ryaner84/Keyboard`, wait for it to complete, and read its execution log.
   The feed also runs on its own **daily schedule (00:30 UTC)** so no report
   goes uncaptured between manual runs. It pulls the FULL history (`?all=1`)
   and prints two blocks:
   - `PRICE_REPORT | …` lines — the **pending** reports to act on (date, set,
     vendor, current price, price source, reason, product URL).
   - `PRICE_REPORT_RESOLVED | …` lines — the **already-resolved** history (same
     fields plus `resolvedAt`), for reconciling the client-reported log so a
     report that self-healed between two runs is never silently dropped. Cross-
     check these against the ledger's full log and append any that are missing.
2. **Re-verify every prior "self-healed" item first — and fix the ones that did
   not heal.** A `self-healed` verdict is provisional: it only holds once a
   later scrape proves it. A nightly scrape runs between review runs, so by the
   next run every self-heal flagged previously can and must be confirmed. Track
   them in the **Self-heal watch** table (1b) of `price-report-ledger.md`: every
   item a run marks self-healed is added there on that run and stays until this
   step confirms or fails it. At the start of every run, before assessing new
   reports, re-check each watched listing against the full-history feed (its
   `PRICE_REPORT` and `PRICE_REPORT_RESOLVED` lines):
   - **Healed → confirm.** The report is now resolved (`resolvedAt` set after a
     scrape that ran *after* the report was filed) and the flagged wrong value
     is gone — price is `null`, now shows the correct base kit, or the
     stock-only listing re-scraped cleanly. Only then mark it resolved, move it
     to the resolution audit, and drop it from the watch.
   - **Did NOT heal → fix it now.** The item is still pending a full day after a
     nightly scrape should have re-verified it, the wrong value came back, or
     the same listing was re-reported. A value that survives or reverts across a
     scrape is the "never heals" case, not a heal. Reclassify it **needs fix**
     and **fix it in this same run** per step 4 — trace the root cause,
     implement the scraper/import fix, add tests, run the suite, and commit on
     `main`. Do not defer it to a human and do not leave it on the watch for
     "another day": the scheduler owns the fix.
3. For each `PRICE_REPORT` line, assess:
   - **Self-healed?** The current price was re-scraped recently or is now
     `null`. Stock-only complaints ("sold out", "no stock", "ready stock")
     self-heal on the next availability scrape and never need code.
   - **Needs a scraper code fix?** The reason points at a systematic scrape bug
     — wrong currency, wrong product, or wrong variant/subkit. These do **not**
     self-heal: re-scraping pulls the same wrong value every run.
4. **Investigate and fix proactively.** Do not wait for per-report approval.
   This covers both fresh "needs fix" reports and any item that **failed
   self-heal verification in step 2**. Trace each to its root cause in
   `scraper/scrape.py` (and `src/lib/import/prices.ts` / `vendor-overrides.ts`),
   implement the fix, add/extend unit tests in
   `scraper/tests/test_scraper_helpers.py`, run the suite, then commit on
   `main`. Only pause for a human decision when a fix is genuinely ambiguous or
   architecturally significant.

   > **"Manual fix" here means the scheduler implements and commits the fix
   > itself** — it never means "stop and wait for a human". An item that did not
   > self-heal is the scheduler's to repair in the same run it detects the
   > failure. A stored prompt that says "do not make code changes / wait for the
   > user to decide" contradicts this routine and is wrong (repoint it here per
   > the note above); the only pause is the genuine-ambiguity exception.
5. Present a results table with these columns:
   `report date | set | vendor | current price | reason | verdict
   (self-healed / needs fix) | recommendation | status post-fixing`.
   - **status post-fixing** describes what the listing looks like once the fix
     lands and the queued re-scrape runs (e.g. "base kit ARS 184,285 shown",
     "price cleared (NO_BASE_KIT)", "unchanged — false alarm").
6. **Remove already-resolved rows.** Reports whose root cause is already fixed
   in the current codebase (the issue no longer exists) are dropped from the
   table. List them in a short "removed / already resolved" note for the audit
   trail instead of leaving them in the main table.
7. **Always render the ledger as three tables** (from `price-report-ledger.md`).
   On EVERY run — including when there are zero pending reports — render:
   - **(a) Open wrong-price reports** — ledger rows that are **not yet
     resolved**. **Resolved rows are omitted** from this table; when everything
     is resolved, show "none".
   - **(b) Open client-recommended values** — client-suggested corrected
     prices/URLs/vendors **still awaiting verification**. **Verified (resolved)
     recommendations are omitted**; when all are verified, show "none".
   - **(c) Client-reported items** — the full client's-eye log of every report
     ever filed (columns: logged date, set, vendor, reported price, client
     reason, verdict, status). This one **always shows every item**, resolved or
     not, and is the durable "what has the client complained about" view.

   Also render **(1b) Self-heal watch** — the items awaiting next-day
   confirmation (step 2). This is the working set the verification loop keys on:
   a row is added when an item is flagged self-healed and cleared only when a
   later run confirms it healed or fixes it. Rendering it every run makes the
   pending verifications visible; when the watch is empty, show "none".

   The `Resolution audit` table in the ledger keeps the full root-cause/fix
   detail for the audit trail and is **not** rendered per run. When the current
   run surfaces a NEW report, append its row to the client-reported log **and**
   the resolution audit (and commit on `main`) so the ledger stays complete.
8. If there are no PENDING reports, still render the three ledger tables
   (step 7), say "No pending reports", and stop.
9. Check on any new product/vendor a reporter recommends (a corrected base
   price, the correct product URL, or a vendor/currency note in the reason) and
   verify it against the scraper's vendor overrides and plausibility bounds.

## Notes

- The feed reads the live site (`/api/price-reports`); GitHub runners can reach
  production, local sessions usually cannot. The log line omits `priceUpdatedAt`
  — judge "re-scraped recently" from the current price, reason, and how often
  the same listing recurs across reports.
- The feed returns only PENDING reports. A report auto-resolves (sets
  `resolvedAt`, drops out of the feed and out of the next run's table) once its
  bad price is gone or the listing was re-scraped after the report was filed —
  so issues fixed on a previous run do not reappear. A still-wrong fresh price
  comes back only via a new visitor report.
- To inspect a reported listing's REAL live variants (titles/prices/stock)
  before concluding anything, dispatch the **Vendor probe** workflow
  (`vendor-probe.yml`) with the product URL(s) — runners reach vendor stores
  that block this session's egress. Reporter reasons can be wrong: e.g. an
  EU store's ex-VAT display (Oblotzky "116" vs the correct DE-market 139 EUR
  base) or a mislabeled complaint against a correct base-kit price.
- Self-heal mechanics live in `src/app/api/price-reports/route.ts`: a report
  re-queues the listing (clears `priceUpdatedAt`); a second report within 7 days
  nulls the price. A buggy scraper that re-stores the wrong value on the next
  run defeats the null — that is the "never heals" case a code fix must break.
- Non-Shopify storefronts (WooCommerce: Latamkeys `/productos/`, STACKS
  `/store/`) are priced by `generic_price()`; Shopify `/products/` listings by
  `shopify_price()`. Both pick the base kit via `choose_kit_variant()`.
