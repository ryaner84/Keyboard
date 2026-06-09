import { prisma } from "@/lib/prisma";
import { fetchGmkGallery } from "./gmk-images";

const DEFAULT_LIMIT = 60;
const DEFAULT_MAX_RUNTIME_MS = 45_000;

export interface EnrichOptions {
  limit?: number;
  maxRuntimeMs?: number;
}

export interface EnrichResult {
  attempted: number;
  enriched: number; // sets that gained at least one new image
  failed: number; // gmk.net blocked or returned nothing
  stoppedEarly: boolean;
}

// Walk sets that list a gmk.net product URL but only have the single KeycapLendar
// render, and try to pull GMK's per-kit gallery images. Best-effort: gmk.net
// bot-protects, so many attempts will return nothing — those just retry next run.
export async function enrichImagesFromGmk(opts: EnrichOptions = {}): Promise<EnrichResult> {
  const { limit = DEFAULT_LIMIT, maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS } = opts;
  const start = Date.now();

  const candidates = await prisma.groupBuy.findMany({
    where: {
      kits: { some: { vendorKits: { some: { productUrl: { contains: "gmk.net" } } } } },
    },
    select: {
      id: true,
      images: true,
      imageUrl: true,
      kits: { select: { vendorKits: { select: { productUrl: true } } } },
    },
    take: limit,
  });

  const result: EnrichResult = { attempted: 0, enriched: 0, failed: 0, stoppedEarly: false };

  for (const gb of candidates) {
    if (Date.now() - start > maxRuntimeMs) {
      result.stoppedEarly = true;
      break;
    }

    // Already enriched (more than just the render) — skip.
    if ((gb.images?.length ?? 0) > 1) continue;

    const gmkUrl = gb.kits
      .flatMap((k) => k.vendorKits)
      .map((vk) => vk.productUrl)
      .find((u): u is string => !!u && /gmk\.net/i.test(u));
    if (!gmkUrl) continue;

    result.attempted++;
    const gallery = await fetchGmkGallery(gmkUrl);
    if (gallery.length === 0) {
      result.failed++;
      continue;
    }

    // Keep the KeycapLendar render first, then any new gallery images, de-duped.
    const base = gb.images && gb.images.length > 0 ? gb.images : gb.imageUrl ? [gb.imageUrl] : [];
    const merged = Array.from(new Set([...base, ...gallery]));

    if (merged.length > base.length) {
      await prisma.groupBuy.update({ where: { id: gb.id }, data: { images: merged } });
      result.enriched++;
    } else {
      result.failed++;
    }
  }

  return result;
}
