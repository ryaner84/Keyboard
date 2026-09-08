// TEMPORARY diagnostic — removed before this branch is proposed.
//
// Round 2. Round 1 established that www.zfrontier.com serves ONE 20,939-byte
// shell for every route (visible text: "zFrontier 装备前线", everything else
// loaded from <script src>), differing from its own root only in a
// per-request window.csrf_token — and that when a cached response makes the
// two match, isGoneFrontPage answers DEAD_LINK for a live listing. Two of the
// three live URLs probed on run 34239886634 came out DEAD_LINK.
//
// The question now: what separates that shell from the pages isGoneFrontPage
// was written for? Measure the visible text of every control the link-health
// suite pins, plus the three stores #164 shipped for, and the DB rows at risk.
import pg from "pg";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: controller.signal });
    return { status: res.status, url: res.url, body: await res.text() };
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function visibleText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CASES = [
  // The three stores #164 shipped isGoneFrontPage for — these MUST stay DEAD_LINK.
  ["drop (retired: Corsair landing page)", "https://drop.com/buy/drop-full-metal-gmk-mecha-01-r2"],
  ["captus (retired: 114-byte placeholder)", "https://captus.io/collections/keycaps/products/gmk-euler"],
  ["kingly-keys (retired: placeholder)", "https://kingly-keys.xyz/products/gb-gmk-fro-yo"],
  // Live shops the check must never touch.
  ["zfrontier (LIVE app shell)", "https://www.zfrontier.com/app/mch/1xmjEGd2dQml"],
  ["funkeys (LIVE, unread platform)", "https://groupbuy.funkeys.com.ua/gmk_colorchrome"],
  ["mokbstore (LIVE, renamed handle)", "https://mokbstore.com/gb-mv-expo-gmk-cyl"],
  ["hexkeyboards (LIVE, /password)", "https://hexkeyboards.com/collections/group-buys/products/gb-gmk-blot"],
];

console.log("=== PAGE vs ROOT, and how much text each carries");
for (const [label, url] of CASES) {
  const page = await get(url);
  if (page.error) {
    console.log(`${label}\n   ERROR ${page.error}`);
    continue;
  }
  const root = await get(new URL(page.url).origin + "/");
  const norm = (h) => String(h ?? "").replace(/\s+/g, " ").trim();
  const equal = !!root.body && norm(page.body) === norm(root.body);
  const text = visibleText(page.body);
  const rootText = visibleText(root.body);
  const scripts = [...page.body.matchAll(/<script[^>]*src=["'][^"']+["']/gi)].length;
  console.log(
    `${label}\n   ${page.status} ${page.body.length}b | equals-root=${equal}` +
      ` | page-text=${text.length} | root-text=${rootText.length} | script-src=${scripts}`
  );
  console.log(`   text: ${JSON.stringify(text.slice(0, 180))}`);
}

// ── Which rows the false verdict can reach ──────────────────────────────────
if (process.env.DATABASE_URL) {
  let cs = process.env.DATABASE_URL;
  if (cs.includes("__PASSWORD__")) {
    cs = cs.replace("__PASSWORD__", encodeURIComponent(process.env.DATABASE_PASSWORD ?? ""));
  }
  cs = cs.replace(/:5432(\/|$|\?)/, ":6543$1");
  const client = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const { rows } = await client.query(`
    SELECT v.slug, gb.status::text AS gb_status,
           count(*)::int AS rows,
           count(*) FILTER (WHERE vk."deadSince" IS NOT NULL)::int AS dead,
           count(*) FILTER (WHERE vk.price IS NOT NULL)::int AS priced,
           max(vk."deadSince") AS newest_dead
      FROM public."VendorKit" vk
      JOIN public."Vendor" v ON v.id = vk."vendorId"
      JOIN public."Kit" k ON k.id = vk."kitId"
      JOIN public."GroupBuy" gb ON gb.id = k."groupBuyId"
     WHERE vk."productUrl" ILIKE '%zfrontier.com%'
     GROUP BY v.slug, gb.status
     ORDER BY v.slug, gb.status
  `);
  console.log("\n=== zfrontier.com rows in production, by vendor and set status");
  for (const r of rows) {
    console.log(
      `${r.slug} | ${r.gb_status} | rows=${r.rows} dead=${r.dead} priced=${r.priced}` +
        ` newestDead=${r.newest_dead ? new Date(r.newest_dead).toISOString().slice(0, 10) : "-"}`
    );
  }
  const { rows: recent } = await client.query(`
    SELECT v.slug, count(*)::int AS newly_dead
      FROM public."VendorKit" vk
      JOIN public."Vendor" v ON v.id = vk."vendorId"
     WHERE vk."deadSince" >= now() - interval '3 days'
     GROUP BY v.slug ORDER BY 2 DESC LIMIT 15
  `);
  console.log("\n=== rows marked gone in the last 3 days");
  for (const r of recent) console.log(`${r.slug} | ${r.newly_dead}`);
  await client.end();
}
