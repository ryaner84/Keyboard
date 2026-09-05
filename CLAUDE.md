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

Fifteen suites, all of which should pass before pushing:

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
npm run test:set-merge
npm run test:link-health
npm run test:catalog-stock
npm run test:kit-bounds
npm run test:host-throttle
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
`setMergeIdentity` (the `db-setup` duplicate merge) all encode this — keep them
in agreement.

Maker is not profile. GMK Electronic Design makes Cherry-profile sets plus the
CYL and MTNU profiles; Signature Plastics makes DCS, SA, DSS and DSA. `MTNU
Electronic Control` carries no "GMK" token, so maker cannot be inferred from a
substring search.

**One set, written twice.** Every upstream source spells a set its own way and
slugs it its own way: gmk.net files "GMK CYL Mizu R2 Keycaps" under
`gmk-cyl-mizu-r2-keycaps`, KeycapLendar files the same product as "GMK Mizu R2"
under `gmk-mizu-r2`, and Geekhack files it as a `gh-<topicid>` thread. The
upserts matched on SLUG alone, so each source wrote its OWN row — the "orphan
duplicate" `_build_set_index` has always routed listings around. Routing around
it is not removing it: the orphan keeps a set page, appears in search and on
/released, and holds whatever vendor links, collection entries and dev updates
landed there, off the row the price comparison lives on. Two half-populated
rows compare worse than one whole one. `build_keycap_norm_index` +
`_existing_set_by_name` are the fix at the source (an unknown slug falls back to
an unambiguous `normalize_set_name` match, which already drops "CYL" and
"Keycaps"); `mergeDuplicateKeycapSets` in `db-setup` folds the rows already
written, moving children before it deletes anything.

That merge DELETES a row, which is a higher bar than `dedupeKey`'s display
collapse, so `scripts/lib/set-merge.mjs` is deliberately stricter in three
places and must stay that way: a parenthetical is unwrapped rather than dropped
(`GMK Nautilus (2021)` is not `GMK Nautilus`), `+` becomes a token before
punctuation is stripped (`GMK Olivia++` is not `GMK Olivia`), and a known
profile token is REQUIRED on both sides — a bare `[GB] Dolch` names no maker and
merges with nothing. It replaced a SQL-side pass that stripped a LEADING profile
word but no trailing one (so `mizur2` never matched `mizur2keycaps`) and deleted
Geekhack stubs outright, taking any collection entry with them: `TrackerItem`
cascades on `GroupBuy`, so a merge has to repoint children first.

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

**And the manufacturer's own shop is on the wrong side of that registry.** GMK
sells its old sets directly, from `gmk.net/shop/en/gmk-warehouse-finds/…`, under
its own Vendor row (`gmk-direct`) — a real storefront, kept deliberately visible
by `MANUFACTURER_STOREFRONT_SLUGS` in `PURCHASABLE_VENDOR_KIT_WHERE`. Visible is
not published: the exception was carried by the site filter alone, while both
price queues and `fetchVendorPrice` refused the row by URL HOST, which cannot
tell whose row it is. So no pass was ever allowed to price the manufacturer's
shop, and an unpriced row is hidden outright on a RELEASED set — which every set
in a warehouse sale is. All 9 listings, invisible, by our rule rather than
anything gmk.net did, and named in the publishing report under "none priced" as
though another scrape would fix it. The code's own justification ("it publishes
as an unpriced store link") is true only of a set still on group buy, and its
other half ("gmk.net blocks serverless IPs") was answered by the probe: gmk.net
serves a runner 200 with OpenGraph product markup, and both the six-hourly price
pass and the nightly run on runners. `isUnpriceableManufacturerListing` is the
one question every price path now asks — the host refusal, excused for the
storefront slugs — and `test:manufacturer-vendors` fails if either half drops
the exception or if `refreshOne` stops selecting the vendor slug the guard
decides on. Note the queue filter's shape: `NOT_MANUFACTURER_LISTING` is SPREAD
into a `where` that sets its own `OR` and `AND`, so a clause added under either
name is silently overwritten — it still typecheck, still reads correctly, and
excludes nothing.

