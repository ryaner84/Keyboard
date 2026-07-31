# Working conventions

## Pull requests

**Open PRs ready for review, never as drafts.**

Undrafting a PR is the one operation that goes through GitHub's GraphQL API,
which has an hourly quota separate from REST. When that quota is exhausted the
PR cannot be undrafted from here at all, and the only way forward is for the
owner to click "Ready for review" in the GitHub UI by hand — which defeats the
point of driving the PR from the CLI.

Creating a PR non-draft needs no GraphQL, so the whole flow (push → open →
CI → merge) stays on REST and keeps working regardless of that quota.

If a PR genuinely isn't ready to merge, say so in chat and in the PR body
rather than reaching for draft state.

## Tests

Five suites, all of which should pass before pushing:

```
python3 -m unittest discover -s scraper/tests     # mirrors CI exactly
npm run test:set-name
npm run test:csv-import
npm run test:collection-import
npm run test:keycap-collection
npx tsc --noEmit
```

CI (`.github/workflows/scraper-tests.yml`) only runs the Python suite, and only
when `scraper/**` changes — so TypeScript changes are gated by Vercel's build
alone. Run `npx tsc --noEmit` and `npx next lint` locally for those.

`npx next build` will compile and typecheck without a database, then stop at
"Collecting page data" with a `No database configuration found` error. That
failure is environmental, not a code problem — `✓ Compiled successfully`
above it is the signal that matters.

## Keycap identity

Profile is product identity for keycaps: `DCS Dolch` and `GMK Dolch` are
different products from different manufacturers and must never be collapsed
into one another. `normalizeSetName`, `dedupeKey({ keepProfile: true })` and
the `db-setup` forum-stub heal all encode this — keep them in agreement.

Maker is not profile. GMK Electronic Design makes Cherry-profile sets plus the
CYL and MTNU profiles; Signature Plastics makes DCS, SA, DSS and DSA. `MTNU
Electronic Control` carries no "GMK" token, so maker cannot be inferred from a
substring search.

## Scraper

Manufacturer/catalog vendors (`gmk` → gmk.net, `dcs-wiki` → dcs.wiki) carry a
catalog URL for the catalog and image passes. They are never priced and never
crawled for listings — register any new one in `MANUFACTURER_VENDOR_SLUGS` and
`MANUFACTURER_URL_PATTERNS`, or its rows will land in the price queue and, having
no price timestamp, sort ahead of every real listing.

The `Vendor` table has no `createdAt`/`updatedAt` columns. Naming them in an
insert has broken a nightly run before.

Stores rate-limit per IP and HTTP 429 counts as "blocked". Any pass that fetches
many URLs must go through `HostThrottle`, and `HostThrottle.interleave()` should
spread a queue across hosts first — a host-clustered queue costs roughly 14x more
wall clock in throttle waits than an interleaved one.
