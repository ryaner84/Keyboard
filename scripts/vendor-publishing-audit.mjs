// Read-only audit of every vendor the site publishes NOTHING for.
//
// `db-setup` already computes this at deploy time — the storefront chain's
// residue lists plus reportVendorsPublishingNothing — but that log only exists
// inside a Vercel build and cannot be read afterwards. A store that silently
// publishes nothing looks exactly like a store nobody buys from, so the failure
// has to be *asked for*, and until this script there was no way to ask. That is
// how 57 of 136 vendor rows came to be publishing nothing at once without any
// single run summary ever looking wrong.
//
// It reports the same shapes db-setup does, in the order the repairs run:
//
//   1. no usable storefront — blank / shortener / marketplace. planVendorUrlHeal
//      can't derive one, so the store is uncrawlable and permanently silent.
//   2. a storefront that isn't this store's — contested or relocatable.
//   3. a healthy storefront and still nothing on any set page — the
//      planPublishingReport residue, with the cause named.
//   4. roster rows an import could move OFF their pinned storefront.
//
// Each silent vendor carries the evidence needed to act: how many VendorKit
// rows it has, how many the price pass has ever READ, how many carry a price,
// and a sample of the listing URLs. The fix differs completely depending on
// whether discovery never linked the store, its links are dead, the price came
// back empty, or its rows are filtered off the set page.
//
// Writes nothing. Run with: npm run audit:publishing
import pg from "pg";
import { readFile } from "node:fs/promises";
import {
  hostKey,
  hostOfUrl,
  needsStorefront,
  ownStorefrontHost,
  planPublishingReport,
  planStorefrontOwnership,
  planStorefrontRelocation,
  planVendorMerges,
  planVendorUrlHeal,
  rosterHostBySlug,
} from "./lib/vendor-urls.mjs";

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not set — skipping vendor publishing audit.");
  process.exit(0);
}

// Mirror src/lib/database-url.ts (plain-node script, can't import the TS
// module): splice DATABASE_PASSWORD into the __PASSWORD__ placeholder and
// redirect the capped session pooler (5432) to the transaction pooler (6543).
let connectionString = process.env.DATABASE_URL;
if (connectionString.includes("__PASSWORD__")) {
  if (!process.env.DATABASE_PASSWORD) {
    console.log("DATABASE_URL has __PASSWORD__ but DATABASE_PASSWORD not set — skipping.");
    process.exit(0);
  }
  connectionString = connectionString.replace(
    "__PASSWORD__",
    encodeURIComponent(process.env.DATABASE_PASSWORD)
  );
}
if (!/localhost|127\.0\.0\.1/.test(connectionString)) {
  connectionString = connectionString.replace(/:5432(\/|$|\?)/, ":6543$1");
}

// Same exclusions db-setup applies: catalog markers publish nothing by design.
const NON_PUBLISHING_SLUGS = new Set([
  "gmk",
  "dcs-wiki",
  "sxm-designs",
  "fancycustoms",
  "fancy-customs",
]);

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const sample = (urls, n = 3) => [...new Set(urls)].slice(0, n).join(" | ") || "(no listing URL)";

