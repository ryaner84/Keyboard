import { unstable_cache } from "next/cache";

// Shared cache layer for the homepage's read-only queries.
//
// The homepage fires 13 Prisma calls per view. Under `force-dynamic` that is 13
// round trips for EVERY visitor, which is the load this module removes: the
// queries are shared across requests, so the cost becomes 13 calls per TTL
// instead of 13 per view.
//
// Why not `export const revalidate` (page-level ISR) instead:
//
//  1. Every loader in page.tsx swallows DB errors and returns []/zeros so the
//     page degrades instead of 500ing. Page-level ISR would CACHE that fallback
//     — one transient blip at generation time would pin an empty homepage
//     reading "0 Active Group Buys" for the whole TTL, for every visitor.
//     Wrapping the queries instead lets the try/catch sit OUTSIDE the cache:
//     unstable_cache only writes after its callback RESOLVES (see
//     next/dist/server/web/spec-extension/unstable-cache.js — `cacheNewResult`
//     is unreachable when the callback throws), so a rejection is never stored
//     and the next request simply retries.
//  2. ISR prerenders at build time, which would reintroduce a build-time
//     database dependency that page.tsx deliberately avoids.
//
// Keeping the page dynamic and caching the DATA gets the load win without
// either hazard.

export const HOME_CACHE_TAG = "home";

// Most homepage queries filter on status/featured enums only. Their writers are
// the nightly scraper and the 16:00 UTC status sweep, so minutes of staleness
// cost nothing — and the sweep busts this tag explicitly (see
// src/app/api/cron/refresh/route.ts).
export const STATIC_TTL = 300;

// "Finishing soon" and "New group buys" compare gbEnd/gbStart against `now`.
// `now` is evaluated on cache MISS, so it freezes for the TTL: a group buy that
// ends mid-window keeps showing until the entry expires, under a heading that
// says "≤ 7 days left" while its own countdown pill (computed client-side at
// view time) already reads "Ended". A short TTL bounds how long that
// self-contradiction can be on screen.
export const WINDOWED_TTL = 60;

/**
 * Cache one homepage query. The callback must THROW on failure rather than
 * returning a fallback — a thrown error is deliberately not cached, so callers
 * put their try/catch around the returned function, not inside it.
 */
export function cachedHomeQuery<T>(
  key: string,
  loader: () => Promise<T>,
  revalidate: number
): () => Promise<T> {
  return unstable_cache(loader, ["home", key], {
    revalidate,
    tags: [HOME_CACHE_TAG],
  });
}
