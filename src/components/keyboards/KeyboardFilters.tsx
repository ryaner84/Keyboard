"use client";

import type { GBStatus } from "@/types";

const LAYOUTS = [
  "40%",
  "60%",
  "65%",
  "75%",
  "TKL",
  "Full-size",
  "Alice/Arisu",
  "Other",
];

const BRANDS = [
  "TGR",
  "Keycult",
  "Matrix",
  "Mode",
  "Geonworks",
  "Rama",
  "Norbauer",
  "Duck",
  "Hiney",
  "Angry Miao",
  "Percent",
  "Swagkeys",
  "CannonKeys",
  "NovelKeys",
  "KBDfans",
];

const STATUS_META: Record<
  GBStatus,
  { label: string; active: string; dot: string }
> = {
  ACTIVE_GB: {
    label: "Group buys",
    active:
      "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  IN_STOCK: {
    label: "In-stock extras",
    active:
      "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  INTEREST_CHECK: {
    label: "Interest checks",
    active:
      "border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  SHIPPING: {
    label: "Shipping",
    active:
      "border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  DELIVERED: {
    label: "Delivered",
    active:
      "border-gray-500 bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200",
    dot: "bg-gray-500",
  },
  CANCELLED: {
    label: "Cancelled",
    active:
      "border-gray-500 bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200",
    dot: "bg-gray-500",
  },
};

interface KeyboardFiltersProps {
  search: string;
  statuses: GBStatus[];
  availableStatuses?: GBStatus[];
  sortBy: string;
  closingSoon?: boolean;
  showClosingSoon?: boolean;
  joinableOnly?: boolean;
  layouts: string[];
  brands: string[];
  statusFilterActive?: boolean;
  onSearchChange: (value: string) => void;
  onStatusToggle: (status: GBStatus) => void;
  onSortChange: (value: string) => void;
  onClosingToggle?: () => void;
  onJoinableToggle?: () => void;
  onLayoutToggle: (value: string) => void;
  onBrandToggle: (value: string) => void;
  onClearAll?: () => void;
}

function ChipGroup({
  options,
  active,
  onToggle,
}: {
  options: string[];
  active: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = active.includes(option);
        return (
          <button
            key={option}
            onClick={() => onToggle(option)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
              selected
                ? "border-violet-600 bg-violet-600 text-white"
                : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function KeyboardFilters({
  search,
  statuses,
  availableStatuses = [],
  sortBy,
  closingSoon = false,
  showClosingSoon = false,
  layouts,
  brands,
  statusFilterActive = false,
  onSearchChange,
  onStatusToggle,
  onSortChange,
  onClosingToggle,
  onLayoutToggle,
  onBrandToggle,
  onClearAll,
}: KeyboardFiltersProps) {
  const activeCount =
    layouts.length +
    brands.length +
    (closingSoon ? 1 : 0) +
    (statusFilterActive ? 1 : 0) +
    (search ? 1 : 0);

  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:p-5">
      <div
        className={`grid gap-3 ${
          showClosingSoon
            ? "lg:grid-cols-[minmax(260px,1fr)_190px_auto]"
            : "lg:grid-cols-[minmax(260px,1fr)_190px]"
        }`}
      >
        <label className="relative block">
          <span className="sr-only">Search keyboards</span>
          <svg
            className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="search"
            placeholder="Search keyboard, designer, vendor or layout"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 py-3 pl-10 pr-4 text-sm text-gray-900 outline-none transition focus:border-violet-400 focus:bg-white focus:ring-4 focus:ring-violet-100 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:focus:ring-violet-950"
          />
        </label>

        <label className="relative block">
          <span className="sr-only">Sort keyboards</span>
          <select
            value={sortBy}
            onChange={(event) => onSortChange(event.target.value)}
            className="h-full min-h-11 w-full appearance-none rounded-xl border border-gray-200 bg-white px-3 pr-9 text-sm font-semibold text-gray-700 outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:focus:ring-violet-950"
          >
            <option value="closing">Closing soon</option>
            <option value="updated">Recently updated</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="name">Name: A to Z</option>
          </select>
          <svg
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 9l4-4 4 4m0 6l-4 4-4-4"
            />
          </svg>
        </label>

        {showClosingSoon && onClosingToggle && (
          <button
            onClick={onClosingToggle}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-bold transition ${
              closingSoon
                ? "border-rose-500 bg-rose-500 text-white"
                : "border-gray-200 bg-white text-gray-700 hover:border-rose-400 hover:text-rose-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                closingSoon ? "animate-pulse bg-white" : "bg-rose-500"
              }`}
            />
            Closing within 7 days
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
        <span className="mr-1 text-[11px] font-bold uppercase tracking-[0.14em] text-gray-400">
          Stage
        </span>
        {availableStatuses.map((status) => {
          const meta = STATUS_META[status];
          const selected = statuses.length === 0 || statuses.includes(status);
          return (
            <button
              key={status}
              onClick={() => onStatusToggle(status)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition ${
                selected
                  ? meta.active
                  : "border-gray-200 bg-white text-gray-500 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  selected ? meta.dot : "bg-gray-300 dark:bg-gray-600"
                }`}
              />
              {meta.label}
            </button>
          );
        })}

        {activeCount > 0 && onClearAll && (
          <button
            onClick={onClearAll}
            className="ml-auto text-xs font-bold text-violet-600 hover:text-violet-800 dark:text-violet-400"
          >
            Clear filters ({activeCount})
          </button>
        )}
      </div>

      <details className="group mt-4 border-t border-gray-100 pt-4 dark:border-gray-800">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-bold text-gray-700 dark:text-gray-200">
          <span>
            More filters
            {(layouts.length > 0 || brands.length > 0) && (
              <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                {layouts.length + brands.length} active
              </span>
            )}
          </span>
          <svg
            className="h-4 w-4 text-gray-400 transition group-open:rotate-180"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </summary>

        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-gray-400">
              Layout
            </p>
            <ChipGroup
              options={LAYOUTS}
              active={layouts}
              onToggle={onLayoutToggle}
            />
          </div>
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-gray-400">
              Maker / vendor
            </p>
            <ChipGroup
              options={BRANDS}
              active={brands}
              onToggle={onBrandToggle}
            />
          </div>
        </div>
      </details>
    </section>
  );
}
