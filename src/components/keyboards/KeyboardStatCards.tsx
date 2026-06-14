"use client";

import type { GroupBuyWithPricing } from "@/types";

interface Props {
  all: GroupBuyWithPricing[];           // full unfiltered keyboard list
  currency: string;
  convert: (amount: number, from: string) => number;
  format: (amount: number, from: string) => string;
  // Clicking a stat applies the matching quick filter.
  onSelectOpen: () => void;
  onSelectIC: () => void;
  onSelectExtra: () => void;
  onSelectClosingSoon: () => void;
}

const DAY = 24 * 60 * 60 * 1000;

function daysLeft(end: Date | string | null): number | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - Date.now();
  if (isNaN(ms)) return null;
  return Math.ceil(ms / DAY);
}

export function KeyboardStatCards({
  all,
  currency,
  convert,
  format,
  onSelectOpen,
  onSelectIC,
  onSelectExtra,
  onSelectClosingSoon,
}: Props) {
  const open = all.filter((k) => k.status === "ACTIVE_GB");
  const ic = all.filter((k) => k.status === "INTEREST_CHECK");
  const extra = all.filter((k) => k.status === "IN_STOCK");
  const closingSoon = open.filter((k) => {
    const d = daysLeft(k.gbEnd);
    return d !== null && d >= 0 && d <= 7;
  });

  // Average price of everything that has a price, in the user's currency.
  const priced = all.filter((k) => k.basePrice && k.priceCurrency);
  const avg =
    priced.length > 0
      ? priced.reduce((sum, k) => sum + convert(k.basePrice!, k.priceCurrency!), 0) /
        priced.length
      : null;

  const cards = [
    {
      key: "open",
      label: "Open Now",
      value: open.length,
      sub: "Group buys live",
      accent: "text-green-600 dark:text-green-400",
      ring: "hover:border-green-300 dark:hover:border-green-600",
      dot: "bg-green-500",
      onClick: onSelectOpen,
    },
    {
      key: "soon",
      label: "Closing Soon",
      value: closingSoon.length,
      sub: "Ends in ≤ 7 days",
      accent: "text-red-600 dark:text-red-400",
      ring: "hover:border-red-300 dark:hover:border-red-600",
      dot: "bg-red-500",
      urgent: true,
      onClick: onSelectClosingSoon,
    },
    {
      key: "ic",
      label: "Interest Check",
      value: ic.length,
      sub: "Gauging demand",
      accent: "text-blue-600 dark:text-blue-400",
      ring: "hover:border-blue-300 dark:hover:border-blue-600",
      dot: "bg-blue-500",
      onClick: onSelectIC,
    },
    {
      key: "extra",
      label: "Extra Drops",
      value: extra.length,
      sub: "In stock now",
      accent: "text-amber-600 dark:text-amber-400",
      ring: "hover:border-amber-300 dark:hover:border-amber-600",
      dot: "bg-amber-500",
      onClick: onSelectExtra,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
      {cards.map((c) => (
        <button
          key={c.key}
          onClick={c.onClick}
          className={`text-left bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-3.5 transition-all hover:shadow-sm ${c.ring}`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full ${c.dot} ${c.urgent && c.value > 0 ? "animate-pulse" : ""}`} />
            <span className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
              {c.label}
            </span>
          </div>
          <div className={`text-2xl font-extrabold ${c.accent}`}>{c.value}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{c.sub}</div>
        </button>
      ))}

      {/* Avg price card — informational, not clickable */}
      <div className="text-left bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-950 dark:to-indigo-950 rounded-xl border border-violet-100 dark:border-violet-800 p-3.5">
        <div className="flex items-center gap-1.5 mb-1">
          <svg className="w-3 h-3 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
          </svg>
          <span className="text-[11px] font-semibold text-violet-500 dark:text-violet-300 uppercase tracking-wide">
            Avg Price
          </span>
        </div>
        <div className="text-2xl font-extrabold text-violet-700 dark:text-violet-300">
          {avg !== null ? format(avg, currency) : "—"}
        </div>
        <div className="text-[11px] text-violet-400 dark:text-violet-400/70 mt-0.5">
          in {currency}, base kit
        </div>
      </div>
    </div>
  );
}
