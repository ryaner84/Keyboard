// TEMPORARY diagnostic — removed before this branch is proposed.
//
// Two questions the standard vendor probe cannot answer:
//   1. Is www.zfrontier.com/app/<kind>/<hash> byte-identical to the site root,
//      and if not, WHERE do the two documents differ? isGoneFrontPage answers
//      DEAD_LINK when they are equal after whitespace normalization, and it
//      answered DEAD_LINK for two of three live listings on run 34239886634.
//   2. Does the page carry the product data anywhere a parser could read it —
//      an embedded state blob, or an app API keyed by the hash?
import { pageFingerprint } from "./lib/link-health.mjs";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function get(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: accept ? { ...HEADERS, Accept: accept } : HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, url: res.url, body, type: res.headers.get("content-type") };
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const ORIGIN = "https://www.zfrontier.com";
const PAGES = [
  "/app/mch/1xmjEGd2dQml",
  "/app/eqp/RG65AYaX2eQl",
  "/app/mch/B5xZk90GGz9o",
];

// ── 1. Is the shell stable, and how does it differ from the root? ────────────
console.log("=== SHELL STABILITY");
const roots = [await get(`${ORIGIN}/`), await get(`${ORIGIN}/`)];
console.log(
  `root fetched twice: ${roots.map((r) => r.body?.length ?? r.error).join(" vs ")} bytes, ` +
    `identical=${pageFingerprint(roots[0].body) === pageFingerprint(roots[1].body)}`
);

for (const path of PAGES) {
  const a = await get(`${ORIGIN}${path}`);
  const b = await get(`${ORIGIN}${path}`);
  if (a.error || b.error) {
    console.log(`${path} | ERROR ${a.error ?? b.error}`);
    continue;
  }
  const fa = pageFingerprint(a.body);
  const fb = pageFingerprint(b.body);
  const froot = pageFingerprint(roots[0].body);
  console.log(
    `${path} | ${a.body.length}b | self-stable=${fa === fb} | equals-root=${fa === froot}`
  );
  if (fa !== froot) {
    let i = 0;
    while (i < fa.length && i < froot.length && fa[i] === froot[i]) i++;
    console.log(`   first difference at ${i}: page=${JSON.stringify(fa.slice(i - 60, i + 90))}`);
    console.log(`                            root=${JSON.stringify(froot.slice(i - 60, i + 90))}`);
  }
  // Visible text (scripts/styles stripped): an app SHELL renders its content
  // client-side and so carries almost none; a retirement landing page IS the
  // content and carries plenty.
  const text = a.body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  console.log(`   visible text ${text.length} chars: ${JSON.stringify(text.slice(0, 200))}`);
  const scripts = [...a.body.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log(`   ${scripts.length} external script(s): ${scripts.slice(0, 4).join(" ")}`);
  const stateKeys = [...a.body.matchAll(/window\.(__[A-Z_]+__|[A-Za-z_$]+)\s*=/g)].map((m) => m[1]);
  console.log(`   window assignments: ${[...new Set(stateKeys)].slice(0, 8).join(", ") || "(none)"}`);
}

// ── 2. Where does the app get its data? ─────────────────────────────────────
console.log("\n=== API CANDIDATES");
const hash = "1xmjEGd2dQml";
const CANDIDATES = [
  `${ORIGIN}/v2/mch/detail?hash=${hash}`,
  `${ORIGIN}/v2/mch/${hash}`,
  `${ORIGIN}/api/mch/${hash}`,
  `${ORIGIN}/api/v2/mch/detail?hash=${hash}`,
  `${ORIGIN}/app/api/mch/${hash}`,
  `${ORIGIN}/v2/flow/detail?hash=${hash}`,
  `${ORIGIN}/api/flow/${hash}`,
  `${ORIGIN}/v2/eqp/detail?hash=RG65AYaX2eQl`,
];
for (const url of CANDIDATES) {
  const r = await get(url, "application/json, text/plain, */*");
  if (r.error) {
    console.log(`${url} | ERROR ${r.error}`);
    continue;
  }
  const looksJson = (r.type ?? "").includes("json");
  console.log(
    `${url} | ${r.status} | ${r.type} | ${r.body.length}b${
      looksJson ? ` | ${JSON.stringify(r.body.slice(0, 300))}` : ""
    }`
  );
}
