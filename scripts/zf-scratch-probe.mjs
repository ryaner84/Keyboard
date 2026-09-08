// TEMPORARY diagnostic — removed before this branch is proposed.
//
// Round 3. Rounds 1-2 established:
//   * www.zfrontier.com serves ONE 20,939-byte client-rendered shell for every
//     route (14 chars of rendered text, 6 script bundles), differing from its
//     own root only in a per-request window.csrf_token — so when a cached
//     response makes the two match, isGoneFrontPage answers DEAD_LINK for a
//     live listing. Two of three live URLs did exactly that on run 34239886634.
//   * The three stores #164 shipped for are separable: drop.com carries 2,504
//     chars of rendered text, captus.io and kingly-keys.xyz carry 0 and load no
//     scripts at all.
//
// Two things left to size the repair:
//   1. Split the zfrontier rows by HOST. Vendor `zfrontier` holds both the
//      Shopify storefront (en.zfrontier.com, which 404s properly) and the app
//      (www.zfrontier.com), and only the second can produce a false verdict.
//   2. Confirm the app never 404s — if every /app/ path answers 200 with the
//      shell, then a deadSince on such a row cannot have come from a 404.
import pg from "pg";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
};

console.log("=== does the app ever 404?");
for (const path of [
  "/app/mch/thisHashDoesNotExist",
  "/app/eqp/zzzzzzzzzzzz",
  "/app/mch/1xmjEGd2dQml",
]) {
  try {
    const res = await fetch(`https://www.zfrontier.com${path}`, { headers: HEADERS });
    const body = await res.text();
    console.log(`${path} | ${res.status} | ${body.length}b | final=${res.url}`);
  } catch (err) {
    console.log(`${path} | ERROR ${err.message}`);
  }
}

if (process.env.DATABASE_URL) {
  let cs = process.env.DATABASE_URL;
  if (cs.includes("__PASSWORD__")) {
    cs = cs.replace("__PASSWORD__", encodeURIComponent(process.env.DATABASE_PASSWORD ?? ""));
  }
  cs = cs.replace(/:5432(\/|$|\?)/, ":6543$1");
  const client = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows } = await client.query(`
    SELECT v.slug,
           split_part(split_part(vk."productUrl", '://', 2), '/', 1) AS host,
           count(*)::int AS rows,
           count(*) FILTER (WHERE vk."deadSince" IS NOT NULL)::int AS dead,
           count(*) FILTER (WHERE vk."deadSince" >= '2026-09-06')::int AS dead_since_164,
           count(*) FILTER (WHERE vk.price IS NOT NULL)::int AS priced,
           count(*) FILTER (WHERE vk."priceSource" = 'UNPARSED')::int AS unparsed
      FROM public."VendorKit" vk
      JOIN public."Vendor" v ON v.id = vk."vendorId"
     WHERE vk."productUrl" ILIKE '%zfrontier.com%'
     GROUP BY 1, 2 ORDER BY 1, 2
  `);
  console.log("\n=== zfrontier rows by vendor and HOST");
  for (const r of rows) {
    console.log(
      `${r.slug} | ${r.host} | rows=${r.rows} dead=${r.dead} deadSince164=${r.dead_since_164}` +
        ` priced=${r.priced} unparsed=${r.unparsed}`
    );
  }

  // Every row anywhere on the roster that #164 could have mis-marked: dead
  // since it shipped, no price, and the page was last read as UNPARSED (which
  // is what a client-rendered shell always is).
  const { rows: suspect } = await client.query(`
    SELECT v.slug,
           split_part(split_part(vk."productUrl", '://', 2), '/', 1) AS host,
           count(*)::int AS rows
      FROM public."VendorKit" vk
      JOIN public."Vendor" v ON v.id = vk."vendorId"
     WHERE vk."deadSince" >= '2026-09-06'
     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20
  `);
  console.log("\n=== every row marked gone since #164 shipped (2026-09-06)");
  for (const r of suspect) console.log(`${r.slug} | ${r.host} | ${r.rows}`);

  await client.end();
}
