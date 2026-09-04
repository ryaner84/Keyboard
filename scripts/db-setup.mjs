// Runs automatically during the Vercel build (see package.json "build").
//
// On the FIRST deploy (empty/missing tables) it executes supabase-setup.sql,
// which creates every table AND loads the 774 real GMK sets. On every later
// deploy it detects the data is already there and skips — so it never wipes
// your database or overwrites manual edits.
//
// It NEVER fails the build: if the DB is unreachable or misconfigured, it logs
// a clear message and exits 0 so the app still deploys (it'll just be empty
// until the connection is fixed).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import {
  hostKey,
  hostOfUrl,
  isStorefrontHost,
  needsStorefront,
  planPublishingReport,
  planRosterSync,
  planStorefrontOwnership,
  planStorefrontRelocation,
  planVendorMerges,
  planVendorUrlHeal,
} from "./lib/vendor-urls.mjs";
import { planSetMerges } from "./lib/set-merge.mjs";
import { KIT_BOUNDS, kitBoundsPurgeSql } from "./lib/kit-bounds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, "..", "supabase-setup.sql");

// Mirror src/lib/database-url.ts so build + runtime resolve identically.
function resolveDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  const password = process.env.DATABASE_PASSWORD;
  if (url) {
    if (url.includes("__PASSWORD__")) {
      if (!password) throw new Error("DATABASE_URL has __PASSWORD__ but DATABASE_PASSWORD is not set");
      return ensureTransactionPooler(url.replace("__PASSWORD__", encodeURIComponent(password)));
    }
    return ensureTransactionPooler(url);
  }
  const ref = process.env.SUPABASE_PROJECT_REF;
  const region = process.env.SUPABASE_REGION;
  if (ref && region) {
    if (!password) throw new Error("DATABASE_PASSWORD is required with SUPABASE_PROJECT_REF + SUPABASE_REGION");
    const host = process.env.SUPABASE_DB_HOST || `aws-0-${region}.pooler.supabase.com`;
    return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:6543/postgres`;
  }
  throw new Error("No database configuration found (DATABASE_URL or SUPABASE_PROJECT_REF + SUPABASE_REGION + DATABASE_PASSWORD)");
}

// Session pooler (5432) caps at 15 clients; transaction pooler (6543) does not.
// Always redirect so the build connects the same way runtime does.
// Local Postgres has no pooler — leave localhost URLs untouched.
function ensureTransactionPooler(url) {
  if (/localhost|127\.0\.0\.1/.test(url)) return url;
  return url.replace(/:5432(\/|$|\?)/, ":6543$1");
}

// Vendors banned from the site (mirrors BLOCKED_VENDOR_SLUGS in
// vendor-overrides.ts). Runs every deploy so a blocked vendor re-imported by
// any path gets purged again. Fancy Customs prices in CLP and poisoned
// listings with six-digit "USD" prices — removed at the owner's request.
async function purgeBlockedVendors(client) {
  try {
    const vendors = await client.query(
      `SELECT id FROM public."Vendor"
        WHERE slug IN ('fancycustoms','fancy-customs')
           OR "websiteUrl" ILIKE '%fancycustoms.com%'
           OR name ILIKE 'fancy customs'`
    );
    if (vendors.rowCount === 0) return;
    const ids = vendors.rows.map((r) => r.id);
    await client.query(`DELETE FROM public."VendorKit" WHERE "vendorId" = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public."ShippingZone" WHERE "vendorId" = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public."Vendor" WHERE id = ANY($1)`, [ids]);
    console.log(`[db-setup] Purged ${ids.length} blocked vendor(s) (fancycustoms).`);
  } catch (err) {
    console.warn(`[db-setup] blocked-vendor purge skipped: ${err.message}`);
  }
}

// The vendor roster (src/data/seed/vendors.json) is the declared list of stores
// the catalog discovery crawler should walk. It only ever reached the database
// through `prisma/seed.ts` (`npm run db:seed`), which is NOT part of the build
// — that runs `db-setup.mjs`, and nothing here ever INSERTed a Vendor. So a
// store added to the roster never got a row, and discoverGmkProducts() iterates
// Vendor rows: no row, no crawl, no VendorKit, no listing on the site, ever.
//
// Two repairs, both idempotent and every deploy:
//   a) INSERT roster stores that have no row yet. ON CONFLICT DO NOTHING keeps
//      existing rows (and their manual edits) untouched — backfillShipping owns
//      region/currency corrections, so this must not fight it.
//   b) Fill a BLANK "websiteUrl" from the roster. discovery.ts does
//      `new URL(vendor.websiteUrl)`, which THROWS on '' — that vendor is
//      skipped on every pass forever. 28 of the 125 rows in supabase-setup.sql
//      shipped with '' here, iLumKB among them, which is why the store the
//      LINK_VENDORS comment calls "guaranteed-present so the crawler always
//      scans it" has never actually been crawled.
//
// Deliberately NOT named in the INSERT: createdAt/updatedAt (the Vendor table
// has no such columns) and lastDiscoveredAt (added later by
// ensureDiscoveryColumn; leaving it NULL is what puts a new store at the FRONT
// of the crawler's NULLS FIRST rotation).
const VENDOR_ROSTER_PATH = join(__dirname, "..", "src", "data", "seed", "vendors.json");

async function ensureVendorRoster(client) {
  let roster;
  try {
    roster = JSON.parse(readFileSync(VENDOR_ROSTER_PATH, "utf8"));
  } catch (err) {
    console.warn(`[db-setup] vendor roster skipped (unreadable): ${err.message}`);
    return;
  }

  // Never re-create a vendor purgeBlockedVendors is about to delete.
  const blocked = new Set(["fancycustoms", "fancy-customs"]);
  const rows = (Array.isArray(roster) ? roster : []).filter(
    (v) => v && v.slug && !blocked.has(v.slug) && String(v.websiteUrl || "").trim() !== ""
  );
  if (rows.length === 0) return;

  // ON CONFLICT (slug) only catches a store the database already knows under
  // the SAME slug — and the roster's slugs are not the database's. Five roster
  // entries are stores that have had a row (and their listings) all along under
  // a different spelling: cannonkeys/cannon-keys, thekeyco/the-key-company,
  // mykeyboard-eu/mykeyboard, mech-land/mechland, toro-studio/toro-studios.
  // Inserting those made a SECOND Vendor row for one store, which discovery
  // then crawls twice and publishes twice — two rows for the same shop in the
  // set's price table, competing on price. A store is identified by its site,
  // so match on the host too and leave the existing row alone.
  //
  // Host matching alone cannot see the rows this pass exists to repair: a
  // BLANK vendor has no host, so a blank row spelled `cannon-keys` reads as a
  // store nobody owns and gets a second row while staying stranded itself.
  // planRosterSync also matches the `aliases` each roster entry declares, so
  // the heal reaches the existing row instead of duplicating it.
  let plan = null;
  try {
    const existing = await client.query(
      `SELECT slug, "websiteUrl" FROM public."Vendor"`
    );
    plan = planRosterSync(rows, existing.rows);
    if (plan.aliased.length > 0) {
      console.log(
        `[db-setup] ${plan.aliased.length} roster store(s) already exist under another slug ` +
          `— left as they are: ${plan.aliased.map((v) => `${v.slug} → ${v.owner}`).join(", ")}`
      );
    }
    if (plan.duplicate.length > 0) {
      console.warn(
        `[db-setup] ${plan.duplicate.length} vendor row(s) duplicate a roster store that ` +
          `already has one — merge or remove them: ` +
          plan.duplicate.map((v) => `${v.slug} (kept ${v.keeps})`).join(", ")
      );
    }
    // The roster names a storefront another Vendor row already holds. Taking it
    // would park two rows on one shop, which is what healMisparkedVendorUrls
    // exists to undo — so say so and change nothing.
    if ((plan.conflicted ?? []).length > 0) {
      console.warn(
        `[db-setup] ${plan.conflicted.length} roster store(s) name a host another vendor ` +
          `row already holds — merge or correct them: ` +
          plan.conflicted.map((v) => `${v.slug} → ${v.host} (held by ${v.owner})`).join(", ")
      );
    }
  } catch (err) {
    // Reconciliation is an optimisation, not a precondition: fall back to the
    // slug-only behaviour rather than skipping the roster entirely.
    console.warn(`[db-setup] roster alias check skipped: ${err.message}`);
    // No `current` to guard on here — the UPDATE below then falls back to
    // repairing blanks only, which is what this path did before.
    plan = { insert: rows, heal: rows.map((v) => ({ slug: v.slug, websiteUrl: v.websiteUrl })) };
  }

  const col = (list, pick) => list.map((v) => (pick(v) == null ? null : String(pick(v))));

  try {
    if (plan.insert.length > 0) {
      const inserted = await client.query(
        `INSERT INTO public."Vendor"
           (id, name, slug, region, country, currency, "websiteUrl", "logoUrl")
         SELECT gen_random_uuid()::text, r.name, r.slug, r.region::public."Region",
                r.country, r.currency, r.website, r.logo
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
                       $5::text[], $6::text[], $7::text[])
             AS r(name, slug, region, country, currency, website, logo)
         ON CONFLICT (slug) DO NOTHING
         RETURNING slug`,
        [
          col(plan.insert, (v) => v.name),
          col(plan.insert, (v) => v.slug),
          col(plan.insert, (v) => v.region),
          col(plan.insert, (v) => v.country),
          col(plan.insert, (v) => v.currency),
          col(plan.insert, (v) => v.websiteUrl),
          col(plan.insert, (v) => v.logoUrl),
        ]
      );
      if (inserted.rowCount > 0) {
        console.log(
          `[db-setup] Added ${inserted.rowCount} roster vendor(s) to the crawl: ` +
            inserted.rows.map((r) => r.slug).join(", ")
        );
      }
    }

    if (plan.heal.length > 0) {
      // Two shapes, one repair: a blank websiteUrl, and one pointed at a
      // shortener / marketplace / social page by an import that predates
      // nextVendorWebsiteUrl. Both are uncrawlable; only the blank one was
      // ever revisited, so a downgraded store stayed off the site for good.
      // `r.current` is the value planRosterSync saw, so a row that changed
      // since is left alone rather than overwritten blind.
      const healed = await client.query(
        `UPDATE public."Vendor" AS v
            SET "websiteUrl" = r.website
           FROM unnest($1::text[], $2::text[], $3::text[]) AS r(slug, website, current)
          WHERE v.slug = r.slug
            AND (btrim(coalesce(v."websiteUrl", '')) = ''
                 OR btrim(coalesce(v."websiteUrl", '')) = r.current)
         RETURNING v.slug, r.current`,
        [
          col(plan.heal, (v) => v.slug),
          col(plan.heal, (v) => v.websiteUrl),
          col(plan.heal, (v) => v.current),
        ]
      );
      if (healed.rowCount > 0) {
        console.log(
          `[db-setup] Restored ${healed.rowCount} vendor storefront(s) from the roster: ` +
            healed.rows
              .map((r) => `${r.slug}${r.current ? ` (was ${r.current})` : ""}`)
              .join(", ")
        );
      }
    }
  } catch (err) {
    console.warn(`[db-setup] vendor roster sync skipped: ${err.message}`);
    return;
  }

  // Anything still blank can't be crawled and isn't in the roster to repair
  // from. Name them in the build log so they can be filled in or removed.
  try {
    const stranded = await client.query(
      `SELECT slug FROM public."Vendor"
        WHERE btrim(coalesce("websiteUrl", '')) = ''
        ORDER BY slug`
    );
    if (stranded.rowCount > 0) {
      console.warn(
        `[db-setup] ${stranded.rowCount} vendor(s) still have no websiteUrl and are ` +
          `excluded from catalog discovery: ${stranded.rows.map((r) => r.slug).join(", ")}`
      );
    }
  } catch {
    /* diagnostic only */
  }
}

// The duplicate rows ensureVendorRoster has been reporting since aliases were
// added — folded back into one row per shop.
//
// Aliases stopped the roster from INSERTING a second Vendor row for a store the
// database already knew under another spelling. They never removed the rows it
// had already inserted, so five shops still carry two rows each and every
// deploy prints "merge or remove them" at a pass that cannot do either.
//
// The empty half of each pair is a vendor the site publishes NOTHING for, by
// construction: `thekeyco` holds 0 listings while `the-key-company` holds 12,
// `mykeyboard-eu` holds 0 while `mykeyboard` holds 206. It is not inert, either
// — discovery rotates 8 stores a night across ~130 rows, so each ghost spends a
// slot re-crawling a catalogue already read under the other id and a real store
// waits another fortnight; whichever id the crawl happens to run under is where
// that night's listings land; and `find_vendor_for_url` resolves an outlet
// collection by HOST, returning whichever of the two Postgres hands back first.
//
// Runs after ensureVendorRoster so the surviving slug exists and has been
// healed, and before healMisparkedVendorUrls so ownership sees one row per host
// instead of reporting the pair as contested for the rest of time.
//
// Deleting a Vendor row is a higher bar than reporting one, so the guards live
// in planVendorMerges: only the ROSTER may declare two slugs to be one shop
// (rows that merely share a host stay contested and reported), and every row
// that has a storefront must agree on the host.
async function mergeDuplicateVendorRows(client) {
  let roster;
  try {
    const parsed = JSON.parse(readFileSync(VENDOR_ROSTER_PATH, "utf8"));
    roster = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[db-setup] duplicate-vendor merge skipped (roster unreadable): ${err.message}`);
    return;
  }

  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT id, slug, "websiteUrl" FROM public."Vendor"`
    ));
  } catch (err) {
    console.warn(`[db-setup] duplicate-vendor merge skipped: ${err.message}`);
    return;
  }

  const { merges, skipped } = planVendorMerges(roster, rows);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  let merged = 0;
  for (const merge of merges) {
    const keep = bySlug.get(merge.keep);
    const drops = merge.drop.map((slug) => bySlug.get(slug)).filter(Boolean);
    if (!keep || drops.length === 0) continue;
    const dropIds = drops.map((r) => r.id);
    try {
      await client.query("BEGIN");

      // Settle every kit both sides list BEFORE moving anything: VendorKit is
      // unique on (kitId, vendorId), so the move would fail on the first shared
      // set otherwise. The row that survives is the one worth publishing — a
      // price beats no price, a page the price pass has READ beats one it never
      // parsed, and the freshest attempt breaks the rest. `is_keep` is only the
      // final tiebreak: the survivor here is often the EMPTY roster row, and
      // preferring it by default would throw away the only priced listing the
      // shop has. Losers are deleted, so exactly one pool row per kit remains.
      await client.query(
        `WITH pool AS (
           SELECT vk.id, vk."kitId",
                  (vk."vendorId" = $1) AS is_keep,
                  (vk.price IS NOT NULL) AS priced,
                  (vk."priceSource" IS NOT NULL) AS was_read,
                  vk."priceUpdatedAt" AS seen
             FROM public."VendorKit" vk
            WHERE vk."vendorId" = $1 OR vk."vendorId" = ANY($2::text[])
         ), winner AS (
           SELECT DISTINCT ON ("kitId") id
             FROM pool
            ORDER BY "kitId", priced DESC, was_read DESC,
                     seen DESC NULLS LAST, is_keep DESC, id
         )
         DELETE FROM public."VendorKit" v
          USING pool p
          WHERE v.id = p.id
            AND EXISTS (SELECT 1 FROM pool o
                         WHERE o."kitId" = p."kitId" AND o.id <> p.id)
            AND p.id NOT IN (SELECT id FROM winner)`,
        [keep.id, dropIds]
      );

      const moved = await client.query(
        `UPDATE public."VendorKit" SET "vendorId" = $1, "updatedAt" = now()
          WHERE "vendorId" = ANY($2::text[])`,
        [keep.id, dropIds]
      );

      // Shipping zones are unique on (vendorId, destinationRegion) and the
      // price table hides a listing the survivor cannot ship (see
      // backfillShipping). Move only the regions it is missing, one per region;
      // the rest cascade away with the row.
      await client.query(
        `WITH survivors AS (
           SELECT DISTINCT ON (z."destinationRegion") z.id
             FROM public."ShippingZone" z
            WHERE z."vendorId" = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM public."ShippingZone" k
                 WHERE k."vendorId" = $1
                   AND k."destinationRegion" = z."destinationRegion")
            ORDER BY z."destinationRegion", z.id
         )
         UPDATE public."ShippingZone" SET "vendorId" = $1
          WHERE id IN (SELECT id FROM survivors)`,
        [keep.id, dropIds]
      );

      // Only ever fill what the survivor is missing. `lastDiscoveredAt` takes
      // the EARLIER of the two (never-crawled wins): the merged row's listing
      // set just changed, and neither half's crawl history describes it any
      // more, so it goes back to the front of the rotation once.
      for (const dropId of [...dropIds].sort()) {
        await client.query(
          `UPDATE public."Vendor" k SET
             "logoUrl" = COALESCE(NULLIF(k."logoUrl", ''), NULLIF(l."logoUrl", '')),
             "lastDiscoveredAt" = CASE
               WHEN k."lastDiscoveredAt" IS NULL OR l."lastDiscoveredAt" IS NULL THEN NULL
               ELSE LEAST(k."lastDiscoveredAt", l."lastDiscoveredAt") END
           FROM public."Vendor" l
          WHERE k.id = $1 AND l.id = $2`,
          [keep.id, dropId]
        );
      }

      // A blank / shortener-parked survivor is the shape aliases exist for: the
      // roster heals it on this same deploy, but if it hasn't yet, take the
      // storefront the row being deleted was carrying rather than lose it.
      if (needsStorefront(keep.websiteUrl)) {
        const rescue = drops.find((r) => !needsStorefront(r.websiteUrl));
        if (rescue) {
          await client.query(
            `UPDATE public."Vendor" SET "websiteUrl" = $2 WHERE id = $1`,
            [keep.id, rescue.websiteUrl]
          );
        }
      }

      await client.query(`DELETE FROM public."Vendor" WHERE id = ANY($1::text[])`, [dropIds]);
      await client.query("COMMIT");
      merged += dropIds.length;
      console.log(
        `[db-setup]   merged ${merge.drop.join(", ")} into ${merge.keep} ` +
          `on ${merge.host} (${moved.rowCount} listing(s) moved)`
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.warn(
        `[db-setup] duplicate-vendor merge failed for ${merge.keep}: ${err.message}`
      );
    }
  }

  if (merged > 0) {
    console.log(`[db-setup] Merged ${merged} duplicate vendor row(s) into their shop.`);
  }
  // Named rather than merged: the roster says one shop and the rows say two.
  for (const group of skipped) {
    console.warn(
      `[db-setup] duplicate-vendor merge skipped ${group.slugs.join(", ")} ` +
        `(${group.hosts.join(", ")}) — ${group.reason}`
    );
  }
}

// A third shape of "no storefront of its own": a row parked on ANOTHER store's
// site. `needsStorefront` reads mokbstore.com as healthy whichever vendor row
// carries it, so Swagkeys (KR) — registered as https://mokbstore.com, a host
// Mokb Store's own row also carries — was never revisited by either repair
// above. Discovery crawls that host under BOTH vendor ids, so Mokb's catalogue
// is published twice on a set page, once under a shop that does not sell it,
// while Swagkeys (KR)'s own site (www.swagkey.kr, where 11 of its 13 listings
// live) is never crawled at all and it publishes nothing of its own.
//
// Runs after ensureVendorRoster so a roster-assigned storefront is already in
// place and wins its host, and before healVendorUrlsFromListings so that pass
// sees ownership settled — a row moved off a host frees it, and a row that
// keeps one holds it against a blank vendor's claim.
async function healMisparkedVendorUrls(client) {
  let roster = [];
  try {
    const parsed = JSON.parse(readFileSync(VENDOR_ROSTER_PATH, "utf8"));
    if (Array.isArray(parsed)) roster = parsed;
  } catch {
    // The roster only breaks ties; listings can still settle them without it.
  }

  let rows;
  try {
    const all = await client.query(
      `SELECT id, slug, "websiteUrl" FROM public."Vendor" ORDER BY slug`
    );
    rows = all.rows;
  } catch (err) {
    console.warn(`[db-setup] vendor ownership check skipped: ${err.message}`);
    return;
  }

  // Only rows sharing a host with another row can be misparked, and they are a
  // handful of ~125 — so find them on the cheap list first and read listing
  // URLs for those alone rather than aggregating every vendor's kits.
  const slugsByHost = new Map();
  for (const r of rows) {
    if (needsStorefront(r.websiteUrl)) continue;
    const key = hostKey(hostOfUrl(r.websiteUrl));
    if (key) slugsByHost.set(key, [...(slugsByHost.get(key) ?? []), r]);
  }
  const colliding = [...slugsByHost.values()].filter((g) => g.length > 1).flat();
  if (colliding.length === 0) return;

  let listings;
  try {
    listings = await client.query(
      `SELECT v.id,
              coalesce(
                array_agg(u.url) FILTER (WHERE u.url IS NOT NULL AND btrim(u.url) <> ''),
                '{}'
              ) AS urls
         FROM public."Vendor" v
         LEFT JOIN public."VendorKit" vk ON vk."vendorId" = v.id
         LEFT JOIN LATERAL (VALUES (vk."productUrl"), (vk."gbUrl")) AS u(url) ON true
        WHERE v.id = ANY($1)
        GROUP BY v.id`,
      [colliding.map((r) => r.id)]
    );
  } catch (err) {
    console.warn(`[db-setup] vendor ownership check skipped: ${err.message}`);
    return;
  }
  const urlsById = new Map(listings.rows.map((r) => [r.id, r.urls]));

  const { heal, contested } = planStorefrontOwnership(
    rows.map((r) => ({ ...r, listingUrls: urlsById.get(r.id) ?? [] })),
    roster
  );

  if (heal.length > 0) {
    try {
      // Guarded on the host it was parked on, so a row another pass moved in
      // the meantime keeps whatever that pass decided.
      await client.query(
        `UPDATE public."Vendor" AS v
            SET "websiteUrl" = r.url
           FROM unnest($1::text[], $2::text[], $3::text[]) AS r(id, url, current)
          WHERE v.id = r.id
            AND btrim(coalesce(v."websiteUrl", '')) = btrim(r.current)`,
        [heal.map((v) => v.id), heal.map((v) => v.websiteUrl), heal.map((v) => v.current)]
      );
      console.log(
        `[db-setup] Moved ${heal.length} vendor(s) off a storefront they do not own ` +
          `onto their own: ${heal.map((v) => `${v.slug} (was ${v.current}) → ${v.host}`).join(", ")}`
      );
    } catch (err) {
      console.warn(`[db-setup] vendor ownership repair skipped: ${err.message}`);
      return;
    }
  }

  // Not a failure — two rows for one shop, which is a merge no pass should do
  // on its own. Left alone, both crawl the same catalogue and the set page
  // lists one store twice.
  if (contested.length > 0) {
    console.warn(
      `[db-setup] ${contested.length} vendor row(s) share a storefront with another row ` +
        `— merge or remove them: ` +
        contested.map((v) => `${v.slug} (${v.host}: ${v.reason})`).join(", ")
    );
  }
}

// The fourth shape, and the one every repair above reads as healthy: a row
// parked ALONE on a storefront that isn't its own. `needsStorefront` says
// "yes, a shop"; planStorefrontOwnership needs a collision and there isn't one;
// planVendorUrlHeal only looks at rows needsStorefront flagged. So the row sits
// there while discovery asks the wrong website for /products.json on every
// rotation — novelkeys on its retired novelkeys.xyz, omnitype on DixieMech's
// site, yushakobo on the corporate apex instead of shop.yushakobo.jp. See
// planStorefrontRelocation for the full list and what it costs.
//
// Runs AFTER healMisparkedVendorUrls so contested hosts are settled first (a
// row moved off one frees it, so the freed host is available here), and BEFORE
// healVendorUrlsFromListings so that pass sees the final ownership when it
// decides which hosts are taken.
async function healOffsiteVendorUrls(client) {
  let roster = [];
  try {
    const parsed = JSON.parse(readFileSync(VENDOR_ROSTER_PATH, "utf8"));
    if (Array.isArray(parsed)) roster = parsed;
  } catch {
    // Only used to skip slugs the roster already decided; without it those rows
    // are simply settled from their listings, which agrees with it in practice.
  }

  let rows;
  try {
    const all = await client.query(
      `SELECT id, slug, "websiteUrl" FROM public."Vendor" ORDER BY slug`
    );
    rows = all.rows;
  } catch (err) {
    console.warn(`[db-setup] offsite vendor check skipped: ${err.message}`);
    return;
  }

  // Which rows could even be on the wrong host is a host question, not a SQL
  // one, so narrow in JS first and aggregate listing URLs only for those.
  // Same rule planStorefrontRelocation applies, so the narrowing here can never
  // starve it of the listings it needs for a row it would have considered.
  const pinned = new Set(
    roster.flatMap((e) =>
      e?.slug && hostOfUrl(e?.websiteUrl) ? [e.slug, ...(e.aliases ?? [])] : []
    )
  );
  const holders = new Map();
  for (const r of rows) {
    if (needsStorefront(r.websiteUrl)) continue;
    const key = hostKey(hostOfUrl(r.websiteUrl));
    if (key) holders.set(key, (holders.get(key) ?? 0) + 1);
  }
  const candidates = rows.filter(
    (r) =>
      !needsStorefront(r.websiteUrl) &&
      !pinned.has(r.slug) &&
      holders.get(hostKey(hostOfUrl(r.websiteUrl))) === 1
  );
  if (candidates.length === 0) return;

  let listings;
  try {
    listings = await client.query(
      `SELECT v.id,
              coalesce(
                array_agg(u.url) FILTER (WHERE u.url IS NOT NULL AND btrim(u.url) <> ''),
                '{}'
              ) AS urls
         FROM public."Vendor" v
         LEFT JOIN public."VendorKit" vk ON vk."vendorId" = v.id
         LEFT JOIN LATERAL (VALUES (vk."productUrl"), (vk."gbUrl")) AS u(url) ON true
        WHERE v.id = ANY($1)
        GROUP BY v.id`,
      [candidates.map((r) => r.id)]
    );
  } catch (err) {
    console.warn(`[db-setup] offsite vendor check skipped: ${err.message}`);
    return;
  }
  const urlsById = new Map(listings.rows.map((r) => [r.id, r.urls]));

  // Every row is passed in, not just the candidates: a host is only "already
  // taken" relative to the whole table.
  const { heal, contested } = planStorefrontRelocation(
    rows.map((r) => ({ ...r, listingUrls: urlsById.get(r.id) ?? [] })),
    roster
  );

  if (heal.length > 0) {
    try {
      // Guarded on the host it was parked on, so a row another pass moved in
      // the meantime keeps whatever that pass decided.
      await client.query(
        `UPDATE public."Vendor" AS v
            SET "websiteUrl" = r.url
           FROM unnest($1::text[], $2::text[], $3::text[]) AS r(id, url, current)
          WHERE v.id = r.id
            AND btrim(coalesce(v."websiteUrl", '')) = btrim(r.current)`,
        [heal.map((v) => v.id), heal.map((v) => v.websiteUrl), heal.map((v) => v.current)]
      );
      console.log(
        `[db-setup] Moved ${heal.length} vendor(s) onto the storefront their own listings ` +
          `sell from: ${heal.map((v) => `${v.slug} (was ${v.current}) → ${v.host}`).join(", ")}`
      );
    } catch (err) {
      console.warn(`[db-setup] offsite vendor repair skipped: ${err.message}`);
      return;
    }
  }

  if (contested.length > 0) {
    console.warn(
      `[db-setup] ${contested.length} vendor(s) sell from a host that already belongs to ` +
        `another row — merge or correct them: ` +
        contested.map((v) => `${v.slug} (${v.reason})`).join(", ")
    );
  }
}

// The roster can only repair a store it lists — 26 of them. Every other vendor
// with no usable storefront has to be repaired from what the database already
// knows: its own listings. A vendor's VendorKit rows carry the product URLs an
// earlier import stored, and those name the storefront (BaseKeys' 34 links are
// all basekeys.jp, Mekibo's are mekibo.com). Reading the host back off them
// turns an uncrawlable vendor into a crawlable one without anyone having to
// look a URL up by hand, and — because the vendor then gets a real catalogue
// pass — gives its URL-less listings a productUrl and finally a price.
//
// "No usable storefront" is BOTH shapes, not just the blank one (see
// needsStorefront in scripts/lib/vendor-urls.mjs). A row pointed at goo.gl,
// item.taobao.com or an Instagram profile cannot be crawled either — and
// unlike a blank row it was never revisited by anything, because every repair
// here was keyed on `websiteUrl = ''`. So the shape that #133 stopped anyone
// from CREATING was also the shape nobody could ever undo: the store dropped
// off the site the day an import downgraded it and stayed off.
//
// Runs AFTER ensureVendorRoster so the hand-written roster always wins, and
// after healBlankVendorUrls so '' has already become NULL on the kit rows.
// Deliberately conservative (see scripts/lib/vendor-urls.mjs): a marketplace
// or shortener host is never adopted, a tie is never broken by guessing, and a
// host that already belongs to another vendor is reported as a duplicate store
// rather than crawled under two names.
async function healVendorUrlsFromListings(client) {
  // Which rows need one is a host question, not a SQL one — `websiteUrl LIKE
  // '%x.com%'` would match mybox.com — so pick them in JS off the cheap list
  // and only then aggregate listings for the ones that qualify.
  let needing;
  let taken;
  try {
    const all = await client.query(
      `SELECT id, slug, "websiteUrl" FROM public."Vendor" ORDER BY slug`
    );
    needing = all.rows.filter((r) => needsStorefront(r.websiteUrl));
    // Hosts already spoken for. One store, one Vendor row — and a row parked
    // on a shortener speaks for nothing, so it must not reserve goo.gl.
    taken = new Set();
    for (const r of all.rows) {
      if (needsStorefront(r.websiteUrl)) continue;
      const key = hostKey(hostOfUrl(r.websiteUrl));
      if (key) taken.add(key);
    }
  } catch (err) {
    console.warn(`[db-setup] vendor URL heal skipped: ${err.message}`);
    return;
  }
  if (needing.length === 0) return;

  let blanks;
  try {
    blanks = await client.query(
      `SELECT v.id, v.slug, v."websiteUrl",
              coalesce(
                array_agg(u.url) FILTER (WHERE u.url IS NOT NULL AND btrim(u.url) <> ''),
                '{}'
              ) AS urls
         FROM public."Vendor" v
         LEFT JOIN public."VendorKit" vk ON vk."vendorId" = v.id
         LEFT JOIN LATERAL (VALUES (vk."productUrl"), (vk."gbUrl")) AS u(url) ON true
        WHERE v.id = ANY($1)
        GROUP BY v.id, v.slug, v."websiteUrl"
        ORDER BY v.slug`,
      [needing.map((r) => r.id)]
    );
  } catch (err) {
    console.warn(`[db-setup] vendor URL heal skipped: ${err.message}`);
    return;
  }
  if (blanks.rowCount === 0) return;

  // purgeBlockedVendors removes the vendor and its listings, but a stray link
  // to a banned store can survive on someone else's row — never adopt one as a
  // storefront and re-create by the back door what that pass just deleted.
  const bannedHosts = new Set(["fancycustoms.com"]);
  const { heal, duplicate, stranded } = planVendorUrlHeal(
    blanks.rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      websiteUrl: r.websiteUrl,
      // A vendor's own bad storefront is usually also its listings' host
      // (cocobrais is goo.gl in both places). storefrontHostFromUrls rejects
      // those anyway, so no filtering is needed here — it simply reports the
      // vendor as stranded rather than re-adopting what it just refused.
      listingUrls: r.urls.filter((u) => !bannedHosts.has(hostKey(hostOfUrl(u)))),
    })),
    taken
  );

  if (heal.length > 0) {
    try {
      // Guarded on the exact value the plan was built from, so a row another
      // pass changed in the meantime is left alone. Blank and downgraded rows
      // both land here; `coalesce` makes the NULL case comparable.
      await client.query(
        `UPDATE public."Vendor" AS v
            SET "websiteUrl" = r.url
           FROM unnest($1::text[], $2::text[], $3::text[]) AS r(id, url, current)
          WHERE v.id = r.id
            AND btrim(coalesce(v."websiteUrl", '')) = btrim(r.current)`,
        [
          heal.map((v) => v.id),
          heal.map((v) => v.websiteUrl),
          heal.map((v) => v.current ?? ""),
        ]
      );
      console.log(
        `[db-setup] Recovered ${heal.length} vendor storefront(s) from their own ` +
          `listings: ${heal
            .map((v) => `${v.slug}${v.current ? ` (was ${v.current})` : ""} → ${v.host}`)
            .join(", ")}`
      );
    } catch (err) {
      console.warn(`[db-setup] vendor URL heal skipped: ${err.message}`);
      return;
    }
  }

  // Not failures — findings. Both lists are stores the site currently shows
  // nothing for, and neither can be fixed from data we already hold.
  if (duplicate.length > 0) {
    console.warn(
      `[db-setup] ${duplicate.length} vendor(s) look like a duplicate row for a store ` +
        `that already has one — merge or remove them: ` +
        duplicate.map((v) => `${v.slug} (${v.host})`).join(", ")
    );
  }
  if (stranded.length > 0) {
    console.warn(
      `[db-setup] ${stranded.length} vendor(s) still have no storefront and can never ` +
        `publish a listing — add them to src/data/seed/vendors.json or remove them: ` +
        stranded
          .map(
            (v) =>
              `${v.slug} (${v.reason}${
                String(v.websiteUrl ?? "").trim() ? `; parked on ${v.websiteUrl}` : ""
              })`
          )
          .join(", ")
    );
  }

  // What survived both repairs: a websiteUrl that isn't blank and isn't a shop
  // either — two vendors registered as `https://goo.gl`, one as Instagram, one
  // as a Google Doc, and their own listings point at the same shortener, so
  // there is nothing to derive a storefront from. Discovery no longer wastes a
  // rotation slot asking them for /products.json, but they still publish
  // nothing until someone gives them a real URL, so name them.
  try {
    const all = await client.query(
      `SELECT slug, "websiteUrl" FROM public."Vendor"
        WHERE btrim(coalesce("websiteUrl", '')) <> '' ORDER BY slug`
    );
    const notShops = all.rows.filter((r) => !isStorefrontHost(hostOfUrl(r.websiteUrl)));
    if (notShops.length > 0) {
      console.warn(
        `[db-setup] ${notShops.length} vendor(s) point at a link shortener / social / ` +
          `marketplace page rather than a storefront, so discovery can never read a ` +
          `catalogue for them — give them a storefront in src/data/seed/vendors.json ` +
          `or remove them: ` +
          notShops.map((r) => `${r.slug} (${r.websiteUrl})`).join(", ")
      );
    }
  } catch {
    /* diagnostic only */
  }
}