**A Vendor row is not always a shop, and the third kind is a PORTFOLIO.** The
registry was built for manufacturer catalogs (gmk.net, dcs.wiki);
`sxm-designs` is a designer's showcase, which is the same shape for a different
reason. sxmdesigns.com has no commerce layer at all — no WooCommerce namespace
in `/wp-json/`, no `product` post type, no `/shop` or `/cart` route, no `<form>`,
and its JSON-LD graph is `Organization / WebSite / BreadcrumbList / WebPage /
Person / Article` with no `Product` and no `Offer`. Probed from a runner under
four User-Agents including Googlebot, so it is not UA-conditional markup. The
one "woocommerce" string that makes it read as a shop from a distance sits
inside EWWW image-optimizer's minified `ewwwWooParseVariations` helper, which
ships whether or not Woo is installed.

Registered as a store, its rows answered `NO_PRODUCT_DATA` for ever. The worse
half was still ahead: the row's `websiteUrl` is blank, which is the ONLY reason
both discovery halves skip it, and `planStorefrontRelocation` exists precisely
to fill that in from a row's own listing hosts — all of which are sxmdesigns.com.
The next deploy that healed it would have pointed discovery at a portfolio,
where the HTML fallback reads every "GMK …" nav anchor as a product and writes
it back as a VendorKit with a null `priceUpdatedAt` — straight to the front of a
time-boxed queue. That is the dcs.wiki failure the registry already documents,
repeated.

**Registering one means FOUR edits, not two.** `MANUFACTURER_VENDOR_SLUGS` +
`MANUFACTURER_URL_HOSTS` in `src/lib/import/manufacturer-vendors.ts`, their
mirrors in `scrape.py`, and `NON_PUBLISHING_SLUGS` in BOTH
`scripts/vendor-publishing-audit.mjs` and `_NON_PUBLISHING_SLUGS` in
`db-setup.mjs` — miss the last two and the publishing audit reports the source
as a silent store on every run, for ever, which is the false alarm the report
exists to avoid. `test:manufacturer-vendors` now derives its expectations from
the registry rather than re-listing it: a hardcoded copy was a fifth place the
list was written, and it went stale the moment a third source was added.

The `Vendor` table has no `createdAt`/`updatedAt` columns. Naming them in an
insert has broken a nightly run before.

**Discovery is written twice** — `run_discovery` in `scrape.py` (the nightly
that actually crawls) and `discoverGmkProducts` in `src/lib/import/discovery.ts`
(the Vercel cron). A fix to one is only half a fix; #131 excluded blank-URL
vendors in the TS copy alone and the nightly kept spending a fifth of every
rotation on stores it could not fetch.

**And the half that was missing a whole code path was the half that runs.**
`/products.json` is a SHOPIFY endpoint; about a fifth of the roster is not
Shopify — Ashkeebs, Zion Studios, Sandkeys and Keyclack are WooCommerce
(`/product/…`), CandyKeys serves `/group-buys/…`, MyKeyboard.eu
`/catalogue/category/…`, Latamkeys `/productos/`, STACKS `/store/`, Drop
`/buy/…`, KLC Playground (KR) and Monstargears are cafe24 shops. `discovery.ts`
has always fallen back to crawling the storefront's own group-buy / pre-order /
in-stock pages; `run_discovery` read the 404 on page one, logged "catalog
unreadable", and moved on — and it is the half with a real browser, so the
Vercel copy's fallback never reached these stores either. So discovery had
never linked OR relinked a single listing for any of them: their rows were
frozen at whatever the first KeycapLendar import wrote, a moved or renamed GB
page could never heal, the price pass kept failing on the dead URL so `price`
stayed NULL, and an unpriced row is hidden outright on a RELEASED set. The store
published nothing at all, and named itself in `planPublishingReport` under the
FIRST cause — "discovery has never matched a tracked set" — which reads as "the
store stopped selling GMK", exactly as the tracked-profile gate did before #140.
`html_catalog` in `scrape.py` is that fallback and `test:set-name` fails if it
disappears or if the two halves pick section pages by different rules.

A crawled anchor is weaker evidence than a catalog entry — it carries no stock
flag and no price — so it may only take over a VendorKit that is **not
currently priced** (`html_guard` in `scrape.py`, `fromHtml` in `discovery.ts`).
That is the state the fallback exists to end; a link the price pass is reading
successfully is not a homepage anchor's to replace. A link that later dies is
cleared to NULL by the price pass (404/410), which hands the row back on the
next rotation.

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
over one row. And `nextVendorWebsiteUrl` now takes the vendor's own host: 96 of
NovelKeys' 258 links are novelkeys.xyz, so without that guard the deploy repairs
the row and the same night's import puts it straight back.

