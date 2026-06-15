"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { KeyboardFilters } from "@/components/keyboards/KeyboardFilters";
import { KeyboardStatCards } from "@/components/keyboards/KeyboardStatCards";
import { KeyboardTable } from "@/components/keyboards/KeyboardTable";
import { useLocation } from "@/context/LocationContext";
import { useCurrency } from "@/hooks/useCurrency";
import type { GroupBuyWithPricing, GBStatus } from "@/types";

const DAY = 24 * 60 * 60 * 1000;
const JOINABLE_STATUSES: GBStatus[] = ["ACTIVE_GB", "IN_STOCK"];

interface Props {
  defaultStatuses?: GBStatus[];
  sectionTitle?: string;
  sectionDescription?: string;
}

export default function KeyboardsContent({
  defaultStatuses,
  sectionTitle = "Keyboard Group Buy Dashboard",
  sectionDescription,
}: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { region, currency, countryCode } = useLocation();
  const { convert, format } = useCurrency(currency);

  const [all, setAll] = useState<GroupBuyWithPricing[]>([]);
  const [loading, setLoading] = useState(true);

  const search = searchParams.get("search") ?? "";
  const sortBy = searchParams.get("sort") ?? "date-desc";
  const joinableOnly = searchParams.get("joinable") === "1";
  const closingSoon = searchParams.get("closing") === "1";
  const layouts = searchParams.getAll("layout");
  const brands = searchParams.getAll("brand");
  const rawStatuses = searchParams.getAll("status") as GBStatus[];

  const statuses: GBStatus[] = useMemo(() => {
    if (joinableOnly) return JOINABLE_STATUSES;
    if (rawStatuses.includes("all" as GBStatus)) return defaultStatuses ?? [];
    if (rawStatuses.length > 0) return rawStatuses;
    return defaultStatuses ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString(), joinableOnly, defaultStatuses?.join(",")]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/group-buys?type=KEYBOARD&status=all&limit=200`);
      const data = await res.json();
      setAll(data.data ?? []);
    } catch {
      setAll([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Filter to section scope first, then apply user-chosen sub-filters
  const sectionItems = useMemo(() => {
    if (!defaultStatuses) return all;
    return all.filter((k) => defaultStatuses.includes(k.status));
  }, [all, defaultStatuses]);

  const filtered = useMemo(() => {
    return sectionItems.filter((k) => {
      if (statuses.length > 0 && !statuses.includes(k.status)) return false;
      if (closingSoon) {
        if (k.status !== "ACTIVE_GB" || !k.gbEnd) return false;
        const d = Math.ceil((new Date(k.gbEnd).getTime() - Date.now()) / DAY);
        if (isNaN(d) || d < 0 || d > 7) return false;
      }
      if (layouts.length > 0 && !(k.layout && layouts.includes(k.layout))) return false;
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
  }, [sectionItems, statuses, closingSoon, layouts, brands, search]);

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

  const handleStatusToggle = (status: GBStatus) => {
    if (joinableOnly) return;
    const next = statuses.includes(status)
      ? statuses.filter((s) => s !== status)
      : [...statuses, status];
    updateParams({ status: next.length > 0 ? next : ["all"], closing: "" });
  };

  const handleJoinableToggle = () =>
    updateParams({ joinable: joinableOnly ? "" : "1", status: [], closing: "" });

  const handleMultiToggle = (key: string, current: string[], value: string) => {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    updateParams({ [key]: next });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-5">
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
          {closingSoon && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 bg-red-50 dark:bg-red-950 dark:text-red-300 border border-red-200 dark:border-red-700 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> Closing soon
            </span>
          )}
          {joinableOnly && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 border border-green-200 dark:border-green-700 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> Open to join
            </span>
          )}
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{sectionTitle}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {loading
            ? "Loading..."
            : sectionDescription
              ? sectionDescription
              : `Tracking ${sectionItems.length} keyboards · ${filtered.length} shown · prices in ${currency} incl. est. shipping to ${countryCode}`}
        </p>
      </div>

      {/* KPI stat cards */}
      {!loading && all.length > 0 && (
        <KeyboardStatCards
          all={all}
          currency={currency}
          convert={convert}
          format={format}
          onSelectOpen={() => updateParams({ status: ["ACTIVE_GB"], joinable: "", closing: "" })}
          onSelectIC={() => updateParams({ status: ["INTEREST_CHECK"], joinable: "", closing: "" })}
          onSelectExtra={() => updateParams({ status: ["IN_STOCK"], joinable: "", closing: "" })}
          onSelectClosingSoon={() => updateParams({ closing: "1", status: [], joinable: "" })}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        <aside>
          <KeyboardFilters
            search={search}
            statuses={statuses}
            sortBy={sortBy}
            joinableOnly={joinableOnly}
            layouts={layouts}
            brands={brands}
            onSearchChange={(v) => updateParams({ search: v })}
            onStatusToggle={handleStatusToggle}
            onSortChange={(v) => updateParams({ sort: v })}
            onJoinableToggle={handleJoinableToggle}
            onLayoutToggle={(v) => handleMultiToggle("layout", layouts, v)}
            onBrandToggle={(v) => handleMultiToggle("brand", brands, v)}
          />
        </aside>

        <div>
          {loading ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-4 space-y-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-12 h-9 rounded-md bg-gray-100 dark:bg-gray-800 animate-pulse" />
                  <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-violet-50 dark:bg-violet-950 mb-4">
                <svg className="w-8 h-8 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <line x1="8" y1="14" x2="16" y2="14" strokeWidth={2.5} strokeLinecap="round" />
                </svg>
              </div>
              <p className="font-semibold text-gray-700 dark:text-gray-300 text-lg">
                {all.length === 0 ? "No keyboard GBs yet" : "No keyboards match these filters"}
              </p>
              <p className="text-sm text-gray-400 dark:text-gray-500 mt-1 max-w-xs mx-auto">
                {all.length === 0
                  ? "The scraper runs daily — keyboard group buys will appear here soon."
                  : "Try clearing some filters to see more results."}
              </p>
            </div>
          ) : (
            <KeyboardTable
              rows={filtered}
              currency={currency}
              destRegion={region}
              countryCode={countryCode}
              convert={convert}
              format={format}
            />
          )}
        </div>
      </div>
    </div>
  );
}