// Vendors that publish NOTHING on any set page, despite having a real
// storefront — the residue every heal above cannot see.
//
// The four healers (planRosterSync, planStorefrontOwnership,
// planStorefrontRelocation, planVendorUrlHeal) exist because a Vendor with no
// usable `websiteUrl` publishes nothing. They each name their own residue in
// the log — the stranded, the contested, the not-a-shops — so every shape of
// "no storefront of its own" reaches the owner one way or another.
//
// A fifth shape gets past every one of them. The row's `websiteUrl` is a real
// shop AND its own, so `needsStorefront` reads it as healthy and neither
// ownership pass has anything to move it to. Discovery crawls it and
// run_outlets resolves collections to it. And still, the site never surfaces a
// single listing from it — because its catalog pass never matched a tracked
// set (a store that stopped selling GMK / DCS), or its /products.json turned
// to a redirect the crawler can't follow, or its every scraped price landed at
// null and the sets it lists are all RELEASED (which hides unpriced rows).
// None can be UNDONE from data we hold — but they can be told apart, and the
// report names which of them applies to each vendor, because "one of these
// things went wrong" sent the owner to the wrong pass as often as the right
// one. The first cause is the one that had a code bug behind it: discovery's
// tracked-profile gate refused every SA / DSS / DSA / MTNU / CYL product, so a
// Signature Plastics specialist could never be linked to anything and sat in
// this report reading as "the store stopped selling tracked sets".
//
// The commonest cause by far is a DEAD LINK SET, and it read as the pricing
// backlog until this pass learned to count `priceSource`. A store that closed,
// moved domain, was acquired, password-locked its Shopify or let the plan lapse
// answers with a redirect / 401 / 402 / 5xx / DNS failure — never a 404 — and
// only a 404/410 clears a price, so the row is re-fetched every six hours
// forever and stays unpriced, hidden, and mis-diagnosed as "refresh-prices".
// See planPublishingReport for why `priceSource IS NOT NULL` is the evidence.
//
// A "visible listing" is a VendorKit that would actually render on a set page:
// its kit is BASE, its productUrl isn't a manufacturer catalog page (unless
// the vendor is gmk-direct, the one real shop on gmk.net), and either it has a
// price (priced row, on any set status) OR its parent GB is ACTIVE and it
// carries a store link (unpriced link — RELEASED sets suppress those; see
// showUnpriced in SetDetailClient). The count is computed in SQL; the plan
// itself is pure so the shape rules (a blank / shortener / marketplace row
// belongs to planVendorUrlHeal, not to this report) live with the rest of
// them in vendor-urls.mjs.
//
// Manufacturer / catalog markers ("gmk", "dcs-wiki") and blocked vendors are
// excluded — they PUBLISH nothing by design, and reporting them would just
// dilute the actionable list.
// RELEASED_STATUSES is the set the site's set page hides unpriced rows on (see
// RELEASED_STATUSES in SetDetailClient.tsx). Named inline in the SQL below so
// there's exactly one list to read; that copy is the authoritative one for
// this pass.
const _NON_PUBLISHING_SLUGS = new Set([
  // MANUFACTURER_VENDOR_SLUGS in src/lib/import/manufacturer-vendors.ts — kept
  // in agreement by manufacturer-vendors.test.ts and vendor-urls.test.mjs.
  "gmk",
  "dcs-wiki",
  // A designer's portfolio, registered alongside them: sxmdesigns.com carries
  // set pages and sells nothing, so "publishes no listing" is its correct and
  // permanent state, not a fault to report every deploy.
  "sxm-designs",
  // purgeBlockedVendors is about to remove these; naming them here is noise.
  "fancycustoms",
  "fancy-customs",
]);