**Which host is "its own" is `ownStorefrontHost`, and the roster outranks the
listings there.** The listing plurality alone reads BACKWARDS for a store whose
links are all on the domain it left: Maamaadei's one listing is on
`www.maamaadei.xyz`, which no longer resolves, so the plurality pinned the row to
the dead domain — adopting any upstream `.xyz` storeLink and refusing the
`maamaadei.com` the roster names. Every deploy healed the row and the next import
was free to undo it, which is the state #145 fixed by hand. The roster is the
rung that is right by construction, so a slug it names is pinned to ITS host in
both directions: nothing can move the row off, and `planRosterSync` stays free to
move it on. The plurality still decides for every row the roster doesn't name.
A roster entry with no `websiteUrl` pins nothing, so `test:vendor-urls` requires
one on every entry.

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

**Naming the vendor is not the diagnosis** — the causes above go to different
passes, and one message listing them all sent the owner to the wrong one as
often as the right one. They leave different residue, so the report also counts
each vendor's VendorKit rows (`listings`), the ones the price pass has ever READ
(`readListings`) and the priced ones (`pricedListings`) and says which applies:
no rows at all is discovery's, rows that were never once read is a dead link set,
rows read but unpriced is `refresh-prices`, priced but invisible is a non-BASE
kit or a catalog URL. Those counts are deliberately unfiltered by kit type or URL
so the four stay disjoint. `listings`/`pricedListings`/`visibleListings` default
to 0, so a caller that forgets one gets "discovery has never matched a tracked
set" about every silent vendor, confidently and wrongly; `readListings` defaults
to `listings` instead, because there the zero-default would invent the newest
diagnosis rather than fall back to the previous one. `test:vendor-urls` asserts
`db-setup` selects and passes all four.

**"Never read" is the commonest cause, and it read as the pricing backlog for
months.** `priceSource` is written (`'SCRAPED'`) whenever the price pass READ the
page — including when the answer was "no base kit on offer", price NULL. A row
whose `priceUpdatedAt` is set while `priceSource` is still NULL was fetched and
never once parsed. Only a 404/410 clears a price, and a store that closed
(kono.store), moved domain (apexkeyboards.ca → .com), was acquired
(ashkeebs.com now serves kineticlabs.com), password-locked its Shopify
(hexkeyboards.com) or let its plan lapse (402) answers with a redirect / 401 /
402 / 5xx / DNS failure — never a 404. So the row is re-fetched every six hours
forever, stays unpriced, stays hidden on its RELEASED sets, and the report kept
naming `refresh-prices`, the one pass that cannot end it. Count `priceSource`,
never `priceUpdatedAt`: the timestamp is written on every attempt, so counting it
would make every dead link look read.

