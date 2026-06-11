"use client";

import { useState } from "react";
import { UpcomingCarousel } from "./UpcomingCarousel";
import { ReleasedCarousel } from "./ReleasedCarousel";
import type { GroupBuyWithKits, GroupBuyWithPricing } from "@/types";

interface HomeCarouselProps {
  upcoming: GroupBuyWithKits[];
  released: GroupBuyWithPricing[];
}

// One hero carousel at the top of the homepage with a tab switcher: visitors
// flip between live group buys and released-set deals without scrolling.
export function HomeCarousel({ upcoming, released }: HomeCarouselProps) {
  const hasGB = upcoming.length > 0;
  const hasReleased = released.length > 0;
  const [tab, setTab] = useState<"gb" | "released">(hasGB ? "gb" : "released");

  if (!hasGB && !hasReleased) return null;
  const activeTab = tab === "gb" && !hasGB ? "released" : tab === "released" && !hasReleased ? "gb" : tab;

  return (
    <section className="bg-white border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Tab switcher */}
        <div className="flex items-center flex-wrap gap-2 mb-4">
          <div className="inline-flex rounded-xl border border-gray-200 bg-gray-50 p-1">
            {hasGB && (
              <button
                onClick={() => setTab("gb")}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                  activeTab === "gb"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${activeTab === "gb" ? "bg-emerald-300 animate-pulse" : "bg-emerald-500"}`} />
                Group Buys
              </button>
            )}
            {hasReleased && (
              <button
                onClick={() => setTab("released")}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                  activeTab === "released"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                💸 Released
              </button>
            )}
          </div>
          <span className="text-[11px] text-gray-400 hidden sm:block">
            {activeTab === "gb"
              ? "Live group buys — order before they close"
              : "Still available to buy · Discount different across stores"}
          </span>
        </div>

        {activeTab === "gb" ? (
          <UpcomingCarousel sets={upcoming} />
        ) : (
          <ReleasedCarousel sets={released} />
        )}
      </div>
    </section>
  );
}
