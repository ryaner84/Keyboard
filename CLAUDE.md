# Project guide for Claude

GMK group-buy price tracker (Next.js + Prisma/Supabase). A nightly Windows
WorkSpace scraper (`scraper/scrape.py`) and a 6-hourly GitHub Actions price
refresh (`src/lib/import/prices.ts`) both write base-kit prices into the same
DB the site reads.

## Wrong-price / listing report routine (standing policy)

Users file reports from the live site when a vendor price or stock status looks
wrong. The "Price reports feed" workflow (`.github/workflows/price-reports-feed.yml`)
prints the pending reports. When triaging these reports — whether run by hand or
on a schedule:

1. **Fix everything actionable in one pass, then report.** Don't stop at
   analysis. Apply the fixes you're confident in, then send a summary split
   into two sections:
   - **Fixed** — what changed, in which file, and how it resolves the report.
   - **Needs your decision** — reports you could not safely auto-fix, each with
     the specific reason and the options.
2. **Inventory/stock reports are valid errors, not noise.** A "sold out" item
   shown in stock (or vice-versa) is a real scraper bug — treat it like a price
   error, don't dismiss it as "not a price issue."
3. **Classify each report:** has it self-healed (price re-scraped recently or
   now null), or does it need a scraper code fix (wrong currency / wrong product
   / wrong variant / wrong stock)?
4. **Don't guess fixes you can't verify.** This environment's network egress is
   allow-listed (GitHub only) — you cannot fetch vendor stores or the live app
   from here. Any fix that depends on a vendor page's live structure (e.g. the
   JSON-LD/OpenGraph path for non-Shopify stores like Latamkeys `/productos/`
   or STACKS `/store/`) must go under **Needs your decision** with what you'd
   change, rather than shipping a blind guess into the shared scraper path.
5. **No reports → say "No pending reports" and stop.** A clean run is silence.

> The *scheduled* routine's own prompt is configured in the Claude Code web
> scheduler, outside this repo. This file documents the policy; if the schedule
> should also auto-fix, update that prompt to point here.

## Where price/variant logic lives (keep in sync)

The base-kit selection, currency bounds, and stock detection are duplicated by
design across three places — **change all three together**:

- `src/lib/import/prices.ts` — canonical TypeScript refresher (GH Actions + Vercel cron).
- `scraper/scrape.py` — Python mirror (nightly WorkSpace browser scraper).
- `scripts/db-setup.mjs` — deploy-time purge bounds; a window tighter than the
  producers' `KIT_BOUNDS` silently wipes legitimate prices on every deploy.

Key rules already encoded:
- Store the **BASE kit** price, never the cheapest add-on variant. Variant
  selection: pinned `?variant=<id>` > a `BASE`-classified variant > the first
  variant that is **not** an explicit non-base sub-kit (Novelties / Spacebars /
  Alphas). If every variant is a sub-kit, the listing has **no base kit** — the
  scraper returns the `NO_BASE_KIT` sentinel and the stale price is **cleared**
  (distinct from a fetch failure, which keeps the last good price).
- Only store prices in currencies the site can convert (`SUPPORTED_CURRENCIES`).
- Never overwrite a `priceSource = 'MANUAL'` price.
