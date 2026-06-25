"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyboardFilters } from "@/components/keyboards/KeyboardFilters";
import { KeyboardGallery } from "@/components/keyboards/KeyboardGallery";
import { useCurrency } from "@/hooks/useCurrency";
import { useLocation } from "@/context/LocationContext";
import { isShowcaseSource } from "@/lib/showcase";
import type { GBStatus, GroupBuyWithPricing } from "@/types";

const DAY = 24 * 60 * 60 * 1000;
const STATUS_ORDER: GBStatus[] = [
  "ACTIVE_GB",
  "IN_STOCK",
  "INTEREST_CHECK",
  "SHIPPING",
  "DELIVERED",
  "CANCELLED",
];

interface Props {
  defaultStatuses?: GBStatus[];
  sectionTitle?: string;
  sectionDescription?: string;
}

function daysLeft(end: Date | string | null): number | null {
  if (!end) return null;
  const value = Math.ceil((new Date(end).getTime() - Date.now()) / DAY);
  return Number.isNaN(value) ? null : value;
}

function isUsefulKeyboardListing(row: GroupBuyWithPricing): boolean {
  // Lightning Keyboards are a browse-only showcase source, never a group buy.
  if (isShowcaseSource(row.vendorName)) return false;
  const name = row.name.trim();
  if (/list of currently running|group buy index|read before posting/i.test(name)) {
    return false;
  }
  if (/\b(keycaps?|keyset)\b/i.test(name) && !/\bkeyboard\b/i.test(name)) {
    return false;
  }
  return true;
}

