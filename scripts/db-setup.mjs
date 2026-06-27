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

// Some keycap sets get scraped into the KEYBOARD section by mistake (a vendor's
// "group buy" collection includes a metal-keycap drop, a Geekhack keycap GB is
// classified as a board, etc.) — so they pollute /released?type=keyboards.
// Move clearly-keycap rows back to KEYCAPS. High precision: requires a
// definitive keycap word (GMK / keycaps / keyset / spacebars / novelties) AND
// the absence of a definitive keyboard word, so real boards are never flipped.
// Runs every deploy and is idempotent (a flipped row no longer matches).
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
       SET price = NULL, "priceUpdatedAt" = NULL
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
        await purgeBlockedVendors(client);
        await purgeCancelledSets(client);
        await reclassifyKeycapKeyboards(client);
        await ensureDiscoveryColumn(client);
        await ensureCurrencies(client);
        await resetPollutedGalleries(client);
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
        await purgeMispricedListings(client);
        await prioritizePreorderVendors(client);
        await reclassifyMisflaggedKeycaps(client);
        await reclassifyGeekhackStatuses(client);
        await dropForumDuplicatesOfOfficialSets(client);
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
    await purgeBlockedVendors(client);
    await purgeCancelledSets(client);
    await ensureDiscoveryColumn(client);
    await ensureCurrencies(client);
    await resetPollutedGalleries(client);
    await backfillShipping(client);
    await cleanupInterestChecks(client);
    await reclassifyMisflaggedKeycaps(client);
    await reclassifyGeekhackStatuses(client);
    await dropForumDuplicatesOfOfficialSets(client);
  } catch (err) {
    console.warn(`[db-setup] Setup failed: ${err.message}`);
    console.warn("[db-setup] The app will still deploy; you can re-run by redeploying once the DB is reachable.");
  } finally {
    await client.end().catch(() => {});
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
// CALIBRATION: the lower bound admits CLEARANCE prices. Released GMK sets are
// routinely sold off at USD 40–70, and the old tighter window (USD ≥ 70)
// wiped those legitimate prices on every deploy — which is why released sets
// showed "no pricing available" while full-MSRP group buys kept theirs. The
// window must never be tighter than what scrape.py / prices.ts will store.
// Idempotent — MANUAL prices are never touched.
async function purgeImplausibleScrapedPrices(client) {
  try {
    const { rowCount } = await client.query(
      `UPDATE public."VendorKit"
       SET price = NULL, "priceUpdatedAt" = NULL
       WHERE "priceSource" = 'SCRAPED'
         AND price IS NOT NULL
         AND (
              (currency = 'USD' AND (price < 30  OR price > 225))
           OR (currency = 'EUR' AND (price < 28  OR price > 210))
           OR (currency = 'GBP' AND (price < 24  OR price > 180))
           OR (currency = 'AUD' AND (price < 45  OR price > 345))
           OR (currency = 'CAD' AND (price < 41  OR price > 310))
           OR (currency = 'SGD' AND (price < 40  OR price > 310))
           OR (currency = 'JPY' AND (price < 4500 OR price > 34000))
           OR (currency = 'KRW' AND (price < 40000 OR price > 320000))
           OR (currency = 'CNY' AND (price < 215 OR price > 1650))
           OR (currency = 'HKD' AND (price < 235 OR price > 1800))
           OR (currency = 'THB' AND (price < 1075 OR price > 8100))
           OR (currency = 'TWD' AND (price < 965 OR price > 7300))
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
// so a restored price is never re-purged.
const ADDON_VARIANT_RE =
  /(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain|coin|tray|deposit|shipping|insurance|add[\s-]?on|extra)/i;
const RESTORE_BOUNDS = {
  USD: [30, 225], EUR: [28, 210], GBP: [24, 180], AUD: [45, 345],
  CAD: [41, 310], SGD: [40, 310], JPY: [4500, 34000], KRW: [40000, 320000],
  CNY: [215, 1650], HKD: [235, 1800], THB: [1075, 8100], TWD: [965, 7300],
  MYR: [140, 1100],
};

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
      if (bounds && (chosen.price < bounds[0] || chosen.price > bounds[1])) continue;
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

// RECURRING (every deploy): Geekhack forum threads are imported as stub sets
// with a `gh-<topicid>` slug. When the same colorway also has an official,
// fully-named "GMK <colorway>" entry (from KeycapLendar / a vendor), the forum
// stub is a lower-quality duplicate — e.g. forum "Distortion" vs official
// "GMK Distortion". Drop the forum stub and keep the official one.
//
// Matching strips bracket tags ([GB]/[IC]), the "| designer" suffix, and a
// leading keycap-profile word (GMK / GMK CYL / SA / KAT / …), then compares the
// remaining colorway, case-insensitively, ignoring punctuation/spacing. A forum
// stub is deleted ONLY when a NON-forum twin with the same colorway exists AND
// that twin's name actually starts with "GMK" — so forum-only sets (no official
// equivalent) are always kept. Child Kit/VendorKit rows cascade on delete.
async function dropForumDuplicatesOfOfficialSets(client) {
  try {
    const { rowCount } = await client.query(
      `WITH normd AS (
         SELECT id, slug, name,
           regexp_replace(
             lower(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(name, '\\|.*$', ''),          -- drop "| designer"
                   '\\[[^\\]]*\\]', '', 'g'),                    -- drop [GB]/[IC] tags
                 '^\\s*(gmk\\s+cyl|gmk|sa|dcs|mtnu|kat|mt3|cyl|xda|mda|dsa|dss|kam)\\s+', '', 'i')
             ),
             '[^a-z0-9]+', '', 'g'                               -- keep only [a-z0-9]
           ) AS key
         FROM public."GroupBuy"
       )
       DELETE FROM public."GroupBuy" g
       USING normd f, normd o
       WHERE g.id = f.id
         AND f.slug LIKE 'gh-%'                                  -- target: forum stub
         AND o.slug NOT LIKE 'gh-%'                              -- twin: non-forum
         AND o.id <> f.id
         AND f.key <> '' AND f.key = o.key                       -- same colorway
         AND o.name ~* '^\\s*(?:\\[[^\\]]*\\]\\s*)*gmk\\y'        -- twin is officially "GMK …"
      `
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Dropped ${rowCount} forum stub(s) duplicating an official "GMK …" set.`);
    }
  } catch (err) {
    console.warn(`[db-setup] Forum-duplicate cleanup skipped: ${err.message}`);
  }
}

main().catch((err) => {
  console.warn(`[db-setup] Unexpected error: ${err.message}`);
  // never fail the build
});
