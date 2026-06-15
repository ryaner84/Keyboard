"use client";

import { useState } from "react";
import { UpcomingCarousel } from "./UpcomingCarousel";
import { ReleasedCarousel } from "./ReleasedCarousel";
import type { GroupBuyWithKits, GroupBuyWithPricing } from "@/types";

interface HomeCarouselProps {
  // Keycaps
  upcoming: GroupBuyWithKits[];
  released: GroupBuyWithPricing[];
  // Keyboards
  kbUpcoming: GroupBuyWithKits[];
  kbReleased: GroupBuyWithKits[];
}

type Category = "keycaps" | "keyboards";
type Tab = "gb" | "released";

// One hero carousel at the top of the homepage. A primary toggle switches the
// whole product category (Keycaps vs Keyboards); within each, a secondary tab
// flips between live group buys and released items. Keycaps lead with
// cross-vendor savings; keyboards are single-vendor, so they reuse the simpler
// upcoming-style carousel for both tabs.
export function HomeCarousel({ upcoming, released, kbUpcoming, kbReleased }: HomeCarouselProps) {
  const has = {
    keycapsGb: upcoming.length > 0,
    keycapsReleased: released.length > 0,
    keyboardsGb: kbUpcoming.length > 0,
    keyboardsReleased: kbReleased.length > 0,
  };
  const hasKeycaps = has.keycapsGb || has.keycapsReleased;
  const hasKeyboards = has.keyboardsGb || has.keyboardsReleased;

  const [category, setCategory] = useState<Category>(hasKeycaps ? "keycaps" : "keyboards");
  const [tab, setTab] = useState<Tab>("gb");

  if (!hasKeycaps && !hasKeyboards) return null;

  // Resolve the effective category/tab against what data actually exists, so a
  // toggle never lands on an empty pane.
  const effCategory: Category =
    category === "keycaps" && !hasKeycaps ? "keyboards" : category === "keyboards" && !hasKeyboards ? "keycaps" : category;

  const gbAvail = effCategory === "keycaps" ? has.keycapsGb : has.keyboardsGb;
  const releasedAvail = effCategory === "keycaps" ? has.keycapsReleased : has.keyboardsReleased;
  const effTab: Tab = tab === "gb" && !gbAvail ? "released" : tab === "released" && !releasedAvail ? "gb" : tab;

  const categoryTabs: Array<{ value: Category; label: string; emoji: string; show: boolean }> = [
    { value: "keycaps", label: "Keycaps", emoji: "🎨", show: hasKeycaps },
    { value: "keyboards", label: "Keyboards", emoji: "⌨️", show: hasKeyboards },
  ];

  const caption =
    effCategory === "keyboards"
      ? effTab === "gb"
        ? "Live keyboard group buys — order before they close"
        : "Keyboards that have finished their group buy"
      : effTab === "gb"
        ? "Live group buys — order before they close"
        : "Still available to buy · Discount different across stores";

  return (
    <section className="bg-white border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Primary category toggle: Keycaps / Keyboards */}
        <div className="flex items-center flex-wrap gap-2 mb-3">
          <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1">
            {categoryTabs.filter((c) => c.show).map((c) => (
              <button
                key={c.value}
                onClick={() => setCategory(c.value)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-bold transition-colors ${
                  effCategory === c.value
                    ? "bg-gray-900 text-white shadow-sm"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                <span>{c.emoji}</span>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Secondary tab switcher: Group Buys / Released */}
        <div className="flex items-center flex-wrap gap-2 mb-4">
          <div className="inline-flex rounded-xl border border-gray-200 bg-gray-50 p-1">
            {gbAvail && (
              <button
                onClick={() => setTab("gb")}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                  effTab === "gb"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${effTab === "gb" ? "bg-emerald-300 animate-pulse" : "bg-emerald-500"}`} />
                Group Buys
              </button>
            )}
            {releasedAvail && (
              <button
                onClick={() => setTab("released")}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                  effTab === "released"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {effCategory === "keycaps" ? "💸 Released" : "Released"}
              </button>
            )}
          </div>
          <span className="text-[11px] text-gray-400 hidden sm:block">{caption}</span>
        </div>

        {effCategory === "keycaps" ? (
          effTab === "gb" ? (
            <UpcomingCarousel sets={upcoming} />
          ) : (
            <ReleasedCarousel sets={released} />
          )
        ) : effTab === "gb" ? (
          <UpcomingCarousel
            sets={kbUpcoming}
            railTitle="Upcoming Keyboards"
            viewAllHref="/keyboards/active"
            moreLabel="Show more keyboards"
          />
        ) : (
          <UpcomingCarousel
            sets={kbReleased}
            railTitle="Released Keyboards"
            viewAllHref="/released?type=keyboards"
            moreLabel="Show more keyboards"
          />
        )}
      </div>
    </section>
  );
}
