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
2. For each `PRICE_REPORT` line, assess:
   - **Self-healed?** The current price was re-scraped recently or is now
     `null`. Stock-only complaints ("sold out", "no stock", "ready stock")
     self-heal on the next availability scrape and never need code.
   - **Needs a scraper code fix?** The reason points at a systematic scrape bug
     — wrong currency, wrong product, or wrong variant/subkit. These do **not**
     self-heal: re-scraping pulls the same wrong value every run.
3. **Investigate and fix proactively.** Do not wait for per-report approval.
   Trace each "needs fix" report to its root cause in `scraper/scrape.py`
   (and `src/lib/import/prices.ts` / `vendor-overrides.ts`), implement the fix,
   add/extend unit tests in `scraper/tests/test_scraper_helpers.py`, run the
   suite, then commit on `main`. Only pause for a human decision when a fix is
   genuinely ambiguous or architecturally significant.
4. Present a results table with these columns:
   `report date | set | vendor | current price | reason | verdict
   (self-healed / needs fix) | recommendation | status post-fixing`.
   - **status post-fixing** describes what the listing looks like once the fix
     lands and the queued re-scrape runs (e.g. "base kit ARS 184,285 shown",
     "price cleared (NO_BASE_KIT)", "unchanged — false alarm").
5. **Remove already-resolved rows.** Reports whose root cause is already fixed
   in the current codebase (the issue no longer exists) are dropped from the
   table. List them in a short "removed / already resolved" note for the audit
   trail instead of leaving them in the main table.
6. If there are no reports, say "No pending reports" and stop.
7. Check on any new product/vendor a reporter recommends (a corrected base
   price, the correct product URL, or a vendor/currency note in the reason) and
   verify it against the scraper's vendor overrides and plausibility bounds.

## Notes

- The feed reads the live site (`/api/price-reports`); GitHub runners can reach
  production, local sessions usually cannot. The log line omits `priceUpdatedAt`
  — judge "re-scraped recently" from the current price, reason, and how often
  the same listing recurs across reports.
- Self-heal mechanics live in `src/app/api/price-reports/route.ts`: a report
  re-queues the listing (clears `priceUpdatedAt`); a second report within 7 days
  nulls the price. A buggy scraper that re-stores the wrong value on the next
  run defeats the null — that is the "never heals" case a code fix must break.
- Non-Shopify storefronts (WooCommerce: Latamkeys `/productos/`, STACKS
  `/store/`) are priced by `generic_price()`; Shopify `/products/` listings by
  `shopify_price()`. Both pick the base kit via `choose_kit_variant()`.
