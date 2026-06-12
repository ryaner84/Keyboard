// Price refresh from CI (GitHub Actions): runs the same refreshPrices() the
// Vercel cron uses, but from a runner IP that vendor stores don't blanket-
// block, and without the 60s serverless budget. Requires DATABASE_URL.
// Run with: npx tsx scripts/refresh-prices-ci.mjs

// Env check BEFORE the import — importing prices.ts instantiates the Prisma
// client at module load, which throws without a database URL.
if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not set — skipping price refresh.");
  process.exit(0);
}

const { refreshPrices } = await import("../src/lib/import/prices.ts");

const result = await refreshPrices({
  limit: 2000,
  maxAgeHours: 6,
  concurrency: 8,
  maxRuntimeMs: 12 * 60_000,
});
console.log(
  `Price refresh: attempted=${result.attempted} updated=${result.updated} ` +
    `failed=${result.failed} stoppedEarly=${result.stoppedEarly}`
);
process.exit(0);