async function reportVendorsPublishingNothing(client) {
  let rows;
  try {
    // Per-vendor count of the VendorKits that WOULD render on a set page,
    // computed with the same shape the site's PURCHASABLE_VENDOR_KIT_WHERE and
    // VendorTable's showUnpriced use. A LATERAL subquery keeps the vendor row
    // singular even when it has hundreds of kits and lets Postgres short-
    // circuit as soon as one visible kit is found — cheap on ~125 vendors.
    ({ rows } = await client.query(
      `SELECT v.id, v.slug, v."websiteUrl",
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
                       gb.status::text NOT IN (
                         'SHIPPING','DELIVERED','IN_STOCK','CANCELLED'
                       )
                       AND (
                         btrim(coalesce(vk."gbUrl", '')) <> ''
                         OR btrim(coalesce(vk."productUrl", '')) <> ''
                       )
                     )
                   )
              ) AS visible_listings,
              -- The three counts that tell the four causes apart (see
              -- planPublishingReport): how many rows the store has at all, how
              -- many the price pass has ever READ, and how many carry a price.
              -- Deliberately unfiltered by kit type or URL, so "has rows but
              -- none visible" stays distinct from "has no rows".
              (SELECT count(*)::int FROM public."VendorKit" vk
                WHERE vk."vendorId" = v.id) AS listings,
              -- priceSource is written ('SCRAPED') whenever the pass READ the
              -- page — including when the answer was "no base kit", price NULL.
              -- Still NULL after an attempt means the URL was never parsed at
              -- all: a dead link, which refresh-prices can never resolve.
              (SELECT count(*)::int FROM public."VendorKit" vk
                WHERE vk."vendorId" = v.id AND vk."priceSource" IS NOT NULL)
                AS read_listings,
              (SELECT count(*)::int FROM public."VendorKit" vk
                WHERE vk."vendorId" = v.id AND vk.price IS NOT NULL) AS priced_listings,
              -- Two sub-cases of read_listings whose repair is a code change
              -- here rather than another scrape: REFUSED is a price this site
              -- turned away (KIT_BOUNDS / the Currency table), UNPARSED a 200
              -- carrying no product markup any parser path knows.
              (SELECT count(*)::int FROM public."VendorKit" vk
                WHERE vk."vendorId" = v.id AND vk."priceSource" = 'REFUSED')
                AS refused_listings,
              (SELECT count(*)::int FROM public."VendorKit" vk
                WHERE vk."vendorId" = v.id AND vk."priceSource" = 'UNPARSED')
                AS unparsed_listings,
              -- The store answered 404/410 for these. Counted separately from
              -- read_listings because a 404 IS a read to priceSource, which is
              -- how a closed store read as a pricing backlog for months.
              (SELECT count(*)::int FROM public."VendorKit" vk
                WHERE vk."vendorId" = v.id AND vk."deadSince" IS NOT NULL)
                AS dead_listings,
              (SELECT min(vk."deadSince") FROM public."VendorKit" vk
                WHERE vk."vendorId" = v.id) AS deadest_since
         FROM public."Vendor" v
        ORDER BY v.slug`
    ));
  } catch (err) {
    console.warn(`[db-setup] silent-vendor report skipped: ${err.message}`);
    return;
  }

  const silent = planPublishingReport(
    rows.map((r) => ({
      slug: r.slug,
      websiteUrl: r.websiteUrl,
      visibleListings: r.visible_listings,
      listings: r.listings,
      readListings: r.read_listings,
      refusedListings: r.refused_listings,
      unparsedListings: r.unparsed_listings,
      pricedListings: r.priced_listings,
      deadListings: r.dead_listings,
      deadestSince: r.deadest_since,
    })),
    _NON_PUBLISHING_SLUGS
  );
  if (silent.length === 0) return;

  console.warn(
    `[db-setup] ${silent.length} vendor(s) have a storefront but publish no ` +
      `listing on any set page. Each is named with the pass to look at — ` +
      `"no listing linked" is discovery, "never read one" is a dead link set ` +
      `(relink or retire — refresh-prices cannot help), "price REFUSED" and ` +
      `"no product markup" are code here (KIT_BOUNDS / the Currency table / ` +
      `the parser), "none priced" is ` +
      `refresh-prices, "none visible" is a non-BASE/catalog row. Removing the ` +
      `Vendor row is the right answer only when the store no longer sells ` +
      `tracked sets. \`npm run audit:publishing\` (or the Vendor publishing ` +
      `audit workflow) prints this on demand, outside a build log.`
  );
  for (const v of silent) {
    console.warn(`[db-setup]   ${v.slug} (${v.websiteUrl}) — ${v.reason}`);
  }
}

// Sets labelled "Canceled"/"Cancelled" (in the name, straight from
// KeycapLendar) or carrying the CANCELLED status never went to production —
// there is nothing to price or buy, so they're removed from the site
// entirely. Runs every deploy so a re-import can't resurrect them.
async function purgeCancelledSets(client) {
  try {
    const sets = await client.query(
      `SELECT id FROM public."GroupBuy"
        WHERE name ~* '\\mcancell?ed\\M'
           OR slug LIKE '%cancel%'
           OR status = 'CANCELLED'`
    );
    if (sets.rowCount === 0) return;
    const ids = sets.rows.map((r) => r.id);
    await client.query(
      `DELETE FROM public."VendorKit"
        WHERE "kitId" IN (SELECT id FROM public."Kit" WHERE "groupBuyId" = ANY($1))`,
      [ids]
    );
    await client.query(`DELETE FROM public."Kit" WHERE "groupBuyId" = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public."GroupBuy" WHERE id = ANY($1)`, [ids]);
    console.log(`[db-setup] Purged ${ids.length} cancelled set(s).`);
  } catch (err) {
    console.warn(`[db-setup] cancelled-set purge skipped: ${err.message}`);
  }
}

// Per-(vendor, set) listings removed at the owner's request (mirrors
// BLOCKED_VENDOR_SET_PAIRS in src/lib/import/vendor-overrides.ts). The vendor
// is legitimate for other sets, so only the named set's VendorKit row is
// dropped — the vendor, its other listings, and shipping zones stay. Runs every
// deploy so discovery or a re-submitted suggestion can't resurrect the pair.
const BLOCKED_VENDOR_SET_PAIRS = [
  { vendor: "keygem", set: "gmk-rainy-day-r2" },
  { vendor: "latamkeys", set: "gmk-mictlan-rebirth" },
  { vendor: "latamkeys", set: "gmk-nervewrecker" },
  { vendor: "zfrontier", set: "gmk-camping-r3" },
  // SwiftCables cable listing mis-linked to the keycap set (reported 3×) —
  // see BLOCKED_VENDOR_SET_PAIRS in src/lib/import/vendor-overrides.ts.
  { vendor: "swiftcables", set: "gmk-evil-dolch-r2" },
];
async function purgeBlockedVendorSetPairs(client) {
  try {
    let total = 0;
    for (const { vendor, set } of BLOCKED_VENDOR_SET_PAIRS) {
      const res = await client.query(
        `DELETE FROM public."VendorKit" vk
          USING public."Kit" k, public."GroupBuy" gb, public."Vendor" v
         WHERE vk."kitId" = k.id AND k."groupBuyId" = gb.id AND vk."vendorId" = v.id
           AND v.slug = $1 AND gb.slug = $2`,
        [vendor, set]
      );
      total += res.rowCount;
    }
    if (total > 0) {
      console.log(`[db-setup] Purged ${total} blocked vendor-set listing(s).`);
    }
  } catch (err) {
    console.warn(`[db-setup] blocked vendor-set purge skipped: ${err.message}`);
  }
}

// Some keycap sets get scraped into the KEYBOARD section by mistake (a vendor's
// "group buy" collection includes a metal-keycap drop, a Geekhack keycap GB is
// classified as a board, etc.) — so they pollute /released?type=keyboards.
// Move clearly-keycap rows back to KEYCAPS. High precision: requires a
// definitive keycap word (GMK / keycaps / keyset / spacebars / novelties) AND
// the absence of a definitive keyboard word, so real boards are never flipped.
// Runs every deploy and is idempotent (a flipped row no longer matches).
// KeycapLendar storeLinks can be empty strings, and until the import guard
// landed they were written to VendorKit.productUrl/gbUrl verbatim — "" passes
// an IS NOT NULL filter, so the price scraper tried to navigate to "" (one
// nightly run failed 87/87 on this). Normalize blanks to NULL so the queues
// and UI treat them as the missing links they are. Idempotent.
// The image pass briefly scraped gmk.net's SHARED Warehouse Finds sale page
// for sets linked by the gmk-direct vendor, filling their galleries with other
// sets' photos (gmk-lazurite showed Blossom/Moonlight/Arctic images). The
// warehouse hero image is a reliable marker for contamination: wipe those
// galleries and clear the stamp so the (now manufacturer-only) image pass
// rebuilds them from the set's own product page. Idempotent.
async function healWarehouseGalleries(client) {
  try {
    const res = await client.query(
      `UPDATE public."GroupBuy"
          SET images = '{}', "imagesUpdatedAt" = NULL
        WHERE EXISTS (SELECT 1 FROM unnest(images) AS img
                       WHERE img ILIKE '%warehouse-find%')`
    );
    if (res.rowCount > 0) {
      console.log(`[db-setup] Reset ${res.rowCount} warehouse-contaminated gallery(ies).`);
    }
  } catch (err) {
    console.warn(`[db-setup] warehouse-gallery heal skipped: ${err.message}`);
  }
}

// Per-build public visibility: build indexes hidden from the shared page.
async function ensureHiddenBuildsColumn(client) {
  try {
    await client.query(
      `ALTER TABLE public."TrackerItem"
       ADD COLUMN IF NOT EXISTS "hiddenBuilds" jsonb`
    );
  } catch (err) {
    console.warn(`[db-setup] hiddenBuilds column setup skipped: ${err.message}`);
  }
}

// Keycap-set purchases are stored as a compact JSON ledger on the same tracker
// record as the set. Keep this self-healing because Vercel's build path uses
// this script even when Prisma migrations have not been applied separately.
async function ensureKeycapAcquisitionsColumn(client) {
  try {
    await client.query(
      `ALTER TABLE public."TrackerItem"
       ADD COLUMN IF NOT EXISTS "keycapAcquisitions" jsonb`
    );
  } catch (err) {
    console.warn(`[db-setup] keycapAcquisitions column setup skipped: ${err.message}`);
  }
}

// Sale record for build 1 / a legacy keycap purchase, plus the piece-level
// switch that decides whether the public page reveals sold state at all.
// Builds 2..N and per-purchase keycap records keep theirs inside the existing
// `units` / `keycapAcquisitions` jsonb, so they need no column.
// Plate and mount, recorded per build. Both used to live inside the free-text
// `buildDetails` blob — its own placeholder read "Plate, mounting
// configuration, stabilizers, foam, artisan details…" — so the two specs an
// owner is most often asked about could be written down but never read back.
//
// Nullable text, not an enum: half-plates, stacked and hybrid mounts and
// one-off materials are ordinary here, and a closed list would refuse them.
// Builds 2..N carry theirs inside the `units` JSON, which needs no migration.
async function ensureBuildSpecColumns(client) {
  try {
    await client.query(
      `ALTER TABLE public."TrackerItem"
       ADD COLUMN IF NOT EXISTS "plateType" text,
       ADD COLUMN IF NOT EXISTS "mountType" text`
    );
  } catch (err) {
    console.warn(`[db-setup] build spec columns setup skipped: ${err.message}`);
  }
}

