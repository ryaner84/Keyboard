import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CACHE_TAG, STATIC_TTL, WINDOWED_TTL } from "@/lib/home-cache";

// The homepage's safety property, asserted against the source itself.
//
// Every loader in page.tsx swallows DB errors and returns []/zeros so the page
// degrades instead of 500ing. That fallback MUST stay outside the cache:
// unstable_cache writes only after its callback resolves, so a thrown error is
// never stored and the next request retries. Move a try/catch inside a
// cachedHomeQuery callback and the fallback becomes cacheable — one transient
// blip would pin an empty homepage reading "0 Active Group Buys" for the whole
// TTL, for every visitor. That is a silent, plausible-looking regression, so it
// is pinned here rather than left to review.

const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");

// --- every cached loader is followed by a catching wrapper -----------------
const cachedLoaders: string[] = [];
const loaderRe = /const (load\w+) = cachedHomeQuery\(/g;
let loaderMatch: RegExpExecArray | null;
while ((loaderMatch = loaderRe.exec(page)) !== null) {
  cachedLoaders.push(loaderMatch[1]);
}
assert.ok(
  cachedLoaders.length >= 9,
  `expected the 9 homepage loaders to be cached, found ${cachedLoaders.length}: ${cachedLoaders}`
);

for (const loader of cachedLoaders) {
  assert.ok(
    new RegExp(`try\\s*{\\s*return await ${loader}\\(\\);\\s*}\\s*catch`).test(page),
    `${loader} must be called inside a try/catch that lives OUTSIDE the cache, ` +
      `so its error fallback is never cached`
  );
}

// --- no try/catch inside a cachedHomeQuery callback -----------------------
// Walk each cachedHomeQuery( ... ) call by brace matching and assert the body
// contains no catch — a regex alone can't respect nesting.
const callRe = /cachedHomeQuery\(/g;
let callMatch: RegExpExecArray | null;
while ((callMatch = callRe.exec(page)) !== null) {
  const start = callMatch.index + callMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < page.length && depth > 0) {
    const ch = page[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  const body = page.slice(start, i);
  assert.ok(
    !/\bcatch\b/.test(body),
    "a cachedHomeQuery callback contains a catch — the error fallback would " +
      "be cached and served to everyone for the whole TTL. Move it outside."
  );
}

// --- the page stays dynamic ------------------------------------------------
// Page-level ISR would prerender at build, reintroducing the build-time DB
// dependency this file's header comment exists to avoid.
assert.ok(
  /export const dynamic = "force-dynamic"/.test(page),
  "page.tsx must stay force-dynamic; caching happens at the query layer"
);
assert.ok(
  !/export const revalidate/.test(page),
  "page-level revalidate would cache the loaders' error fallbacks"
);

// --- TTLs are sane ---------------------------------------------------------
// Windowed queries freeze `now` for their TTL, so they must expire faster than
// the time-independent ones.
assert.ok(WINDOWED_TTL < STATIC_TTL, "windowed data must expire sooner than static data");
assert.ok(WINDOWED_TTL >= 30, "too short a TTL defeats the point of caching");
assert.equal(HOME_CACHE_TAG, "home");

// The cron status sweep must bust the cache, or the homepage keeps counting
// ended group buys as active while the rest of the site has moved on.
const cron = readFileSync(
  join(process.cwd(), "src/app/api/cron/refresh/route.ts"),
  "utf8"
);
assert.ok(
  /revalidateTag\(HOME_CACHE_TAG\)/.test(cron),
  "the refresh cron must revalidateTag(HOME_CACHE_TAG) after the status sweep"
);

console.log("home-cache invariant checks passed");
