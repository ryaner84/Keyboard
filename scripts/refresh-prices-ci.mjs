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
// `dead` is the subset of `failed` the store answered "gone" for — a 404/410 or
// a redirect to its front door. It is reported separately because the two mean
// opposite things: failures are mostly blocks and say nothing, while a run whose
// dead count jumps has just taken links off the site. Without it the only way to
// see what a run did to link health was to re-run audit:publishing afterwards.
// `refused` and `unparsed` are neither failures nor updates: the store answered
// and the row still has no price because THIS side refused the number (outside
// KIT_BOUNDS / an unconvertible currency) or could not read the page's platform
// at all. Both used to be counted as failures, which is how a live shop read as
// a blocked one — and neither is fixed by running this workflow again, so a run
// that reports them is pointing at code, not at the vendor.
console.log(
  `Price refresh: attempted=${result.attempted} updated=${result.updated} ` +
    `failed=${result.failed} dead=${result.dead} refused=${result.refused} ` +
    `unparsed=${result.unparsed} stoppedEarly=${result.stoppedEarly}`
);
process.exit(0);