try {
  await client.connect();

  const roster = JSON.parse(
    await readFile(new URL("../src/data/seed/vendors.json", import.meta.url), "utf8")
  );

  // One pass over the table: every vendor, its listing URLs, and the counts that
  // tell the publishing failures apart. The counts are scalar subqueries rather
  // than aggregates over the URL join — that join fans each VendorKit out to two
  // rows (productUrl, gbUrl), which would double every count.
  const { rows } = await client.query(`
    SELECT v.id, v.slug, v.name, v."websiteUrl",
           coalesce(
             array_agg(DISTINCT u.url)
               FILTER (WHERE u.url IS NOT NULL AND btrim(u.url) <> ''),
             '{}'
           ) AS urls,
           (SELECT count(*)::int FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id) AS listings,
           (SELECT count(*)::int FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id AND vk."priceSource" IS NOT NULL)
             AS read_listings,
           (SELECT count(*)::int FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id AND vk.price IS NOT NULL) AS priced_listings,
           -- Two sub-cases of read_listings, split out because the repair for
           -- each is a code change HERE, not another scrape: REFUSED means the
           -- product data parsed and this site turned the number away
           -- (KIT_BOUNDS / the Currency table), UNPARSED that the page answered
           -- 200 carrying no product markup any parser path knows.
           (SELECT count(*)::int FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id AND vk."priceSource" = 'REFUSED')
             AS refused_listings,
           (SELECT count(*)::int FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id AND vk."priceSource" = 'UNPARSED')
             AS unparsed_listings,
           -- The store answered 404/410 for these. A 404 IS a read as far as
           -- priceSource goes, so without this count a closed store reads as a
           -- pricing backlog. See scripts/lib/link-health.mjs.
           (SELECT count(*)::int FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id AND vk."deadSince" IS NOT NULL)
             AS dead_listings,
           (SELECT min(vk."deadSince") FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id) AS deadest_since,
           -- How the price queue SEES this vendor, which is a different
           -- question from what the price pass concluded — and the four reasons
           -- above can only ever answer the second.
           --
           -- Every diagnosis here is read off columns a price ATTEMPT writes,
           -- so a row the queue is not currently visiting yields the same
           -- residue as one the store never answered: read=0, priced=0, dead=0,
           -- and the confident sentence "the store's links are dead; relink or
           -- retire it". On 2026-09-03 that sentence was being printed about
           -- nineteen vendors whose rows had all been parked on the 14-day
           -- back-off four days earlier, eight of which answer a runner
           -- perfectly well. lastAttempt and failures are what tell the two
           -- apart, and queued says whether the queue can select the row at
           -- all (it filters on a non-blank productUrl and a BASE kit, so a row
           -- failing either is never fetched, never priced and never
           -- dead-marked — by our rule, not the store's).
           --
           -- A stale lastAttempt on a fully backed-off vendor means the
           -- reason beside it describes the code as it was THEN. Re-read the
           -- rows before acting on it: refresh-prices with force ignores the
           -- back-off entirely.
           (SELECT count(*)::int
              FROM public."VendorKit" vk
              JOIN public."Kit" k ON k.id = vk."kitId"
             WHERE vk."vendorId" = v.id
               AND k.type = 'BASE'
               AND btrim(coalesce(vk."productUrl", '')) <> '') AS queued_listings,
           (SELECT count(*)::int FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id AND vk."priceUpdatedAt" IS NOT NULL)
             AS attempted_listings,
           (SELECT max(vk."priceUpdatedAt") FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id) AS last_attempt,
           (SELECT max(vk."linkFailures") FROM public."VendorKit" vk
             WHERE vk."vendorId" = v.id) AS max_link_failures,
           (
             SELECT count(*)::int
               FROM public."VendorKit" vk
               JOIN public."Kit" k ON k.id = vk."kitId"
               JOIN public."GroupBuy" gb ON gb.id = k."groupBuyId"
              WHERE vk."vendorId" = v.id
                AND k.type = 'BASE'
                AND (
                  v.slug = 'gmk-direct'
                  OR vk."productUrl" IS NULL
                  OR (vk."productUrl" NOT ILIKE '%gmk.net%'
                      AND vk."productUrl" NOT ILIKE '%dcs.wiki%')
                )
                -- Mirrors PURCHASABLE_VENDOR_KIT_WHERE: a link the store
                -- answers 404/410 for is not a place to buy.
                AND NOT (vk."deadSince" IS NOT NULL AND vk.price IS NULL)
                AND (
                  vk.price IS NOT NULL
                  OR (
                    gb.status::text NOT IN ('SHIPPING','DELIVERED','IN_STOCK','CANCELLED')
                    AND (btrim(coalesce(vk."gbUrl", '')) <> ''
                         OR btrim(coalesce(vk."productUrl", '')) <> '')
                  )
                )
           ) AS visible_listings
      FROM public."Vendor" v
      LEFT JOIN public."VendorKit" vk ON vk."vendorId" = v.id
      LEFT JOIN LATERAL (VALUES (vk."productUrl"), (vk."gbUrl")) AS u(url) ON true
     GROUP BY v.id, v.slug, v.name, v."websiteUrl"
     ORDER BY v.slug
  `);

  const vendors = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    websiteUrl: r.websiteUrl,
    listingUrls: r.urls,
    listings: r.listings,
    readListings: r.read_listings,
    refusedListings: r.refused_listings,
    unparsedListings: r.unparsed_listings,
    pricedListings: r.priced_listings,
    deadListings: r.dead_listings,
    deadestSince: r.deadest_since,
    visibleListings: r.visible_listings,
    queuedListings: r.queued_listings,
    attemptedListings: r.attempted_listings,
    lastAttempt: r.last_attempt,
    maxLinkFailures: r.max_link_failures,
  }));
  const bySlug = new Map(vendors.map((v) => [v.slug, v]));
  console.log(`Vendor publishing audit — ${vendors.length} vendor row(s).`);

  // 1. No usable storefront: uncrawlable, unpriceable, permanently silent.
  const taken = new Set();
  for (const v of vendors) {
    if (needsStorefront(v.websiteUrl)) continue;
    const key = hostKey(hostOfUrl(v.websiteUrl));
    if (key) taken.add(key);
  }
  const urlHeal = planVendorUrlHeal(
    vendors.filter((v) => needsStorefront(v.websiteUrl)),
    taken
  );
  const shapeOne = urlHeal.heal.length + urlHeal.duplicate.length + urlHeal.stranded.length;
  console.log(`\n== 1. No usable storefront (${shapeOne}) ==`);
  for (const v of urlHeal.heal) {
    console.log(`RECOVERABLE | ${v.slug} | was ${v.current || "(blank)"} → ${v.host}`);
  }
  for (const v of urlHeal.duplicate) {
    console.log(`DUPLICATE   | ${v.slug} | listings sell from ${v.host}, already another row's`);
  }
  for (const v of urlHeal.stranded) {
    console.log(
      `STRANDED    | ${v.slug} | ${v.reason} | parked on ${v.websiteUrl || "(blank)"}` +
        ` | listings=${v.listings} | ${sample(v.listingUrls)}`
    );
  }

  // 2. A storefront that is a shop, but not this shop's.
  //
  // The roster-declared duplicates are pulled out first. They read as contested
  // — two rows, one host, neither obviously wrong — but the roster has already
  // said they are one shop, so db-setup's mergeDuplicateVendorRows folds them on
  // the next deploy. Counting them as unrepairable was how "merge or remove
  // them" stayed on the list for months after the merge existed.
  const vendorMerge = planVendorMerges(roster, vendors);
  // Both halves stop contesting the host once they are one row; only the DROPS
  // stop existing. A survivor that is silent for some other reason stays on the
  // list — merging two rows changes which slug is silent, not the silence.
  const merging = new Set(vendorMerge.merges.flatMap((m) => [m.keep, ...m.drop]));
  const mergedAway = new Set(vendorMerge.merges.flatMap((m) => m.drop));
  const ownership = planStorefrontOwnership(vendors, roster);
  const relocation = planStorefrontRelocation(vendors, roster);
  const contested = [...ownership.contested, ...relocation.contested].filter(
    (v) => !merging.has(v.slug)
  );
  const shapeTwo =
    ownership.heal.length +
    relocation.heal.length +
    contested.length +
    vendorMerge.merges.length +
    vendorMerge.skipped.length;
  console.log(`\n== 2. Parked on someone else's / the wrong storefront (${shapeTwo}) ==`);
  for (const v of [...ownership.heal, ...relocation.heal]) {
    console.log(`RELOCATABLE | ${v.slug} | ${v.current} → ${v.host}`);
  }
  for (const m of vendorMerge.merges) {
    const drop = m.drop.map((slug) => bySlug.get(slug)?.listings ?? 0);
    console.log(
      `MERGING     | ${m.drop.join(", ")} → ${m.keep} | ${m.host} | one shop, two rows` +
        ` — the roster says so; next deploy folds ${drop.join("+")} listing(s) across`
    );
  }
  for (const g of vendorMerge.skipped) {
    console.log(`ALIAS-STALE | ${g.slugs.join(", ")} | ${g.hosts.join(", ")} | ${g.reason}`);
  }
  for (const v of contested) {
    console.log(`CONTESTED   | ${v.slug} | ${v.host} | ${v.reason}`);
  }

  // 3. Healthy storefront, nothing on any set page.
  const silent = planPublishingReport(vendors, NON_PUBLISHING_SLUGS);
  console.log(`\n== 3. Healthy storefront, publishes nothing (${silent.length}) ==`);
  for (const v of silent) {
    const row = bySlug.get(v.slug);
    console.log(
      `SILENT      | ${v.slug}${mergedAway.has(v.slug) ? " (merging away)" : ""}` +
        ` | ${v.websiteUrl} | listings=${row.listings}` +
        ` read=${row.readListings} priced=${row.pricedListings}` +
        ` dead=${row.deadListings} refused=${row.refusedListings}` +
        ` unparsed=${row.unparsedListings}` +
        ` queued=${row.queuedListings} attempted=${row.attemptedListings}` +
        ` failures=${row.maxLinkFailures ?? 0}` +
        ` lastAttempt=${row.lastAttempt ? new Date(row.lastAttempt).toISOString().slice(0, 10) : "never"}` +
        ` | ${v.reason}` +
        ` | ${sample(row.listingUrls)}`
    );
  }

  // 4. Roster rows the nightly import could move off their pinned storefront.
  // ownStorefrontHost pins a roster-named row to the roster's host precisely so
  // this list stays empty; a row appearing here means the pin was not applied
  // (an alias the roster doesn't name, say) and the deploy's repair is one
  // import away from being undone — which is how Maamaadei went dark.
  const rosterUrlBySlug = rosterHostBySlug(roster);
  const unpinned = [];
  for (const v of vendors) {
    const rosterUrl = rosterUrlBySlug.get(v.slug);
    if (!rosterUrl) continue;
    const own = hostKey(ownStorefrontHost(rosterUrl, v.listingUrls) ?? "");
    const rosterKey = hostKey(hostOfUrl(rosterUrl));
    if (own !== rosterKey) unpinned.push({ ...v, own, rosterKey });
  }
  console.log(`\n== 4. Roster rows an import could move off their storefront (${unpinned.length}) ==`);
  for (const v of unpinned) {
    console.log(`UNPINNED    | ${v.slug} | roster=${v.rosterKey} | import would pin=${v.own}`);
  }

  // Rows the merge is about to fold are NOT counted: a deploy repairs them.
  const total =
    urlHeal.duplicate.length +
    urlHeal.stranded.length +
    contested.length +
    vendorMerge.skipped.length +
    silent.filter((v) => !mergedAway.has(v.slug)).length;
  console.log(
    `\nTOTAL_UNPUBLISHED ${total} vendor(s) the site shows nothing for and no deploy pass can repair.`
  );
} catch (err) {
  console.error(`Vendor publishing audit failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