**And the commonest of those answers is not a status at all — it is a silent
redirect.** A store that has removed a product usually sends it to the store's
own FRONT DOOR rather than 404ing it, and an acquired shop redirects its whole
domain to the buyer's home page. `fetch()` and `page.goto()` follow the hop
without a word, so all either price pass ever saw was a 200 on a page that is
not the listing: the row read as "blocked, try again later", for ever. Probing
production found kono (44 listings) 302ing every product to `kono.store/` and
ashkeebs (38) 301ing to `kineticlabs.com/`. `isGoneRedirect` (mirrored as
`is_gone_redirect`) reads it off the FINAL url and answers `DEAD_LINK`, which is
also what stops a front page carrying Product markup of its own from being
scraped and published as that set's price at that vendor. It is deliberately
narrow — only the site ROOT counts, so a renamed handle, a collection page and a
`/password` lock are all still merely unreadable — and the verdict is taken on
the HUMAN product page, never on `/products/*.json`, which a live store that
simply doesn't serve it answers from its front door too. `npm run
audit:publishing` re-diagnoses those vendors as gone; `scripts/vendor-link-probe.mjs`
(the **Vendor probe** workflow) is how a silent store's answer is read in the
first place, from a runner IP rather than guessed at.

**And a store can say "gone" with no redirect at all — it just serves its front
page.** A retired shop is often not taken down but rewritten: every path under
it answers 200, with the URL unchanged, carrying the landing page the root
serves. Nothing in that response says so. `isDeadLinkStatus` sees a 200,
`isGoneRedirect` reads a final URL that is still the product URL (the rewrite is
server-side, so there is no Location header at all), `isGoneHostError` sees a
host that resolves — and the page has no product markup, so all three passed it
through as `NO_PRODUCT_DATA` and the report asked the owner to "teach the parser
or retire it" about shops that no longer exist. Probed from a runner on
2026-09-05: **drop.com** (acquired by Corsair) serves every `/buy/<slug>` as the
same 27,140-byte "Drop - Gaming Collaborations by Corsair" page its root
returns — all 32 tracked listings; **captus.io** and **kingly-keys.xyz** answer
every path with the same 114-byte placeholder their front door serves. 34 rows
under the one diagnosis that could never end them. `isGoneFrontPage` (mirrored
as `is_gone_front_page`) is that answer, read off the BODY rather than the
Location header, and it is `isGoneRedirect`'s rule restated: the store's reply to
this URL was its front door. Narrow the same way — the request may not have
STARTED at the root, the answer must name the same host and the same path (an
http→https upgrade is the same page; a hop onto `/password` or onto a renamed
handle is somebody else's verdict, and a hop onto the root is already
`isGoneRedirect`'s), and both bodies must be non-empty and equal after nothing
but whitespace normalization. The caller adds the condition that carries the
safety: it is only ever asked about a page that yielded NO product markup, which
is also what makes the extra fetch affordable — the storefront's root is
fingerprinted once per SILENT origin per run (`frontPageCache` /
`_FRONT_PAGE_CACHE`), never once per row, and a readable store never pays for it
at all. The two halves must fetch that root the way they fetched the product
page: a browser-rendered DOM and raw markup are different documents for the same
page, so a mismatched pair could never be equal and the check would silently do
nothing. `test:link-health` fails if either half stops asking, and the four
controls above — funkeys (a real page we cannot parse), mokbstore (a renamed
handle), hexkeyboards (`/password`), saberkeebs and gmk.net (readable) — are
pinned in both test suites, because a false positive here hides a live listing.

**Byte equality is what makes that rule safe, and the store it protects is a
LIVE one.** A client-rendered shop serves ONE shell for every route, its root
included, so "this body equals the root's" is true of a live single-page app for
exactly the same reason it is true of a retired catch-all — and no HTTP-level
test separates them. What separates them in practice is that a real app's shell
is not static: **zfrontier.com** looked like the fourth case on one probe (all
190 `/app/` rows, 20,939 bytes, identical to its root) and failed the comparison
on the next, because the shell carries a per-request token — and it is a live
shop, which `run_zfrontier` reads through its app API rather than through the
price pass at all. So the tolerance is whitespace and NOTHING else. Loosening it
to ignore inline script contents would "catch" zfrontier by hiding the listings
of every app-rendered store on the roster, which is the one failure this whole
chain exists to prevent; a retirement page that varies per request stays
`NO_PRODUCT_DATA`, which is merely the previous, safe answer.

**And a third answer gives no status, no redirect and no page at all: the
DOMAIN is gone.** Every guard in the vendor chain judges a storefront by the
SHAPE of its URL — `needsStorefront`, `planStorefrontOwnership`,
`planVendorUrlHeal`, `planRosterSync`, and `test:vendor-urls` behind them — and
a host that no longer exists is shaped exactly like a healthy one. So a shop
whose domain lapsed reads as healthy to every repair, is asked for
`/products.json` on every discovery rotation, and answers with a DNS failure
that `fetch()` reports as a bare `TypeError: fetch failed` (the reason buried in
`cause`) and Playwright as `net::ERR_NAME_NOT_RESOLVED`. Both price passes filed
that under the same `null` a Cloudflare block gives: never dead, never retired,
re-fetched every six hours for ever, and named in the publishing report as "the
price pass has never read one — relink or retire it", which is a guess, not a
diagnosis — the identical sentence thicthock.com (Cloudflare 521) and
zionstudios.ph (526) get while both domains are very much alive. Resolving the
storefront host of every silent vendor found seven whose host answers NXDOMAIN:
`mykeyboard.eu` (206 listings), `store.projectkeyboard.com` (15),
`spaceholdings.net` (18), `keyclack.com` (4), `letsgetit.io` (4),
`mkultra.click` (3) and `donutcables.com` (3). `isGoneHostError` (mirrored as
`is_gone_host_error`) answers `DEAD_LINK` for those: NXDOMAIN is as definitive
as a 404, because there is no server left to ask, and just as self-healing —
`nextLinkHealth` clears `deadSince` on the first read that gets through.
`GONE_HOST_ERROR_MARKERS` is deliberately three spellings of that one answer,
and the exclusions carry the safety: `EAI_AGAIN` is a TEMPORARY resolver
failure, a refused or timed-out connection is a host that exists, and a bad
certificate is a live site — all blocks, and a block may never hide a listing.
Written twice, and `test:link-health` fails if the marker lists disagree or if
either half stops judging a failed navigation. Check the www twin before
retiring a row: a shop can lose one spelling of its domain and keep the other —
though not here, since `www.spaceholdings.net` 301s straight back to the apex
that no longer resolves. The probe reports that twin, and the cause code under
"fetch failed", so the next dead domain is visible from the tool rather than
from a hand-run `getent`.

**And a 404 counted as READ, so the commonest cause was hiding inside the
second-commonest.** Both price passes returned the `NO_BASE_KIT` sentinel for a
404/410, and its caller stamps `priceSource = 'SCRAPED'` — the same mark a live
page carrying only add-on kits gets. A store whose products had all been removed
therefore came back "read, just not priced", i.e. the pricing backlog, i.e.
`refresh-prices` again. Probing production found monokei (44 listings read, 0
priced), vala-supply (19/0), mechs-co (33/0) and apex-keyboards (19/0) all
reported that way with every sampled product page in fact gone. `DEAD_LINK` is
now a third answer alongside `NO_BASE_KIT` and null, and the dead branch
deliberately does NOT write `priceSource`.

**And `null` still meant four different things, two of which are OUR fault, not
the store's.** A page can be fetched, parsed and completely understood and still
leave the row unpriced because this site refused the number — `KIT_BOUNDS` capped
a USD base kit at 225 while norbauer.co sells its DSA kit at 230; the `Currency`
table cannot convert TRY and rationalkeys.com.tr prices in it — or because no
parser path recognised the page at all (Drop's `/buy/` SPA, funkeys' custom
storefront, the 114-byte placeholder captus.io and kingly-keys.xyz now serve).
Both answered the same `null` a Cloudflare block gives, with three
consequences: `priceSource` stayed NULL so the row never counted as READ and the
publishing report told the owner to "relink or retire" a shop that answers
perfectly; `linkFailures` climbed on a page that was read fine, so after six
runs — a day and a half at four runs a night — the row was demoted to the
14-day dead-link cadence; and nothing named the repair, which is a code or
config change here that no number of re-scrapes can substitute for.
`PRICE_REFUSED` and `NO_PRODUCT_DATA` are those two answers, stamped
`priceSource = 'REFUSED'` / `'UNPARSED'`, counted by the report, and printed in
both price passes' summaries. Neither clears a stored price: the refusal is
about the number just read, and a page with no markup says nothing about the
last good one. `PRICE_REFUSED` resets link health (the store answered) while
`NO_PRODUCT_DATA` does not — a bot check served as a 200 is indistinguishable
from a platform the parser cannot read, which is the whole reason `linkFailures`
is a heuristic. A refusal on the Shopify path still falls through to the
JSON-LD reader exactly as its `null` did, so which number gets stored is
unchanged.

**And the refusal window was written FOUR times, so it could only ever be
wrong.** `KIT_BOUNDS` is a backstop for parse errors — `pickBaseVariant` is what
actually keeps a deskmat off a set page — but a backstop set too low does not
fail loudly: it answers `PRICE_REFUSED` on a page it read and understood
perfectly, and an unpriced row is hidden outright on a RELEASED set, so the
store publishes nothing and looks from outside like a store nobody buys from.
The ceiling was calibrated when a GMK base kit topped out near USD 180; the
roster now carries the Signature Plastics profiles and the boutique makers who
use them price above GMK, so norbauer.co's USD 230 keyset — its only listing —
was refused on every run for ever by our rule rather than by anything the store
did. `scripts/lib/kit-bounds.mjs` is now the one place the window is decided
(USD 300, every other currency the same USD-equivalent so a set does not publish
on one storefront and vanish on another): `prices.ts` and `db-setup` IMPORT it,
the deploy purge SQL is GENERATED from it rather than hand-written, the restore
window IS it, and only `scrape.py` still mirrors it because Python cannot
import a JS module. `test:kit-bounds` fails if the mirror drifts or if either
half hand-writes a bound again. The purge is the half that must never drift
low — it nulls stored prices on every deploy, and a purge tighter than the
producers is what blanked released-set pricing once before.

**And the ceiling was then set to the dearest kit anyone had found, so it went
wrong again five dollars later.** keyspresso.ca sells "[Extras] GMK Harvest
(In-stock)", whose base variant — "Hiragana Base - Inari", a keycap base kit, in
stock, and USD per the store's own `/meta.json` — is 305 against a ceiling of
300. That row is the vendor's only listing and its set is released, so
keyspresso published nothing at all. The two ways the window can be wrong are
not symmetrical: too HIGH stores a visible wrong number, which the wrong-price
report feed and the nightly audit both exist to catch, while too LOW publishes
nothing, silently, for ever. So USD 400 is headroom over the dearest kit, not a
fit to it.

**Three things had to be wrong at once for that to be invisible, and the other
two are still the general lesson.** The window is only ever a window ON a
currency, and `prices.ts` applied it to the store's `/meta.json` currency alone
— null for any shop that blocks that endpoint, and `isPlausibleBaseKitPrice`
bounds a null as USD, so a CA$/A$/S$ price was refused for exceeding a ceiling
in money it was never quoted in. `effectiveCurrency` (the vendor row's own
currency as fallback) is what the supported-currency test one line above already
used and what `scrape.py` has always done — the drift was in the half that runs.
And a refusal only survived a `null` or `NO_PRODUCT_DATA` from the JSON-LD
reader, while a Shopify page reliably yields `NO_BASE_KIT` there: Shopify emits
one UNNAMED JSON-LD Offer per variant, so the reader sees several offers, can
name none of them the base, and answers "ambiguous aggregate". That overwrote
the refusal on every refused Shopify row — `priceSource` stamped `'SCRAPED'`
instead of `'REFUSED'`, the stored price CLEARED (a refusal never clears; the
number was read and it was this site that turned it away), and the publishing
audit reporting "none priced — unpriced rows are hidden", which sends the owner
to `refresh-prices`, the one pass that can never end a refusal. A refusal now
outlives every non-answer and yields only to a real price or a `DEAD_LINK`.
`test:kit-bounds` pins all three.

The probe reports `SHOP CCY` for the same reason: a price is only ever refused
or accepted RELATIVE to a currency, so "READABLE" beside an unpriced row is not
a diagnosis until you know which window the number was measured against.

`scripts/lib/link-health.mjs` holds the rules and **two columns that mean
different things on purpose**: `VendorKit.deadSince` is the first time the STORE
answered 404/410 — definitive, so it is the only signal allowed to take a
listing off the site (`PURCHASABLE_VENDOR_KIT_WHERE` refuses an unpriced dead
row; a link to a removed page is worse than no link) — while `linkFailures`
counts consecutive unreadable attempts of any kind and is a HEURISTIC, because a
store blocking the scraper is indistinguishable from one that closed. It may
slow a row down and name it in the report; it may never hide a live store. Both
reset on any successful read, `NO_BASE_KIT` included, so a store that comes back
heals itself.

The point of the columns is the back-off. Only a 404/410 clears a price, so
every other kind of dead link was re-fetched **every six hours forever**; the
price run is time-boxed, so several hundred permanently-dead rows were crowding
live listings out of it — and an unpriced live listing is hidden outright on a
RELEASED set. A backed-off row waits `DEAD_LINK_RECHECK_HOURS` (14 days)
instead. It is a back-off, never a retirement: the row keeps its place in the
queue, and `FORCE_PRICE_REFRESH` ignores it entirely.

**And a back-off outlived the code that caused it, so every fix above reached
the rows it was written for except on the rows that needed it.** The fortnight
is priced against KNOWLEDGE: a row the store 404'd, or one the pass has read,
will say the same thing in a fortnight, so waiting costs nothing. A row with
neither `deadSince` nor `priceSource` is the opposite case — six attempts have
produced no fact at all — and parking that for fourteen days freezes it against
every improvement in diagnosis, which is the only thing that could ever change
its answer. `isGoneHostError` (#156) shipped on 2026-08-30 to answer
`DEAD_LINK` for a host that no longer resolves; by then all seven of the
vendors it was written for had hit `DEAD_LINK_FAILURE_THRESHOLD` and been
parked until 2026-09-13, so it never ran against one of the ~253 listings it
was for. Four days of `audit:publishing` printed the same pre-fix sentence —
"the price pass has never read one — the store's links are dead; relink or
retire it" — about mykeyboard.eu (206 rows) and six other dead domains, about
`olkb`, whose one link is a plain 404, and about eight stores that answer a
runner perfectly well (rationalkeys.com.tr serves JSON-LD Product; thicthock
521, zionstudios.ph 526 and alphakeys.ca 402 were blocking, not gone; auramech
and hineybush serve an incomplete TLS chain; mkultra.click was an `EAI_AGAIN`).
Nothing was wrong with any of those diagnoses except their date, and only
`FORCE_PRICE_REFRESH` — a person, by hand, who happens to know — could correct
them. `UNDIAGNOSED_RECHECK_HOURS` (24) is the third cadence: a backed-off row
carrying no verdict waits a day, not a fortnight, so any answer this codebase
learns reaches every row within one nightly run, and the row leaves that
cadence for one of the other two the moment a verdict lands. Written twice, as
ever — `prices.ts` builds the arm from the constant, `scrape.py` mirrors it as
a third `WHEN`, and it must come FIRST in that `CASE`, because SQL takes the
first matching arm and an undiagnosed row also satisfies the `linkFailures`
test below it. `test:link-health` fails if the constants drift, if either
half's arm stops requiring BOTH verdict columns to be null, or if
`FORCE_PRICE_REFRESH` stops overriding it.

A corollary for the report: every line `planPublishingReport` prints is read
off columns a price ATTEMPT writes, so it describes the code as it was at
`lastAttempt`, not as it is now. `audit:publishing` prints `attempted`,
`failures` and `lastAttempt` beside each silent vendor for exactly that reason
— a stale date on a fully backed-off store means re-read the rows before acting
on the sentence next to it. `queued` is the companion count: the price queue
filters on a non-blank `productUrl` and a BASE kit, so a row failing either is
never fetched, never priced and never dead-marked, and leaves the identical
residue as a store that never answered.

**The price pass is written twice too** — `run_prices` in `scrape.py` (the
nightly with a real browser) and `refreshPrices` in `src/lib/import/prices.ts`
(the Vercel cron and `refresh-prices-ci`). `prices.ts` IMPORTS `link-health.mjs`
rather than copying it; `scrape.py` cannot, so it mirrors it and
`test:link-health` fails if the constants, the sentinel, the two 404 return
sites per half, or the queue's back-off disagree. Both halves have a Shopify
path and a generic WooCommerce/JSON-LD path, and a fifth of the roster is not
Shopify — the non-Shopify half is the one that keeps getting missed.

**The report only ever existed inside a Vercel build log, which nobody can
read.** That is how 57 of 136 vendor rows came to be publishing nothing at once
with no run summary ever looking wrong. `npm run audit:publishing`
(`scripts/vendor-publishing-audit.mjs`, dispatchable as the **Vendor publishing
audit** workflow) prints all four shapes against the production database on
demand and writes nothing. Reach for it before guessing at why a store is
silent — a silent store and a store nobody buys from look identical from
outside.

Roster entries carry `aliases` because the rows the roster exists to repair are
the ones host matching cannot see: a blank vendor has no host, so a blank
`cannon-keys` row reads as a store nobody owns and the roster's `cannonkeys`
entry used to insert a *second* row beside it. Add the DB's spelling to
`aliases` rather than adding a second entry.

**Aliases stop the next duplicate; they never removed the last one.** Five shops
still carried two Vendor rows each (`cannonkeys`/`cannon-keys`,
`thekeyco`/`the-key-company`, `mykeyboard-eu`/`mykeyboard`,
`mech-land`/`mechland`, `toro-studio`/`toro-studios`) long after the aliases
were added, and every deploy printed "merge or remove them" at a pass that could
do neither. The empty half is a vendor the site publishes NOTHING for by
construction — `thekeyco` held 0 listings while `the-key-company` held 12,
`mykeyboard-eu` 0 while `mykeyboard` held 206 — and it is not inert: discovery
rotates 8 stores a night across ~130 rows, so each ghost spends a slot
re-crawling a catalogue already read under the other id (a real store waits
another fortnight), whichever id the crawl runs under is where that night's
listings land, and `find_vendor_for_url` resolves by host and returns whichever
row Postgres hands back first. `planVendorMerges` + `mergeDuplicateVendorRows`
fold them into one row, and — like `mergeDuplicateKeycapSets` — the merge moves
children before it deletes anything: shared kits are settled FIRST (VendorKit is
unique on `(kitId, vendorId)`, so the move fails on the first shared set
otherwise), preferring a priced row over an unpriced one and only then the
survivor, because the survivor is usually the EMPTY roster row and defaulting to
it would throw away the shop's only price.

Because that merge DELETES a Vendor row, the bar is higher than
`planStorefrontOwnership`'s report and two guards keep it there: only the
ROSTER may declare two slugs to be one shop — rows that merely share a host
(`protozoa-studio`/`protozoa-studio-us` are two regional group buys on one site,
`pancco`/`panc-interactive` are in no roster entry) stay contested and reported
— and every row that HAS a storefront must agree on the host, so a stale alias
pointing at two real, different shops is reported, never merged.

**`OUTLET_COLLECTIONS` and the vendor registry are two halves of one thing.**
`run_outlets` resolves each collection's vendor by HOST, so a host no Vendor row
carries logs "no tracked vendor" and does nothing, forever — `test:vendor-urls`
fails if any outlet host is registered by neither the roster nor
`SEEDED_VENDORS`.

**A listing goes stale IN STOCK, and only one pass ever noticed.**
`VendorKit.inStock` is `DEFAULT true`, both discovery halves create rows as
true, and for a long time the only writer of `false` was the price pass — which
is time-boxed and runs oldest-first over the whole roster, so a set a store
ended could keep its Buy button indefinitely. Worse, `linkVendorKit` in
`vendor-overrides.ts` re-asserted `inStock: true` on EXISTING rows every run,
from the daily cron, at step 3 — before the price pass at step 5. A curated link
knows WHERE a set is sold and has never fetched the page; it must never write
that flag. Ktechs' GMK CYL Thunder God sat green that way while the shop
reported `available: false` on every endpoint it serves.

Discovery now reads stock from the catalog feed it already fetches, and the rule
is ONE-DIRECTIONAL like `html_guard` next door: a feed may mark a row **sold
out**, never in stock. "Something on this product is purchasable" is not "the
BASE variant this row is priced from is purchasable", and the price pass reads
the actual variant, so it stays the only authority for `true`.

`catalogAvailability` has **three** answers and the third is the point: `false`,
`true`, and `null` for "this feed does not report availability". Collapsing null
into false marks a whole catalogue sold out — and an unpriced or sold-out row is
hidden or dead on a released set. Ktechs is its own example: `/products.json`
carries `available`, `/products/<handle>.json` has no such key at all. A strict
boolean test is what separates them (in Python that means excluding `int`, since
`isinstance(True, int)` is true). Written twice — `scripts/lib/catalog-stock.mjs`
and `catalog_availability` in `scrape.py` — and `test:catalog-stock` fails if
they disagree.

Stores rate-limit per IP and HTTP 429 counts as "blocked". Any pass that fetches
many URLs must go through `HostThrottle`, and `HostThrottle.interleave()` should
spread a queue across hosts first — a host-clustered queue costs roughly 14x more
wall clock in throttle waits than an interleaved one.

**And that rule was written for a pass in one language while the other half had
neither piece.** `run_prices` has spaced its fetches and interleaved its queue
since it was written; `refreshPrices` — the half that actually runs, four times
a day in CI and again on the Vercel cron — had no throttle at all, and recorded
the premise that made it look unnecessary: *"vendors are distinct hosts, so this
is safe"*. That is false for the order the queue is built in. Candidates come
back `ORDER BY priceUpdatedAt ASC`, and a store's rows are all stamped within
milliseconds of each other by the run that last visited them, so the queue does
not merely happen to cluster — it reproduces the previous run's per-vendor
grouping exactly. Eight lanes pulling consecutive indices out of that are eight
simultaneous, unspaced requests to ONE store, and they stay there for as many
rows as it has: 219 in a row for zfrontier-cn, 206 for mykeyboard-eu, 46 for
monokei. The stores with the most listings take the heaviest burst.

The cost is not wall clock, it is published listings. A 429 — like a 403, like a
connection that never answers — is `UNREADABLE`, so it increments
`linkFailures`; `DEAD_LINK_FAILURE_THRESHOLD` of those back the row off to the
14-day cadence, and an unpriced row is hidden outright on a RELEASED set. That
is `link-health.mjs`'s one prohibition ("a block may never hide a listing")
reached from the other end, by producing the block ourselves.
`scripts/lib/host-throttle.mjs` is now the single definition — `prices.ts`
IMPORTS it, `scrape.py` still mirrors it because Python cannot import a JS
module — and `test:host-throttle` fails if the two intervals drift, if either
half stops interleaving or throttling, or if the runner summary drops the
`throttledS` it costs. Interleaving is what makes the throttle nearly free:
requests to different hosts never wait on each other, so it only sleeps in the
tail, where the small stores are exhausted and only the giants remain — which
are exactly the rows a burst gets us blocked by. The slot is claimed
SYNCHRONOUSLY, before the sleep, so two lanes landing on one host queue up
instead of both reading the same stale timestamp and firing together.
