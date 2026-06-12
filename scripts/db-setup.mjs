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
       ('aiglatson',           'ASIA', 'TH', 'THB')
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
        await purgeBlockedVendors(client);
        await ensureDiscoveryColumn(client);
        await ensureCurrencies(client);
        await resetPollutedGalleries(client);
        await backfillShipping(client);
        await cleanupInterestChecks(client);
        await ensureVariantsColumn(client);
        await purgeImplausibleScrapedPrices(client);
        await restorePurgedPricesFromVariants(client);
        await requeuePurgedClearancePrices(client);
        await requeueCurrencyMismatches(client);
        await requeueLegacyScrapedPrices(client);
        await requeuePinnedVariantPrices(client);
        await requeueGeoCurrencyPrices(client);
        await prioritizePreorderVendors(client);
        await markPricedVendorKitsInStock(client);
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
    await ensureVariantsColumn(client);
    await ensureVendorSuggestionTable(client);
    await ensureFeedbackTable(client);
        await ensurePriceReportTable(client);
        await purgeBlockedVendors(client);
    await ensureDiscoveryColumn(client);
    await ensureCurrencies(client);
    await resetPollutedGalleries(client);
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
  } catch (err) {
    console.warn(`[db-setup] images column setup skipped: ${err.message}`);
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
};

async function restorePurgedPricesFromVariants(client) {
  try {
    const { rows } = await client.query(
      `SELECT vk.id, vk.currency, vk.variants, v.currency AS vendor_currency
       FROM public."VendorKit" vk
       JOIN public."Vendor" v ON v.id = vk."vendorId"
       WHERE vk.price IS NULL
         AND vk."priceSource" = 'SCRAPED'
         AND vk.variants IS NOT NULL`
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
         ('PLN', 'Polish Zloty',       'zł',  4.02,  to_timestamp(0))
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
  } catch (err) {
    console.warn(`[db-setup] PriceReport table setup skipped: ${err.message}`);
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

// One-time (idempotent) fix: scraped prices were historically written without
// setting inStock=true, so DELIVERED/SHIPPING sets with real prices still had
// inStock=false and were invisible in the "available" filter.
// Set inStock=true for every VendorKit that has a non-null scraped/manual price.
async function markPricedVendorKitsInStock(client) {
  try {
    const { rowCount } = await client.query(
      `UPDATE public."VendorKit"
       SET "inStock" = true
       WHERE price IS NOT NULL
         AND "priceSource" IN ('SCRAPED', 'MANUAL')
         AND "inStock" = false`
    );
    if (rowCount > 0) {
      console.log(`[db-setup] Marked ${rowCount} priced VendorKit(s) as inStock=true.`);
    }
  } catch (err) {
    console.warn(`[db-setup] markPricedVendorKitsInStock skipped: ${err.message}`);
  }
}

main().catch((err) => {
  console.warn(`[db-setup] Unexpected error: ${err.message}`);
  // never fail the build
});
