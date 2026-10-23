// What a VISITOR may see of a public collection piece, decided in one place.
//
// The public page, the share poster (og:image) and the photo-report endpoint
// each used to decide this for themselves, and they drifted: the page learned
// to skip a hidden build 1 while the poster kept drawing its photo, and kept
// drawing an old keycap photo after the owner made that purchase private. Every
// public surface now asks these helpers, and test:public-collection pins them.
//
// Server-only in practice (node:crypto), but free of Prisma so it is testable.
import { createHash } from "node:crypto";

// ── Keyboards ───────────────────────────────────────────────────────────────

// 0-based ORIGINAL build indexes the owner keeps off the public page.
export function hiddenBuildSet(hiddenBuilds: unknown): Set<number> {
  return new Set(
    Array.isArray(hiddenBuilds)
      ? hiddenBuilds.map((index) => Number(index)).filter((index) => Number.isInteger(index))
      : []
  );
}

// The original indexes of the builds a visitor may see, in build order.
export function visibleBuildIndexes(quantity: number | null | undefined, hiddenBuilds: unknown): number[] {
  const hidden = hiddenBuildSet(hiddenBuilds);
  const count = Math.max(1, Math.min(99, quantity || 1));
  return Array.from({ length: count }, (_, index) => index).filter((index) => !hidden.has(index));
}

// A build's own uploaded photo. Build 1 lives in the record's top-level
// customImageUrl, builds 2..N in the units JSON.
export function buildPhotoAt(customImageUrl: unknown, units: unknown, index: number): string | null {
  const value =
    index === 0
      ? customImageUrl
      : Array.isArray(units)
        ? ((units[index - 1] ?? {}) as Record<string, unknown>).imageUrl
        : null;
  return typeof value === "string" && value.trim() ? value : null;
}

// ── Keycaps ─────────────────────────────────────────────────────────────────

export function hasPublicKeycapPurchase(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.some((acquisition) => {
    const data = (acquisition ?? {}) as Record<string, unknown>;
    return data.isPublic !== false;
  });
}

// ── The share poster ────────────────────────────────────────────────────────

export type CollectionGroupBuy = {
  name: string;
  designer: string;
  imageUrl: string | null;
  productType: string;
  layout: string | null;
  vendorName: string | null;
};


export interface PosterSourceItem {
  customImageUrl: string | null;
  quantity: number;
  hiddenBuilds: unknown;
  units: unknown;
  keycapAcquisitions: unknown;
  groupBuy: CollectionGroupBuy;
}

// Is any part of this piece public? A keyboard with every build hidden, or a
// keycap set with every purchase private, is not on the page and must not be
// counted or drawn anywhere else either.
export function isPieceDisplayed(item: PosterSourceItem): boolean {
  if (item.groupBuy.productType === "KEYBOARD") {
    return visibleBuildIndexes(item.quantity, item.hiddenBuilds).length > 0;
  }
  return hasPublicKeycapPurchase(item.keycapAcquisitions);
}

// The photo the poster draws for a piece. Only ever a PUBLIC photo:
// - a keyboard uses its first visible build that has an uploaded photo — never
//   build 1's top-level customImageUrl when build 1 is hidden;
// - a keycap set with per-purchase records uses a PUBLIC purchase's custom
//   photo, and never falls back to the legacy top-level customImageUrl — that
//   column outlives the purchase it was copied into, so after the owner made
//   that purchase private or switched it to the catalog photo it still held
//   the old image. Only a set that has never had purchases reads it.
// Anything else falls back to the catalog render.
export function posterItemImage(item: PosterSourceItem): string | null {
  if (item.groupBuy.productType === "KEYBOARD") {
    for (const index of visibleBuildIndexes(item.quantity, item.hiddenBuilds)) {
      const photo = buildPhotoAt(item.customImageUrl, item.units, index);
      if (photo) return photo;
    }
    return item.groupBuy.imageUrl;
  }
  if (Array.isArray(item.keycapAcquisitions) && item.keycapAcquisitions.length > 0) {
    const visible = item.keycapAcquisitions.find((acquisition) => {
      const data = (acquisition ?? {}) as Record<string, unknown>;
      return (
        data.isPublic !== false &&
        data.photoSource === "CUSTOM" &&
        typeof data.imageUrl === "string" &&
        data.imageUrl.trim() !== ""
      );
    }) as Record<string, unknown> | undefined;
    return (visible?.imageUrl as string | undefined) || item.groupBuy.imageUrl;
  }
  return item.customImageUrl || item.groupBuy.imageUrl;
}

const KNOWN_BRANDS: Array<[RegExp, string]> = [
  [/\bkeycult\b/i, "Keycult"],
  [/\btgr\b/i, "TGR"],
  [/\bmatrix(?:\s*lab)?\b/i, "Matrix Lab"],
  [/\bgeon(?:works)?\b/i, "Geon"],
  [/\bowlab\b/i, "OwLab"],
  [/\brama(?:\s*works)?\b/i, "RAMA"],
  [/\bmode(?:\s*designs)?\b/i, "Mode"],
  [/\bsinga\b/i, "Singa"],
  [/\bmonokei\b/i, "MONOKEI"],
  [/\bangry\s*miao\b/i, "Angry Miao"],
  [/\bqwertykeys\b/i, "Qwertykeys"],
  [/\bkbd\s*fans\b|\bkbdfans\b/i, "KBDfans"],
  [/\bpercent(?:\s*studio)?\b/i, "Percent Studio"],
  [/\bnorbauer\b|\bnorbaforce\b/i, "Norbauer"],
  [/\bsmith\s*(?:\+|&|and)\s*rune\b/i, "Smith + Rune"],
  [/\bcannon\s*keys\b|\bcannonkeys\b/i, "CannonKeys"],
  [/\bai03\b/i, "ai03"],
];

