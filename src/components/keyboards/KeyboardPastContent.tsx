"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useLocation } from "@/context/LocationContext";
import { KeyboardCard } from "@/components/keyboards/KeyboardCard";
import { isShowcaseSource } from "@/lib/showcase";
import type { GroupBuyWithPricing } from "@/types";

const BRANDS = [
  "TGR", "Keycult", "Matrix", "Mode", "Geonworks",
  "Rama", "Norbauer", "Duck", "Hiney", "Angry Miao",
  "Percent", "Swagkeys", "CannonKeys", "NovelKeys", "KBDfans",
];

export function KeyboardPastContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { countryCode } = useLocation();

  const [all, setAll] = useState<GroupBuyWithPricing[]>([]);
  const [loading, setLoading] = useState(true);

  const search = searchParams.get("search") ?? "";
  const brands = searchParams.getAll("brand");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/group-buys?type=KEYBOARD&status=all&limit=200`);
      const data = await res.json();
      const past = (data.data ?? []).filter(
        (k: GroupBuyWithPricing) =>
          (k.status === "SHIPPING" || k.status === "DELIVERED") &&
          // Lightning Keyboards are a browse-only showcase, not group buys.
          !isShowcaseSource(k.vendorName)
      );
      // Sort by most recently updated first
      past.sort((a: GroupBuyWithPricing, b: GroupBuyWithPricing) =>
        new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
      );
      setAll(past);
    } catch {
      setAll([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = useMemo(() => {
    return all.filter((k) => {
      if (brands.length > 0) {
        const nameLower = k.name.toLowerCase();
        if (!brands.some((b) => nameLower.includes(b.toLowerCase()))) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        const hay = `${k.name} ${k.vendorName ?? k.designer}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, brands, search]);

  const updateParams = useCallback(
    (updates: Record<string, string | string[]>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        params.delete(key);
        if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
        else if (value) params.set(key, value);
      }
      router.replace(`?${params.toString()}`);
    },
    [searchParams, router]
  );

  const handleBrandToggle = (brand: string) => {
    const next = brands.includes(brand)
      ? brands.filter((b) => b !== brand)
      : [...brands, brand];
    updateParams({ brand: next });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Past Keyboard Group Buys</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {loading ? "Loading…" : `${filtered.length} keyboards shipped or delivered · sorted by most recently updated`}
        </p>
      </div>

      {/* Compact filters: search + brand chips */}
      <div className="mb-6 space-y-3">
        <div className="relative max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search keyboards…"
            value={search}
            onChange={(e) => updateParams({ search: e.target.value })}
            className="w-full pl-9 pr-4 py-2 border border-gray-200 dark:border-gray-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {BRANDS.map((b) => (
            <button
              key={b}
              onClick={() => handleBrandToggle(b)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                brands.includes(b)
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-indigo-300"
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {/* Card grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden animate-pulse">
              <div className="aspect-[4/3] bg-gray-100 dark:bg-gray-800" />
              <div className="p-3 space-y-2">
                <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded w-3/4" />
                <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800">
          <p className="font-semibold text-gray-700 dark:text-gray-300 text-lg">No keyboards found</p>
          <p className="text-sm text-gray-400 mt-1">Try clearing the filters above.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((k) => (
            <KeyboardCard key={k.id} kb={k} countryCode={countryCode} />
          ))}
        </div>
      )}
    </div>
  );
}
