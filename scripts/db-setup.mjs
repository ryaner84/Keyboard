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
      return url.replace("__PASSWORD__", encodeURIComponent(password));
    }
    return url;
  }
  const ref = process.env.SUPABASE_PROJECT_REF;
  const region = process.env.SUPABASE_REGION;
  if (ref && region) {
    if (!password) throw new Error("DATABASE_PASSWORD is required with SUPABASE_PROJECT_REF + SUPABASE_REGION");
    const host = process.env.SUPABASE_DB_HOST || `aws-0-${region}.pooler.supabase.com`;
    return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres`;
  }
  throw new Error("No database configuration found (DATABASE_URL or SUPABASE_PROJECT_REF + SUPABASE_REGION + DATABASE_PASSWORD)");
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
                    'zion-studios','zionstudios','zion-studios-sg')
       AND region <> 'SG'`
  );
  // 1b. Fix other commonly-mislabelled vendors (wrong origin inflates shipping).
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
       ('zfrontier',           'ASIA', 'CN', 'USD')
     ) AS c(slug, region, country, currency)
     WHERE v.slug = c.slug AND v.region::text <> c.region`
  );
  const fixed = (fixSG.rowCount || 0) + (fixIntl.rowCount || 0);
  if (fixed > 0) console.log(`[db-setup] Corrected ${fixed} vendor region(s).`);

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
        await backfillShipping(client);
        await cleanupInterestChecks(client);
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
    await backfillShipping(client);
    await cleanupInterestChecks(client);
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
    const { rowCount } = await client.query(
      `UPDATE public."GroupBuy"
       SET images = ARRAY["imageUrl"]
       WHERE (images IS NULL OR cardinality(images) = 0) AND "imageUrl" IS NOT NULL`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Backfilled images[] for ${rowCount} sets.`);
    }
  } catch (err) {
    console.warn(`[db-setup] images column setup skipped: ${err.message}`);
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

main().catch((err) => {
  console.warn(`[db-setup] Unexpected error: ${err.message}`);
  // never fail the build
});
