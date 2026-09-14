// Clear specific LISTING_FLAG rows the daily triage has DEALT WITH.
//
// A ListingReport carries no derivable auto-resolution (unlike a PriceReport),
// so once the triage confirms a flag is resolved — the flagged listing was
// purged, the duplicate was merged, the root cause was fixed and verified — the
// row must be marked resolved by id or it re-surfaces in the inbox every run.
// The routine (docs/price-report-review-routine.md, step 1b) authorises exactly
// this. Setting resolvedAt is reversible (set it back to NULL to reopen).
//
// SCOPE: touches ONLY "ListingReport"."resolvedAt", ONLY for ids passed in, ONLY
// where it is currently NULL. It cannot delete a row, change a listing, or
// resolve anything not named explicitly. Ids come from the FLAG_IDS env var
// (workflow_dispatch input), comma- or whitespace-separated.
//
// Runs from .github/workflows/resolve-listing-flags.yml (workflow_dispatch).

const raw = process.env.FLAG_IDS ?? "";
const ids = [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not set — skipping.");
  process.exit(0);
}
if (ids.length === 0) {
  console.log("No FLAG_IDS provided — nothing to resolve. Pass a comma-separated id list.");
  process.exit(0);
}

// Cuid ids only — reject anything that isn't a plausible ListingReport id so a
// stray value can never widen the WHERE clause.
const CUID = /^c[a-z0-9]{20,}$/;
const bad = ids.filter((id) => !CUID.test(id));
if (bad.length) {
  console.log(`Refusing to run — these ids are not valid cuids: ${bad.join(", ")}`);
  process.exit(1);
}

// Same connection handling as scripts/visitor-inbox-ci.mjs.
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

const pg = (await import("pg")).default;
const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

try {
  await client.connect();
  console.log(`RESOLVE LISTING FLAGS — ${ids.length} id(s) requested (${new Date().toISOString()})`);

  // Report the state of every requested id first, so the log shows exactly what
  // was cleared and what was already resolved / not found.
  const { rows: before } = await client.query(
    `SELECT id, slug, "issueType", "resolvedAt" FROM "ListingReport" WHERE id = ANY($1::text[])`,
    [ids]
  );
  const seen = new Map(before.map((r) => [r.id, r]));
  for (const id of ids) {
    const r = seen.get(id);
    if (!r) console.log(`  ? ${id} — not found`);
    else if (r.resolvedAt) console.log(`  · ${id} — already resolved (${r.slug} [${r.issueType}])`);
    else console.log(`  → ${id} — resolving (${r.slug} [${r.issueType}])`);
  }

  const { rows: updated } = await client.query(
    `UPDATE "ListingReport" SET "resolvedAt" = now()
      WHERE id = ANY($1::text[]) AND "resolvedAt" IS NULL
      RETURNING id`,
    [ids]
  );
  console.log(`\nResolved ${updated.length} flag(s).`);
} catch (err) {
  console.log(`resolve-listing-flags skipped: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