export function inferLayout(groupBuy: CollectionGroupBuy): string {
  const text = `${groupBuy.layout ?? ""} ${groupBuy.name}`.toLowerCase();
  if (/\b(?:f13\s*)?tkl\b|\b80%\b/.test(text)) return "TKL";
  if (/\b(?:full[\s-]?size|100%|104[\s-]?key)\b/.test(text)) return "Full-size";
  if (/\b1800\b/.test(text)) return "1800";
  if (/\b96%\b/.test(text)) return "96%";
  if (/\b75%\b|\b75[\s-]?key\b/.test(text)) return "75%";
  if (/\b70%\b/.test(text)) return "70%";
  if (/\b65%\b|\b6[568][\s-]?key\b/.test(text)) return "65%";
  if (/\bhhkb\b/.test(text)) return "HHKB";
  if (/\b60%\b|\b60[\s-]?key\b/.test(text)) return "60%";
  if (/\b50%\b/.test(text)) return "50%";
  if (/\b4[05]%\b|\b40s\b/.test(text)) return "40%";
  if (/\balice\b|\barisu\b/.test(text)) return "Alice";
  if (/\bsplit\b/.test(text)) return "Split";
  if (/\bortho(?:linear)?\b/.test(text)) return "Ortho";
  return "Other";
}

export function inferBrand(groupBuy: CollectionGroupBuy): string | null {
  const haystack = `${groupBuy.name} ${groupBuy.designer}`;
  const known = KNOWN_BRANDS.find(([pattern]) => pattern.test(haystack));
  if (known) return known[1];

  const designer = groupBuy.designer
    .replace(/\b(?:community group buy|independent design)\b/gi, "")
    .split(/\s+(?:x|×|by)\s+|\||,/i)[0]
    .replace(/^\s*(?:\[.*?\]\s*)+/, "")
    .trim();

  if (designer && designer.length <= 24) return designer;
  return null;
}

export function rankedCounts(
  values: Array<string | null>,
  limit: number
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function countKeycapKitCopies(value: unknown, legacyQuantity: number) {
  if (!Array.isArray(value) || value.length === 0) return Math.max(1, legacyQuantity || 1);
  return value.reduce((total, acquisition) => {
    const data = (acquisition ?? {}) as Record<string, unknown>;
    if (data.isPublic === false) return total;
    const kits = Array.isArray(data.kits) && data.kits.length > 0 ? data.kits.length : 1;
    const quantity = Math.max(1, Math.min(99, Number(data.quantity) || 1));
    return total + kits * quantity;
  }, 0);
}

export interface PosterModel {
  owner: string;
  title: string;
  bio: string | null;
  keyboards: number;
  displayed: number;
  keycapCount: number;
  layoutCounts: Array<{ label: string; count: number }>;
  brandCounts: Array<{ label: string; count: number }>;
  keycapMix: Array<{ label: string; count: number }>;
  // The first five displayed pieces' photos, in the collector's order.
  imageUrls: Array<string | null>;
}

// Everything the poster draws, and nothing else. The route renders from this,
// and the page's og:image cache token is a hash of it — so the token changes
// exactly when the picture would, and it is derived from public content only.
// It used to be max(updatedAt) over the owner and their public items, which
// published the owner's last activity to the millisecond and, when a piece was
// later hidden, could move BACKWARDS onto an older cached poster that still
// showed it.
export function buildPosterModel(collection: {
  displayName: string | null;
  collectionTitle: string | null;
  collectionBio: string | null;
  items: PosterSourceItem[];
}): PosterModel {
  const owner = collection.displayName || "Keyboard collector";
  const title = collection.collectionTitle || `${owner}'s collection`;
  const displayedItems = collection.items.filter(isPieceDisplayed);
  const keyboards = displayedItems
    .filter((item) => item.groupBuy.productType === "KEYBOARD")
    .map((item) => item.groupBuy);
  const keycapItems = displayedItems.filter((item) => item.groupBuy.productType !== "KEYBOARD");
  const keycapCount = keycapItems.length;
  const keycapKitCopies = keycapItems.reduce(
    (total, item) => total + countKeycapKitCopies(item.keycapAcquisitions, item.quantity),
    0
  );
  return {
    owner,
    title,
    bio: collection.collectionBio,
    keyboards: keyboards.length,
    displayed: displayedItems.length,
    keycapCount,
    layoutCounts: rankedCounts(keyboards.map(inferLayout), 5),
    brandCounts: rankedCounts(keyboards.map(inferBrand), 5),
    keycapMix:
      keycapCount > 0
        ? [
            { label: "Keycap sets", count: keycapCount },
            { label: "Kit copies", count: keycapKitCopies },
          ]
        : [],
    imageUrls: displayedItems.slice(0, 5).map(posterItemImage),
  };
}

export function posterVersion(model: PosterModel): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 16);
}
