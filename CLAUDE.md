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

Ten suites, all of which should pass before pushing:

```
python3 -m unittest discover -s scraper/tests     # mirrors CI exactly
npm run test:set-name
npm run test:csv-import
npm run test:collection-import
npm run test:keycap-collection
npm run test:collection-sales
npm run test:http-json
npm run test:home-cache
npm run test:vendor-urls
npm run test:manufacturer-vendors
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

**That registry is written twice too**, and for a year only the Python half
knew about dcs.wiki: `src/lib/import/manufacturer-vendors.ts` is the TS copy,
and `test:manufacturer-vendors` fails if the two lists disagree or if a call
site hand-writes `slug: { not: "gmk" }` again. A bare "gmk" filter reads as
correct and silently lets the other source through — into the price queue, into
the discovery rotation, and onto the set page as a place to buy.

The `Vendor` table has no `createdAt`/`updatedAt` columns. Naming them in an
insert has broken a nightly run before.

**Discovery is written twice** — `run_discovery` in `scrape.py` (the nightly
that actually crawls) and `discoverGmkProducts` in `src/lib/import/discovery.ts`
(the Vercel cron). A fix to one is only half a fix; #131 excluded blank-URL
vendors in the TS copy alone and the nightly kept spending a fifth of every
rotation on stores it could not fetch.

**The profiles discovery reads a catalog for must equal the profiles the site
publishes.** That gate is the first thing every store product passes through,
and it spent a year as a local `\b(?:GMK|DCS)\b` in both halves while
`MAKER_NAME_PREFIXES` in `src/lib/set-name.ts` had grown to GMK/CYL/MTNU and
DCS/SA/DSS/DSA — the Geekhack importer files those threads as keycap sets and
/browse offers them under the two maker pills. So the sets existed, the site
listed them, and every SA / DSS / DSA / MTNU / CYL product in every store
catalog was dropped before `matchProduct` saw a title. A Signature Plastics
specialist (Saber Keebs: 9 of its 10 keycap products are DCS/DSS/SA) therefore
came back "0 tracked listing(s)" on every rotation, forever, with a healthy
`websiteUrl` and no run summary ever looking wrong — the fifth "publishes
nothing" shape below, with a code bug behind it rather than bad data.
`TRACKED_PROFILES` is now derived from the maker registry itself and mirrored
in `scrape.py`; `test:set-name` fails if the two lists disagree, if a maker
prefix names a profile the gate refuses, or if `discovery.ts` declares its own
regex again. Whole-word matching is what makes the two-letter tokens safe —
`\bSA\b` cannot reach inside "Salamander" or "Sanctuary", which is the hazard
`MAKER_NAME_PREFIXES` has to spell around as `"SA "`.

A vendor is identified by its **site**, not its slug: the roster spells five
stores differently from the database (`cannonkeys`/`cannon-keys`,
`thekeyco`/`the-key-company`, …), so anything that inserts a Vendor must match
on the host or it creates a second row for one shop — which is then crawled
twice and published twice. A store with no usable `websiteUrl` publishes
nothing at all; `db-setup` recovers what it can from the vendor's own listing
URLs and names the rest in the build log.

**`Vendor.websiteUrl` is per-store; every upstream catalog describes it
per-SET.** KeycapLendar carries one `storeLink` on each of a shop's ~300 keyset
entries and they disagree — 1228 of its 9031 vendor entries have none at all,
and 142 stores have both linked and blank entries. Last-write-wins therefore
erased a working storefront whenever a blank entry happened to import last: 12
stores per run, CannonKeys and KBDfans among them, and it is a different 12 each
time. Blanking a vendor un-crawls it (#131's discovery filter), so it gets no
new VendorKit, the price pass skips its URL-less rows, and it publishes nothing
until the next deploy heals it — which the next night's import undoes. Any
import may only ever *replace a storefront with another storefront*:
`nextVendorWebsiteUrl` in `scripts/lib/vendor-urls.mjs` is that rule, and it is
imported by the TS import path rather than copied, so the marketplace/forum host
list stays in one place.

**A store whose upstream links are marketplace-only can only be repaired by
hand.** `nextVendorWebsiteUrl` won't adopt a marketplace link and
`planVendorUrlHeal` won't derive a storefront from marketplace-only listings —
both correct, and both leave the same residue: a permanently blank
`websiteUrl`. Blank un-crawls the store (both discovery halves), hides it from
`find_vendor_for_url` so `run_outlets` skips its collection nightly, and leaves
its listings pointing somewhere no price can be scraped — and unpriced listings
are hidden on released sets, so the store publishes *nothing at all*.
`src/data/seed/vendors.json` is the only rung that breaks that cycle; GEONWORKS
and Swagkeys (both filed under smartstore.naver.com upstream) sat outside it for
a year while db-setup named them "stranded" every deploy.

**"No storefront" has two shapes, and every repair must take both.** Blank is
the obvious one; a `websiteUrl` pointed at something that isn't a shop —
`goo.gl`, an Instagram profile, a Google Form, `item.taobao.com` — is the other,
and it is strictly worse, because a blank row was at least revisited by the
roster heal and the listings heal while a downgraded one matched neither
(`websiteUrl = ''`) and so was frozen forever, publishing nothing, named only in
a build-log line. `nextVendorWebsiteUrl` stops new downgrades but cannot undo
one already written, and four shipped in `supabase-setup.sql`. `needsStorefront`
in `scripts/lib/vendor-urls.mjs` is the single predicate both halves of the heal
and both halves of the discovery rotation key on — never re-derive it as
`websiteUrl = ''`. It is a HOST test, not a substring test: `ILIKE '%x.com%'`
also matches `mybox.com`, which is why the rotation over-fetches and filters in
code rather than in SQL. `NON_STOREFRONT_HOSTS` is written twice
(`_NON_STOREFRONT_HOSTS` in `scrape.py` is the Python copy) and
`test:vendor-urls` fails if the two lists disagree.

**Three shapes, in fact: the third is a row parked on ANOTHER store's
storefront.** `needsStorefront` asks whether a URL is *a* shop, never whether it
is *this* shop, so `Swagkeys (KR)` registered as `https://mokbstore.com` — the
host Mokb Store's own row carries — read as healthy to every repair. It is
uncrawlable *as itself*: discovery fetches that host under both vendor ids, so
one shop's catalogue is published twice on a set page and once under a shop that
doesn't sell it; `find_vendor_for_url` returns whichever of the two rows
Postgres happens to hand back first; and the store's real site is never crawled,
so it publishes nothing of its own. The evidence to fix it is already in the
database — 11 of Swagkeys (KR)'s 13 listings are on `www.swagkey.kr` — so
`planStorefrontOwnership` settles a contested host by asking whose listings sell
from it (the roster outranks that when it names one) and moves the loser onto
the storefront its own listings name. It only ever touches a row that SHARES its
host: two rows whose listings both sell from it are one shop with two rows
(Protozoa Studio / Protozoa Studio (US)), which is a merge no pass should do by
itself, so it is reported instead. `nextVendorWebsiteUrl` refuses a storeLink on
another vendor's host for the same reason it refuses a marketplace link —
without that the nightly import re-parks the row the deploy just repaired, since
one of Swagkeys (KR)'s own upstream entries names mokbstore.com.