async function ensureSoldColumns(client) {
  try {
    await client.query(
      `ALTER TABLE public."TrackerItem"
       ADD COLUMN IF NOT EXISTS "isSold" boolean NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS "soldAt" timestamp(3) without time zone,
       ADD COLUMN IF NOT EXISTS "soldPrice" double precision,
       ADD COLUMN IF NOT EXISTS "soldCurrency" text,
       ADD COLUMN IF NOT EXISTS "showSoldStatus" boolean NOT NULL DEFAULT false`
    );
  } catch (err) {
    console.warn(`[db-setup] sold columns setup skipped: ${err.message}`);
  }
}

async function healBlankVendorUrls(client) {
  try {
    const res = await client.query(
      `UPDATE public."VendorKit"
          SET "productUrl" = NULLIF(btrim(coalesce("productUrl", '')), ''),
              "gbUrl" = NULLIF(btrim(coalesce("gbUrl", '')), '')
        WHERE btrim(coalesce("productUrl", '')) = '' AND "productUrl" IS NOT NULL
           OR btrim(coalesce("gbUrl", '')) = '' AND "gbUrl" IS NOT NULL`
    );
    if (res.rowCount > 0) {
      console.log(`[db-setup] Normalized ${res.rowCount} blank vendor URL(s) to NULL.`);
    }
  } catch (err) {
    console.warn(`[db-setup] blank-URL heal skipped: ${err.message}`);
  }
}

async function reclassifyKeycapKeyboards(client) {
  try {
    const res = await client.query(
      `UPDATE public."GroupBuy"
          SET "productType" = 'KEYCAPS', "updatedAt" = now()
        WHERE "productType" = 'KEYBOARD'
          AND (
                slug LIKE 'gmk-%'
             OR name ~* '\\mGMK\\M'
             OR name ~* '\\mkeycaps?\\M'
             OR name ~* '\\mkeysets?\\M'
             OR name ~* '\\mspacebars?\\M'
             OR name ~* '\\mnovelties\\M'
          )
          AND name !~* '\\m(keyboard|pcb|barebones|hotswap|gasket|switches?)\\M'`
    );
    if (res.rowCount > 0) {
      console.log(`[db-setup] Reclassified ${res.rowCount} keycap set(s) out of the keyboard section.`);
    }
  } catch (err) {
    console.warn(`[db-setup] keycap reclassification skipped: ${err.message}`);
  }
}

// Date-based status transitions so the timeline/cards never show a closed GB as
// "Active GB / Ending soon": an ACTIVE_GB past its gbEnd moves to SHIPPING, and
// an interest check whose start date has arrived becomes ACTIVE_GB. The daily
// cron does the same; running it here too fixes it immediately on deploy.
async function expireEndedGroupBuys(client) {
  try {
    const ended = await client.query(
      `UPDATE public."GroupBuy" SET status = 'SHIPPING', "updatedAt" = now()
        WHERE status = 'ACTIVE_GB' AND "gbEnd" IS NOT NULL AND "gbEnd" < now()`
    );
    if (ended.rowCount > 0) {
      console.log(`[db-setup] Expired ${ended.rowCount} ended group buy(s) (ACTIVE_GB → SHIPPING).`);
    }
    const startedNow = await client.query(
      `UPDATE public."GroupBuy" SET status = 'ACTIVE_GB', "updatedAt" = now()
        WHERE status = 'INTEREST_CHECK' AND "gbStart" IS NOT NULL AND "gbStart" <= now()
          AND ("gbEnd" IS NULL OR "gbEnd" >= now())`
    );
    if (startedNow.rowCount > 0) {
      console.log(`[db-setup] Promoted ${startedNow.rowCount} started interest check(s) (→ ACTIVE_GB).`);
    }
    // A set whose GB window is currently OPEN (gbStart ≤ now ≤ gbEnd) but which a
    // coarser source left as SHIPPING should read as an ACTIVE_GB. gmk.net's
    // catalog scraper infers "in production / shipping" for live GMK sets, and it
    // overwrites status nightly — so date-derived status must win here, or the
    // KeycapLendar date-reconcile's promotion gets clobbered every night. Only
    // reopens rows with a concrete window; DELIVERED/CANCELLED are terminal.
    const reopened = await client.query(
      `UPDATE public."GroupBuy" SET status = 'ACTIVE_GB', "updatedAt" = now()
        WHERE status = 'SHIPPING' AND "gbStart" IS NOT NULL AND "gbStart" <= now()
          AND "gbEnd" IS NOT NULL AND "gbEnd" >= now()`
    );
    if (reopened.rowCount > 0) {
      console.log(`[db-setup] Reopened ${reopened.rowCount} in-window group buy(s) (SHIPPING → ACTIVE_GB).`);
    }
  } catch (err) {
    console.warn(`[db-setup] status sweep skipped: ${err.message}`);
  }
}

// Correct known-mislabelled vendors and (re)seed DHL-estimate shipping zones.
// Runs every deploy. The cost CASE is recalibrated to discounted small-parcel
// DHL rates (a GMK base kit is compact/light, ~1kg) — anchored to a real
// proto[Typist] checkout where UK→SG was GBP 19.76 (~USD 25). The upsert uses
// DO UPDATE so EXISTING zones get recalibrated, not just newly-inserted ones.
async function backfillShipping(client) {
  // 1a. Fix Singapore vendors KeycapLendar mislabels (e.g. Ktech shown as US).
  const fixSG = await client.query(
    `UPDATE public."Vendor"
     SET region = 'SG', country = 'SG', currency = 'SGD'
     WHERE slug IN ('ilumkb','ktechs','ktech','ashkeebs','monokei',
                    'zion-studios','zionstudios','zion-studios-sg',
                    'pantheonkeys','pantheon-keys')
       AND region <> 'SG'
     RETURNING id`
  );
  // 1b. Fix other commonly-mislabelled vendors (wrong origin inflates shipping,
  // wrong currency corrupts every scraped price — e.g. Aiglatson Studio is a
  // Thai store (฿/THB) that KeycapLendar lists as US/USD).
  const fixIntl = await client.query(
    `UPDATE public."Vendor" AS v SET
       region   = c.region::public."Region",
       country  = c.country,
       currency = c.currency
     FROM (VALUES
       ('prototypist',         'UK',   'GB', 'GBP'),
       ('gmk',                 'EU',   'DE', 'EUR'),
       ('oblotzky',            'EU',   'DE', 'EUR'),
       ('oblotzky-industries', 'EU',   'DE', 'EUR'),
       ('geonworks',           'ASIA', 'KR', 'USD'),
       ('kbdfans',             'ASIA', 'CN', 'USD'),
       ('zfrontier',           'ASIA', 'CN', 'USD'),
       ('aiglatson-studio',    'ASIA', 'TH', 'THB'),
       ('aiglatson',           'ASIA', 'TH', 'THB'),
       ('stacks',              'ASIA', 'IN', 'INR'),
       ('neo-macro',           'ASIA', 'IN', 'INR'),
       ('neomacro',            'ASIA', 'IN', 'INR'),
       ('latamkeys',           'OTHER','AR', 'ARS'),
       ('yushakobo',           'ASIA', 'JP', 'JPY'),
       ('mecha',               'ASIA', 'MY', 'MYR'),
       ('mecha-my',            'ASIA', 'MY', 'MYR')
     ) AS c(slug, region, country, currency)
     WHERE v.slug = c.slug AND (v.region::text <> c.region OR v.currency <> c.currency)
     RETURNING v.id`
  );
  const correctedIds = [...fixSG.rows, ...fixIntl.rows].map((r) => r.id);
  if (correctedIds.length > 0) {
    console.log(`[db-setup] Corrected ${correctedIds.length} vendor region(s).`);
    // Their scraped prices were stored under the wrong currency — wipe them so
    // the nightly refresh re-scrapes with the corrected store currency.
    const requeue = await client.query(
      `UPDATE public."VendorKit"
       SET price = NULL, "compareAtPrice" = NULL, "priceUpdatedAt" = NULL
       WHERE "priceSource" = 'SCRAPED' AND "vendorId" = ANY($1)`,
      [correctedIds]
    );
    if (requeue.rowCount > 0) {
      console.log(`[db-setup] Re-queued ${requeue.rowCount} prices from corrected vendors.`);
    }
  }

  // 2. Upsert vendor × destination shipping zones with recalibrated DHL rates.
  const seed = await client.query(
    `INSERT INTO public."ShippingZone"
       (id, "vendorId", "destinationRegion", "baseShippingCost", currency,
        "estimatedDaysMin", "estimatedDaysMax", "shipsToRegion")
     SELECT
       gen_random_uuid()::text,
       v.id,
       d.region::public."Region",
       CASE
         WHEN d.region = 'SG' THEN
           CASE v.region::text
             WHEN 'SG' THEN 5 WHEN 'ASIA' THEN 12 WHEN 'AU' THEN 18
             WHEN 'EU' THEN 24 WHEN 'UK' THEN 24 WHEN 'US' THEN 26
             WHEN 'CA' THEN 28 ELSE 28 END
         WHEN d.region = 'ASIA' THEN
           CASE v.region::text
             WHEN 'ASIA' THEN 8 WHEN 'SG' THEN 12 WHEN 'AU' THEN 20
             WHEN 'EU' THEN 24 WHEN 'UK' THEN 24 WHEN 'US' THEN 26
             WHEN 'CA' THEN 28 ELSE 28 END
         WHEN d.region = v.region::text THEN 8
         WHEN d.region IN ('US','CA') AND v.region::text IN ('US','CA') THEN 12
         WHEN d.region IN ('EU','UK') AND v.region::text IN ('EU','UK') THEN 10
         WHEN (d.region IN ('US','CA') AND v.region::text IN ('EU','UK'))
           OR (d.region IN ('EU','UK') AND v.region::text IN ('US','CA')) THEN 18
         ELSE 26
       END,
       'USD',
       CASE WHEN d.region = v.region::text THEN 1 ELSE 2 END,
       CASE WHEN d.region = v.region::text THEN 3 ELSE 5 END,
       true
     FROM public."Vendor" v
     CROSS JOIN (VALUES ('US'),('CA'),('EU'),('UK'),('AU'),('SG'),('ASIA'),('OTHER')) AS d(region)
     ON CONFLICT ("vendorId","destinationRegion") DO UPDATE SET
       "baseShippingCost" = EXCLUDED."baseShippingCost",
       "estimatedDaysMin" = EXCLUDED."estimatedDaysMin",
       "estimatedDaysMax" = EXCLUDED."estimatedDaysMax",
       "shipsToRegion"    = EXCLUDED."shipsToRegion"`
  );
  if (seed.rowCount > 0) {
    console.log(`[db-setup] Seeded/updated ${seed.rowCount} DHL shipping zones.`);
  }
}

