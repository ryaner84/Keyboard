# Price-report review routine

Canonical instructions for the recurring **wrong-price report** review of the
GMK group-buy tracker. The scheduled routine prompt should point here so the
procedure stays versioned with the code it acts on.

Work on the `main` branch.

## Procedure

1. Dispatch the **Price reports feed** workflow (`price-reports-feed.yml`) on
   `ryaner84/Keyboard`, wait for it to complete, and read its execution log.
   Each pending report prints as a `PRICE_REPORT | …` line (date, set, vendor,
   current price, price source, reason, product URL).
2. **Re-verify prior "self-healed" items first.** A `self-healed` verdict is
   provisional — it only holds once the fix survives a later scrape. At the
   start of every run, before assessing new reports, re-check each listing a
   previous run marked self-healed:
   - **Stayed rectified?** The current price is still `null` (or now shows the
     correct base kit) and the flagged wrong value did not come back. Only then
     is it truly resolved and can stop being tracked.
   - **Regressed?** The wrong price returned (a re-scrape re-stored the bad
     value, or a stock-only complaint keeps recurring). It never actually
     healed — reclassify it as **needs fix** and treat it as a systematic bug,
     because a value that reverts is the "never heals" case, not a heal.
3. For each `PRICE_REPORT` line, assess:
   - **Self-healed?** The current price was re-scraped recently or is now
     `null`. Stock-only complaints ("sold out", "no stock", "ready stock")
     self-heal on the next availability scrape and never need code.
   - **Needs a scraper code fix?** The reason points at a systematic scrape bug
     — wrong currency, wrong product, or wrong variant/subkit. These do **not**
     self-heal: re-scraping pulls the same wrong value every run.
4. **Investigate and fix proactively.** Do not wait for per-report approval.
   Trace each "needs fix" report to its root cause in `scraper/scrape.py`
   (and `src/lib/import/prices.ts` / `vendor-overrides.ts`), implement the fix,
   add/extend unit tests in `scraper/tests/test_scraper_helpers.py`, run the
   suite, then commit on `main`. Only pause for a human decision when a fix is
   genuinely ambiguous or architecturally significant.
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
