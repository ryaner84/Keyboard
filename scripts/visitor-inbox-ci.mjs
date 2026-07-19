// Visitor-inbox feed: surfaces EVERY channel a website visitor can send input
// through, so the daily scheduled review run can triage them in one place:
//   • STORE_LINK   — "Add a store link" / suggest-vendor      (VendorSuggestion)
//   • PRICE_REPORT — "Report wrong price" flag on a vendor row (PriceReport)
//   • LISTING_FLAG — "Report a listing" flag on a set/keyboard (ListingReport)
//   • FEEDBACK     — header "Feedback" panel                  (Feedback)
//   • PHOTO_REPORT — "Report photo" on a public collection     (CollectionPhotoReport)
//
// Only UNRESOLVED items are printed, grouped by category, one concise line each
// (no full records). Resolution works two ways, by design:
//   • Auto-resolve what's derivable — a STORE_LINK once it's `processed`, and a
//     PRICE_REPORT once its bad price is gone (VendorKit deleted or price nulled).
//   • The rest are cleared manually by the owner (the line carries the row id):
//       UPDATE "Feedback" SET "resolvedAt" = now() WHERE id = '<id>';
//     (VendorSuggestion uses `processed = true` instead of resolvedAt.)
//
// Runs from .github/workflows/visitor-inbox.yml on a daily schedule; the
// scheduled Claude session reads these log lines via the GitHub API.
// Run with: node scripts/visitor-inbox-ci.mjs
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not set — skipping visitor inbox.");
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

// Short, single-line summary of a free-text field — never the whole record.
function brief(text, max = 80) {
  if (!text) return "";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function day(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Lightly mask a reporter email so the log isn't a plaintext address dump,
// while still letting the owner recognise / reply to the sender.
function maskEmail(email) {
  const [user = "", domain = ""] = String(email).split("@");
  const head = user.slice(0, 2);
  return `${head}${user.length > 2 ? "***" : ""}@${domain}`;
}

// Print one category section; never let a missing table/column abort the rest.
async function section(label, runQuery, format) {
  try {
    const { rows } = await runQuery();
    if (rows.length === 0) {
      console.log(`\n${label} (0): none`);
      return 0;
    }
    console.log(`\n${label} (${rows.length}):`);
    for (const r of rows) console.log("  " + format(r));
    return rows.length;
  } catch (err) {
    // A table/column may not exist yet (created on the next deploy by
    // scripts/db-setup.mjs) — report and continue with the other channels.
    console.log(`\n${label}: skipped (${err.message})`);
    return 0;
  }
}

try {
  await client.connect();

  console.log(`VISITOR INBOX — unresolved items by category (generated ${new Date().toISOString()})`);

  // ── Auto-resolve what's derivable ─────────────────────────────────────────
  // A price report's job is done once the bad price it flagged is gone (the
  // VendorKit was deleted, or its price was nulled by the 2nd-report
  // auto-repair) — or once the listing was re-scraped AFTER the report was
  // filed: the report's re-queue worked and a fresh scrape re-verified the
  // price. A still-wrong fresh price gets re-reported as a new case. Same
  // rule as GET /api/price-reports, so both feeds stay in step.
  try {
    const healed = await client.query(`
      UPDATE "PriceReport" pr
         SET "resolvedAt" = now()
       WHERE pr."resolvedAt" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "VendorKit" vk
            WHERE vk.id = pr."vendorKitId"
              AND vk.price IS NOT NULL
              AND (vk."priceUpdatedAt" IS NULL
                   OR vk."priceUpdatedAt" <= pr."submittedAt")
         )
      RETURNING pr.id
    `);
    if (healed.rowCount > 0) {
      console.log(`\nAuto-resolved ${healed.rowCount} price report(s) whose bad price is gone.`);
    }
  } catch (err) {
    console.log(`\nAuto-resolve step skipped (${err.message}).`);
  }

  // ── Unresolved items, grouped by category ─────────────────────────────────
  let total = 0;

  total += await section(
    "STORE_LINK",
    () =>
      client.query(`
        SELECT id, slug, "vendorName", "productUrl", "submittedAt"
          FROM "VendorSuggestion"
         WHERE processed = false
         ORDER BY "submittedAt" DESC
         LIMIT 100
      `),
    (r) =>
      `STORE_LINK | ${day(r.submittedAt)} | set=${r.slug} | ` +
      `vendor=${r.vendorName ?? "?"} | url=${brief(r.productUrl, 90)} | id=${r.id}`
  );

  total += await section(
    "PRICE_REPORT",
    () =>
      client.query(`
        SELECT pr.id, pr."submittedAt", pr."setSlug", pr."vendorName", pr.reason,
               vk.price, vk.currency
          FROM "PriceReport" pr
          LEFT JOIN "VendorKit" vk ON vk.id = pr."vendorKitId"
         WHERE pr."resolvedAt" IS NULL
         ORDER BY pr."submittedAt" DESC
         LIMIT 100
      `),
    (r) => {
      const price = r.price != null ? `${r.price} ${r.currency ?? "?"}` : "(no price)";
      return (
        `PRICE_REPORT | ${day(r.submittedAt)} | set=${r.setSlug} | ` +
        `vendor=${r.vendorName} | current=${price} | reason="${brief(r.reason)}" | id=${r.id}`
      );
    }
  );

  total += await section(
    "LISTING_FLAG",
    () =>
      client.query(`
        SELECT id, slug, name, "issueType", notes, "submittedAt"
          FROM "ListingReport"
         WHERE "resolvedAt" IS NULL
         ORDER BY "submittedAt" DESC
         LIMIT 100
      `),
    (r) =>
      `LISTING_FLAG | ${day(r.submittedAt)} | set=${r.slug} | issue=${r.issueType} | ` +
      `notes="${brief(r.notes)}" | id=${r.id}`
  );

  total += await section(
    "FEEDBACK",
    () =>
      client.query(`
        SELECT id, email, subject, "submittedAt"
          FROM "Feedback"
         WHERE "resolvedAt" IS NULL
         ORDER BY "submittedAt" DESC
         LIMIT 100
      `),
    (r) =>
      `FEEDBACK | ${day(r.submittedAt)} | from=${maskEmail(r.email)} | ` +
      `subject="${brief(r.subject)}" | id=${r.id}`
  );

  total += await section(
    "PHOTO_REPORT",
    () =>
      client.query(`
        SELECT id, "collectionSlug", "issueType", notes, "submittedAt"
          FROM "CollectionPhotoReport"
         WHERE "resolvedAt" IS NULL
         ORDER BY "submittedAt" DESC
         LIMIT 100
      `),
    (r) =>
      `PHOTO_REPORT | ${day(r.submittedAt)} | collection=${r.collectionSlug} | ` +
      `issue=${r.issueType} | notes="${brief(r.notes)}" | id=${r.id}`
  );

  console.log(
    total === 0
      ? "\nNo unresolved visitor input. Inbox clear."
      : `\n${total} unresolved item(s). Clear non-auto ones with: ` +
          `UPDATE "<Table>" SET "resolvedAt" = now() WHERE id = '<id>';  ` +
          `(STORE_LINK: UPDATE "VendorSuggestion" SET processed = true WHERE id = '<id>';)`
  );
} catch (err) {
  // Never fail the workflow on a transient DB hiccup.
  console.log(`visitor-inbox step skipped: ${err.message}`);
} finally {
  await client.end().catch(() => {});
}
