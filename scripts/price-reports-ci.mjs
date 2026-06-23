// Surfaces pending wrong-price reports in the workflow log and re-queues the
// reported listings for re-scraping. Runs before the price refresh in
// .github/workflows/refresh-prices.yml so reported listings are re-verified
// in the same run (the refresh queue is ORDER BY priceUpdatedAt NULLS FIRST).
//
// Also runs a proactive variant-mismatch check: finds BASE listings where the
// scraped price matches a non-base variant (novelties, spacebars, alpha) rather
// than the actual base-kit variant — the clearest mechanical signal that the
// wrong Shopify variant was selected by the scraper.
//
// The log lines are also the review feed: a scheduled Claude session reads
// them via the GitHub API to triage the human-written reasons (wrong currency,
// product mismatch, …) that mechanical re-scraping can't always fix.
// Run with: node scripts/price-reports-ci.mjs
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not set — skipping price reports.");
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

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

try {
  await client.connect();

  const { rows } = await client.query(`
    SELECT pr."submittedAt", pr."setSlug", pr."vendorName", pr.reason,
           pr."vendorKitId",
           vk.price, vk.currency, vk."priceSource", vk."priceUpdatedAt",
           vk."productUrl"
      FROM "PriceReport" pr
      LEFT JOIN "VendorKit" vk ON vk.id = pr."vendorKitId"
     WHERE pr."submittedAt" > now() - interval '14 days'
     ORDER BY pr."submittedAt" DESC
     LIMIT 50
  `);

  if (rows.length === 0) {
    console.log("No price reports in the last 14 days.");
  } else {
    console.log(`${rows.length} price report(s) in the last 14 days:`);
    for (const r of rows) {
      const when = new Date(r.submittedAt).toISOString();
      const price = r.price != null ? `${r.price} ${r.currency ?? "?"}` : "(no price)";
      console.log(
        `PRICE_REPORT | ${when} | set=${r.setSlug} | vendor=${r.vendorName} | ` +
          `current=${price} | source=${r.priceSource ?? "?"} | ` +
          `reason=${JSON.stringify(r.reason ?? "")} | url=${r.productUrl ?? "?"}`
      );
    }

    // Re-queue every reported non-manual listing (covers reports submitted
    // before the submit-time auto-repair was deployed).
    const requeue = await client.query(`
      UPDATE "VendorKit" vk
         SET "priceUpdatedAt" = NULL
        FROM "PriceReport" pr
       WHERE vk.id = pr."vendorKitId"
         AND pr."submittedAt" > now() - interval '14 days'
         AND vk."priceSource" IS DISTINCT FROM 'MANUAL'
         AND vk."priceUpdatedAt" IS NOT NULL
       RETURNING vk.id
    `);
    if (requeue.rowCount > 0) {
      console.log(`Re-queued ${requeue.rowCount} reported listing(s) for re-scrape this run.`);
    }
  }

  // ── Proactive variant-mismatch detection ────────────────────────────────
  // Find BASE listings where the stored scraped price matches a non-base
  // variant (novelties, spacebars, alpha) but NOT the base-kit variant.
  // This is the primary mechanical signal that the wrong Shopify variant
  // was selected — e.g. a £38 novelties kit was picked instead of the £150
  // base kit because both live on the same product page.
  //
  // Mirrors the classification logic in src/lib/kit-variants.ts and the
  // add-on filter in src/lib/import/prices.ts — keep them in sync.

  function classifyVariant(title) {
    if (/novelt|ノベルティ/i.test(title)) return "NOVELTIES";
    if (/space\s*bar|スペースバー/i.test(title)) return "SPACEBARS";
    if (/alpha|アルファ/i.test(title)) return "ALPHA";
    if (/base|ベース/i.test(title)) return "BASE";
    return "OTHERS";
  }

  const ADDON_RE =
    /(desk\s?mat|mouse\s?pad|wrist\s?rest|cable|artisan|sticker|sample|keychain|coin|tray|deposit|shipping|insurance|add[\s-]?on|extra)/i;

  const { rows: candidates } = await client.query(`
    SELECT vk.id, vk.price, vk.currency, vk.variants, vk."productUrl",
           vk."priceSource", vk."priceUpdatedAt",
           gb.slug AS "setSlug", v.name AS "vendorName"
      FROM "VendorKit" vk
      JOIN "Kit" k       ON k.id = vk."kitId"
      JOIN "GroupBuy" gb ON gb.id = k."groupBuyId"
      JOIN "Vendor" v    ON v.id = vk."vendorId"
     WHERE k.type = 'BASE'
       AND vk.price IS NOT NULL
       AND vk."priceSource" = 'SCRAPED'
       AND vk.variants IS NOT NULL
       AND jsonb_typeof(vk.variants::jsonb) = 'array'
       AND jsonb_array_length(vk.variants::jsonb) > 1
     ORDER BY vk."priceUpdatedAt" DESC NULLS FIRST
     LIMIT 300
  `);

  let flagged = 0;
  for (const row of candidates) {
    const raw = Array.isArray(row.variants) ? row.variants : [];
    const variants = raw
      .filter(
        (v) =>
          v &&
          typeof v.title === "string" &&
          typeof v.price === "number" &&
          v.price > 0
      )
      .filter((v) => !ADDON_RE.test(v.title));

    const baseVars = variants.filter((v) => classifyVariant(v.title) === "BASE");
    const nonBaseVars = variants.filter((v) => {
      const c = classifyVariant(v.title);
      return c === "NOVELTIES" || c === "SPACEBARS" || c === "ALPHA";
    });

    if (nonBaseVars.length === 0) continue;

    const scraped = Number(row.price);
    // Allow 2-cent tolerance for floating-point representation of prices
    const matchedNonBase = nonBaseVars.find((v) => Math.abs(v.price - scraped) < 0.02);
    if (!matchedNonBase) continue;

    // Skip if the base variant happens to share the same price — the
    // selection may still be correct and this would be a false positive.
    const baseSharesPrice = baseVars.some((v) => Math.abs(v.price - scraped) < 0.02);
    if (baseSharesPrice) continue;

    flagged++;
    const baseStr =
      baseVars.length > 0
        ? `${Math.min(...baseVars.map((v) => v.price))} ${row.currency ?? ""}`
        : "no BASE variant found";
    console.log(
      `SUSPECT_PRICE | set=${row.setSlug} | vendor=${row.vendorName} | ` +
        `scraped=${scraped} ${row.currency ?? ""} | ` +
        `matched_variant=${JSON.stringify(matchedNonBase.title)} | ` +
        `base_kit_price=${baseStr} | url=${row.productUrl ?? "?"}`
    );
  }

  if (flagged > 0) {
    console.log(
      `${flagged} listing(s) flagged as SUSPECT_PRICE (wrong variant selected — scraper fix needed).`
    );
  } else {
    console.log("Variant-mismatch check: no suspect prices found.");
  }
} catch (err) {
  // Never fail the workflow — the price refresh is the primary job.
  console.log(`price-reports step skipped: ${err.message}`);
} finally {
  await client.end().catch(() => {});
}
