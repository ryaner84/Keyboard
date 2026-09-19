// TEMPORARY read-only diagnostic (not part of the shipped tree).
// Prints the per-row VendorKit state for a few silent vendors so the publishing
// audit's per-vendor aggregate can be traced to the rows it came from.
import pg from "pg";

let connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.log("DATABASE_URL not set — nothing to do.");
  process.exit(0);
}
if (connectionString.includes("__PASSWORD__")) {
  connectionString = connectionString.replace(
    "__PASSWORD__",
    encodeURIComponent(process.env.DATABASE_PASSWORD ?? "")
  );
}
if (!/localhost|127\.0\.0\.1/.test(connectionString)) {
  connectionString = connectionString.replace(/:5432(\/|$|\?)/, ":6543$1");
}

const SLUGS = (process.env.DIAG_SLUGS ?? "prime-keyboards,rectangles,typoworks,keygem")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});
await client.connect();

const { rows } = await client.query(
  `SELECT v.slug AS vendor, v.currency AS vendor_currency,
          vk.id, vk."productUrl", vk.price, vk.currency, vk."priceSource",
          vk."priceUpdatedAt", vk."deadSince", vk."linkFailures", vk."inStock",
          k.type AS kit_type, k.name AS kit_name,
          gb.slug AS set_slug, gb.name AS set_name, gb.status AS set_status,
          gb."productType" AS product_type
     FROM public."VendorKit" vk
     JOIN public."Vendor" v ON v.id = vk."vendorId"
     JOIN public."Kit" k ON k.id = vk."kitId"
     JOIN public."GroupBuy" gb ON gb.id = k."groupBuyId"
    WHERE v.slug = ANY($1::text[])
    ORDER BY v.slug, vk."productUrl"`,
  [SLUGS]
);

for (const r of rows) {
  console.log(
    `ROW | ${r.vendor} | id=${r.id} | kit=${r.kit_type}/${r.kit_name} | set=${r.set_slug} (${r.set_status}, ${r.product_type}) | ` +
      `price=${r.price} ${r.currency ?? "(null)"} | src=${r.priceSource ?? "(null)"} | ` +
      `updated=${r.priceUpdatedAt ? new Date(r.priceUpdatedAt).toISOString().slice(0, 10) : "never"} | ` +
      `dead=${r.deadSince ? new Date(r.deadSince).toISOString().slice(0, 10) : "-"} | ` +
      `failures=${r.linkFailures} | inStock=${r.inStock} | ${r.productUrl}`
  );
}
console.log(`ROWS ${rows.length}`);
await client.end();

// What the price pass itself makes of each URL, right now, from this runner.
const { fetchVendorPrice } = await import("../src/lib/import/prices.ts");
for (const r of rows) {
  if (!r.productUrl) continue;
  const out = await fetchVendorPrice(r.productUrl, r.vendor_currency, r.vendor, false);
  const label =
    out === null
      ? "UNREADABLE(null)"
      : typeof out === "string"
        ? out
        : `PRICED ${out.price} ${out.currency ?? "(null)"} inStock=${out.inStock} variants=${JSON.stringify((out.variants ?? []).map((v) => [v.title, v.price, v.available]))}`;
  console.log(`FETCH | ${r.vendor} | ${r.productUrl} -> ${label}`);
}
