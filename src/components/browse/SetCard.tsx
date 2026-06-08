"use client";

import Link from "next/link";
import Image from "next/image";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatRelativeDate, getCountdownLabel, normalizeImageUrl } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency-utils";
import { computeCheapest, latestUpdate } from "@/lib/pricing";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { useLocation } from "@/context/LocationContext";
import { useCurrency } from "@/hooks/useCurrency";
import type { GroupBuyWithPricing, Region } from "@/types";

interface SetCardProps {
  set: GroupBuyWithPricing;
}

export function SetCard({ set }: SetCardProps) {
  const { isTracked, toggle } = useTrackedSets();
  const { region, currency, countryCode } = useLocation();
  const { rates, loading } = useCurrency(currency);
  const tracked = isTracked(set.slug);
  const countdown = getCountdownLabel(set.status, set.gbStart, set.gbEnd);

  const cheapest = computeCheapest(set, region as Region, currency, rates).slice(0, 3);
  const updated = latestUpdate(cheapest);
  const href = `/sets/${set.slug}?country=${countryCode}`;

  return (
    <div className="group bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden hover:border-indigo-200 dark:hover:border-indigo-600 hover:shadow-md transition-all duration-200 flex flex-col">
      <Link href={href} className="block">
        <div className="relative aspect-video bg-gray-50 overflow-hidden">
          {normalizeImageUrl(set.imageUrl) ? (
            <Image
              src={normalizeImageUrl(set.imageUrl)!}
              alt={set.name}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
              unoptimized
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-indigo-50 to-purple-50">
              <span className="text-5xl opacity-30">⌨</span>
            </div>
          )}
          <div className="absolute top-3 left-3">
            <StatusBadge status={set.status} size="sm" />
          </div>
          {countdown && (
            <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/70 text-white text-[11px] font-semibold px-2 py-1 rounded-full backdrop-blur-sm">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {countdown}
            </div>
          )}
        </div>
      </Link>

      <div className="p-4 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-2">
          <Link href={href} className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-white truncate hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
              {set.name}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">by {set.designer}</p>
          </Link>
          <button
            onClick={() => toggle(set.slug)}
            title={tracked ? "Remove from tracker" : "Add to tracker"}
            className={`flex-shrink-0 p-1.5 rounded-lg transition-colors ${
              tracked ? "text-indigo-600 bg-indigo-50" : "text-gray-400 hover:text-indigo-600 hover:bg-indigo-50"
            }`}
          >
            <svg className="w-4 h-4" fill={tracked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
        </div>

        {/* Price comparison preview */}
        <div className="mt-3 pt-3 border-t border-gray-50 dark:border-gray-800 flex-1">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
              Cheapest to {countryCode}
            </p>
            {cheapest.length > 0 && (
              <span className="text-[11px] text-indigo-600 font-medium">{cheapest.length} vendor{cheapest.length > 1 ? "s" : ""}</span>
            )}
          </div>

          {loading ? (
            <div className="space-y-1.5">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-4 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : cheapest.length > 0 ? (
            <>
              <ul className="space-y-1">
                {cheapest.map((p, i) => (
                  <li key={p.vendorName} className="flex items-center justify-between gap-2 text-sm">
                    <span className={`truncate ${i === 0 ? "text-gray-900 dark:text-white font-medium" : "text-gray-500 dark:text-gray-400"}`}>
                      {i === 0 && <span className="text-green-600 mr-1">▾</span>}
                      {p.vendorName}
                    </span>
                    <span className={`whitespace-nowrap ${i === 0 ? "font-bold text-green-700 dark:text-green-400" : "text-gray-600 dark:text-gray-300"}`}>
                      {formatCurrency(p.totalLocal, currency)}
                    </span>
                  </li>
                ))}
              </ul>
              {updated && (
                <p className="text-[10px] text-gray-400 mt-2">
                  Prices updated {formatRelativeDate(updated)} · incl. shipping
                </p>
              )}
            </>
          ) : (
            <Link href={href} className="block text-sm text-gray-400 hover:text-indigo-600">
              No live prices to {countryCode} yet — view vendors →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
