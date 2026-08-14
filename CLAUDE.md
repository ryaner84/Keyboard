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

**Merge as soon as CI is green — don't ask first.** Squash-merge, matching the
existing history: 101 of main's 102 commits are one-per-PR `Title (#NN)`, so a
merge commit would introduce a second style and put work-in-progress commits on
main permanently.

Squashing has one consequence worth remembering: it creates a NEW commit, so a
branch's own commits are never ancestors of main. `git merge-base --is-ancestor`
will therefore report every merged branch as "unmerged" — check the PR's state
instead. It is also why a branch needs `--force-with-lease` after its PR merges.

## Tests

Eight suites, all of which should pass before pushing:

```
python3 -m unittest discover -s scraper/tests     # mirrors CI exactly
npm run test:set-name
npm run test:csv-import
npm run test:collection-import
npm run test:keycap-collection
npm run test:collection-sales
npm run test:home-cache
npm run test:vendor-urls
npx tsc --noEmit
```

Two CI workflows gate these. `scraper-tests.yml` runs the Python suite, but only
when `scraper/**` changes. `web-tests.yml` runs every `npm run test:*` suite plus
`npx tsc --noEmit` and `npx next lint` on every PR and push to main, each suite
with `if: always()` so one break doesn't hide the others.

**Adding a suite means three edits, not one:** the script in `package.json`, a
step in `web-tests.yml`, and the list above. A suite that exists but isn't wired
into the workflow is worse than no suite — it looks covered and isn't.

Run them locally before pushing anyway; the gate is a backstop, not a substitute.

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

**Discovery is written twice** — `run_discovery` in `scrape.py` (the nightly
that actually crawls) and `discoverGmkProducts` in `src/lib/import/discovery.ts`
(the Vercel cron). A fix to one is only half a fix; #131 excluded blank-URL
vendors in the TS copy alone and the nightly kept spending a fifth of every
rotation on stores it could not fetch.

A vendor is identified by its **site**, not its slug: the roster spells five
stores differently from the database (`cannonkeys`/`cannon-keys`,
`thekeyco`/`the-key-company`, …), so anything that inserts a Vendor must match
on the host or it creates a second row for one shop — which is then crawled
twice and published twice. A store with no usable `websiteUrl` publishes
nothing at all; `db-setup` recovers what it can from the vendor's own listing
URLs and names the rest in the build log.

Stores rate-limit per IP and HTTP 429 counts as "blocked". Any pass that fetches
many URLs must go through `HostThrottle`, and `HostThrottle.interleave()` should
spread a queue across hosts first — a host-clustered queue costs roughly 14x more
wall clock in throttle waits than an interleaved one.