async function main() {
  let connectionString;
  try {
    connectionString = resolveDatabaseUrl();
  } catch (err) {
    console.warn(`[db-setup] Skipped: ${err.message}`);
    return;
  }

  // Supabase requires SSL. Skip it for local Postgres (no SSL support).
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  const ssl = isLocal ? undefined : { rejectUnauthorized: false };

  // Log the host (never the password) so the build log is diagnostic.
  try {
    const host = new URL(connectionString).host;
    console.log(`[db-setup] Connecting to ${host} (ssl: ${ssl ? "on" : "off"}) …`);
  } catch {
    /* ignore */
  }

  const client = new pg.Client({ connectionString, ssl, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
  } catch (err) {
    console.warn(`[db-setup] Could not connect to the database: ${err.message}`);
    console.warn("[db-setup] The app will deploy but show no data until the connection is fixed.");
    return;
  }

  try {
    // Is the data already loaded? Check the table exists first, then count,
    // so a missing table doesn't raise a noisy error.
    let alreadyPopulated = false;
    const exists = await client.query(
      `SELECT to_regclass('public."GroupBuy"') IS NOT NULL AS present`
    );
    if (exists.rows[0].present) {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM public."GroupBuy"');
      alreadyPopulated = rows[0].n > 0;

      // Auto-repair: older data stored image URLs under the deleted `keysets/`
      // path. The live image lives under `thumbs/`. Fix any stragglers each
      // deploy (idempotent — only touches rows that still have the old path).
      const fix = await client.query(
        `UPDATE public."GroupBuy"
         SET "imageUrl" = replace("imageUrl", 'keysets%2F', 'thumbs%2F')
         WHERE "imageUrl" LIKE '%keysets%2F%'`
      );
      if (fix.rowCount > 0) {
        console.log(`[db-setup] Repaired ${fix.rowCount} image URLs (keysets/ -> thumbs/).`);
      }

      if (alreadyPopulated) {
        await ensureImagesColumn(client);
        await ensureVendorSuggestionTable(client);
        await ensureFeedbackTable(client);
        await ensurePriceReportTable(client);
        await ensureListingReportTable(client);
        await ensurePersonalTrackerTables(client);
        await ensureCollectionPhotoReportTable(client);
        await ensureCompareAtPriceColumn(client);
    await purgeBlockedVendors(client);
        await purgeCancelledSets(client);
        await purgeBlockedVendorSetPairs(client);
        await reclassifyKeycapKeyboards(client);
        await healBlankVendorUrls(client);
        await ensureHiddenBuildsColumn(client);
        await ensureKeycapAcquisitionsColumn(client);
        await ensureSoldColumns(client);
        await ensureBuildSpecColumns(client);
        await healWarehouseGalleries(client);
        await expireEndedGroupBuys(client);
        await ensureDiscoveryColumn(client);
        // Ahead of reportVendorsPublishingNothing, which counts dead listings,
        // and of the nightly price pass, which writes them.
        await ensureLinkHealthColumns(client);
        await ensureDataTrustLayer(client);
        await ensureCurrencies(client);
        await resetPollutedGalleries(client);
        // Before backfillShipping: a store inserted here needs that pass to give
        // it shipping zones in the SAME deploy, or the price table hides every
        // listing it publishes until the next nightly self-heal.
        await ensureVendorRoster(client);
        // Before healMisparkedVendorUrls: a shop with two rows collides with
        // itself, and ownership would report the pair as contested forever.
        await mergeDuplicateVendorRows(client);
        await healMisparkedVendorUrls(client);
        await healOffsiteVendorUrls(client);
        await healVendorUrlsFromListings(client);
        // The residue every heal above misses: a healthy storefront that still
        // publishes nothing on any set page. Report-only — no automatic pass
        // can undo a stale catalog or a store that stopped selling GMK/DCS.
        await reportVendorsPublishingNothing(client);
        await backfillShipping(client);
        await cleanupInterestChecks(client);
        await ensureVariantsColumn(client);
        await ensureKeyboardColumns(client);
        await ensureCollectorCatalogEntries(client);
        await ensureKeyboardContributionTable(client);
        await purgeImplausibleScrapedPrices(client);
        await restorePurgedPricesFromVariants(client);
        await requeuePurgedClearancePrices(client);
        await requeueCurrencyMismatches(client);
        await requeueLegacyScrapedPrices(client);
        await requeuePinnedVariantPrices(client);
        await requeueGeoCurrencyPrices(client);
        await requeueGeoCurrencyPricesV2(client);
        await auditCleanupV3(client);
        await ensureCompareAtPriceColumn(client);
        await purgeMispricedListings(client);
        await prioritizePreorderVendors(client);
        await reclassifyMisflaggedKeycaps(client);
        await reclassifyGeekhackStatuses(client);
        await mergeDuplicateKeycapSets(client);
        await ensureBaseKitForKeycapSets(client);
      }
    }

    if (alreadyPopulated) {
      console.log("[db-setup] Database already populated — skipping setup.");
      return;
    }

    console.log("[db-setup] Empty database detected. Running supabase-setup.sql …");
    const sql = readFileSync(SQL_PATH, "utf8");
    await client.query(sql);

    const { rows } = await client.query('SELECT count(*)::int AS n FROM public."GroupBuy"');
    console.log(`[db-setup] Done. Loaded ${rows[0].n} group buys.`);

    await ensureImagesColumn(client);
    await repairKnownBrokenImages(client);
    await ensureVariantsColumn(client);
    await ensureKeyboardColumns(client);
    await ensureCollectorCatalogEntries(client);
    await ensureKeyboardContributionTable(client);
    await ensureVendorSuggestionTable(client);
    await ensureFeedbackTable(client);
    await ensurePriceReportTable(client);
    await ensureListingReportTable(client);
    await ensurePersonalTrackerTables(client);
    await ensureCollectionPhotoReportTable(client);
    await ensureKeycapAcquisitionsColumn(client);
    await ensureSoldColumns(client);
    await ensureBuildSpecColumns(client);
    await purgeBlockedVendors(client);
    await purgeCancelledSets(client);
    await purgeBlockedVendorSetPairs(client);
    await ensureDiscoveryColumn(client);
    await ensureLinkHealthColumns(client);
    await ensureDataTrustLayer(client);
    await ensureCurrencies(client);
    await resetPollutedGalleries(client);
    await ensureVendorRoster(client);
    await mergeDuplicateVendorRows(client);
    await healMisparkedVendorUrls(client);
    await healOffsiteVendorUrls(client);
    await healVendorUrlsFromListings(client);
    await backfillShipping(client);
    await cleanupInterestChecks(client);
    await reclassifyMisflaggedKeycaps(client);
    await reclassifyGeekhackStatuses(client);
    await mergeDuplicateKeycapSets(client);
    await ensureBaseKitForKeycapSets(client);
  } catch (err) {
    console.warn(`[db-setup] Setup failed: ${err.message}`);
    console.warn("[db-setup] The app will still deploy; you can re-run by redeploying once the DB is reachable.");
  } finally {
    await client.end().catch(() => {});
  }
}

// Pre-discount price for the same variant `price` came from, so the site can
// show "was X, now Y". Nullable and only written when a real markdown exists.
async function ensureCompareAtPriceColumn(client) {
  try {
    await client.query(
      `ALTER TABLE public."VendorKit"
       ADD COLUMN IF NOT EXISTS "compareAtPrice" double precision`
    );
  } catch (err) {
    console.warn(`[db-setup] compareAtPrice column ensure skipped: ${err.message}`);
  }
}

// Ensure the GroupBuy.images array column exists (added after first deploys),
// then backfill it from imageUrl so the carousel always has at least one image.
async function ensureImagesColumn(client) {
  try {
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS images text[] DEFAULT ARRAY[]::text[] NOT NULL`
    );
    // Gallery-rotation timestamp: the scraper revisits oldest-checked galleries
    // first, so polluted ones self-heal and fresh ones aren't hammered nightly.
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "imagesUpdatedAt" timestamp(3) without time zone`
    );
    const { rowCount } = await client.query(
      `UPDATE public."GroupBuy"
       SET images = ARRAY["imageUrl"]
       WHERE (images IS NULL OR cardinality(images) = 0) AND "imageUrl" IS NOT NULL`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Backfilled images[] for ${rowCount} sets.`);
    }

    // Older imports can contain a complete gallery but no hero image. Catalog
    // cards historically read imageUrl only, so keep both fields synchronized.
    const heroBackfill = await client.query(
      `UPDATE public."GroupBuy"
       SET "imageUrl" = images[1]
       WHERE ("imageUrl" IS NULL OR btrim("imageUrl") = '')
         AND cardinality(images) > 0
         AND images[1] IS NOT NULL`
    );
    if (heroBackfill.rowCount > 0) {
      console.log(`[db-setup] Backfilled hero images for ${heroBackfill.rowCount} sets.`);
    }
  } catch (err) {
    console.warn(`[db-setup] images column setup skipped: ${err.message}`);
  }
}

// RECURRING (every deploy): these source galleries were removed or now reject
// hotlinks. Replace them with verified manufacturer/vendor CDN images so the
// same dead URLs cannot be restored as the hero by a later import.
async function repairKnownBrokenImages(client) {
  const overrides = [
    [
      "gh-117742",
      "https://keebsforall.com/cdn/shop/products/IMG-20220222-WA0010_306026171769143_b2453097-427a-45e8-8dec-c761a74f9b5d.jpg?v=1703031359&width=1533",
    ],
    [
      "gmk-hangulbeit",
      "https://www.gmk.net/shop/media/40/f9/26/1765191031/GMK_CYL_Hangulbeit_Keycaps%20%283%29.webp?ts=1765191049",
    ],
    [
      "gmk-unobtainium-blue",
      "https://novelkeys.com/cdn/shop/files/GMK_CYL_Unobtainium_TILE_1200x.jpg?v=1778615730",
    ],
    [
      "gmk-mtnu-divinapapaya",
      "https://www.gmk.net/shop/media/eb/4c/2c/1765538863/GMK_CYL-MTNU_Divinapapaya_Keycaps%20%282%29.webp?ts=1765539130",
    ],
  ];

  try {
    let repaired = 0;
    for (const [slug, imageUrl] of overrides) {
      const result = await client.query(
        `UPDATE public."GroupBuy"
         SET "imageUrl" = $2,
             images = ARRAY[$2]::text[],
             "imagesUpdatedAt" = now(),
             "updatedAt" = now()
         WHERE slug = $1
           AND (
             "imageUrl" IS DISTINCT FROM $2
             OR images IS DISTINCT FROM ARRAY[$2]::text[]
           )`,
        [slug, imageUrl]
      );
      repaired += result.rowCount;
    }
    if (repaired > 0) {
      console.log(`[db-setup] Replaced ${repaired} broken image gallery source(s).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Known image repair skipped: ${err.message}`);
  }
}

// ONE-TIME cleanup (v2): the v1 reset cleared related-products pollution, but
// the WorkSpace Python scraper still lacked the main-gallery trim and merged
// the polluted gallery right back in on its next nightly run. Now that BOTH
// scrapers trim AND rebuild galleries (replacing gmk.net images instead of
// merging), reset multi-image galleries once more to the single trusted
// KeycapLendar render; the fixed scrapers repopulate them correctly.
//
// Guarded by a sentinel table so it runs EXACTLY ONCE — it must not wipe good
// galleries on every future deploy.
async function resetPollutedGalleries(client) {
  const KEY = "reset_polluted_galleries_v2";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return; // already applied

    const reset = await client.query(
      `UPDATE public."GroupBuy"
       SET images = ARRAY["imageUrl"], "imagesUpdatedAt" = NULL
       WHERE cardinality(images) > 1 AND "imageUrl" IS NOT NULL`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1)
       ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    if (reset.rowCount > 0) {
      console.log(`[db-setup] Reset ${reset.rowCount} polluted galleries to the single render (one-time).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Gallery cleanup skipped: ${err.message}`);
  }
}

// Ensure the VendorKit.variants jsonb column exists (added for the kit-category
// price filter — stores every scraped Shopify variant as [{ title, price }]).
async function ensureVariantsColumn(client) {
  try {
    await client.query(
      `ALTER TABLE public."VendorKit" ADD COLUMN IF NOT EXISTS variants jsonb`
    );
  } catch (err) {
    console.warn(`[db-setup] variants column setup skipped: ${err.message}`);
  }
}

// Link health for a vendor listing. Both price passes (run_prices in scrape.py,
// refreshPrices in prices.ts) write these; scrape.py creates them too, because
// the nightly run happens whether or not a deploy has reached the database
// since. See scripts/lib/link-health.mjs for what each one means and why it is
// two columns rather than one.
async function ensureLinkHealthColumns(client) {
  try {
    await client.query(
      `ALTER TABLE public."VendorKit"
       ADD COLUMN IF NOT EXISTS "linkFailures" integer NOT NULL DEFAULT 0`
    );
    await client.query(
      `ALTER TABLE public."VendorKit"
       ADD COLUMN IF NOT EXISTS "deadSince" timestamp(3) without time zone`
    );
    // The price queue's back-off filters on these, and the publishing report
    // counts them per vendor across ~5k rows on every deploy.
    await client.query(
      `CREATE INDEX IF NOT EXISTS "VendorKit_deadSince_idx"
         ON public."VendorKit" ("deadSince")`
    );
  } catch (err) {
    console.warn(`[db-setup] link-health column setup skipped: ${err.message}`);
  }
}

// Add productType + keyboard-specific spec columns to GroupBuy and create the
// DevUpdate table for keyboard development changelog entries. All idempotent.
async function ensureKeyboardColumns(client) {
  try {
    // productType distinguishes keycap sets from keyboard group buys.
    // Backfill all existing rows as 'KEYCAPS' (everything to date is keycaps).
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "productType" text NOT NULL DEFAULT 'KEYCAPS'`
    );
    // Keyboard-specific spec fields (NULL on keycap sets).
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS layout text`
    );
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS material text`
    );
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "mountingStyle" text`
    );
    // Keyboard pricing/vendor fields (single-vendor, so price lives on the row).
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "basePrice" double precision`
    );
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "priceCurrency" text`
    );
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "productUrl" text`
    );
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "vendorName" text`
    );
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "vendorRegion" text`
    );
    // Development changelog table for keyboard GBs.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public."DevUpdate" (
        id           text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "groupBuyId" text        NOT NULL REFERENCES public."GroupBuy"(id) ON DELETE CASCADE,
        title        text        NOT NULL,
        content      text        NOT NULL,
        milestone    text,
        "imageUrls"  text[]      NOT NULL DEFAULT ARRAY[]::text[],
        "postedAt"   timestamptz NOT NULL DEFAULT now(),
        "createdAt"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS "DevUpdate_groupBuyId_postedAt_idx"
       ON public."DevUpdate" ("groupBuyId", "postedAt")`
    );
  } catch (err) {
    console.warn(`[db-setup] keyboard columns setup skipped: ${err.message}`);
  }
}

// Curated collector catalog entries for meaningful keyboard editions that did
// not all have a Geekhack GB thread. Keeping these as separate GroupBuy rows
// lets a collector own multiple editions from the same family (for example,
// both a Jane v2 OG and a Jane v2 ME) without collapsing them into one record.
async function ensureCollectorCatalogEntries(client) {
  try {
    await client.query(`
      UPDATE public."GroupBuy"
      SET name = 'TGR Jane v2 OG',
          subtitle = 'Original 2018 Jane v2 group buy',
          designer = 'TGR',
          layout = 'TKL',
          material = 'Aluminum + stainless steel + brass',
          "mountingStyle" = 'Top Mount',
          "updatedAt" = now()
      WHERE slug = 'gh-97552'
    `);

    await client.query(`
      UPDATE public."GroupBuy"
      SET name = 'TGR Jane v2 CE',
          subtitle = 'Carbon Edition',
          designer = 'TGR',
          layout = 'F13 TKL',
          material = 'Aluminum + carbon fiber + stainless steel',
          "mountingStyle" = 'Top Mount',
          "updatedAt" = now()
      WHERE slug = 'gh-100415'
    `);

    await client.query(`
      INSERT INTO public."GroupBuy" (
        id, slug, name, subtitle, colorway, designer, status,
        "imageUrl", images, description, featured, "productType",
        layout, material, "mountingStyle", "productUrl",
        "vendorName", "vendorRegion", "createdAt", "updatedAt"
      )
      VALUES (
        'catalog-tgr-jane-v2-me',
        'tgr-jane-v2-me',
        'TGR Jane v2 ME',
        'MONOKEI Edition',
        '',
        'TGR × MONOKEI',
        'DELIVERED'::"GBStatus",
        'https://static1.squarespace.com/static/5f68da90297b94613c756dd6/62e80f8a45d6171b85fb81ae/633c80cb67446f0a2c5fe3ee/1735515639445/LXI05775+TKL.jpg?format=1500w',
        ARRAY['https://static1.squarespace.com/static/5f68da90297b94613c756dd6/62e80f8a45d6171b85fb81ae/633c80cb67446f0a2c5fe3ee/1735515639445/LXI05775+TKL.jpg?format=1500w']::text[],
        'The Jane v2 ME is the MONOKEI collaboration edition of the TGR Jane family. It introduced a magnetic aluminum backplate, USB-C, modern alignment features, and top-mount or O-ring build support.',
        false,
        'KEYBOARD',
        'F13 TKL',
        'Aluminum + stainless steel',
        'Top Mount / O-ring',
        'https://www.instagram.com/p/Ckr15ZVPMTB/',
        'MONOKEI',
        'SG',
        now(),
        now()
      )
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        subtitle = EXCLUDED.subtitle,
        designer = EXCLUDED.designer,
        status = EXCLUDED.status,
        "imageUrl" = EXCLUDED."imageUrl",
        images = EXCLUDED.images,
        description = EXCLUDED.description,
        "productType" = EXCLUDED."productType",
        layout = EXCLUDED.layout,
        material = EXCLUDED.material,
        "mountingStyle" = EXCLUDED."mountingStyle",
        "productUrl" = EXCLUDED."productUrl",
        "vendorName" = EXCLUDED."vendorName",
        "vendorRegion" = EXCLUDED."vendorRegion",
        "updatedAt" = now()
    `);
  } catch (err) {
    console.warn(`[db-setup] Collector catalog entries skipped: ${err.message}`);
  }
}

// ONE-TIME: scraped rows whose currency defaulted to USD while the vendor's
// own currency differs (e.g. Deskhero CAD prices stored as USD, inflating
// CA$88 to US$88). Clear priceUpdatedAt so the nightly refresh re-scrapes them
// first with the fixed fallback. Sentinel-guarded — a store may legitimately
// sell in USD from a non-USD country, so this must not loop every deploy.
async function requeueCurrencyMismatches(client) {
  const KEY = "requeue_usd_mismatch_v1";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const { rowCount } = await client.query(
      `UPDATE public."VendorKit" vk
       SET "priceUpdatedAt" = NULL
       FROM public."Vendor" v
       WHERE vk."vendorId" = v.id
         AND vk."priceSource" = 'SCRAPED'
         AND vk.currency = 'USD'
         AND v.currency <> 'USD'`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Re-queued ${rowCount} possibly mis-currencied prices for re-scrape (one-time).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Currency mismatch requeue skipped: ${err.message}`);
  }
}

// The old price scraper took the CHEAPEST Shopify variant, which on group-buy
// listings is often a cheap add-on (deskmat, sample, deposit) — producing
// absurd kit prices like $22. The scraper now picks the real BASE kit variant
// and bounds prices to a plausible per-currency window (mirrors KIT_BOUNDS in
// src/lib/import/prices.ts), so any stored SCRAPED price outside that window
// is garbage: null it out and clear priceUpdatedAt so the nightly refresh
// re-scrapes those rows first.
//
// CALIBRATION: there is no lower bound. It previously sat at USD 30 to admit
// clearance prices, but the dcs.wiki archive tracks accessory products as
// first-class sets (DCS Bae Addon, 6u bars, 9009 Fix Kit …) that genuinely
// cost a few dollars, and the floor purged those on every deploy. Only a
// 0/negative price — always a parse failure — is refused now.
//
// The window must never be tighter than what scrape.py / prices.ts will store:
// an earlier mismatch here is exactly what blanked released-set pricing. It
// used to be spelled out here as sixteen hand-written comparisons under a
// comment asking the reader to keep it in step with two other files; it is now
// GENERATED from scripts/lib/kit-bounds.mjs, the same table the price passes
// bound against, so "tighter than the producers" is no longer a thing anyone
// can write by accident. It also covers every currency in that table now — the
// hand-written list stopped at TWD and silently let CLP/INR/ARS/MYR through.
// Idempotent — MANUAL prices are never touched.
async function purgeImplausibleScrapedPrices(client) {
  try {
    const { rowCount } = await client.query(
      `UPDATE public."VendorKit"
       SET price = NULL, "compareAtPrice" = NULL, "priceUpdatedAt" = NULL
       WHERE "priceSource" = 'SCRAPED'
         AND price IS NOT NULL
         AND (
              ${kitBoundsPurgeSql()}
         )`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Purged ${rowCount} implausible scraped prices (re-scrape queued).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Price purge skipped: ${err.message}`);
  }
}

// Recover prices the old over-tight purge wiped. The purge nulled `price`
// but kept the scraped `variants` JSON, which still holds every variant's
// title and price — so the BASE-kit price can be restored offline, without
// waiting for the next scraper run. Mirrors the variant selection in
// scraper/scrape.py / src/lib/import/prices.ts: skip add-on variants, prefer
// a "base"-titled variant, else the first non-add-on. Only prices inside the
// new plausibility window are restored, and priceUpdatedAt stays NULL so the
// row remains first in the re-scrape queue for live verification.
// Idempotent: only touches price-NULL rows; restore window ⊆ purge window,
// so a restored price is never re-purged. Floors are 0 to match the purge —
// accessory sets legitimately cost a few dollars and must be restorable too.
const ADDON_VARIANT_RE =
  /(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain|coin|tray|deposit|shipping|insurance|add[\s-]?on|extra)/i;
// The restore window IS the purge window — same table, so "restore ⊆ purge" is
// true by construction rather than by two lists happening to agree. A second
// hand-written copy is how the pair drifts.
const RESTORE_BOUNDS = KIT_BOUNDS;

async function restorePurgedPricesFromVariants(client) {
  try {
    const { rows } = await client.query(
      `SELECT vk.id, vk.currency, vk.variants, v.currency AS vendor_currency
       FROM public."VendorKit" vk
       JOIN public."Vendor" v ON v.id = vk."vendorId"
       WHERE vk.price IS NULL
         AND vk."priceSource" = 'SCRAPED'
         AND vk.variants IS NOT NULL
         -- GMK is the manufacturer, not a vendor: never restore a price onto
         -- its rows (purgeMispricedListings wipes them every deploy).
         AND v.slug <> 'gmk'
         AND COALESCE(vk."productUrl", '') NOT ILIKE '%gmk.net%'`
    );
    let restored = 0;
    for (const row of rows) {
      let variants = row.variants;
      if (typeof variants === "string") {
        try { variants = JSON.parse(variants); } catch { continue; }
      }
      if (!Array.isArray(variants) || variants.length === 0) continue;
      const usable = variants.filter(
        (v) => v && typeof v.price === "number" && typeof v.title === "string"
      );
      const nonAddon = usable.filter((v) => !ADDON_VARIANT_RE.test(v.title));
      const pool = nonAddon.length > 0 ? nonAddon : usable;
      const chosen = pool.find((v) => /base/i.test(v.title)) ?? pool[0];
      if (!chosen) continue;
      const cur = row.currency ?? row.vendor_currency ?? "USD";
      const bounds = RESTORE_BOUNDS[cur];
      if (bounds && (chosen.price < bounds.min || chosen.price > bounds.max)) continue;
      await client.query(
        `UPDATE public."VendorKit" SET price = $1 WHERE id = $2 AND price IS NULL`,
        [chosen.price, row.id]
      );
      restored++;
    }
    if (restored > 0) {
      console.log(`[db-setup] Restored ${restored} purged prices from stored variants.`);
    }
  } catch (err) {
    console.warn(`[db-setup] Variant price restore skipped: ${err.message}`);
  }
}

// ONE-TIME: rows whose price the old over-tight purge wiped (clearance prices
// below the old USD-70-equivalent floor) sit at price NULL with
// priceUpdatedAt NULL — already first in the scrape queue. Bump them again
// explicitly in case a later failed scrape attempt stamped priceUpdatedAt,
// so tonight's WorkSpace run re-prices every released set immediately.
async function requeuePurgedClearancePrices(client) {
  const KEY = "requeue_purged_clearance_v1";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const { rowCount } = await client.query(
      `UPDATE public."VendorKit"
       SET "priceUpdatedAt" = NULL
       WHERE price IS NULL
         AND "productUrl" IS NOT NULL
         AND ("priceSource" IS NULL OR "priceSource" <> 'MANUAL')`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Re-queued ${rowCount} unpriced vendor links for immediate re-scrape (one-time).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Clearance requeue skipped: ${err.message}`);
  }
}

