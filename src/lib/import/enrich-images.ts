import { prisma } from "@/lib/prisma";
import { fetchGmkGallery } from "./gmk-images";

const DEFAULT_LIMIT = 60;
const DEFAULT_MAX_RUNTIME_MS = 45_000;

// How long a scraped gallery stays fresh before the rotation revisits it.
const GALLERY_MAX_AGE_DAYS = 7;

export interface EnrichOptions {
  limit?: number;
  maxRuntimeMs?: number;
}

export interface EnrichResult {
  attempted: number;
  enriched: number; // sets whose gallery changed
  failed: number; // gmk.net blocked or returned nothing
  stoppedEarly: boolean;
}

// True for images scraped from gmk.net — the only ones the gallery rebuild may
// replace. KeycapLendar renders and admin-entered images from elsewhere are kept.
function isGmkMedia(url: string): boolean {
  return /gmk\.net/i.test(url);
}

// Walk sets that list a gmk.net product URL, oldest-checked gallery first, and
// REBUILD each gallery from a fresh scrape: keep non-gmk images (KeycapLendar
// render, manual entries) in order, then append the trimmed gmk gallery. This
// replaces — never merges with — previously scraped gmk images, so a gallery
// polluted by an older scraper self-heals on its next visit.
//
// Best-effort: gmk.net bot-protects serverless IPs, so most attempts here fail
// and the real work happens on the WorkSpace scraper (scraper/scrape.py, same
// logic). Every attempt stamps imagesUpdatedAt so the rotation moves on.
export async function enrichImagesFromGmk(opts: EnrichOptions = {}): Promise<EnrichResult> {
  const { limit = DEFAULT_LIMIT, maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS } = opts;
  const start = Date.now();
  const staleCutoff = new Date(Date.now() - GALLERY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await prisma.groupBuy.findMany({
    where: {
      kits: { some: { vendorKits: { some: { productUrl: { contains: "gmk.net" } } } } },
      OR: [{ imagesUpdatedAt: null }, { imagesUpdatedAt: { lt: staleCutoff } }],
    },
    select: {
      id: true,
      images: true,
      imageUrl: true,
      kits: { select: { vendorKits: { select: { productUrl: true } } } },
    },
    orderBy: [{ imagesUpdatedAt: { sort: "asc", nulls: "first" } }],
    take: limit,
  });

  const result: EnrichResult = { attempted: 0, enriched: 0, failed: 0, stoppedEarly: false };

  for (const gb of candidates) {
    if (Date.now() - start > maxRuntimeMs) {
      result.stoppedEarly = true;
      break;
    }

    const gmkUrl = gb.kits
      .flatMap((k) => k.vendorKits)
      .map((vk) => vk.productUrl)
      .find((u): u is string => !!u && /gmk\.net/i.test(u));
    if (!gmkUrl) continue;

    result.attempted++;
    const gallery = await fetchGmkGallery(gmkUrl);
    if (gallery.length === 0) {
      // Blocked/empty — record the attempt so the rotation moves to the next set.
      await prisma.groupBuy.update({
        where: { id: gb.id },
        data: { imagesUpdatedAt: new Date() },
      });
      result.failed++;
      continue;
    }

    // Rebuild: trusted non-gmk images first (render stays the hero), then the
    // fresh gmk gallery, de-duped in order.
    const existing = gb.images && gb.images.length > 0 ? gb.images : gb.imageUrl ? [gb.imageUrl] : [];
    const kept = existing.filter((u) => !isGmkMedia(u));
    const rebuilt = Array.from(new Set([...kept, ...gallery]));

    const changed =
      rebuilt.length !== existing.length || rebuilt.some((u, i) => u !== existing[i]);
    await prisma.groupBuy.update({
      where: { id: gb.id },
      data: {
        imagesUpdatedAt: new Date(),
        ...(changed ? { images: rebuilt, imageUrl: rebuilt[0] } : {}),
      },
    });
    // Unchanged gallery is a successful verification, not a failure.
    if (changed) result.enriched++;
  }

  return result;
}
