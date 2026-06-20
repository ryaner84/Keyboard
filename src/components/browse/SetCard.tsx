"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  formatRelativeDate,
  getCountdownLabel,
  getImageCandidates,
} from "@/lib/utils";
import { formatCurrency } from "@/lib/currency-utils";
import { computeCheapest, computeSavings, latestUpdate } from "@/lib/pricing";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { useLocation } from "@/context/LocationContext";
import { useCurrency } from "@/hooks/useCurrency";
import type { GroupBuyWithPricing, Region } from "@/types";
import { ReportListingButton } from "@/components/ui/ReportListingButton";

interface SetCardProps {
  set: GroupBuyWithPricing;
}

// Pill label that identifies what kind of product this card represents.
// Stays bottom-right of the image; icon only on very narrow cards.
function ProductTypePill({ type }: { type?: string | null }) {
  if (type === "KEYBOARD") {
    return (
      <span className="absolute bottom-2 right-2 flex items-center gap-1 bg-violet-600/90 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full backdrop-blur-sm">
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <rect x="2" y="6" width="20" height="12" rx="2" strokeWidth={2} />
          <line x1="6" y1="10" x2="6" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="10" y1="10" x2="10" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="14" y1="10" x2="14" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="18" y1="10" x2="18" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="8" y1="14" x2="16" y2="14" strokeWidth={2.5} strokeLinecap="round" />
        </svg>
        Keyboard
      </span>
    );
  }
  // Default / KEYCAPS
  return (
    <span className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/60 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full backdrop-blur-sm">
      <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <rect x="3" y="8" width="18" height="10" rx="1.5" strokeWidth={1.8} />
        <rect x="6" y="11" width="2" height="2" rx="0.4" fill="currentColor" strokeWidth={0} />
        <rect x="10" y="11" width="2" height="2" rx="0.4" fill="currentColor" strokeWidth={0} />
        <rect x="14" y="11" width="2" height="2" rx="0.4" fill="currentColor" strokeWidth={0} />
        <rect x="8" y="14" width="6" height="1.5" rx="0.4" fill="currentColor" strokeWidth={0} />
      </svg>
      Keycap Set
    </span>
  );
}

export function SetCard({ set }: SetCardProps) {
  const { isTracked, toggle } = useTrackedSets();
  const { region, currency, countryCode } = useLocation();
  const { rates, loading } = useCurrency(currency);
  const tracked = isTracked(set.slug);
  const countdown = getCountdownLabel(set.status, set.gbStart, set.gbEnd);
  const imageCandidates = useMemo(
    () => getImageCandidates(set.imageUrl, set.images),
    [set.imageUrl, set.images]
  );
  const imageSignature = imageCandidates.join("\n");
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [set.id, imageSignature]);

  const allPrices = computeCheapest(set, region as Region, currency, rates);
  const cheapest = allPrices.slice(0, 3);
  // Group buy prices are fixed by the manufacturer — no inter-vendor savings.
  // Only show the savings badge on released/in-stock sets where vendors vary.
  const isGroupBuy = set.status === "ACTIVE_GB" || set.status === "INTEREST_CHECK";
  const savings = isGroupBuy ? null : computeSavings(allPrices);
  const updated = latestUpdate(cheapest);
  const href = `/sets/${set.slug}?country=${countryCode}`;

  const imgSrc = imageCandidates[imageIndex] ?? null;
  const showImage = !!imgSrc;

  const handleImgError = () => {
    setImageIndex((current) => current + 1);
  };

  return (
    <div className="group bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden hover:border-indigo-200 dark:hover:border-indigo-600 hover:shadow-md transition-all duration-200 flex flex-col">
      <Link href={href} className="block">
        <div className="relative aspect-video bg-gray-50 overflow-hidden">
          {showImage ? (
            <Image
              key={imgSrc}
              src={imgSrc!}
              alt={set.name}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
              unoptimized
              onError={handleImgError}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-indigo-50 to-purple-50 gap-2">
              <span className="text-4xl opacity-25">⌨</span>
              <span className="text-[11px] text-gray-400 font-medium">{set.name}</span>
            </div>
          )}
          <div className="absolute top-3 left-3">
            <StatusBadge status={set.status} size="sm" />
          </div>
          {savings && (
            <div
              className="absolute top-3 right-3 flex items-center gap-1 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[11px] font-bold px-2.5 py-1 rounded-full shadow-lg"
              title={`${formatCurrency(savings.amount, currency)} cheaper than ${savings.vsVendor}`}
            >
              💸 Save {savings.percent}%
            </div>
          )}
          {countdown && (
            <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/70 text-white text-[11px] font-semibold px-2 py-1 rounded-full backdrop-blur-sm">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {countdown}
            </div>
          )}
          <ProductTypePill type={(set as { productType?: string }).productType} />
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
          <div className="flex items-center gap-1 flex-shrink-0">
            <ReportListingButton slug={set.slug} name={set.name} />
            <button
              onClick={() => toggle(set.slug)}
              title={tracked ? "Remove from tracker" : "Add to tracker"}
              className={`p-1.5 rounded-lg transition-colors ${
                tracked ? "text-indigo-600 bg-indigo-50" : "text-gray-400 hover:text-indigo-600 hover:bg-indigo-50"
              }`}
            >
              <svg className="w-4 h-4" fill={tracked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
            </button>
          </div>
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
              {savings && (
                <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 mt-2">
                  {formatCurrency(savings.amount, currency)} cheaper than {savings.vsVendor}
                </p>
              )}
              {updated && (
                <p className="text-[10px] text-gray-400 mt-1">
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
