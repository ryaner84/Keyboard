// Price refresh from CI (GitHub Actions): runs the same refreshPrices() the
// Vercel cron uses, but from a runner IP that vendor stores don't blanket-
// block, and without the 60s serverless budget. Requires DATABASE_URL.
// Tracker notifications run separately from the daily Vercel currency cron,
// which has access to the production email and authentication configuration.
// Run with: npx tsx scripts/refresh-prices-ci.mjs

// Env check BEFORE the import — importing prices.ts instantiates the Prisma
// client at module load, which throws without a database URL.
if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not set — skipping price refresh.");
  process.exit(0);
}
if (process.env.DATABASE_URL.includes("__PASSWORD__") && !process.env.DATABASE_PASSWORD) {
  console.log("DATABASE_URL has __PASSWORD__ but DATABASE_PASSWORD not set — skipping price refresh.");
  process.exit(0);
}

const { refreshPrices } = await import("../src/lib/import/prices.ts");
const force = process.env.FORCE_PRICE_REFRESH === "true";
const ids = (process.env.PRICE_REFRESH_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const result = await refreshPrices({
  limit: ids.length > 0 ? ids.length : 2000,
  maxAgeHours: force ? 0 : 6,
  concurrency: 8,
  maxRuntimeMs: 12 * 60_000,
  ids: ids.length > 0 ? ids : undefined,
});
console.log(
  `Price refresh: attempted=${result.attempted} updated=${result.updated} ` +
    `failed=${result.failed} stoppedEarly=${result.stoppedEarly}`
);
process.exit(0);
