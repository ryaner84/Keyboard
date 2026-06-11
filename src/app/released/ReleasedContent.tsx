"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SetCard } from "@/components/browse/SetCard";
import type { GroupBuyWithPricing } from "@/types";

// Post-group-buy section. The whole page is organised around one question —
// "I missed the group buy: can I still buy this set?" — so availability is
// the primary control, with year and search refining from there.

const PAGE_SIZE = 24;
const CURRENT_YEAR = new Date().getFullYear();
const OLDEST_YEAR = 2015; // first GMK rounds KeycapLendar tracks

const AVAILABILITY_TABS = [
  { value: "", label: "All" },
  { value: "available", label: "Available now" },
  { value: "soldout", label: "Sold out" },
] as const;

export default function ReleasedContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const search = searchParams.get("search") ?? "";
  const availability = searchParams.get("availability") ?? "";
  const year = searchParams.get("year") ?? "";
  const sortBy = searchParams.get("sort") ?? "released-desc";

  const [sets, setSets] = useState<GroupBuyWithPricing[]>([]);
  const [total, setTotal] = useState(0);
  const [totalReleased, setTotalReleased] = useState<number | null>(null);
  const [totalAvailable, setTotalAvailable] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Debounce the search box so we don't refetch per keystroke.
  const [searchDraft, setSearchDraft] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.replace(`/released?${params.toString()}`);
    },
    [searchParams, router]
  );

  const onSearchChange = (value: string) => {
    setSearchDraft(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateParams({ search: value }), 350);
  };

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (availability) params.set("availability", availability);
      if (year) params.set("year", year);
      params.set("sort", sortBy);
      params.set("page", String(pageNum));
      params.set("limit", String(PAGE_SIZE));

      try {
        const res = await fetch(`/api/released?${params}`);
        const data = await res.json();
        setSets((prev) => (append ? [...prev, ...(data.data ?? [])] : (data.data ?? [])));
        setTotal(data.total ?? 0);
        setTotalReleased(data.totalReleased ?? null);
        setTotalAvailable(data.totalAvailable ?? null);
        setPage(pageNum);
      } catch {
        if (!append) setSets([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [search, availability, year, sortBy]
  );

  useEffect(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  const hasMore = sets.length < total;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* ── Hero: what this section is, with live aftermarket stats ───────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 px-6 py-8 sm:px-10 sm:py-10 mb-8">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              "radial-gradient(circle at 80% 20%, white 0%, transparent 45%), radial-gradient(circle at 10% 90%, white 0%, transparent 35%)",
          }}
        />
        <div className="relative">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">
            Released Sets
          </h1>
          <p className="mt-2 text-emerald-50 text-sm sm:text-base max-w-2xl">
            Missed the group buy? These sets have finished their run — here&apos;s
            which ones vendors still stock, and where they&apos;re cheapest to you.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <div className="bg-white/15 backdrop-blur-sm rounded-xl px-4 py-2">
              <p className="text-xl font-bold text-white leading-tight">
                {totalReleased ?? "—"}
              </p>
              <p className="text-[11px] text-emerald-100 uppercase tracking-wide">
                released sets
              </p>
            </div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl px-4 py-2">
              <p className="text-xl font-bold text-white leading-tight">
                {totalAvailable ?? "—"}
              </p>
              <p className="text-[11px] text-emerald-100 uppercase tracking-wide">
                buyable right now
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-6">
        {/* Availability — the primary filter of this section */}
        <div className="inline-flex rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1">
          {AVAILABILITY_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => updateParams({ availability: tab.value })}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                availability === tab.value
                  ? tab.value === "available"
                    ? "bg-emerald-600 text-white"
                    : tab.value === "soldout"
                      ? "bg-gray-700 text-white"
                      : "bg-indigo-600 text-white"
                  : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchDraft}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search sets, designers, colorways…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900 transition-colors"
          />
        </div>

        {/* Year released */}
        <select
          value={year}
          onChange={(e) => updateParams({ year: e.target.value })}
          className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:border-indigo-400"
        >
          <option value="">Any year</option>
          {Array.from({ length: CURRENT_YEAR - OLDEST_YEAR + 1 }, (_, i) => CURRENT_YEAR - i).map(
            (y) => (
              <option key={y} value={String(y)}>
                Released {y}
              </option>
            )
          )}
        </select>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => updateParams({ sort: e.target.value })}
          className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:border-indigo-400"
        >
          <option value="released-desc">Recently released</option>
          <option value="released-asc">Oldest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {/* ── Result count ──────────────────────────────────────────────────── */}
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {loading
          ? "Loading…"
          : `${total} set${total !== 1 ? "s" : ""}${
              availability === "available"
                ? " you can buy right now"
                : availability === "soldout"
                  ? " not currently stocked"
                  : ""
            }`}
      </p>

      {/* ── Grid ──────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden">
              <div className="aspect-video bg-gray-100 dark:bg-gray-800 animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-3/4" />
                <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : sets.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">⌨</p>
          <p className="font-medium text-gray-500 dark:text-gray-300">No released sets found</p>
          <p className="text-sm mt-1">
            {availability === "available"
              ? "Nothing matching your filters is in stock right now — try widening the year or clearing the search."
              : "Try adjusting your filters"}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {sets.map((set) => (
              <SetCard key={set.id} set={set} />
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={() => fetchPage(page + 1, true)}
                disabled={loadingMore}
                className="px-6 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-700 dark:text-gray-200 hover:border-indigo-300 hover:text-indigo-600 transition-colors disabled:opacity-60"
              >
                {loadingMore
                  ? "Loading…"
                  : `Load more (${sets.length} of ${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