// Column for the catalog discovery crawler's oldest-first vendor rotation.
async function ensureDiscoveryColumn(client) {
  try {
    await client.query(
      `ALTER TABLE public."Vendor"
       ADD COLUMN IF NOT EXISTS "lastDiscoveredAt" timestamp(3) without time zone`
    );
  } catch (err) {
    console.warn(`[db-setup] lastDiscoveredAt column setup skipped: ${err.message}`);
  }
}

// Data-trust metadata lets the UI distinguish product lifecycle from source
// confidence. This matters most for Geekhack forum imports: old threads can
// keep "[GB]" in the title long after the buy died, and some never receive a
// closing/status update.
async function ensureDataTrustLayer(client) {
  const currentYear = new Date().getUTCFullYear();
  const oldYears = [];
  for (let year = 2010; year < currentYear; year++) oldYears.push(String(year));
  const oldYearRegex = oldYears.length > 0 ? `\\m(${oldYears.join("|")})\\M` : "\\m0000\\M";
  const currentYearRegex = `\\m${currentYear}\\M`;

  try {
    await client.query(
      `ALTER TABLE public."GroupBuy"
       ADD COLUMN IF NOT EXISTS "sourceType" text,
       ADD COLUMN IF NOT EXISTS "sourceUrl" text,
       ADD COLUMN IF NOT EXISTS "sourceLastCheckedAt" timestamp(3) without time zone,
       ADD COLUMN IF NOT EXISTS "sourceLastActivityAt" timestamp(3) without time zone,
       ADD COLUMN IF NOT EXISTS "dataTrustLevel" text NOT NULL DEFAULT 'TRUSTED',
       ADD COLUMN IF NOT EXISTS "dataTrustReason" text`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "GroupBuy_dataTrustLevel_idx"
       ON public."GroupBuy" ("dataTrustLevel")`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "GroupBuy_sourceType_idx"
       ON public."GroupBuy" ("sourceType")`
    );

    const backfilled = await client.query(
      `UPDATE public."GroupBuy"
       SET
         "sourceType" = COALESCE("sourceType", 'GEEKHACK'),
         "sourceUrl" = COALESCE("sourceUrl", "productUrl"),
         "sourceLastCheckedAt" = COALESCE("sourceLastCheckedAt", "updatedAt")
       WHERE slug LIKE 'gh-%'
          OR "productUrl" ILIKE '%geekhack.org/index.php?topic=%'`
    );

    const restored = await client.query(
      `UPDATE public."GroupBuy" gb
       SET "dataTrustLevel" = 'TRUSTED',
           "dataTrustReason" = NULL
       WHERE gb."dataTrustLevel" <> 'TRUSTED'
         AND EXISTS (
           SELECT 1
           FROM public."Kit" k
           JOIN public."VendorKit" vk ON vk."kitId" = k.id
           WHERE k."groupBuyId" = gb.id
             AND vk.price IS NOT NULL
         )`
    );

    const dead = await client.query(
      `UPDATE public."GroupBuy" gb
       SET "dataTrustLevel" = 'DEAD',
           "dataTrustReason" = 'Geekhack thread appears inactive and has no live priced vendor listing.'
       WHERE gb."sourceType" = 'GEEKHACK'
         AND gb.status::text IN ('ACTIVE_GB', 'INTEREST_CHECK')
         AND NOT EXISTS (
           SELECT 1
           FROM public."Kit" k
           JOIN public."VendorKit" vk ON vk."kitId" = k.id
           WHERE k."groupBuyId" = gb.id
             AND vk.price IS NOT NULL
         )
         AND (
           (gb."sourceLastActivityAt" IS NOT NULL AND gb."sourceLastActivityAt" < now() - interval '120 days')
           OR (gb."gbEnd" IS NOT NULL AND gb."gbEnd" < now() - interval '21 days')
           OR (
             gb."gbEnd" IS NULL
             AND gb."sourceLastActivityAt" IS NULL
             AND (gb.name || ' ' || COALESCE(gb.description, '')) ~* $1
             AND (gb.name || ' ' || COALESCE(gb.description, '')) !~* $2
           )
         )`,
      [oldYearRegex, currentYearRegex]
    );

    const stale = await client.query(
      `UPDATE public."GroupBuy" gb
       SET "dataTrustLevel" = 'STALE',
           "dataTrustReason" = 'Geekhack thread has no confirmed GB end date and has not shown recent source activity.'
       WHERE gb."sourceType" = 'GEEKHACK'
         AND gb."dataTrustLevel" <> 'DEAD'
         AND gb.status::text IN ('ACTIVE_GB', 'INTEREST_CHECK')
         AND gb."gbEnd" IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM public."Kit" k
           JOIN public."VendorKit" vk ON vk."kitId" = k.id
           WHERE k."groupBuyId" = gb.id
             AND vk.price IS NOT NULL
         )
         AND (
           gb."sourceLastActivityAt" IS NULL
           OR gb."sourceLastActivityAt" < now() - interval '45 days'
         )`
    );

    const inferredStale = await client.query(
      `UPDATE public."GroupBuy" gb
       SET "dataTrustLevel" = 'STALE',
           "dataTrustReason" = 'Geekhack lifecycle status is inferred from an inactive source with no confirmed GB end date.'
       WHERE gb."sourceType" = 'GEEKHACK'
         AND gb."dataTrustLevel" = 'TRUSTED'
         AND gb.status::text NOT IN ('ACTIVE_GB', 'INTEREST_CHECK')
         AND gb."gbEnd" IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM public."Kit" k
           JOIN public."VendorKit" vk ON vk."kitId" = k.id
           WHERE k."groupBuyId" = gb.id
             AND vk.price IS NOT NULL
         )
         AND (
           gb."sourceLastActivityAt" IS NULL
           OR gb."sourceLastActivityAt" < now() - interval '365 days'
         )`
    );

    const caution = await client.query(
      `UPDATE public."GroupBuy" gb
       SET "dataTrustLevel" = 'CAUTION',
           "dataTrustReason" = 'Geekhack source is missing a confirmed group-buy end date.'
       WHERE gb."sourceType" = 'GEEKHACK'
         AND gb."dataTrustLevel" = 'TRUSTED'
         AND gb.status::text IN ('ACTIVE_GB', 'INTEREST_CHECK')
         AND gb."gbEnd" IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM public."Kit" k
           JOIN public."VendorKit" vk ON vk."kitId" = k.id
           WHERE k."groupBuyId" = gb.id
             AND vk.price IS NOT NULL
         )`
    );

    const changed = restored.rowCount + dead.rowCount + stale.rowCount + inferredStale.rowCount + caution.rowCount;
    if (backfilled.rowCount > 0 || changed > 0) {
      console.log(
        `[db-setup] Data trust: backfilled ${backfilled.rowCount} Geekhack row(s); ` +
          `restored ${restored.rowCount}, dead ${dead.rowCount}, stale ${stale.rowCount + inferredStale.rowCount}, caution ${caution.rowCount}.`
      );
    }
  } catch (err) {
    console.warn(`[db-setup] Data-trust setup skipped: ${err.message}`);
  }
}

// Make sure every currency a vendor store can price in exists in the Currency
// table — a missing row makes convertCurrency silently fall back to rate 1,
// displaying e.g. a ฿4,000 Thai price as if it were $4,000 (~32x inflation).
// Static rates are placeholders at the right magnitude; lastUpdated is epoch 0
// so the next exchange-rate refresh overwrites them immediately.
async function ensureCurrencies(client) {
  try {
    const { rowCount } = await client.query(
      `INSERT INTO public."Currency" (code, name, symbol, "exchangeRateToUSD", "lastUpdated")
       VALUES
         ('USD', 'US Dollar',          '$',   1.0,   to_timestamp(0)),
         ('SGD', 'Singapore Dollar',   'S$',  1.35,  to_timestamp(0)),
         ('EUR', 'Euro',               '€',   0.92,  to_timestamp(0)),
         ('GBP', 'British Pound',      '£',   0.79,  to_timestamp(0)),
         ('CAD', 'Canadian Dollar',    'CA$', 1.37,  to_timestamp(0)),
         ('AUD', 'Australian Dollar',  'A$',  1.54,  to_timestamp(0)),
         ('JPY', 'Japanese Yen',       '¥',   150.5, to_timestamp(0)),
         ('CNY', 'Chinese Yuan',       '¥',   7.24,  to_timestamp(0)),
         ('KRW', 'South Korean Won',   '₩',   1340,  to_timestamp(0)),
         ('MYR', 'Malaysian Ringgit',  'RM',  4.71,  to_timestamp(0)),
         ('THB', 'Thai Baht',          '฿',   35.8,  to_timestamp(0)),
         ('NZD', 'New Zealand Dollar', 'NZ$', 1.64,  to_timestamp(0)),
         ('HKD', 'Hong Kong Dollar',   'HK$', 7.82,  to_timestamp(0)),
         ('TWD', 'New Taiwan Dollar',  'NT$', 32.1,  to_timestamp(0)),
         ('SEK', 'Swedish Krona',      'kr',  10.5,  to_timestamp(0)),
         ('NOK', 'Norwegian Krone',    'kr',  10.8,  to_timestamp(0)),
         ('DKK', 'Danish Krone',       'kr',  6.89,  to_timestamp(0)),
         ('CHF', 'Swiss Franc',        'CHF', 0.89,  to_timestamp(0)),
         ('PLN', 'Polish Zloty',       'zł',  4.02,  to_timestamp(0)),
         ('INR', 'Indian Rupee',       '₹',   84.0,  to_timestamp(0)),
         ('ARS', 'Argentine Peso',     'AR$', 1200,  to_timestamp(0)),
         ('CLP', 'Chilean Peso',       'CL$', 960,   to_timestamp(0))
       ON CONFLICT (code) DO NOTHING`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Added ${rowCount} missing currencies.`);
    }
  } catch (err) {
    console.warn(`[db-setup] Currency backfill skipped: ${err.message}`);
  }
}

// Visitor feedback (header "Feedback" panel): email + subject only, viewed
// directly in Supabase — the site never reads it back.
async function ensureFeedbackTable(client) {
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."Feedback" (
         id            text NOT NULL PRIMARY KEY,
         email         text NOT NULL,
         subject       text NOT NULL,
         "submittedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    );
    // Triage state for the visitor-inbox feed (NULL = unresolved).
    await client.query(
      `ALTER TABLE public."Feedback"
       ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone`
    );
  } catch (err) {
    console.warn(`[db-setup] Feedback table setup skipped: ${err.message}`);
  }
}

// Wrong-price reports submitted by users on the vendor table.
async function ensurePriceReportTable(client) {
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."PriceReport" (
         id             text NOT NULL PRIMARY KEY,
         "setSlug"      text NOT NULL,
         "vendorKitId"  text NOT NULL,
         "vendorName"   text NOT NULL,
         reason         text,
         "submittedAt"  timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    );
    // Triage state for the visitor-inbox feed (auto-resolved when the reported
    // listing's bad price is gone — see scripts/visitor-inbox-ci.mjs).
    await client.query(
      `ALTER TABLE public."PriceReport"
       ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone`
    );
  } catch (err) {
    console.warn(`[db-setup] PriceReport table setup skipped: ${err.message}`);
  }
}

// "Report a listing" submissions — the flag icon + modal on every set card and
// keyboard row. Owner reviews these daily (GET /api/listing-reports); the site
// never reads them back to visitors. `id` is a Prisma-generated cuid, so the
// column carries no DB-side default.
async function ensureListingReportTable(client) {
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."ListingReport" (
         id            text NOT NULL PRIMARY KEY,
         slug          text NOT NULL,
         name          text NOT NULL,
         "issueType"   text NOT NULL,
         notes         text,
         "submittedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    );
    // Triage state for the visitor-inbox feed (NULL = unresolved).
    await client.query(
      `ALTER TABLE public."ListingReport"
       ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "ListingReport_submittedAt_idx"
       ON public."ListingReport" ("submittedAt")`
    );
  } catch (err) {
    console.warn(`[db-setup] ListingReport table setup skipped: ${err.message}`);
  }
}

// Passwordless personal tracker tables. These are also represented by a Prisma
// migration, but production deploys use this idempotent setup path.
async function ensurePersonalTrackerTables(client) {
  try {
    await client.query(
       `CREATE TABLE IF NOT EXISTS public."TrackerUser" (
         id              text NOT NULL PRIMARY KEY,
         email           text NOT NULL UNIQUE,
         "alertsEnabled" boolean NOT NULL DEFAULT true,
         "countryCode"   text,
         region           text,
         currency         text,
         "displayName"    text,
         "collectionSlug" text,
         "collectionTitle" text,
         "collectionBio"  text,
         "collectionPublished" boolean NOT NULL DEFAULT false,
         "verifiedAt"    timestamp(3) without time zone NOT NULL,
         "createdAt"     timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updatedAt"     timestamp(3) without time zone NOT NULL
       )`
    );
    await client.query(
      `ALTER TABLE public."TrackerUser"
         ADD COLUMN IF NOT EXISTS "displayName" text,
         ADD COLUMN IF NOT EXISTS "collectionSlug" text,
         ADD COLUMN IF NOT EXISTS "collectionTitle" text,
         ADD COLUMN IF NOT EXISTS "collectionBio" text,
         ADD COLUMN IF NOT EXISTS "collectionPublished" boolean NOT NULL DEFAULT false`
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "TrackerUser_collectionSlug_key"
       ON public."TrackerUser" ("collectionSlug")`
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."TrackerAuthChallenge" (
         id               text NOT NULL PRIMARY KEY,
         email            text NOT NULL,
         "magicTokenHash" text NOT NULL UNIQUE,
         "otpHash"        text NOT NULL,
         attempts         integer NOT NULL DEFAULT 0,
         "ipHash"         text,
         "pendingSlugs"   text[] NOT NULL DEFAULT ARRAY[]::text[],
         "countryCode"    text,
         region            text,
         currency          text,
         "expiresAt"      timestamp(3) without time zone NOT NULL,
         "consumedAt"     timestamp(3) without time zone,
         "requestedAt"    timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "TrackerAuthChallenge_email_requestedAt_idx"
       ON public."TrackerAuthChallenge" (email, "requestedAt")`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "TrackerAuthChallenge_expiresAt_idx"
       ON public."TrackerAuthChallenge" ("expiresAt")`
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."TrackerItem" (
         id                 text NOT NULL PRIMARY KEY,
         "userId"           text NOT NULL,
         "groupBuyId"       text NOT NULL,
         "alertsEnabled"    boolean NOT NULL DEFAULT true,
         "isTracking"       boolean NOT NULL DEFAULT true,
         "inCollection"     boolean NOT NULL DEFAULT false,
         "isPublic"         boolean NOT NULL DEFAULT false,
         "acquiredAt"       timestamp(3) without time zone,
         condition          text,
         "purchasePrice"    double precision,
         "purchaseCurrency" text,
         "showPurchasePrice" boolean NOT NULL DEFAULT false,
         switches           text,
         keycaps            text,
         "buildDetails"     text,
         notes              text,
         "displayOrder"     integer NOT NULL DEFAULT 0,
         "lastStatus"       text,
         "lastBestPriceUsd" double precision,
         "lastVendorCount"  integer NOT NULL DEFAULT 0,
         "lastDevUpdateAt"  timestamp(3) without time zone,
         "createdAt"        timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updatedAt"        timestamp(3) without time zone NOT NULL,
         CONSTRAINT "TrackerItem_userId_fkey"
           FOREIGN KEY ("userId") REFERENCES public."TrackerUser"(id) ON DELETE CASCADE,
         CONSTRAINT "TrackerItem_groupBuyId_fkey"
           FOREIGN KEY ("groupBuyId") REFERENCES public."GroupBuy"(id) ON DELETE CASCADE,
         CONSTRAINT "TrackerItem_userId_groupBuyId_key" UNIQUE ("userId", "groupBuyId")
       )`
    );
    await client.query(
      `ALTER TABLE public."TrackerItem"
         ADD COLUMN IF NOT EXISTS "isTracking" boolean NOT NULL DEFAULT true,
         ADD COLUMN IF NOT EXISTS "inCollection" boolean NOT NULL DEFAULT false,
         ADD COLUMN IF NOT EXISTS "isPublic" boolean NOT NULL DEFAULT false,
         ADD COLUMN IF NOT EXISTS "acquiredAt" timestamp(3) without time zone,
         ADD COLUMN IF NOT EXISTS condition text,
         ADD COLUMN IF NOT EXISTS "purchasePrice" double precision,
         ADD COLUMN IF NOT EXISTS "purchaseCurrency" text,
         ADD COLUMN IF NOT EXISTS "showPurchasePrice" boolean NOT NULL DEFAULT false,
         ADD COLUMN IF NOT EXISTS switches text,
         ADD COLUMN IF NOT EXISTS keycaps text,
         ADD COLUMN IF NOT EXISTS "buildDetails" text,
         ADD COLUMN IF NOT EXISTS notes text,
         ADD COLUMN IF NOT EXISTS "displayOrder" integer NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS color text,
         ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1,
         ADD COLUMN IF NOT EXISTS "customImageUrl" text,
         ADD COLUMN IF NOT EXISTS units jsonb`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "TrackerItem_groupBuyId_idx"
       ON public."TrackerItem" ("groupBuyId")`
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."TrackerNotification" (
         id              text NOT NULL PRIMARY KEY,
         "userId"        text NOT NULL,
         "trackerItemId" text,
         type            text NOT NULL,
         title           text NOT NULL,
         body            text NOT NULL,
         fingerprint     text NOT NULL UNIQUE,
         "createdAt"     timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "sentAt"        timestamp(3) without time zone,
         CONSTRAINT "TrackerNotification_userId_fkey"
           FOREIGN KEY ("userId") REFERENCES public."TrackerUser"(id) ON DELETE CASCADE,
         CONSTRAINT "TrackerNotification_trackerItemId_fkey"
           FOREIGN KEY ("trackerItemId") REFERENCES public."TrackerItem"(id) ON DELETE SET NULL
       )`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "TrackerNotification_userId_sentAt_idx"
       ON public."TrackerNotification" ("userId", "sentAt")`
    );
  } catch (err) {
    console.warn(`[db-setup] Personal tracker table setup skipped: ${err.message}`);
  }
}

async function ensureCollectionPhotoReportTable(client) {
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."CollectionPhotoReport" (
         id               text NOT NULL PRIMARY KEY,
         "trackerItemId"  text NOT NULL,
         "collectionSlug" text NOT NULL,
         "buildIndex"     integer NOT NULL DEFAULT 0,
         "imageHash"      text NOT NULL,
         "issueType"      text NOT NULL,
         notes             text,
         "reporterIpHash" text,
         "reporterUserId" text,
         "submittedAt"    timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
         CONSTRAINT "CollectionPhotoReport_trackerItemId_fkey"
           FOREIGN KEY ("trackerItemId") REFERENCES public."TrackerItem"(id) ON DELETE CASCADE
       )`
    );
    // Triage state for the visitor-inbox feed (NULL = unresolved).
    await client.query(
      `ALTER TABLE public."CollectionPhotoReport"
       ADD COLUMN IF NOT EXISTS "resolvedAt" timestamp(3) without time zone`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "CollectionPhotoReport_trackerItemId_imageHash_submittedAt_idx"
       ON public."CollectionPhotoReport" ("trackerItemId", "imageHash", "submittedAt")`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "CollectionPhotoReport_submittedAt_idx"
       ON public."CollectionPhotoReport" ("submittedAt")`
    );
  } catch (err) {
    console.warn(`[db-setup] CollectionPhotoReport table setup skipped: ${err.message}`);
  }
}

// ONE-TIME: push the major pre-order vendors (iLumKB etc.) to the FRONT of the
// catalog-discovery queue so their pre-order GMK listings are linked on the
// very next cron run instead of waiting for the rotation to reach them.
async function prioritizePreorderVendors(client) {
  const KEY = "prioritize_preorder_vendors_v1";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const { rowCount } = await client.query(
      `UPDATE public."Vendor"
       SET "lastDiscoveredAt" = NULL
       WHERE slug IN ('ilumkb','ktechs','kbdfans','novelkeys','cannon-keys',
                      'cannonkeys','prototypist','oblotzky-industries','oblotzky',
                      'deskhero','dailyclack','daily-clack','swagkeys','monokei',
                      'ashkeebs','zion-studios','vala-supply','keebsforall',
                      'kono','kono-store','divinikey','omnitype','mykeyboard',
                      'mykeyboard-eu','candykeys','keygem','keygem-store')`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Bumped ${rowCount} pre-order vendors to the front of the discovery queue (one-time).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Pre-order vendor priority skipped: ${err.message}`);
  }
}