**A fourth shape has no collision to give it away: a row parked ALONE on a
storefront that isn't this store's site.** `needsStorefront` says "yes, a
shop"; `planStorefrontOwnership` needs two rows fighting over one host and
there is only one; `planVendorUrlHeal` only ever looks at rows
`needsStorefront` flagged. So the row reads as healthy to every repair while
discovery asks the wrong website for `/products.json` on every rotation, and
the store is never crawled *as itself*: no new listing is linked, no moved
listing is relinked, and its dead URLs never heal — which on a RELEASED set
means hidden. `find_vendor_for_url` resolves outlet collections by host too, so
none of them can reach the row either. Six of the 125 shipped vendors are in
that state — a retired domain (`novelkeys` on novelkeys.xyz), a sibling brand
(`omnitype` on dixiemech.com), a renamed shop (`mekanisk` on
mekanisktastatur.no), a corporate apex instead of the shop subdomain
(`yushakobo` on yushakobo.jp, `mechboards` on mechboards.co.uk) — and only
Swagkeys (KR) was reachable, because it happened to share mokbstore.com with
Mokb Store's row. Worst is a live shop on the wrong side of it: discovery reads
DixieMech's catalogue and files it as Omnitype's listings, which is
`planStorefrontOwnership`'s exact harm with nothing to detect it.