export default function KeyboardCollectionContent({
  defaultStatuses,
  sectionTitle = "Keyboard Group Buys",
  sectionDescription,
}: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { region, currency, countryCode } = useLocation();
  const { convert, format } = useCurrency(currency);

  const [all, setAll] = useState<GroupBuyWithPricing[]>([]);
  const [loading, setLoading] = useState(true);

  const search = searchParams.get("search") ?? "";
  const defaultSort = defaultStatuses?.includes("ACTIVE_GB")
    ? "closing"
    : defaultStatuses
    ? "updated"
    : "gbstart";
  const sortBy = searchParams.get("sort") ?? defaultSort;
  const closingSoon = searchParams.get("closing") === "1";
  const showClosingSoonToggle = (defaultStatuses ?? []).includes("ACTIVE_GB");
  const layouts = searchParams.getAll("layout");
  const brands = searchParams.getAll("brand");
  const rawStatuses = searchParams.getAll("status") as GBStatus[];

  const statuses = useMemo<GBStatus[]>(() => {
    if (rawStatuses.includes("all" as GBStatus)) return [];
    if (rawStatuses.length > 0) return rawStatuses;
    return defaultStatuses ?? [];
  }, [defaultStatuses, rawStatuses]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        type: "KEYBOARD",
        limit: "800",
      });
      if (defaultStatuses?.length) {
        defaultStatuses.forEach((status) => params.append("status", status));
      } else {
        params.set("status", "all");
      }
      const response = await fetch(
        `/api/group-buys?${params}`
      );
      if (!response.ok) throw new Error("Keyboard listings unavailable");
      const payload = await response.json();
      setAll((payload.data ?? []).filter(isUsefulKeyboardListing));
    } catch {
      setAll([]);
    } finally {
      setLoading(false);
    }
  }, [defaultStatuses]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const sectionItems = useMemo(() => {
    if (!defaultStatuses) return all;
    return all.filter((row) => defaultStatuses.includes(row.status));
  }, [all, defaultStatuses]);

  const availableStatuses = useMemo(
    () =>
      STATUS_ORDER.filter((status) =>
        sectionItems.some((row) => row.status === status)
      ),
    [sectionItems]
  );

  const filtered = useMemo(() => {
    const matching = sectionItems.filter((row) => {
      if (statuses.length > 0 && !statuses.includes(row.status)) return false;

      if (closingSoon) {
        const remaining = daysLeft(row.gbEnd ?? null);
        if (
          row.status !== "ACTIVE_GB" ||
          remaining === null ||
          remaining < 0 ||
          remaining > 7
        ) {
          return false;
        }
      }

      if (layouts.length > 0 && (!row.layout || !layouts.includes(row.layout))) {
        return false;
      }

      if (brands.length > 0) {
        const haystack =
          `${row.name} ${row.vendorName ?? ""} ${row.designer}`.toLowerCase();
        if (!brands.some((brand) => haystack.includes(brand.toLowerCase()))) {
          return false;
        }
      }

      if (search) {
        const query = search.toLowerCase();
        const haystack = [
          row.name,
          row.vendorName,
          row.designer,
          row.layout,
          row.mountingStyle,
          row.material,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    });

    return [...matching].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);

      if (sortBy === "price-asc" || sortBy === "price-desc") {
        const priceA =
          a.basePrice != null && a.priceCurrency
            ? convert(a.basePrice, a.priceCurrency)
            : null;
        const priceB =
          b.basePrice != null && b.priceCurrency
            ? convert(b.basePrice, b.priceCurrency)
            : null;
        if (priceA === null && priceB === null) {
          return a.name.localeCompare(b.name);
        }
        if (priceA === null) return 1;
        if (priceB === null) return -1;
        return sortBy === "price-asc" ? priceA - priceB : priceB - priceA;
      }

      if (sortBy === "updated") {
        const dateA = new Date(a.updatedAt ?? a.gbStart ?? 0).getTime();
        const dateB = new Date(b.updatedAt ?? b.gbStart ?? 0).getTime();
        return dateB - dateA;
      }

      if (sortBy === "gbstart") {
        const yearA = new Date(a.gbStart ?? a.updatedAt ?? 0).getTime();
        const yearB = new Date(b.gbStart ?? b.updatedAt ?? 0).getTime();
        return yearB - yearA;
      }

      const remainingA =
        a.status === "ACTIVE_GB" ? daysLeft(a.gbEnd ?? null) : null;
      const remainingB =
        b.status === "ACTIVE_GB" ? daysLeft(b.gbEnd ?? null) : null;
      const rankA =
        remainingA !== null && remainingA >= 0 ? remainingA : Number.MAX_VALUE;
      const rankB =
        remainingB !== null && remainingB >= 0 ? remainingB : Number.MAX_VALUE;
      if (rankA !== rankB) return rankA - rankB;
      if (a.status !== b.status) {
        return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      }
      return a.name.localeCompare(b.name);
    });
  }, [
    sectionItems,
    statuses,
    closingSoon,
    layouts,
    brands,
    search,
    sortBy,
    convert,
  ]);

  const updateParams = useCallback(
    (updates: Record<string, string | string[]>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        params.delete(key);
        if (Array.isArray(value)) {
          value.forEach((item) => params.append(key, item));
        } else if (value) {
          params.set(key, value);
        }
      }
      const query = params.toString();
      router.replace(query ? `?${query}` : "?");
    },
    [router, searchParams]
  );

  const handleStatusToggle = (status: GBStatus) => {
    const next = statuses.includes(status)
      ? statuses.filter((item) => item !== status)
      : [...statuses, status];
    updateParams({
      status: next.length > 0 ? next : ["all"],
      closing: "",
    });
  };

  const handleMultiToggle = (
    key: "layout" | "brand",
    current: string[],
    value: string
  ) => {
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    updateParams({ [key]: next });
  };

  const clearFilters = () =>
    updateParams({
      search: "",
      status: [],
      closing: "",
      layout: [],
      brand: [],
      sort: "",
    });

  const pricedCount = sectionItems.filter(
    (row) => row.basePrice != null && row.priceCurrency
  ).length;
  const closingCount = sectionItems.filter((row) => {
    const remaining = daysLeft(row.gbEnd ?? null);
    return (
      row.status === "ACTIVE_GB" &&
      remaining !== null &&
      remaining >= 0 &&
      remaining <= 7
    );
  }).length;
  const inStockCount = sectionItems.filter(
    (row) => row.status === "IN_STOCK"
  ).length;
  const description =
    sectionDescription ??
    "Browse live custom keyboard projects and in-stock extras as a visual collection. Compare the details that matter, then open the official sale page.";

  return (
    <main className="mx-auto max-w-7xl px-4 py-7 sm:px-6 sm:py-9 lg:px-8">
      <section className="relative mb-6 overflow-hidden rounded-[2rem] bg-gradient-to-br from-gray-950 via-violet-950 to-indigo-900 px-6 py-7 text-white shadow-xl shadow-violet-950/10 sm:px-8 sm:py-9">
        <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-indigo-400/10 blur-3xl" />
        <div className="relative max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-violet-100 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Collector&apos;s board
          </span>
          <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">
            {sectionTitle}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-indigo-100/80 sm:text-base">
            {description}
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold backdrop-blur">
              {loading ? "—" : sectionItems.length} listings
            </span>
            <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold backdrop-blur">
              {loading ? "—" : pricedCount} with pricing
            </span>
            {inStockCount > 0 && (
              <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold text-amber-100 backdrop-blur">
                {inStockCount} in-stock extras
              </span>
            )}
            {closingCount > 0 && (
              <button
                onClick={() => updateParams({ closing: "1", status: [] })}
                className="rounded-full border border-rose-300/25 bg-rose-300/10 px-3 py-1.5 text-xs font-semibold text-rose-100 backdrop-blur transition hover:bg-rose-300/20"
              >
                {closingCount} closing this week
              </button>
            )}
          </div>
        </div>
      </section>

      <KeyboardFilters
        search={search}
        statuses={statuses}
        availableStatuses={availableStatuses}
        sortBy={sortBy}
        closingSoon={closingSoon}
        showClosingSoon={showClosingSoonToggle}
        layouts={layouts}
        brands={brands}
        statusFilterActive={rawStatuses.length > 0}
        onSearchChange={(value) => updateParams({ search: value })}
        onStatusToggle={handleStatusToggle}
        onSortChange={(value) => updateParams({ sort: value })}
        onClosingToggle={() =>
          updateParams({ closing: closingSoon ? "" : "1" })
        }
        onLayoutToggle={(value) =>
          handleMultiToggle("layout", layouts, value)
        }
        onBrandToggle={(value) => handleMultiToggle("brand", brands, value)}
        onClearAll={clearFilters}
      />

      <div className="mb-4 mt-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-400">
            Curated results
          </p>
          <h2 className="mt-1 text-xl font-bold text-gray-950 dark:text-white">
            {loading
              ? "Loading keyboards"
              : `${filtered.length} keyboard${filtered.length === 1 ? "" : "s"}`}
          </h2>
        </div>
        <p className="max-w-md text-left text-xs leading-5 text-gray-500 dark:text-gray-400 sm:text-right">
          Prices shown in {currency}; landed estimates include approximate
          shipping to {countryCode}.
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="overflow-hidden rounded-3xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
            >
              <div className="aspect-[16/10] animate-pulse bg-gray-100 dark:bg-gray-800" />
              <div className="space-y-3 p-5">
                <div className="h-5 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                <div className="h-4 w-1/2 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                <div className="h-20 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <section className="rounded-3xl border border-dashed border-gray-300 bg-white px-6 py-20 text-center dark:border-gray-700 dark:bg-gray-900">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-50 text-violet-500 dark:bg-violet-950">
            <svg
              className="h-9 w-9"
              viewBox="0 0 48 32"
              fill="none"
              stroke="currentColor"
            >
              <rect x="1" y="1" width="46" height="30" rx="5" />
              <path d="M7 9h4M15 9h4M23 9h4M31 9h4M39 9h2M7 16h5M16 16h5M25 16h5M34 16h7M10 23h28" />
            </svg>
          </div>
          <h2 className="mt-5 text-lg font-bold text-gray-900 dark:text-white">
            No keyboards match these filters
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Clear the filters to return to the full collection.
          </p>
          <button
            onClick={clearFilters}
            className="mt-5 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-violet-700"
          >
            Clear filters
          </button>
        </section>
      ) : (
        <KeyboardGallery
          rows={filtered}
          currency={currency}
          destRegion={region}
          countryCode={countryCode}
          convert={convert}
          format={format}
        />
      )}
    </main>
  );
}
