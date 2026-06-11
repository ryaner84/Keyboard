"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { normalizeImageUrl } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency-utils";
import { computeCheapest, computeSavings, type Savings } from "@/lib/pricing";
import { useLocation } from "@/context/LocationContext";
import { useCurrency } from "@/hooks/useCurrency";
import type { GroupBuyWithPricing, Region } from "@/types";

interface ReleasedCarouselProps {
  sets: GroupBuyWithPricing[];
}

const AUTO_ADVANCE_MS = 6000;

function releaseLabel(set: GroupBuyWithPricing): string {
  if (set.gbEnd) return `Released ${new Date(set.gbEnd).getFullYear()}`;
  return set.status === "IN_STOCK" ? "In Stock" : "Released";
}

export function ReleasedCarousel({ sets }: ReleasedCarouselProps) {
  const { countryCode, region, currency } = useLocation();
  const { rates, loading } = useCurrency(currency);
  const [active, setActive] = useState(0);
  const count = sets.length;

  const go = useCallback(
    (i: number) => setActive(((i % count) + count) % count),
    [count]
  );

  useEffect(() => {
    if (count <= 1) return;
    const timer = setInterval(() => setActive((a) => (a + 1) % count), AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [count]);

  if (count === 0) return null;

  // Per-set savings in the user's currency — the discount differs across
  // vendors, so this is the carousel's headline number.
  const savingsOf = (set: GroupBuyWithPricing): { savings: Savings | null; fromPrice: number | null } => {
    if (loading) return { savings: null, fromPrice: null };
    const prices = computeCheapest(set, region as Region, currency, rates);
    return {
      savings: computeSavings(prices),
      fromPrice: prices.length > 0 ? prices[0].totalLocal : null,
    };
  };

  const current = sets[active];
  const currentDeal = savingsOf(current);
  const href = (slug: string) => `/sets/${slug}?country=${countryCode}`;

  // Rendered inside the HomeCarousel tab switcher — no outer section/container.
  return (
    <div>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          {/* Main feature image */}
          <div className="relative rounded-2xl overflow-hidden bg-gray-100 group">
            <Link href={href(current.slug)} className="block">
              <div className="relative aspect-[16/9] w-full">
                {normalizeImageUrl(current.imageUrl) ? (
                  <Image
                    src={normalizeImageUrl(current.imageUrl)!}
                    alt={current.name}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    unoptimized
                    priority
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-emerald-100 to-teal-100">
                    <span className="text-6xl opacity-30">⌨</span>
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                <div className="absolute top-3 left-3">
                  <StatusBadge status={current.status} size="sm" />
                </div>
                {/* Discount badge — vendors price this set differently */}
                {currentDeal.savings && (
                  <div className="absolute top-3 right-3 flex items-center gap-1 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg">
                    💸 Save {currentDeal.savings.percent}% vs {currentDeal.savings.vsVendor}
                  </div>
                )}
              </div>
            </Link>

            {/* Caption */}
            <div className="absolute bottom-0 right-0 left-0 p-4 pointer-events-none">
              <Link href={href(current.slug)} className="pointer-events-auto inline-block">
                <h2 className="text-white text-xl sm:text-2xl font-bold drop-shadow">
                  {current.name}
                </h2>
                <p className="text-white/80 text-sm">
                  by {current.designer} · {releaseLabel(current)}
                  {currentDeal.fromPrice != null && (
                    <span className="text-white font-semibold">
                      {" "}· from {formatCurrency(currentDeal.fromPrice, currency)}
                    </span>
                  )}
                </p>
                {currentDeal.savings && (
                  <p className="text-amber-300 text-sm font-semibold mt-0.5">
                    {formatCurrency(currentDeal.savings.amount, currency)} cheaper than{" "}
                    {currentDeal.savings.vsVendor}
                  </p>
                )}
              </Link>
            </div>

            {/* Arrows + dots */}
            {count > 1 && (
              <>
                <button
                  onClick={() => go(active - 1)}
                  aria-label="Previous"
                  className="absolute top-1/2 left-2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/80 hover:bg-white flex items-center justify-center shadow transition-colors"
                >
                  <svg className="w-5 h-5 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() => go(active + 1)}
                  aria-label="Next"
                  className="absolute top-1/2 right-2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/80 hover:bg-white flex items-center justify-center shadow transition-colors"
                >
                  <svg className="w-5 h-5 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <div className="absolute bottom-3 right-3 flex gap-1.5">
                  {sets.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => go(i)}
                      aria-label={`Go to slide ${i + 1}`}
                      className={`h-1.5 rounded-full transition-all ${
                        i === active ? "w-5 bg-white" : "w-1.5 bg-white/50 hover:bg-white/80"
                      }`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Right rail */}
          <div className="hidden lg:flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">Best Released Deals</h3>
              <Link href="/released" className="text-xs text-emerald-600 hover:text-emerald-700">
                View all →
              </Link>
            </div>
            <div className="flex flex-col gap-1.5 overflow-hidden">
              {sets.slice(0, 5).map((set, i) => {
                const deal = savingsOf(set);
                return (
                  <Link
                    key={set.id}
                    href={href(set.slug)}
                    onMouseEnter={() => go(i)}
                    className={`flex items-center gap-3 p-2 rounded-xl text-left transition-colors ${
                      i === active ? "bg-emerald-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <div className="relative w-16 h-10 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0">
                      {normalizeImageUrl(set.imageUrl) ? (
                        <Image
                          src={normalizeImageUrl(set.imageUrl)!}
                          alt={set.name}
                          fill
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-lg opacity-30">⌨</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{set.name}</p>
                      <p className="text-xs text-gray-400">
                        {deal.savings ? (
                          <span className="text-amber-600 font-semibold">
                            💸 Save {deal.savings.percent}%
                            {deal.fromPrice != null &&
                              ` · from ${formatCurrency(deal.fromPrice, currency)}`}
                          </span>
                        ) : deal.fromPrice != null ? (
                          `from ${formatCurrency(deal.fromPrice, currency)}`
                        ) : (
                          releaseLabel(set)
                        )}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
            <Link
              href="/released"
              className="mt-2 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-gray-200 text-sm font-medium text-gray-500 hover:border-emerald-300 hover:text-emerald-600 transition-colors"
            >
              Show more released sets
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>

        {/* Mobile CTA */}
        <div className="lg:hidden mt-3">
          <Link
            href="/released"
            className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-gray-200 text-sm font-medium text-gray-500 hover:border-emerald-300 hover:text-emerald-600 transition-colors"
          >
            Show more released sets
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
    </div>
  );
}