// Crowd-sourced vendor links: users submit a product URL via the "Add vendor
// link" panel; the nightly refresh turns them into scrapeable VendorKits.
async function ensureKeyboardContributionTable(client) {
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."KeyboardContribution" (
         id          text NOT NULL PRIMARY KEY,
         content     text NOT NULL,
         handle      text,
         "submittedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
         processed   boolean NOT NULL DEFAULT false
       )`
    );
  } catch (err) {
    console.warn(`[db-setup] KeyboardContribution table setup skipped: ${err.message}`);
  }
}

async function ensureVendorSuggestionTable(client) {
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."VendorSuggestion" (
         id            text NOT NULL PRIMARY KEY,
         slug          text NOT NULL,
         "productUrl"  text NOT NULL,
         "vendorName"  text,
         "submittedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
         processed     boolean NOT NULL DEFAULT false
       )`
    );
  } catch (err) {
    console.warn(`[db-setup] VendorSuggestion table setup skipped: ${err.message}`);
  }
}

// ONE-TIME: prices written by the old WorkSpace Python scraper used the
// cheapest-variant logic AND never stored the variants list, so there's no way
// to verify (or fix) which variant they captured. Re-queue them all for a
// fresh scrape with the corrected BASE-variant selection. Rows WITH variants
// are verified in place by the nightly price audit instead. Sentinel-guarded.
async function requeueLegacyScrapedPrices(client) {
  const KEY = "requeue_legacy_scraped_prices_v1";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const { rowCount } = await client.query(
      `UPDATE public."VendorKit"
       SET "priceUpdatedAt" = NULL
       WHERE "priceSource" = 'SCRAPED' AND variants IS NULL`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Re-queued ${rowCount} unverifiable legacy scraped prices (one-time).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Legacy price requeue skipped: ${err.message}`);
  }
}

// ONE-TIME: vendor links that pin an exact variant (?variant=<id>) used to be
// scraped with title heuristics that mis-pick on non-English stores (e.g.
// Yushakobo's GMK Prussian Alert showed the most expensive bundle instead of
// the ¥23,200 base kit). The scraper now trusts the pinned variant id, so
// re-queue those rows for a fresh scrape. Sentinel-guarded.
async function requeuePinnedVariantPrices(client) {
  const KEY = "requeue_pinned_variant_prices_v1";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const { rowCount } = await client.query(
      `UPDATE public."VendorKit"
       SET "priceUpdatedAt" = NULL
       WHERE "priceSource" = 'SCRAPED'
         AND "productUrl" LIKE '%variant=%'`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Re-queued ${rowCount} pinned-variant prices for re-scrape (one-time).`);
    }
  } catch (err) {
    console.warn(`[db-setup] Pinned-variant requeue skipped: ${err.message}`);
  }
}

// ONE-TIME: Shopify Markets geo-localizes product .json prices to the
// requester's country, so scrapes picked up SGD-converted numbers that were
// then labeled with the shop's base currency (CannonKeys S$104 stored as
// "USD 104", displayed as S$140 — a double conversion). The scraper now pins
// the storefront context to the shop's home market. CannonKeys prices are
// confirmed wrong — wipe them now; every other scraped price is re-queued
// (kept on display) so the nightly refresh re-verifies it. Sentinel-guarded.
async function requeueGeoCurrencyPrices(client) {
  const KEY = "requeue_geo_currency_v1";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const wiped = await client.query(
      `UPDATE public."VendorKit" vk
       SET price = NULL, "priceUpdatedAt" = NULL
       FROM public."Vendor" v
       WHERE vk."vendorId" = v.id
         AND vk."priceSource" = 'SCRAPED'
         AND v.slug IN ('cannon-keys','cannonkeys')`
    );
    const requeued = await client.query(
      `UPDATE public."VendorKit"
       SET "priceUpdatedAt" = NULL
       WHERE "priceSource" = 'SCRAPED' AND price IS NOT NULL`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    console.log(
      `[db-setup] Geo-currency fix: wiped ${wiped.rowCount} CannonKeys prices, re-queued ${requeued.rowCount} for re-verification (one-time).`
    );
  } catch (err) {
    console.warn(`[db-setup] Geo-currency requeue skipped: ${err.message}`);
  }
}

// ONE-TIME v2: the geo-currency fix (v1) only patched the Node refresher —
// the WorkSpace scraper kept ignoring ?variant= pins and Shopify Markets
// localization, so CannonKeys prices were re-poisoned by every nightly run
// (GMK BKRE $150 stored as 224 → shown as S$301). scrape.py now pins both;
// wipe CannonKeys scraped prices and re-queue all pinned-variant rows so the
// next scrape (with the fixed code) re-verifies them. Sentinel-guarded.
async function requeueGeoCurrencyPricesV2(client) {
  const KEY = "requeue_geo_currency_v2";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const wiped = await client.query(
      `UPDATE public."VendorKit" vk
       SET price = NULL, "priceUpdatedAt" = NULL
       FROM public."Vendor" v
       WHERE vk."vendorId" = v.id
         AND vk."priceSource" = 'SCRAPED'
         AND v.slug IN ('cannon-keys','cannonkeys')`
    );
    const requeued = await client.query(
      `UPDATE public."VendorKit"
       SET "priceUpdatedAt" = NULL
       WHERE "priceSource" = 'SCRAPED'
         AND "productUrl" LIKE '%variant=%'
         AND price IS NOT NULL`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    console.log(
      `[db-setup] Geo-currency fix v2: wiped ${wiped.rowCount} CannonKeys prices, re-queued ${requeued.rowCount} pinned-variant rows (one-time).`
    );
  } catch (err) {
    console.warn(`[db-setup] Geo-currency v2 requeue skipped: ${err.message}`);
  }
}

// RECURRING (every deploy): defects that re-appear because a scrape or import
// re-creates them — wiping once isn't enough.
//  a) GMK is the MANUFACTURER, not a vendor — its rows only carry the gmk.net
//     URL for the image/catalog passes. Wipe ANY price that lands on them
//     (e.g. a WorkSpace scraper running pre-removal code). priceUpdatedAt is
//     set to now() — not NULL — so the rows don't jump to the head of the
//     scrape queue on machines still running old code.
//  b) Child-kit sets ('-addon', alphas rounds) linked to the MAIN set's
//     product page — DELETE the link (a price wipe just gets re-priced).
//  c) Omnitype's GMK ASCII R1 clearance page linked to the ASCII R2 set.
async function purgeMispricedListings(client) {
  try {
    const gmkPrices = await client.query(
      `UPDATE public."VendorKit" vk
       SET price = NULL, "priceUpdatedAt" = now()
       FROM public."Vendor" v
       WHERE vk."vendorId" = v.id
         AND (v.slug = 'gmk' OR vk."productUrl" ILIKE '%gmk.net%')
         AND vk.price IS NOT NULL`
    );
    const mislinks = await client.query(
      `DELETE FROM public."VendorKit" vk
       USING public."Kit" k, public."GroupBuy" gb
       WHERE vk."kitId" = k.id AND k."groupBuyId" = gb.id
         AND (gb.slug LIKE '%-addon' OR gb.slug LIKE '%alphas%')
         AND COALESCE(vk."priceSource", '') <> 'MANUAL'
         AND vk."productUrl" NOT ILIKE '%addon%'
         AND vk."productUrl" NOT ILIKE '%nordeuk%'
         AND vk."productUrl" NOT ILIKE '%hagoromo%'
         AND vk."productUrl" NOT ILIKE '%alphas%'
         AND vk."productUrl" NOT ILIKE '%grrrr%'`
    );
    const asciiR1 = await client.query(
      `DELETE FROM public."VendorKit" vk
       USING public."Kit" k, public."GroupBuy" gb
       WHERE vk."kitId" = k.id AND k."groupBuyId" = gb.id
         AND gb.slug = 'gmk-ascii-r2'
         AND COALESCE(vk."priceSource", '') <> 'MANUAL'
         AND vk."productUrl" ILIKE '%omnitype.com/products/gmk-ascii'`
    );
    const total = gmkPrices.rowCount + mislinks.rowCount + asciiR1.rowCount;
    if (total > 0) {
      console.log(
        `[db-setup] Mispriced listings: wiped ${gmkPrices.rowCount} manufacturer (GMK) prices, ` +
          `deleted ${mislinks.rowCount} child-kit mislinks + ${asciiR1.rowCount} ASCII R1-on-R2 links.`
      );
    }
  } catch (err) {
    console.warn(`[db-setup] Mispriced-listing purge skipped: ${err.message}`);
  }
}

