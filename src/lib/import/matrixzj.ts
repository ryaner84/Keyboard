// matrixzj.github.io/docs/gmk-keycaps is the most complete community index of
// every GMK keycap set ever produced. It's a static GitHub Pages site — no bot
// protection, fetchable from Vercel serverless. We use it as the primary set
// catalog (replaces KeycapLendar as the list of "does this set exist").
//
// For each set we also try fetching the order statistics images:
//   order.png         — units ordered vs MOQ, with extras, includes GB dates + prices
//   order_no_extra.png — same chart, extras excluded
// These only exist for some sets (usually delivered ones with public order data).
// They go at the END of the images array so the keyboard render stays the hero.

import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import type { GBStatus } from "@/generated/prisma";

const MATRIXZJ_BASE = "https://matrixzj.github.io";
const MATRIXZJ_INDEX = `${MATRIXZJ_BASE}/docs/gmk-keycaps/`;
const MATRIXZJ_ASSETS = `${MATRIXZJ_BASE}/assets/images/gmk-keycaps`;

const FETCH_TIMEOUT_MS = 12_000;
const HEAD_TIMEOUT_MS = 6_000;
// Concurrent HEAD requests for order-image existence checks.
const HEAD_CONCURRENCY = 12;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,*/*",
};

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function headExists(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS);
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// Run tasks in batches of `concurrency` — faster than sequential but avoids
// hammering GitHub's CDN with 1400 simultaneous HEAD requests.
async function batchAsync<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

interface SetLink {
  folder: string;      // e.g. "CYL-Alter-Redux"
  displayName: string; // e.g. "CYL Alter Redux"  (from link text, or derived)
}

// Extract set links from the matrixzj index page.
// The "just-the-docs" Jekyll theme renders nav links like:
//   href="/docs/gmk-keycaps/CYL-Alter-Redux/"
// We capture both the folder (from href) and the display name (from link text).
function parseSetLinks(html: string): SetLink[] {
  const seen = new Set<string>();
  const sets: SetLink[] = [];

  // Match all anchor tags linking into /docs/gmk-keycaps/{folder}
  const re =
    /href=["'](?:https:\/\/matrixzj\.github\.io)?\/docs\/gmk-keycaps\/([^/"?#\s]+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const folder = m[1].trim();
    if (!folder || folder === "index" || seen.has(folder)) continue;
    // Strip any HTML tags from the link text
    const rawText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    seen.add(folder);
    sets.push({ folder, displayName: rawText || folder.replace(/-/g, " ") });
  }

  return sets;
}

// Derive slug variants to maximise matching against existing DB records.
// matrixzj uses "CYL-" prefix for many sets; our DB might have been imported
// without it from KeycapLendar. We try both.
function slugVariants(folder: string): string[] {
  const displayName = folder.replace(/-/g, " ");
  const withGmk = `GMK ${displayName}`;
  const variants = [slugify(withGmk)];

  // Without the "CYL " profile prefix (older KeycapLendar imports omit it)
  const withoutCyl = slugify(withGmk.replace(/\bCYL\s+/i, ""));
  if (withoutCyl !== variants[0]) variants.push(withoutCyl);

  return variants;
}

function orderImgUrl(folder: string) {
  return `${MATRIXZJ_ASSETS}/${folder}/order.png`;
}
function orderNoExtraImgUrl(folder: string) {
  return `${MATRIXZJ_ASSETS}/${folder}/order_no_extra.png`;
}

// Merge order images into an existing images array.
// Order images go at the END — the keyboard render stays the hero.
// We never add a matrixzj image that's already present.
function mergeOrderImages(
  existing: string[],
  orderImg: string | null,
  orderNoExtraImg: string | null
): string[] {
  const toAdd = [orderImg, orderNoExtraImg].filter((u): u is string => {
    return !!u && !existing.includes(u);
  });
  return toAdd.length > 0 ? [...existing, ...toAdd] : existing;
}

export interface MatrixzjImportOptions {
  maxRuntimeMs?: number;
}

export interface MatrixzjImportResult {
  setsFound: number;
  created: number;
  imagesAdded: number; // sets whose images array grew
  stoppedEarly: boolean;
}

export async function importFromMatrixzj(
  opts: MatrixzjImportOptions = {}
): Promise<MatrixzjImportResult> {
  const { maxRuntimeMs = 50_000 } = opts;
  const start = Date.now();
  const result: MatrixzjImportResult = {
    setsFound: 0,
    created: 0,
    imagesAdded: 0,
    stoppedEarly: false,
  };

  // 1. Fetch the index page
  const html = await fetchHtml(MATRIXZJ_INDEX);
  if (!html) return result;

  const links = parseSetLinks(html);
  result.setsFound = links.length;

  if (links.length === 0) return result;

  // 2. Bulk-load existing sets so we diff without per-row queries
  const existingSets = await prisma.groupBuy.findMany({
    select: { id: true, slug: true, images: true, imageUrl: true },
  });
  const bySlug = new Map(existingSets.map((s) => [s.slug, s]));

  // 3. Resolve which DB record each matrixzj folder maps to (if any)
  interface Resolved {
    link: SetLink;
    dbId: string | null;
    dbImages: string[];
    slug: string; // canonical slug to use for create
  }

  const resolved: Resolved[] = links.map((link) => {
    const variants = slugVariants(link.folder);
    for (const v of variants) {
      const rec = bySlug.get(v);
      if (rec) {
        return {
          link,
          dbId: rec.id,
          dbImages: rec.images ?? (rec.imageUrl ? [rec.imageUrl] : []),
          slug: v,
        };
      }
    }
    return {
      link,
      dbId: null,
      dbImages: [],
      slug: variants[0], // primary slug for new record
    };
  });

  // 4. Determine which sets need order-image checks:
  //    - Sets not yet in DB always need checking.
  //    - Sets already in DB but WITHOUT any matrixzj image need checking.
  //    - Sets that already have matrixzj order images → skip (already done).
  const needsCheck = resolved.filter(
    (r) => !r.dbImages.some((u) => u.includes("matrixzj.github.io"))
  );

  // 5. Batch HEAD checks (cheap GitHub CDN, low latency)
  interface CheckResult {
    resolved: Resolved;
    orderImg: string | null;
    orderNoExtraImg: string | null;
  }

  const checked = await batchAsync<Resolved, CheckResult>(
    needsCheck,
    async (r) => {
      const [hasOrder, hasNoExtra] = await Promise.all([
        headExists(orderImgUrl(r.link.folder)),
        headExists(orderNoExtraImgUrl(r.link.folder)),
      ]);
      return {
        resolved: r,
        orderImg: hasOrder ? orderImgUrl(r.link.folder) : null,
        orderNoExtraImg: hasNoExtra ? orderNoExtraImgUrl(r.link.folder) : null,
      };
    },
    HEAD_CONCURRENCY
  );

  if (Date.now() - start > maxRuntimeMs) {
    result.stoppedEarly = true;
    return result;
  }

  // 6. Write to DB
  for (const { resolved: r, orderImg, orderNoExtraImg } of checked) {
    if (Date.now() - start > maxRuntimeMs) {
      result.stoppedEarly = true;
      break;
    }

    const merged = mergeOrderImages(r.dbImages, orderImg, orderNoExtraImg);
    const imagesChanged = merged.length > r.dbImages.length;

    if (r.dbId) {
      // Existing set — add order images if we found any
      if (imagesChanged) {
        await prisma.groupBuy.update({
          where: { id: r.dbId },
          data: { images: merged, imageUrl: merged[0] ?? r.dbImages[0] },
        });
        result.imagesAdded++;
      }
    } else {
      // New set — create it with whatever images we have
      const images = merged; // only order images at this point
      try {
        await prisma.groupBuy.create({
          data: {
            slug: r.slug,
            name: `GMK ${r.link.displayName}`,
            colorway: r.link.displayName,
            designer: "",
            // Default to DELIVERED — most matrixzj sets are historical.
            // KeycapLendar supplement will update status/dates for active ones.
            status: "DELIVERED" as GBStatus,
            imageUrl: images[0] ?? null,
            images,
            featured: false,
            kits: { create: [{ name: "Base Kit", type: "BASE" }] },
          },
        });
        result.created++;
      } catch {
        // Slug collision race — ignore (the set was created concurrently or on
        // a previous run; the next cron will add images via the update path).
      }
    }
  }

  return result;
}
