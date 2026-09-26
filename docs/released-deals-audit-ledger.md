# Released deals audit — ledger

Scheduled review of the `/released` **On sale** listings (`/released?deals=1`):
each run takes the next 50 on-sale sets (alphabetical by slug, after the cursor
below), re-reads every priced BASE vendor listing from a GitHub runner with
**Released deals audit** (`released-deals-audit.yml`, `scripts/released-deals-audit.mjs`),
checks link / price / markdown / stock against the store, and files confirmed
problems through the site's own report buttons (the same workflow's `reports`
input → `/api/price-reports` for a vendor row, `/api/listing-reports` for the
listing flag). When the cursor passes the end of the list, the next run wraps
to the start.

## Cursor

`after_slug` for the next run: _(none yet — start from the beginning)_

## Runs

| date | batch (first … last slug) | sets | listings | issues found | reports filed | audit run |
|---|---|---|---|---|---|---|
