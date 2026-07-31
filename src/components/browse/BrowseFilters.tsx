"use client";

import { STATUS_LABELS } from "@/lib/utils";
import { KEYCAP_MAKER_LABELS, type KeycapMaker } from "@/lib/set-name";
import type { GBStatus } from "@/types";

const ALL_STATUSES: GBStatus[] = [
  "INTEREST_CHECK",
  "ACTIVE_GB",
  "SHIPPING",
  "DELIVERED",
  "IN_STOCK",
];

const ALL_MAKERS: KeycapMaker[] = ["GMK", "SP"];

interface BrowseFiltersProps {
  search: string;
  statuses: GBStatus[];
  makers: KeycapMaker[];
  sortBy: string;
  finishingSoon: boolean;
  newArrivals: boolean;
  onSearchChange: (v: string) => void;
  onStatusToggle: (s: GBStatus) => void;
  onMakerToggle: (m: KeycapMaker) => void;
  onSortChange: (v: string) => void;
  onFinishingToggle: () => void;
  onNewToggle: () => void;
}

export function BrowseFilters({
  search,
  statuses,
  makers,
  sortBy,
  finishingSoon,
  newArrivals,
  onSearchChange,
  onStatusToggle,
  onMakerToggle,
  onSortChange,
  onFinishingToggle,
  onNewToggle,
}: BrowseFiltersProps) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-4 space-y-4">
      {/* Search */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search sets, designers, colorways..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Quick filters */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Quick filters</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onFinishingToggle}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              finishingSoon
                ? "bg-red-500 text-white border-red-500"
                : "bg-white text-gray-600 border-gray-200 hover:border-red-300"
            }`}
          >
            ⏳ Finishing soon
          </button>
          <button
            onClick={onNewToggle}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              newArrivals
                ? "bg-green-500 text-white border-green-500"
                : "bg-white text-gray-600 border-gray-200 hover:border-green-300"
            }`}
          >
            ✨ New arrivals
          </button>
        </div>
      </div>

      {/* Maker filters — GMK vs Signature Plastics. No pill selected means
          "all makers", so sets whose profile we don't recognise stay visible
          instead of vanishing behind a filter nobody set. */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Brand</p>
        <div className="flex flex-wrap gap-2">
          {ALL_MAKERS.map((maker) => (
            <button
              key={maker}
              onClick={() => onMakerToggle(maker)}
              aria-pressed={makers.includes(maker)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                makers.includes(maker)
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
              }`}
            >
              {KEYCAP_MAKER_LABELS[maker]}
            </button>
          ))}
        </div>
      </div>

      {/* Status filters */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Status</p>
        <div className="flex flex-wrap gap-2">
          {ALL_STATUSES.map((status) => (
            <button
              key={status}
              onClick={() => onStatusToggle(status)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                statuses.includes(status)
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
              }`}
            >
              {STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </div>

      {/* Sort */}
      <div className="flex items-center gap-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">Sort by</p>
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value)}
          className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
        >
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>
    </div>
  );
}