**The roster is right about a WRONG storefront, not just a missing one.**
`planRosterSync` healed only rows `needsStorefront` flagged, so `novelkeys`
sat on its retired domain for a year while `src/data/seed/vendors.json` — the
hand-written rung that exists to be right about exactly this — said
`https://novelkeys.com` on every deploy and was ignored. All four of NovelKeys'
`OUTLET_COLLECTIONS` entries logged "no tracked vendor for novelkeys.com" and
did nothing, nightly; `test:vendor-urls` did not catch it because it checks
those hosts against the ROSTER, which was right — the Vendor row disagreed. It
now heals whenever
the row's HOST differs from the roster's (a www-only spelling difference is not
churn worth writing), and reports rather than takes a host another row holds.
For the rows the roster doesn't name, `planStorefrontRelocation` settles it
with the evidence already in the database — the row's own listing URLs, same
strict-plurality `storefrontHostFromUrls` every other planner here uses. It
skips roster-pinned slugs and contested hosts so the three passes never fight
over one row. And `nextVendorWebsiteUrl` now takes the vendor's own listing
host: 96 of NovelKeys' 258 links are novelkeys.xyz, so without that guard the
deploy repairs the row and the same night's import puts it straight back.

**A fifth shape gets past every one of those repairs**: a `websiteUrl` that IS
a real shop belonging to this vendor and still publishes nothing. The row looks
healthy — `needsStorefront` returns false, `planStorefrontOwnership` sees no
collision — but the site surfaces zero of its listings on any set page, because
its catalog pass never matched a tracked set (the store stopped selling GMK /
DCS), its /products.json turned to a redirect the crawler can't follow, or its
every scraped price landed at null and the sets it lists are all RELEASED
(which hides unpriced rows). No automatic pass can undo those, but
`planPublishingReport` names them in the deploy log alongside the four heal
residues so the owner can act on them — remove the row, chase down why
discovery isn't matching, or force a re-scrape. A "visible listing" is what
`PURCHASABLE_VENDOR_KIT_WHERE` + `showUnpriced` (in `VendorTable`) would render,
counted in SQL; the planner has the shape rules so a blank / shortener /
marketplace row belongs to `planVendorUrlHeal`, not to this report.

**Naming the vendor is not the diagnosis** — the three causes above go to three
different passes, and one message listing all three sent the owner to the wrong
one as often as the right one. They leave different residue, so the report also
counts each vendor's VendorKit rows (`listings`) and priced rows
(`pricedListings`) and says which applies: no rows at all is discovery's, rows
but no price is `refresh-prices`, priced but invisible is a non-BASE kit or a
catalog URL. Those counts are deliberately unfiltered by kit type or URL so the
three stay disjoint — and every one of them defaults to 0, so a caller that
forgets to pass them gets "discovery has never matched a tracked set" about
every silent vendor, confidently and wrongly. `test:vendor-urls` asserts
`db-setup` selects and passes all three.

Roster entries carry `aliases` because the rows the roster exists to repair are
the ones host matching cannot see: a blank vendor has no host, so a blank
`cannon-keys` row reads as a store nobody owns and the roster's `cannonkeys`
entry used to insert a *second* row beside it. Add the DB's spelling to
`aliases` rather than adding a second entry.

**`OUTLET_COLLECTIONS` and the vendor registry are two halves of one thing.**
`run_outlets` resolves each collection's vendor by HOST, so a host no Vendor row
carries logs "no tracked vendor" and does nothing, forever — `test:vendor-urls`
fails if any outlet host is registered by neither the roster nor
`SEEDED_VENDORS`.

Stores rate-limit per IP and HTTP 429 counts as "blocked". Any pass that fetches
many URLs must go through `HostThrottle`, and `HostThrottle.interleave()` should
spread a queue across hosts first — a host-clustered queue costs roughly 14x more
wall clock in throttle waits than an interleaved one.
