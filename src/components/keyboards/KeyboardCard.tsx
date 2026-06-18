"use client";

import Link from "next/link";
import Image from "next/image";
import { normalizeImageUrl } from "@/lib/utils";
import type { GroupBuyWithPricing } from "@/types";
import { useTrackedSets } from "@/hooks/useTrackedSets";

const STAGE_META: Record<string, { label: string; cls: string; dot: string }> = {
  ACTIVE_GB: { label: "GB Open", cls: "text-green-700 bg-green-50 border-green-200 dark:text-green-300 dark:bg-green-950 dark:border-green-800", dot: "bg-green-500" },
  IN_STOCK: { label: "In stock", cls: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950 dark:border-amber-800", dot: "bg-amber-500" },
  INTEREST_CHECK: { label: "Interest Check", cls: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950 dark:border-blue-800", dot: "bg-blue-500" },
  SHIPPING: { label: "Shipping", cls: "text-purple-700 bg-purple-50 border-purple-200 dark:text-purple-300 dark:bg-purple-950 dark:border-purple-800", dot: "bg-purple-500" },
  DELIVERED: { label: "Delivered", cls: "text-gray-600 bg-gray-50 border-gray-200 dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700", dot: "bg-gray-400" },
};

const REGION_FLAG: Record<string, string> = {
  US: "🇺🇸", CA: "🇨🇦", EU: "🇪🇺", UK: "🇬🇧",
  AU: "🇦🇺", SG: "🇸🇬", ASIA: "🌏",
  CN: "🇨🇳", China: "🇨🇳", Korea: "🇰🇷",
  Global: "🌐", GLOBAL: "🌐",
};

export function timeAgo(date: string | Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function truncate(text: string, maxLen = 150): string {
  if (!text || text.length <= maxLen) return text ?? "";
  return text.slice(0, maxLen).replace(/\s\S*$/, "") + "…";
}

// Shared keyboard card — used on /keyboards/past and the Keyboards tab of /released.
// Keyboards are single-vendor (price on the row), so this card shows status,
// vendor + region, a description excerpt and the last-updated time rather than
// the multi-vendor price comparison used for keycap sets.
export function KeyboardCard({
  kb,
  countryCode,
}: {
  kb: GroupBuyWithPricing;
  countryCode: string;
}) {
  const { isTracked, toggle } = useTrackedSets();
  const meta = STAGE_META[kb.status] ?? STAGE_META.DELIVERED;
  const img = normalizeImageUrl(kb.imageUrl);
  const flag = REGION_FLAG[kb.vendorRegion ?? ""] ?? "";
  const desc = truncate(kb.description ?? "");

  const tracked = isTracked(kb.slug);

  return (
    <div className="group relative bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md transition-all">
      <Link href={`/sets/${kb.slug}?country=${countryCode}`} className="block">
        <div className="relative aspect-[4/3] bg-gray-100 dark:bg-gray-800 overflow-hidden">
        {img ? (
          <Image src={img} alt={kb.name} fill className="object-cover group-hover:scale-105 transition-transform duration-300" unoptimized />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-4xl text-gray-300">⌨</span>
        )}
        </div>

        <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <h3 className="font-semibold text-gray-900 dark:text-white text-sm leading-snug group-hover:text-violet-600 dark:group-hover:text-violet-400 line-clamp-2">
            {kb.name}
          </h3>
          <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold border px-1.5 py-0.5 rounded-full ${meta.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
        </div>

        <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
          {flag} {kb.vendorName ?? kb.designer}
        </p>

        {desc && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed line-clamp-3 mb-2">
            {desc}
          </p>
        )}

        {kb.updatedAt && (
          <p className="text-[10px] text-gray-400 dark:text-gray-500">
            Updated {timeAgo(kb.updatedAt)}
          </p>
        )}
        </div>
      </Link>
      <button
        onClick={() => toggle(kb.slug)}
        title={tracked ? "Remove from tracker" : "Add to tracker"}
        className={`absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg border shadow-sm backdrop-blur-sm ${
          tracked
            ? "border-indigo-200 bg-indigo-600 text-white"
            : "border-white/70 bg-white/90 text-gray-500 hover:text-indigo-600"
        }`}
      >
        <svg className="h-4 w-4" fill={tracked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
      </button>
    </div>
  );
}
