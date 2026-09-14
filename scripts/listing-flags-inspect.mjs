// Read-only production inspector for the daily listing-flag triage.
//
// The visitor-inbox feed prints every unresolved LISTING_FLAG (the "report a
// listing" flag beside a set/keyboard), but a flag carries no derivable state:
// to triage it — is the "duplicate" pair still two rows? does the "inactive"
// group buy still show active? was the flagged test product actually purged? —
// the reviewer needs the current catalog state of each flagged slug, and this
// session cannot reach production (only runners can). This script joins each
// unresolved ListingReport to its GroupBuy row and reports that state. It runs
// planSetMerges over the live keycap rows so a "duplicate" flag can be checked
// against what the deploy-time merge would actually fold, and lists every row
// that shares a flagged row's merge identity so a twin the merge WON'T fold
// (a "TKL" subset, a >180-day round gap) is visible too.
//
// WRITES NOTHING — only SELECTs. Clearing a flag is a separate, explicit step.
// Runs from .github/workflows/listing-flags-inspect.yml (workflow_dispatch).
import pg from "pg";
import { setMergeIdentity, planSetMerges } from "./lib/set-merge.mjs";

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not set — skipping listing-flag inspection.");
  process.exit(0);
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

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

function day(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : "—";
}

try {
  await client.connect();
  console.log(`LISTING-FLAG INSPECTOR — read-only catalog state (generated ${new Date().toISOString()})`);

  const { rows: flags } = await client.query(`
    SELECT id, slug, name, "issueType", notes, "submittedAt"
      FROM "ListingReport"
     WHERE "resolvedAt" IS NULL
     ORDER BY "submittedAt" DESC
  `);

  // Every GroupBuy row with the counts that decide publishing / survivorship.
  const { rows: gbs } = await client.query(`
    SELECT gb.id, gb.slug, gb.name, gb."productType", gb.status::text AS status,
           gb.designer, gb."gbStart", gb."createdAt",
           gb."vendorName", gb."vendorRegion", gb."productUrl",
           (SELECT count(*)::int FROM "VendorKit" vk
              JOIN "Kit" k ON k.id = vk."kitId"
             WHERE k."groupBuyId" = gb.id) AS vendor_links,
           (SELECT count(*)::int FROM "VendorKit" vk
              JOIN "Kit" k ON k.id = vk."kitId"
             WHERE k."groupBuyId" = gb.id AND vk.price IS NOT NULL) AS priced_links,
           (SELECT count(*)::int FROM "TrackerItem" t
             WHERE t."groupBuyId" = gb.id) AS tracker_items
      FROM "GroupBuy" gb
  `);

  const bySlug = new Map(gbs.map((r) => [r.slug, r]));

  // Identity buckets over ALL rows (keycaps only carry a merge identity), so a
  // flagged row's twins are visible whether or not the deploy merge folds them.
  const identityBuckets = new Map();
  for (const r of gbs) {
    if ((r.productType ?? "KEYCAPS") !== "KEYCAPS") continue;
    const id = setMergeIdentity(r.name);
    if (!id) continue;
    const key = `${id.profile}::${id.key}`;
    if (!identityBuckets.has(key)) identityBuckets.set(key, []);
    identityBuckets.get(key).push(r);
  }

  // What the deploy-time merge would actually do right now.
  const { merges, skipped } = planSetMerges(
    gbs.map((r) => ({
      id: r.id, slug: r.slug, name: r.name, productType: r.productType,
      createdAt: r.createdAt, gbStart: r.gbStart,
      vendorLinks: r.vendor_links, trackerItems: r.tracker_items,
    }))
  );
  const mergeRoleBySlug = new Map();
  for (const m of merges) {
    mergeRoleBySlug.set(m.keep.slug, `KEEP (folds ${m.drop.map((d) => d.slug).join(", ")})`);
    for (const d of m.drop) mergeRoleBySlug.set(d.slug, `DROP → ${m.keep.slug}`);
  }
  const skipReasonByKey = new Map(skipped.map((s) => [`${s.profile}::${s.key}`, s.reason]));

  console.log(`\n${flags.length} unresolved LISTING_FLAG(s):\n`);
  for (const f of flags) {
    const row = bySlug.get(f.slug);
    console.log(`■ ${f.slug}  [${f.issueType}]  flagged ${day(f.submittedAt)}  id=${f.id}`);
    if (f.notes) console.log(`   note: "${f.notes}"`);
    if (!row) {
      console.log(`   → NO GroupBuy row with this slug (already deleted/purged, or slug renamed).`);
      console.log("");
      continue;
    }
    console.log(
      `   row: name="${row.name}" type=${row.productType} status=${row.status} designer=${row.designer}` +
      ` gbStart=${day(row.gbStart)}`
    );
    console.log(
      `   links: ${row.vendor_links} vendorKit(s), ${row.priced_links} priced, ${row.tracker_items} trackerItem(s)` +
      (row.productType === "KEYBOARD"
        ? ` | vendor=${row.vendorName ?? "?"} region=${row.vendorRegion ?? "?"}`
        : "")
    );
    if ((row.productType ?? "KEYCAPS") === "KEYCAPS") {
      const id = setMergeIdentity(row.name);
      if (id) {
        const key = `${id.profile}::${id.key}`;
        const twins = (identityBuckets.get(key) ?? []).filter((t) => t.slug !== row.slug);
        console.log(
          `   identity: ${key}` +
          (twins.length
            ? ` | TWIN ROW(S): ${twins.map((t) => `${t.slug} ("${t.name}", ${t.vendor_links}vk/${t.priced_links}priced)`).join("; ")}`
            : " | no twin row shares this identity")
        );
        if (mergeRoleBySlug.has(row.slug)) console.log(`   deploy-merge: ${mergeRoleBySlug.get(row.slug)}`);
        else if (skipReasonByKey.has(key)) console.log(`   deploy-merge: SKIPPED (${skipReasonByKey.get(key)})`);
        else if (twins.length) console.log(`   deploy-merge: not folded (identities differ — see twin names above)`);
      } else {
        console.log(`   identity: none (name carries no maker/profile token — merge folds nothing)`);
      }
    }
    console.log("");
  }

  console.log("Read-only inspection complete — no rows were modified.");
} catch (err) {
  console.log(`listing-flags-inspect skipped: ${err.message}`);
} finally {
  await client.end().catch(() => {});
}
