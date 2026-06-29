import type { GBStatus } from "@/types";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// KeycapLendar's `image` field points at the original upload under `keysets/`,
// but those originals are deleted after the resize extension runs (HTTP 404).
// The surviving copy lives under `thumbs/` with the same access token. We rewrite
// the path at render time so images always load, regardless of what's stored in
// the database (older rows may still hold the broken `keysets/` path).
export function normalizeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace("keysets%2F", "thumbs%2F").replace("/keysets/", "/thumbs/");
}

// Verified manufacturer/vendor replacements for galleries whose original host
// removed the files or now rejects hotlinks. Keep these first in the candidate
// list so browse cards recover even when a deployment does not run db-setup.
const IMAGE_OVERRIDES: Record<string, string> = {
  "gh-117742":
    "https://keebsforall.com/cdn/shop/products/IMG-20220222-WA0010_306026171769143_b2453097-427a-45e8-8dec-c761a74f9b5d.jpg?v=1703031359&width=1533",
  "gmk-hangulbeit":
    "https://www.gmk.net/shop/media/40/f9/26/1765191031/GMK_CYL_Hangulbeit_Keycaps%20%283%29.webp?ts=1765191049",
  "gmk-unobtainium-blue":
    "https://novelkeys.com/cdn/shop/files/GMK_CYL_Unobtainium_TILE_1200x.jpg?v=1778615730",
  "gmk-mtnu-divinapapaya":
    "https://www.gmk.net/shop/media/eb/4c/2c/1765538863/GMK_CYL-MTNU_Divinapapaya_Keycaps%20%282%29.webp?ts=1765539130",
};

// Some imports have a populated gallery but a null or stale hero image. Cards
// therefore use both fields and advance through every candidate on load errors.
export function getImageCandidates(
  imageUrl: string | null | undefined,
  images: string[] | null | undefined = [],
  slug?: string
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const override = slug ? IMAGE_OVERRIDES[slug] : null;
  for (const raw of [override, imageUrl, ...(images ?? [])]) {
    if (!raw) continue;
    const normalized = normalizeImageUrl(raw);
    for (const candidate of [normalized, raw]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function formatDate(date: Date | string | null): string {
  if (!date) return "TBD";
  return new Date(date).toLocaleDateString("en-SG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateRange(
  start: Date | string | null,
  end: Date | string | null
): string {
  if (!start && !end) return "Dates TBD";
  if (start && !end) return `From ${formatDate(start)}`;
  if (!start && end) return `Until ${formatDate(end)}`;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

// Short relative date for "Updated …" labels, e.g. "today", "3 Jun".
export function formatRelativeDate(date: Date | string | null): string {
  if (!date) return "never";
  const d = new Date(date);
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString("en-SG", { day: "numeric", month: "short" });
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysUntil(target: Date): number {
  const today = new Date();
  const t = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const n = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return Math.round((t.getTime() - n.getTime()) / MS_PER_DAY);
}

// Countdown label shown on carousel art / cards.
// Active GBs count down to gbEnd; upcoming ones count up to gbStart.
export function getCountdownLabel(
  status: GBStatus,
  gbStart: Date | string | null,
  gbEnd: Date | string | null
): string | null {
  if (status === "ACTIVE_GB" && gbEnd) {
    const days = daysUntil(new Date(gbEnd));
    // gbEnd already passed — the GB is over, never "ending soon". (The daily
    // status sweep flips these to SHIPPING; this guards the window in between.)
    if (days < 0) return "Ended";
    if (days === 0) return "Ends today";
    if (days === 1) return "Last day";
    return `Remaining ${days} days`;
  }
  if (status === "INTEREST_CHECK") {
    if (gbStart) {
      const days = daysUntil(new Date(gbStart));
      if (days === 0) return "Starting today";
      if (days === 1) return "Starting tomorrow";
      if (days > 1) return `Starting in ${days} days`;
    }
    return "Interest Check";
  }
  if (status === "SHIPPING") return "Shipping now";
  if (status === "IN_STOCK") return "In stock";
  return null;
}

export const STATUS_LABELS: Record<GBStatus, string> = {
  INTEREST_CHECK: "Interest Check",
  ACTIVE_GB: "Active GB",
  SHIPPING: "Shipping",
  DELIVERED: "Delivered",
  IN_STOCK: "In Stock",
  CANCELLED: "Cancelled",
};

export const STATUS_COLORS: Record<GBStatus, string> = {
  INTEREST_CHECK: "bg-slate-100 text-slate-700 border-slate-200",
  ACTIVE_GB: "bg-green-100 text-green-800 border-green-200",
  SHIPPING: "bg-blue-100 text-blue-800 border-blue-200",
  DELIVERED: "bg-purple-100 text-purple-800 border-purple-200",
  IN_STOCK: "bg-amber-100 text-amber-800 border-amber-200",
  CANCELLED: "bg-red-100 text-red-800 border-red-200",
};

export const STATUS_DOT_COLORS: Record<GBStatus, string> = {
  INTEREST_CHECK: "bg-slate-400",
  ACTIVE_GB: "bg-green-500",
  SHIPPING: "bg-blue-500",
  DELIVERED: "bg-purple-500",
  IN_STOCK: "bg-amber-500",
  CANCELLED: "bg-red-500",
};
