"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SetCard } from "@/components/browse/SetCard";
import { BrowseFilters } from "@/components/browse/BrowseFilters";
import type { GroupBuyWithPricing, GBStatus } from "@/types";

const DEFAULT_STATUSES: GBStatus[] = ["INTEREST_CHECK", "ACTIVE_GB"];

export default function BrowseContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [sets, setSets] = useState<GroupBuyWithPricing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const search = searchParams.get("search") ?? "";
  const sortBy = searchParams.get("sort") ?? "date-desc";
  const finishing = searchParams.get("finishing") ?? "";
  const newDays = searchParams.get("new") ?? "";
  const rawStatuses = searchParams.getAll("status") as GBStatus[];
  const statuses: GBStatus[] = useMemo(
    () => {
      // "all" is an explicit marker meaning the user deselected every status
      // pill — show everything. Distinct from a fresh visit (no status params
      // at all), which gets the default selection.
      if (rawStatuses.includes("all" as GBStatus)) return [];
      return rawStatuses.length > 0 ? rawStatuses : DEFAULT_STATUSES;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams.toString()]
  );

  const fetchSets = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (sortBy) params.set("sort", sortBy);
    if (finishing) params.set("finishing", finishing);
    if (newDays) params.set("new", newDays);
    params.set("limit", "60");
    statuses.forEach((s) => params.append("status", s));

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
  }, [search, sortBy, statuses, finishing, newDays]);

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
      router.replace(`/browse?${params.toString()}`);
    },
    [searchParams, router]
  );

  const handleStatusToggle = (status: GBStatus) => {
    const next = statuses.includes(status)
      ? statuses.filter((s) => s !== status)
      : [...statuses, status];
    // Empty selection = show all sets. Keep the explicit "all" marker in the
    // URL so it isn't mistaken for a fresh visit (which re-applies defaults).
    updateParams({ status: next.length > 0 ? next : ["all"] });
  };

  // Finishing-soon and new-arrivals are mutually exclusive quick filters.
  const handleFinishingToggle = () => {
    updateParams({ finishing: finishing ? "" : "7", new: "" });
  };
  const handleNewToggle = () => {
    updateParams({ new: newDays ? "" : "14", finishing: "" });
  };

  const title = finishing
    ? "Finishing Soon"
    : newDays
      ? "New Group Buys"
      : "Browse Sets";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {loading ? "Loading..." : `${total} set${total !== 1 ? "s" : ""} found`}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <aside>
          <BrowseFilters
            search={search}
            statuses={statuses}
            sortBy={sortBy}
            finishingSoon={!!finishing}
            newArrivals={!!newDays}
            onSearchChange={(v) => updateParams({ search: v })}
            onStatusToggle={handleStatusToggle}
            onSortChange={(v) => updateParams({ sort: v })}
            onFinishingToggle={handleFinishingToggle}
            onNewToggle={handleNewToggle}
          />
        </aside>

        <div>
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                  <div className="aspect-video bg-gray-100 animate-pulse" />
                  <div className="p-4 space-y-2">
                    <div className="h-4 bg-gray-100 rounded animate-pulse w-3/4" />
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : sets.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <p className="text-4xl mb-3">⌨</p>
              <p className="font-medium text-gray-500">No sets found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
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
