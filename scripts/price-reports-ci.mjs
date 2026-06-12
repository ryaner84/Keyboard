// Surfaces pending wrong-price reports in the workflow log and re-queues the
// reported listings for re-scraping. Runs before the price refresh in
// .github/workflows/refresh-prices.yml so reported listings are re-verified
// in the same run (the refresh queue is ORDER BY priceUpdatedAt NULLS FIRST).
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
} catch (err) {
  // Never fail the workflow — the price refresh is the primary job.
  console.log(`price-reports step skipped: ${err.message}`);
} finally {
  await client.end().catch(() => {});
}
