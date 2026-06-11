"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getCountdownLabel, formatDateRange, normalizeImageUrl } from "@/lib/utils";
import { useLocation } from "@/context/LocationContext";
import type { GroupBuyWithKits } from "@/types";

interface UpcomingCarouselProps {
  sets: GroupBuyWithKits[];
}

const AUTO_ADVANCE_MS = 6000;

export function UpcomingCarousel({ sets }: UpcomingCarouselProps) {
  const { countryCode } = useLocation();
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

  const current = sets[active];
  const href = (slug: string) => `/sets/${slug}?country=${countryCode}`;

  // Rendered inside the HomeCarousel tab switcher — no outer section/container.
  return (
    <div>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          {/* Main feature */}
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
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-indigo-100 to-purple-100">
                    <span className="text-6xl opacity-30">⌨</span>
                  </div>
                )}

                {/* Gradient for text legibility */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />

                {/* Countdown pill — raised above the caption text so the two
                    never overlap */}
                {(() => {
                  const label = getCountdownLabel(current.status, current.gbStart, current.gbEnd);
                  return label ? (
                    <div className="absolute bottom-[76px] sm:bottom-[84px] left-3 flex items-center gap-1.5 bg-black/70 text-white text-xs font-semibold px-3 py-1.5 rounded-full backdrop-blur-sm">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {label}
                    </div>
                  ) : null;
                })()}

                {/* Status badge — top-left */}
                <div className="absolute top-3 left-3">
                  <StatusBadge status={current.status} size="sm" />
                </div>
              </div>
            </Link>

            {/* Caption bar */}
            <div className="absolute bottom-0 right-0 left-0 p-4 pointer-events-none">
              <div className="flex items-end justify-between gap-4">
                <Link href={href(current.slug)} className="pointer-events-auto">
                  <h2 className="text-white text-xl sm:text-2xl font-bold drop-shadow">
                    {current.name}
                  </h2>
                  <p className="text-white/80 text-sm">
                    by {current.designer} · {formatDateRange(current.gbStart, current.gbEnd)}
                  </p>
                </Link>
              </div>
            </div>

            {/* Arrows */}
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

                {/* Dots */}
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

          {/* Right rail — upcoming list */}
          <div className="hidden lg:flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">Upcoming Group Buys</h3>
              <Link href="/browse" className="text-xs text-indigo-600 hover:text-indigo-700">
                View all →
              </Link>
            </div>
            <div className="flex flex-col gap-1.5 overflow-hidden">
              {sets.slice(0, 5).map((set, i) => {
                const label = getCountdownLabel(set.status, set.gbStart, set.gbEnd);
                return (
                  // Click navigates to the set page; hovering previews it in the
                  // big image on the left.
                  <Link
                    key={set.id}
                    href={href(set.slug)}
                    onMouseEnter={() => go(i)}
                    className={`flex items-center gap-3 p-2 rounded-xl text-left transition-colors ${
                      i === active ? "bg-indigo-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <div className="relative w-16 h-10 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0">
                      {normalizeImageUrl(set.imageUrl) ? (
                        <Image src={normalizeImageUrl(set.imageUrl)!} alt={set.name} fill className="object-cover" unoptimized />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-lg opacity-30">⌨</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{set.name}</p>
                      <p className="text-xs text-gray-400">{label ?? set.designer}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
            <Link
              href="/browse"
              className="mt-2 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-gray-200 text-sm font-medium text-gray-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
            >
              Show more group buys
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>

        {/* Mobile "show more" (right rail is hidden on small screens) */}
        <div className="lg:hidden mt-3">
          <Link
            href="/browse"
            className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-gray-200 text-sm font-medium text-gray-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
          >
            Show more group buys
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
    </div>
  );
}