// ONE-TIME v3 (savings audit, 2026-06-12): three poison patterns found in
// every >=50% "savings" spread —
//  a) GMK.net base kits stored at 49.82: JSON-LD AggregateOffer.lowPrice is
//     the CHEAPEST child kit (spacebars/addon), not the base. Scrapers now
//     reject ambiguous lowPrice; wipe the stored artifacts.
//  b) '-addon' sets (GMK Mictlan - NordeUK Addon, …) carrying vendor links
//     that point at the MAIN set's product — a full base kit price on an
//     addon set produces a fake 60%+ spread against the real £37 addon kit.
//  c) Listings whose stored currency differs from the (corrected) vendor
//     currency (Mino Keys 198 "USD" on a CAD store) — requeue to re-verify
//     with the localization-pinned scrapers.
async function auditCleanupV3(client) {
  const KEY = "savings_audit_cleanup_v3";
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public."_AppMigrations" (
         key text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = await client.query(
      `SELECT 1 FROM public."_AppMigrations" WHERE key = $1`,
      [KEY]
    );
    if (done.rowCount > 0) return;

    const gmkLow = await client.query(
      `UPDATE public."VendorKit" vk
       SET price = NULL, "priceUpdatedAt" = NULL
       FROM public."Vendor" v
       WHERE vk."vendorId" = v.id AND v.slug = 'gmk'
         AND vk."priceSource" = 'SCRAPED' AND vk.price < 60`
    );
    const addonLinks = await client.query(
      `UPDATE public."VendorKit" vk
       SET price = NULL, "priceUpdatedAt" = NULL
       FROM public."Kit" k, public."GroupBuy" gb
       WHERE vk."kitId" = k.id AND k."groupBuyId" = gb.id
         AND gb.slug LIKE '%-addon'
         AND vk."priceSource" = 'SCRAPED'
         AND vk."productUrl" NOT ILIKE '%addon%'
         AND vk."productUrl" NOT ILIKE '%nordeuk%'
         AND vk."productUrl" NOT ILIKE '%grrrr%'`
    );
    const mismatch = await client.query(
      `UPDATE public."VendorKit" vk
       SET "priceUpdatedAt" = NULL
       FROM public."Vendor" v
       WHERE vk."vendorId" = v.id
         AND vk."priceSource" = 'SCRAPED'
         AND vk.price IS NOT NULL
         AND vk.currency IS NOT NULL
         AND vk.currency <> v.currency`
    );
    await client.query(
      `INSERT INTO public."_AppMigrations" (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [KEY]
    );
    console.log(
      `[db-setup] Audit cleanup v3: wiped ${gmkLow.rowCount} GMK lowPrice artifacts, ` +
        `${addonLinks.rowCount} addon-set mislinks; re-queued ${mismatch.rowCount} currency-mismatch rows (one-time).`
    );
  } catch (err) {
    console.warn(`[db-setup] Audit cleanup v3 skipped: ${err.message}`);
  }
}

// RECURRING (every deploy): give every keycap set a BASE Kit.
//
// Vendor pricing is only reachable through a BASE kit — the scraper's set index
// inner-joins on it and every vendor-linking pass writes against its id. Only
// the gmk.net and KBDfans upserts used to create one, so a set whose only source
// is Geekhack had NO kit and could never be priced. That silently made every
// non-GMK profile unpriceable: all 14 Geekhack-sourced DCS sets were in exactly
// this state. scrape.py now creates the kit on both its insert and update paths;
// this heal repairs the rows that already exist.
async function ensureBaseKitForKeycapSets(client) {
  try {
    const { rowCount } = await client.query(
      `INSERT INTO public."Kit" (id, name, type, "groupBuyId")
       SELECT gen_random_uuid()::text, 'Base Kit', 'BASE', gb.id
         FROM public."GroupBuy" gb
        WHERE gb."productType" = 'KEYCAPS'
          AND gb.slug NOT LIKE 'custom-%'
          AND NOT EXISTS (
            SELECT 1 FROM public."Kit" k
             WHERE k."groupBuyId" = gb.id AND k.type = 'BASE'
          )`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Added a BASE kit to ${rowCount} keycap set(s) that had none.`);
    }
  } catch (err) {
    console.warn(`[db-setup] Base-kit backfill skipped: ${err.message}`);
  }
}

// Remove speculative, date-less interest-check sets from KeycapLendar
// (e.g. GMK Strawberry) — no confirmed GB date, no real vendor listings.
// Cascade deletes child Kit/VendorKit rows automatically.
async function cleanupInterestChecks(client) {
  try {
    const { rowCount } = await client.query(
      `DELETE FROM public."GroupBuy"
       WHERE status = 'INTEREST_CHECK' AND "gbStart" IS NULL`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Removed ${rowCount} date-less interest-check sets.`);
    }
  } catch (err) {
    console.warn(`[db-setup] Interest-check cleanup skipped: ${err.message}`);
  }
}

// RECURRING (every deploy): some keycap sets get scraped into the keyboards
// space (productType='KEYBOARD') — they show up on /keyboards/active even
// though they're keycaps. This happens for keycap-only brands the scraper
// hadn't yet learned (Keykobo, MW/Milkyway) and for keycap PROFILE names
// (GMK, SA, KAT, MT3, …) that slipped in before the classifier was tightened.
// Flip any such KEYBOARD row back to KEYCAPS by its name. The tokens here are
// keycap-exclusive in this domain, so the match is safe to run every deploy
// (it self-heals rows the nightly scraper may re-introduce until its own code
// is refreshed). Mirrors _GH_KEYCAP_PROFILE / KEYBOARD_BLOCKED_BRANDS in
// scraper/scrape.py.
async function reclassifyMisflaggedKeycaps(client) {
  try {
    const { rowCount } = await client.query(
      `UPDATE public."GroupBuy"
       SET "productType" = 'KEYCAPS', "updatedAt" = now()
       WHERE "productType" = 'KEYBOARD'
         AND (
              -- keycap profiles + keycap-only brands as whole words, anywhere
              name ~* '\\y(gmk|sa|dcs|mtnu|kat|mt3|cyl|xda|mda|dsa|dss|kam|nicepbt|npbt|keykobo|infinikey|keyreative|melgeek|milkyway)\\y'
              OR name ~* '\\ykey\\s+kobo\\y'
              OR name ~* '\\ymilky\\s+way\\y'
              -- "MW" (Milkyway) only as the leading token, tolerating [GB]/[IC] tags,
              -- so it can't match an "mw" buried inside an unrelated keyboard name
              OR name ~* '^\\s*(?:\\[[^\\]]*\\]\\s*)*mw\\y'
         )`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Reclassified ${rowCount} keycap set(s) mislabeled as keyboards → KEYCAPS.`);
    }
  } catch (err) {
    console.warn(`[db-setup] Keycap reclassification skipped: ${err.message}`);
  }
}

// RECURRING: Geekhack thread titles are frequently updated after a GB closes
// (production, shipping, extras, replacement keys). A recent forum reply must
// not turn those historical threads back into ACTIVE_GB.
async function reclassifyGeekhackStatuses(client) {
  try {
    const inStock = await client.query(
      `UPDATE public."GroupBuy"
       SET status = 'IN_STOCK'::"GBStatus", "updatedAt" = now()
       WHERE slug LIKE 'gh-%'
         AND name ~* '\\y(in[ -]?stock|extras? (are )?(in stock|available now))\\y'
         AND status IS DISTINCT FROM 'IN_STOCK'::"GBStatus"`
    );
    const interestChecks = await client.query(
      `UPDATE public."GroupBuy"
       SET status = 'INTEREST_CHECK'::"GBStatus", "updatedAt" = now()
       WHERE slug LIKE 'gh-%'
         AND name ~* '(\\[IC\\]|interest check|checking interest)'
         AND status IS DISTINCT FROM 'INTEREST_CHECK'::"GBStatus"`
    );
    const delivered = await client.query(
      `UPDATE public."GroupBuy"
       SET status = 'DELIVERED'::"GBStatus", "updatedAt" = now()
       WHERE slug LIKE 'gh-%'
         AND (
           "gbEnd" < current_date - interval '365 days'
           OR name ~* '\\y(closed|fulfilled|delivered|completed|finished|gb over|group buy over|100% sent|100% shipped|replacement keys shipped)\\y'
         )
         AND status IS DISTINCT FROM 'DELIVERED'::"GBStatus"`
    );
    const shipping = await client.query(
      `UPDATE public."GroupBuy"
       SET status = 'SHIPPING'::"GBStatus", "updatedAt" = now()
       WHERE slug LIKE 'gh-%'
         AND status = 'ACTIVE_GB'::"GBStatus"
         AND (
           ("gbEnd" IS NOT NULL AND "gbEnd" < current_date)
           OR name ~* '\\y(shipping|fulfillment|delivering|final numbers|production confirmed|in production|queue for production|in the queue for production|last day|final weekend)\\y'
         )`
    );
    if (
      inStock.rowCount +
        interestChecks.rowCount +
        delivered.rowCount +
        shipping.rowCount >
      0
    ) {
      console.log(
        `[db-setup] Reclassified Geekhack status rows: ${inStock.rowCount} in-stock, ` +
          `${interestChecks.rowCount} IC, ${shipping.rowCount} shipping, ` +
          `${delivered.rowCount} delivered.`
      );
    }
  } catch (err) {
    console.warn(`[db-setup] Geekhack status cleanup skipped: ${err.message}`);
  }
}

// RECURRING (every deploy): one set, two rows — fold the duplicate into the
// row the site actually publishes.
//
// gmk.net's catalog calls a set "GMK CYL Mizu R2 Keycaps" and KeycapLendar
// calls the same product "GMK Mizu R2". `upsert_gmk_set` matches on SLUG, so
// both got written; `_build_set_index` in scrape.py has called the second one
// "the orphan duplicate" ever since, and routes new listings around it. What it
// cannot do is remove it: the orphan keeps its own set page, shows up in search
// and on /released, and holds on to whatever vendor links, tracker items and
// dev updates happened to land there — off the row the price comparison lives
// on. Two half-populated rows compare worse than one whole one.
//
// This replaces an earlier pass that deleted Geekhack stubs duplicating an
// official set. That pass keyed on a SQL-side normalisation which stripped a
// LEADING profile word but no trailing ones, so the pair above never matched
// it — "mizur2" vs "mizur2keycaps". It also DELETED the stub outright, taking
// any collection entry pointing at it down with it (TrackerItem cascades on
// GroupBuy). A merge is what was wanted both times, so there is now one rule,
// in scripts/lib/set-merge.mjs, covered by `npm run test:set-merge`.
//
// Nothing is deleted until its children have been moved. Each merge runs in its
// own transaction, so a failure on one duplicate leaves that pair untouched
// rather than half-merged, and the rest of the deploy carries on.
async function mergeDuplicateKeycapSets(client) {
  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT gb.id, gb.slug, gb.name, gb."productType",
              gb."createdAt", gb."gbStart",
              (SELECT count(*)::int FROM public."VendorKit" vk
                 JOIN public."Kit" k ON k.id = vk."kitId"
                WHERE k."groupBuyId" = gb.id) AS vendor_links,
              (SELECT count(*)::int FROM public."TrackerItem" t
                WHERE t."groupBuyId" = gb.id) AS tracker_items
         FROM public."GroupBuy" gb
        WHERE gb."productType" = 'KEYCAPS'`
    ));
  } catch (err) {
    console.warn(`[db-setup] duplicate-set merge skipped: ${err.message}`);
    return;
  }

  const { merges, skipped } = planSetMerges(
    rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      productType: r.productType,
      createdAt: r.createdAt,
      gbStart: r.gbStart,
      vendorLinks: r.vendor_links,
      trackerItems: r.tracker_items,
    }))
  );

  let merged = 0;
  let strandedTrackers = 0;
  for (const merge of merges) {
    const keepId = merge.keep.id;
    const dropIds = merge.drop.map((r) => r.id);
    try {
      await client.query("BEGIN");

      // The survivor must have somewhere to put the listings. A keycap row
      // without a BASE kit publishes nothing at all (ensureBaseKitForKeycapSets
      // exists for exactly that), and a duplicate whose only kit is a subkit
      // would otherwise strand its vendor links.
      await client.query(
        `INSERT INTO public."Kit" (id, name, type, "groupBuyId")
         SELECT gen_random_uuid()::text, 'Base Kit', 'BASE', $1
          WHERE NOT EXISTS (
            SELECT 1 FROM public."Kit" WHERE "groupBuyId" = $1 AND type = 'BASE')`,
        [keepId]
      );
      // …and one kit per type the duplicates carry, so an ALPHA/NOVELTY listing
      // lands on a kit of its own type instead of being dropped or flattened
      // onto BASE (kit type is what the set page's category filter reads).
      await client.query(
        `INSERT INTO public."Kit" (id, name, type, "groupBuyId")
         SELECT gen_random_uuid()::text, s.name, s.type, $1
           FROM (SELECT DISTINCT ON (type) name, type
                   FROM public."Kit" WHERE "groupBuyId" = ANY($2::text[])
                  ORDER BY type, id) s
          WHERE NOT EXISTS (
            SELECT 1 FROM public."Kit" kk
             WHERE kk."groupBuyId" = $1 AND kk.type = s.type)`,
        [keepId, dropIds]
      );

      // Move the listings. VendorKit is unique on (kitId, vendorId), so a
      // vendor the survivor already lists is left where it is and cascades away
      // with the duplicate — its price is the one already on the visible row.
      // DISTINCT ON keeps two duplicates' listings from the same shop from
      // colliding on the survivor, preferring the priced, freshest one.
      const moved = await client.query(
        `WITH target AS (
           SELECT DISTINCT ON (type) id, type
             FROM public."Kit" WHERE "groupBuyId" = $1 ORDER BY type, id
         ), moves AS (
           SELECT DISTINCT ON (t.id, vk."vendorId") vk.id AS vk_id, t.id AS kit_id
             FROM public."VendorKit" vk
             JOIN public."Kit" lk ON lk.id = vk."kitId"
             JOIN target t ON t.type = lk.type
            WHERE lk."groupBuyId" = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM public."VendorKit" ex
                 WHERE ex."kitId" = t.id AND ex."vendorId" = vk."vendorId")
            ORDER BY t.id, vk."vendorId", (vk.price IS NOT NULL) DESC,
                     vk."priceUpdatedAt" DESC NULLS LAST, vk.id
         )
         UPDATE public."VendorKit" v
            SET "kitId" = m.kit_id, "updatedAt" = now()
           FROM moves m WHERE v.id = m.vk_id`,
        [keepId, dropIds]
      );

      // Collections and price alerts. TrackerItem is unique on
      // (userId, groupBuyId): an owner who added BOTH rows keeps the entry on
      // the survivor, and the duplicate's entry goes — which is what the
      // collection page already showed them, since it dedupes on display.
      await client.query(
        `WITH moves AS (
           SELECT DISTINCT ON (t."userId") t.id
             FROM public."TrackerItem" t
            WHERE t."groupBuyId" = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM public."TrackerItem" e
                 WHERE e."userId" = t."userId" AND e."groupBuyId" = $1)
            ORDER BY t."userId", t."inCollection" DESC,
                     t."updatedAt" DESC NULLS LAST, t.id
         )
         UPDATE public."TrackerItem" t SET "groupBuyId" = $1
           FROM moves m WHERE t.id = m.id`,
        [keepId, dropIds]
      );
      await client.query(
        `UPDATE public."DevUpdate" SET "groupBuyId" = $1
          WHERE "groupBuyId" = ANY($2::text[])`,
        [keepId, dropIds]
      );

      // Only ever fill what the survivor is missing — never overwrite an edit.
      // One duplicate at a time, oldest first, so the result does not depend on
      // which row Postgres happened to join.
      for (const dropId of [...dropIds].sort()) {
        await client.query(
          `UPDATE public."GroupBuy" k SET
             "imageUrl"   = COALESCE(NULLIF(k."imageUrl", ''), NULLIF(l."imageUrl", '')),
             images       = CASE WHEN COALESCE(cardinality(k.images), 0) = 0
                                 THEN l.images ELSE k.images END,
             description  = CASE WHEN COALESCE(k.description, '') = ''
                                 THEN l.description ELSE k.description END,
             designer     = CASE WHEN COALESCE(k.designer, '') = ''
                                 THEN l.designer ELSE k.designer END,
             colorway     = CASE WHEN COALESCE(k.colorway, '') = ''
                                 THEN l.colorway ELSE k.colorway END,
             subtitle     = CASE WHEN COALESCE(k.subtitle, '') = ''
                                 THEN l.subtitle ELSE k.subtitle END,
             "gbStart"    = COALESCE(k."gbStart", l."gbStart"),
             "gbEnd"      = COALESCE(k."gbEnd", l."gbEnd"),
             "sourceUrl"  = COALESCE(NULLIF(k."sourceUrl", ''), NULLIF(l."sourceUrl", '')),
             "updatedAt"  = now()
           FROM public."GroupBuy" l
          WHERE k.id = $1 AND l.id = $2`,
          [keepId, dropId]
        );
      }

      const { rows: left } = await client.query(
        `SELECT count(*)::int AS n FROM public."TrackerItem"
          WHERE "groupBuyId" = ANY($1::text[])`,
        [dropIds]
      );
      strandedTrackers += left[0].n;

      await client.query(`DELETE FROM public."GroupBuy" WHERE id = ANY($1::text[])`, [
        dropIds,
      ]);
      await client.query("COMMIT");
      merged += dropIds.length;
      console.log(
        `[db-setup]   merged ${merge.drop.map((r) => r.slug).join(", ")} into ` +
          `${merge.keep.slug} (${moved.rowCount} listing(s) moved)`
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.warn(
        `[db-setup] duplicate-set merge failed for ${merge.keep.slug}: ${err.message}`
      );
    }
  }

  if (merged > 0) {
    console.log(`[db-setup] Merged ${merged} duplicate keycap set row(s).`);
  }
  if (strandedTrackers > 0) {
    console.log(
      `[db-setup] ${strandedTrackers} collection entr(ies) were already on the ` +
        `surviving row and were removed with the duplicate.`
    );
  }
  // Named rather than merged: two rows that look like one set but whose group
  // buys ran a long way apart are more likely two rounds that lost a suffix.
  for (const group of skipped) {
    console.warn(
      `[db-setup] duplicate-set merge skipped ${group.profile} "${group.key}" ` +
        `(${group.rows.map((r) => r.slug).join(", ")}) — ${group.reason}`
    );
  }
}

main().catch((err) => {
  console.warn(`[db-setup] Unexpected error: ${err.message}`);
  // never fail the build
});
