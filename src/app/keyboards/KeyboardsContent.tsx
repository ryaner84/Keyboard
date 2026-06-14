"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SetCard } from "@/components/browse/SetCard";
import { KeyboardFilters } from "@/components/keyboards/KeyboardFilters";
import type { GroupBuyWithPricing, GBStatus } from "@/types";

const JOINABLE_STATUSES: GBStatus[] = ["INTEREST_CHECK", "ACTIVE_GB"];
const DEFAULT_STATUSES: GBStatus[] = JOINABLE_STATUSES;

export default function KeyboardsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [sets, setSets] = useState<GroupBuyWithPricing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const search = searchParams.get("search") ?? "";
  const sortBy = searchParams.get("sort") ?? "date-desc";
  const joinableOnly = searchParams.get("joinable") === "1";
  const layouts = searchParams.getAll("layout");
  const mounts = searchParams.getAll("mount");
  const materials = searchParams.getAll("material");

  const rawStatuses = searchParams.getAll("status") as GBStatus[];
  const statuses: GBStatus[] = useMemo(() => {
    if (joinableOnly) return JOINABLE_STATUSES;
    if (rawStatuses.includes("all" as GBStatus)) return [];
    return rawStatuses.length > 0 ? rawStatuses : DEFAULT_STATUSES;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString(), joinableOnly]);

  const fetchSets = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    params.set("sort", sortBy);
    params.set("limit", "60");
    params.set("type", "KEYBOARD");
    statuses.forEach((s) => params.append("status", s));
    layouts.forEach((l) => params.append("layout", l));
    mounts.forEach((m) => params.append("mount", m));
    materials.forEach((m) => params.append("material", m));

    try {
      const res = await fetch(`/api/group-buys?${params}`);
      const data = await res.json();
      setSets(data.data ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setSets([]);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sortBy, statuses, layouts, mounts, materials]);

  useEffect(() => {
    fetchSets();
  }, [fetchSets]);

  const updateParams = useCallback(
    (updates: Record<string, string | string[]>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        params.delete(key);
        if (Array.isArray(value)) {
          value.forEach((v) => params.append(key, v));
        } else if (value) {
          params.set(key, value);
        }
      }
      router.replace(`/keyboards?${params.toString()}`);
    },
    [searchParams, router]
  );

  const handleStatusToggle = (status: GBStatus) => {
    if (joinableOnly) return; // locked while "still joinable" is on
    const next = statuses.includes(status)
      ? statuses.filter((s) => s !== status)
      : [...statuses, status];
    updateParams({ status: next.length > 0 ? next : ["all"] });
  };

  const handleJoinableToggle = () => {
    if (joinableOnly) {
      updateParams({ joinable: "", status: [] });
    } else {
      updateParams({ joinable: "1", status: [] });
    }
  };

  const handleMultiToggle = (key: string, current: string[], value: string) => {
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    updateParams({ [key]: next });
  };

  const activeFilterCount = layouts.length + mounts.length + materials.length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-600 bg-violet-50 dark:bg-violet-950 dark:text-violet-300 border border-violet-200 dark:border-violet-700 px-2 py-0.5 rounded-full">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <line x1="6" y1="10" x2="6.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
              <line x1="10" y1="10" x2="10.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
              <line x1="14" y1="10" x2="14.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
              <line x1="18" y1="10" x2="18.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
              <line x1="8" y1="14" x2="16" y2="14" strokeWidth={2.5} strokeLinecap="round" />
            </svg>
            Keyboards
          </span>
          {joinableOnly && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 border border-green-200 dark:border-green-700 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Open to join
            </span>
          )}
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center text-[11px] font-semibold text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
              {activeFilterCount} filter{activeFilterCount !== 1 ? "s" : ""} active
            </span>
          )}
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {joinableOnly ? "Open Keyboard Group Buys" : "Keyboard Group Buys"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {loading ? "Loading..." : `${total} keyboard${total !== 1 ? "s" : ""} found`}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <aside>
          <KeyboardFilters
            search={search}
            statuses={statuses}
            sortBy={sortBy}
            joinableOnly={joinableOnly}
            layouts={layouts}
            mounts={mounts}
            materials={materials}
            onSearchChange={(v) => updateParams({ search: v })}
            onStatusToggle={handleStatusToggle}
            onSortChange={(v) => updateParams({ sort: v })}
            onJoinableToggle={handleJoinableToggle}
            onLayoutToggle={(v) => handleMultiToggle("layout", layouts, v)}
            onMountToggle={(v) => handleMultiToggle("mount", mounts, v)}
            onMaterialToggle={(v) => handleMultiToggle("material", materials, v)}
          />
        </aside>

        <div>
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
            <div className="text-center py-20">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-violet-50 dark:bg-violet-950 mb-4">
                <svg className="w-8 h-8 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <line x1="6" y1="10" x2="6.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
                  <line x1="10" y1="10" x2="10.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
                  <line x1="14" y1="10" x2="14.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
                  <line x1="18" y1="10" x2="18.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
                  <line x1="8" y1="14" x2="16" y2="14" strokeWidth={2.5} strokeLinecap="round" />
                </svg>
              </div>
              <p className="font-semibold text-gray-700 dark:text-gray-300 text-lg">
                {activeFilterCount > 0 || joinableOnly ? "No keyboards match these filters" : "No keyboard GBs yet"}
              </p>
              <p className="text-sm text-gray-400 dark:text-gray-500 mt-1 max-w-xs mx-auto">
                {activeFilterCount > 0 || joinableOnly
                  ? "Try removing some filters to see more results."
                  : "Keyboard group buys will appear here when added. Check back soon."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
              {sets.map((set) => (
                <SetCard key={set.id} set={set} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
