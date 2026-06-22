// Serverless importer for the Lightning Keyboards build showcase
// (lightningkeyboards.com). It's a Squarespace portfolio paginated as
// /work-pt-1/ … /work-pt-N/; each part is a grid of build cards linking to
// /work-pt-N/<handle> detail pages (title + photo gallery).
//
// Unlike the WorkSpace Playwright pass, this runs from Vercel with plain fetch
// — Squarespace serves the markup server-side, so the grid links and detail
// galleries are present without a browser. Each build becomes a no-price,
// DELIVERED keyboard entry (slug "lk-<handle>") that's searchable and addable
// to a collection.
//
// Idempotent + resumable: builds whose slug already exists are skipped, so the
// endpoint can be hit repeatedly to finish a large first backfill, and nightly
// runs only fetch detail pages for newly-added builds.

import { prisma } from "@/lib/prisma";

const LK_BASE = "https://www.lightningkeyboards.com";
const LK_MAX_PART_PROBE = 60; // safety ceiling when probing upward for new parts
const FETCH_TIMEOUT_MS = 10_000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Anchor to a build detail page: /work-pt-<n>/<handle> (relative or absolute).
const LINK_RE =
  /href="(?:https:\/\/www\.lightningkeyboards\.com)?\/work-pt-(\d+)\/([^"#?\s]+)"/gi;
const SQSP_IMG_RE =
  /https:\/\/images\.squarespace-cdn\.com\/[^\s"'<>)\\]+/gi;
const OG_TITLE_RE = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i;
const OG_IMG_RE = /<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i;
const OG_DESC_RE = /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i;

const LAYOUT_PATTERNS: [RegExp, string][] = [
  [/\b(100%|full[\s-]?size|fullsize)\b/i, "Full-size"],
  [/\b(tkl|80%|tenkeyless)\b/i, "TKL"],
  [/\b75%\b/i, "75%"],
  [/\b65%\b/i, "65%"],
  [/\b60%\b/i, "60%"],
  [/\b40%\b/i, "40%"],
  [/\b(alice|arisu)\b/i, "Alice/Arisu"],
  [/\bsplit\b/i, "Split"],
  [/\b(numpad|num\s?pad)\b/i, "Numpad"],
];

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

async function fetchText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

interface BuildLink {
  handle: string;
  part: number;
  url: string;
}

// Parse the build-card links from a /work-pt-N/ grid page. Returns [] when the
// part doesn't exist (Squarespace 404s render as 200, so "no links" = the end).
function parseBuildLinks(markup: string, part: number): BuildLink[] {
  const out: BuildLink[] = [];
  const seen = new Set<string>();
  for (const m of Array.from(markup.matchAll(LINK_RE))) {
    if (Number(m[1]) !== part) continue; // ignore nav links to other parts
    const handle = m[2].replace(/\/+$/, "");
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push({ handle, part, url: `${LK_BASE}/work-pt-${part}/${handle}` });
  }
  return out;
}

interface ScrapedBuild {
  handle: string;
  title: string;
  url: string;
  images: string[];
  description: string;
}

function parseBuildDetail(markup: string, link: BuildLink): ScrapedBuild | null {
  let title = link.handle.replace(/-/g, " ").trim();
  const mt = OG_TITLE_RE.exec(markup);
  if (mt && mt[1].trim()) title = decodeEntities(mt[1]).trim();

  const images: string[] = [];
  const bases = new Set<string>();
  const addImg = (raw: string) => {
    const base = raw.split("?")[0];
    if (base && !bases.has(base)) {
      bases.add(base);
      images.push(base); // base CDN URL is stable; query tokens expire
    }
  };
  const mi = OG_IMG_RE.exec(markup);
  if (mi && mi[1].trim()) addImg(mi[1].trim());
  for (const m of Array.from(markup.matchAll(SQSP_IMG_RE))) {
    addImg(m[0]);
    if (images.length >= 12) break;
  }
  if (images.length === 0) return null; // no photos → not a real build page

  let description = "";
  const md = OG_DESC_RE.exec(markup);
  if (md && md[1].trim()) description = decodeEntities(md[1]).trim().slice(0, 1000);

  return { handle: link.handle, title: title.slice(0, 200), url: link.url, images, description };
}

function detectLayout(text: string): string | null {
  for (const [re, value] of LAYOUT_PATTERNS) if (re.test(text)) return value;
  return null;
}

export interface LightningResult {
  parts: number;
  builds: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  stoppedEarly: boolean;
  sample: string[]; // first few created/updated titles, for verification
}

export async function importLightning(
  { maxRuntimeMs = 45_000 }: { maxRuntimeMs?: number } = {}
): Promise<LightningResult> {
  const deadline = Date.now() + maxRuntimeMs;
  const result: LightningResult = {
    parts: 0,
    builds: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    stoppedEarly: false,
    sample: [],
  };

  // Existing showcase slugs → skip detail fetches for builds already imported.
  const existing = await prisma.groupBuy.findMany({
    where: { slug: { startsWith: "lk-" } },
    select: { slug: true },
  });
  const known = new Set(existing.map((r) => r.slug));

  for (let part = 1; part <= LK_MAX_PART_PROBE; part++) {
    if (Date.now() > deadline) {
      result.stoppedEarly = true;
      break;
    }
    const gridMarkup = await fetchText(`${LK_BASE}/work-pt-${part}/`);
    if (gridMarkup == null) {
      // Network error vs. genuine end is indistinguishable; stop probing.
      break;
    }
    const links = parseBuildLinks(gridMarkup, part);
    if (links.length === 0) break; // contiguous numbering — first empty part ends it
    result.parts++;

    for (const link of links) {
      if (Date.now() > deadline) {
        result.stoppedEarly = true;
        break;
      }
      const slug = `lk-${link.handle}`.slice(0, 120);
      if (known.has(slug)) {
        result.skipped++;
        continue;
      }
      const markup = await fetchText(link.url);
      if (markup == null) {
        result.failed++;
        continue;
      }
      const build = parseBuildDetail(markup, link);
      if (!build) {
        result.failed++;
        continue;
      }
      try {
        const layout = detectLayout(`${build.title} ${build.description}`);
        const data = {
          name: build.title,
          status: "DELIVERED" as const,
          productType: "KEYBOARD",
          imageUrl: build.images[0],
          images: build.images,
          description: build.description || null,
          productUrl: build.url,
          vendorName: "Lightning Keyboards",
        };
        const created = !(await prisma.groupBuy.findUnique({
          where: { slug },
          select: { id: true },
        }));
        await prisma.groupBuy.upsert({
          where: { slug },
          create: {
            slug,
            designer: "",
            layout: layout ?? undefined,
            ...data,
          },
          update: {
            // Refresh photos/title; never clobber a manually-set layout.
            ...data,
          },
        });
        known.add(slug);
        result.builds++;
        if (created) result.created++;
        else result.updated++;
        if (result.sample.length < 8) result.sample.push(build.title);
      } catch {
        result.failed++;
      }
    }
  }

  return result;
}
