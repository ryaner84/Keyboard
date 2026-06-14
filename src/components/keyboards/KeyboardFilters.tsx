"use client";

import type { GBStatus } from "@/types";

const LAYOUTS = ["40%", "60%", "65%", "75%", "TKL", "Full-size", "Alice/Arisu", "Other"];
const MOUNTS = ["Gasket", "Top Mount", "Tray Mount", "Leaf Spring", "Burger", "Plateless"];
const MATERIALS = ["Aluminum", "Polycarbonate", "PC + Brass", "Acrylic"];

// Labels use keyboard-collector vocabulary rather than generic e-commerce terms.
// Ordered by the typical lifecycle of a keyboard group buy.
const STATUS_OPTIONS: { value: GBStatus; label: string; desc: string; dot: string }[] = [
  {
    value: "INTEREST_CHECK",
    label: "Interest Check",
    desc: "Designer gauging interest — no ordering yet",
    dot: "bg-blue-400",
  },
  {
    value: "ACTIVE_GB",
    label: "Group Buy Open",
    desc: "Ordering window is live — join now",
    dot: "bg-green-500",
  },
  {
    value: "IN_STOCK",
    label: "Extra Drop",
    desc: "Post-GB leftover units available to buy now",
    dot: "bg-amber-400",
  },
  {
    value: "SHIPPING",
    label: "Shipping",
    desc: "GB closed, units on the way to buyers",
    dot: "bg-purple-400",
  },
  {
    value: "DELIVERED",
    label: "Delivered",
    desc: "GB complete — all units received",
    dot: "bg-gray-400",
  },
];

interface KeyboardFiltersProps {
  search: string;
  statuses: GBStatus[];
  sortBy: string;
  joinableOnly: boolean;
  layouts: string[];
  mounts: string[];
  materials: string[];
  onSearchChange: (v: string) => void;
  onStatusToggle: (s: GBStatus) => void;
  onSortChange: (v: string) => void;
  onJoinableToggle: () => void;
  onLayoutToggle: (v: string) => void;
  onMountToggle: (v: string) => void;
  onMaterialToggle: (v: string) => void;
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
        {label}
      </p>
      {children}
    </div>
  );
}

function ChipGroup({
  options,
  active,
  onToggle,
  color = "violet",
}: {
  options: string[];
  active: string[];
  onToggle: (v: string) => void;
  color?: "violet" | "indigo";
}) {
  const on = color === "violet"
    ? "bg-violet-600 text-white border-violet-600"
    : "bg-indigo-600 text-white border-indigo-600";
  const off = color === "violet"
    ? "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-violet-300 dark:hover:border-violet-600"
    : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-indigo-300";

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onToggle(opt)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
            active.includes(opt) ? on : off
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export function KeyboardFilters({
  search,
  statuses,
  sortBy,
  joinableOnly,
  layouts,
  mounts,
  materials,
  onSearchChange,
  onStatusToggle,
  onSortChange,
  onJoinableToggle,
  onLayoutToggle,
  onMountToggle,
  onMaterialToggle,
}: KeyboardFiltersProps) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-4 space-y-5">

      {/* Search */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search keyboards, designers..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 border border-gray-200 dark:border-gray-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:bg-gray-800 dark:text-white"
        />
      </div>

      {/* Availability — the #1 question for a keyboard hunter */}
      <button
        onClick={onJoinableToggle}
        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all ${
          joinableOnly
            ? "bg-green-50 dark:bg-green-950 border-green-400 dark:border-green-600 text-green-800 dark:text-green-300"
            : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-green-300"
        }`}
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className={`w-2 h-2 rounded-full ${joinableOnly ? "bg-green-500 animate-pulse" : "bg-gray-300 dark:bg-gray-600"}`} />
          Still open to join
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          joinableOnly
            ? "bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200"
            : "bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
        }`}>
          {joinableOnly ? "ON" : "OFF"}
        </span>
      </button>

      {/* Layout — second most important */}
      <FilterSection label="Layout">
        <ChipGroup options={LAYOUTS} active={layouts} onToggle={onLayoutToggle} />
      </FilterSection>

      {/* Mount type */}
      <FilterSection label="Mount type">
        <ChipGroup options={MOUNTS} active={mounts} onToggle={onMountToggle} />
      </FilterSection>

      {/* Material */}
      <FilterSection label="Material">
        <ChipGroup options={MATERIALS} active={materials} onToggle={onMaterialToggle} />
      </FilterSection>

      {/* Status — full lifecycle, collector vocabulary */}
      <FilterSection label="GB Stage">
        <div className="space-y-1.5">
          {STATUS_OPTIONS.map(({ value, label, desc, dot }) => {
            const isActive = statuses.includes(value);
            const closedStage = value === "SHIPPING" || value === "DELIVERED";
            const disabled = joinableOnly && closedStage;
            return (
              <button
                key={value}
                onClick={() => !disabled && onStatusToggle(value)}
                disabled={disabled}
                title={desc}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  isActive
                    ? "bg-violet-50 dark:bg-violet-950 border-violet-300 dark:border-violet-700 text-violet-800 dark:text-violet-200"
                    : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-violet-300"
                }`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${isActive ? dot : "bg-gray-300 dark:bg-gray-600"}`} />
                <span className="font-medium">{label}</span>
                <span className={`ml-auto text-[10px] ${isActive ? "text-violet-500" : "text-gray-400"}`}>
                  {desc}
                </span>
              </button>
            );
          })}
        </div>
        {!joinableOnly && (
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-2">
            Select none to show all stages
          </p>
        )}
      </FilterSection>

      {/* Sort */}
      <FilterSection label="Sort by">
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white dark:bg-gray-800 dark:text-white"
        >
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
          <option value="name">Name A–Z</option>
          <option value="ending-soon">Ending soon</option>
        </select>
      </FilterSection>

    </div>
  );
}
