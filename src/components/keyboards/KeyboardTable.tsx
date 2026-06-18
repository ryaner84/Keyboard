"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import type { GroupBuyWithPricing, GBStatus } from "@/types";
import { normalizeImageUrl } from "@/lib/utils";
import { estimateKeyboardShippingUSD } from "@/lib/keyboard-shipping";
import { ReportListingButton } from "@/components/ui/ReportListingButton";
import { useTrackedSets } from "@/hooks/useTrackedSets";

interface Props {
  rows: GroupBuyWithPricing[];
  currency: string;
  destRegion: string;
  countryCode: string;
  convert: (amount: number, from: string) => number;
  format: (amount: number, from: string) => string;
}

type SortKey = "name" | "stage" | "price" | "ends";
type SortDir = "asc" | "desc";

const DAY = 24 * 60 * 60 * 1000;

// Lifecycle order for the "stage" sort and grouping.
const STAGE_ORDER: Record<GBStatus, number> = {
  ACTIVE_GB: 0,
  IN_STOCK: 1,
  INTEREST_CHECK: 2,
  SHIPPING: 3,
  DELIVERED: 4,
  CANCELLED: 5,
};

const STAGE_META: Record<string, { label: string; cls: string; dot: string }> = {
  ACTIVE_GB: { label: "GB Open", cls: "text-green-700 bg-green-50 border-green-200 dark:text-green-300 dark:bg-green-950 dark:border-green-800", dot: "bg-green-500" },
  IN_STOCK: { label: "Extra Drop", cls: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950 dark:border-amber-800", dot: "bg-amber-500" },
  INTEREST_CHECK: { label: "Interest Check", cls: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950 dark:border-blue-800", dot: "bg-blue-500" },
  SHIPPING: { label: "Shipping", cls: "text-purple-700 bg-purple-50 border-purple-200 dark:text-purple-300 dark:bg-purple-950 dark:border-purple-800", dot: "bg-purple-500" },
  DELIVERED: { label: "Delivered", cls: "text-gray-600 bg-gray-50 border-gray-200 dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700", dot: "bg-gray-400" },
  CANCELLED: { label: "Cancelled", cls: "text-gray-500 bg-gray-50 border-gray-200", dot: "bg-gray-400" },
};

function daysLeft(end: Date | string | null): number | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - Date.now();
  if (isNaN(ms)) return null;
  return Math.ceil(ms / DAY);
}

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-SG", { day: "numeric", month: "short" });
}

// What to show in the countdown column based on status + end date.
function Countdown({ row }: { row: GroupBuyWithPricing }) {
  const d = daysLeft(row.gbEnd ?? null);

  if (row.status === "ACTIVE_GB" && d !== null && d >= 0) {
    const urgent = d <= 3;
    const soon = d <= 7;
    return (
      <span
        className={`inline-flex items-center gap-1 font-bold text-xs px-2 py-0.5 rounded-full ${
          urgent
            ? "text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-950 animate-pulse"
            : soon
              ? "text-orange-700 bg-orange-100 dark:text-orange-300 dark:bg-orange-950"
              : "text-gray-600 bg-gray-100 dark:text-gray-300 dark:bg-gray-800"
        }`}
      >
        {d === 0 ? "Today!" : `${d}d left`}
      </span>
    );
  }
  if (row.status === "IN_STOCK") return <span className="text-xs text-amber-600 font-medium">In stock</span>;
  if (row.status === "INTEREST_CHECK") return <span className="text-xs text-blue-500 font-medium">Voting</span>;
  if (row.status === "SHIPPING") return <span className="text-xs text-purple-500 font-medium">In transit</span>;
  if (row.status === "DELIVERED") return <span className="text-xs text-gray-400">Closed</span>;
  return <span className="text-xs text-gray-400">—</span>;
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  const active = sortKey === col;
  return (
    <th className={`px-3 py-2.5 ${className}`}>
      <button
        onClick={() => onSort(col)}
        className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
          active ? "text-violet-600 dark:text-violet-400" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        } ${align === "right" ? "ml-auto" : align === "center" ? "mx-auto" : ""}`}
      >
        {label}
        <span className="text-[8px] leading-none">
          {active ? (sortDir === "asc" ? "▲" : "▼") : "▲▼"}
        </span>
      </button>
    </th>
  );
}

export function KeyboardTable({ rows, currency, destRegion, countryCode, convert, format }: Props) {
  const { isTracked, toggle } = useTrackedSets();
  const [sortKey, setSortKey] = useState<SortKey>("ends");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      // sensible default direction per column
      setSortDir(k === "price" || k === "ends" ? "asc" : "asc");
    }
  };

  const sorted = useMemo(() => {
    const copy = [...rows];
    const dir = sortDir === "asc" ? 1 : -1;

    copy.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name) * dir;
        case "stage":
          return (STAGE_ORDER[a.status] - STAGE_ORDER[b.status]) * dir;
        case "price": {
          const pa = a.basePrice && a.priceCurrency ? convert(a.basePrice, a.priceCurrency) : Infinity;
          const pb = b.basePrice && b.priceCurrency ? convert(b.basePrice, b.priceCurrency) : Infinity;
          return (pa - pb) * dir;
        }
        case "ends":
        default: {
          // Closing-soon first: active GBs with the nearest future end date.
          // Items without a meaningful countdown sink to the bottom regardless of dir.
          const da = a.status === "ACTIVE_GB" ? daysLeft(a.gbEnd ?? null) : null;
          const db = b.status === "ACTIVE_GB" ? daysLeft(b.gbEnd ?? null) : null;
          const va = da !== null && da >= 0 ? da : Infinity;
          const vb = db !== null && db >= 0 ? db : Infinity;
          if (va === vb) return STAGE_ORDER[a.status] - STAGE_ORDER[b.status];
          return (va - vb) * dir;
        }
      }
    });
    return copy;
  }, [rows, sortKey, sortDir, convert]);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead className="border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
            <tr>
              <SortHeader label="Keyboard" col="name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Stage" col="stage" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label={`Price (${currency})`} col="price" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <th className="px-3 py-2.5 hidden md:table-cell">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Vendor</span>
              </th>
              <SortHeader label="GB Ends" col="ends" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <th className="px-3 py-2.5 text-right">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Link</span>
              </th>
              <th className="w-8" />
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800/50">
            {sorted.map((row) => {
              const meta = STAGE_META[row.status] ?? STAGE_META.DELIVERED;
              const img = normalizeImageUrl(row.imageUrl);
              const specLine = [row.layout, row.mountingStyle, row.material].filter(Boolean).join(" · ");
              const priceLocal = row.basePrice && row.priceCurrency ? convert(row.basePrice, row.priceCurrency) : null;
              const ship = estimateKeyboardShippingUSD(row.vendorRegion, destRegion);
              const shipLocal = convert(ship.usd, "USD");

              return (
                <tr key={row.id} className="hover:bg-violet-50/40 dark:hover:bg-violet-950/20 transition-colors">
                  {/* Keyboard: thumb + name + specs */}
                  <td className="px-3 py-2.5">
                    <Link href={`/sets/${row.slug}?country=${countryCode}`} className="flex items-center gap-3 group">
                      <div className="relative w-12 h-9 rounded-md overflow-hidden bg-gray-100 dark:bg-gray-800 shrink-0">
                        {img ? (
                          <Image src={img} alt={row.name} fill className="object-cover" unoptimized />
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center text-gray-300 text-base">⌨</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-900 dark:text-white truncate group-hover:text-violet-600 dark:group-hover:text-violet-400 max-w-[200px]">
                          {row.name}
                        </div>
                        {specLine && (
                          <div className="text-[11px] text-gray-400 truncate max-w-[200px]">{specLine}</div>
                        )}
                      </div>
                    </Link>
                  </td>

                  {/* Stage */}
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold border px-2 py-0.5 rounded-full ${meta.cls}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  </td>

                  {/* Price + est. shipping */}
                  <td className="px-3 py-2.5">
                    {priceLocal !== null ? (
                      <div>
                        <div className="font-bold text-gray-900 dark:text-white">
                          {format(row.basePrice!, row.priceCurrency!)}
                        </div>
                        <div className="text-[11px] text-gray-400" title={`Estimated ${ship.band} shipping`}>
                          + ~{formatShort(shipLocal, currency)} ship
                        </div>
                      </div>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>

                  {/* Vendor + region */}
                  <td className="px-3 py-2.5 hidden md:table-cell">
                    <div className="text-gray-700 dark:text-gray-300 text-xs font-medium">{row.vendorName ?? row.designer}</div>
                    {row.vendorRegion && (
                      <div className="text-[11px] text-gray-400">{regionLabel(row.vendorRegion)}</div>
                    )}
                  </td>

                  {/* Countdown / ends */}
                  <td className="px-3 py-2.5">
                    <Countdown row={row} />
                    {row.status === "ACTIVE_GB" && row.gbEnd && (
                      <div className="text-[11px] text-gray-400 mt-0.5">{fmtDate(row.gbEnd)}</div>
                    )}
                  </td>

                  {/* External link */}
                  <td className="px-3 py-2.5 text-right">
                    {row.productUrl ? (
                      <a
                        href={row.productUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Visit
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    ) : (
                      <Link href={`/sets/${row.slug}?country=${countryCode}`} className="text-xs text-gray-400 hover:text-violet-600">
                        Details
                      </Link>
                    )}
                  </td>

                  {/* Personal tracker */}
                  <td className="py-2.5">
                    <button
                      onClick={() => toggle(row.slug)}
                      title={isTracked(row.slug) ? "Remove from tracker" : "Add to tracker"}
                      className={`rounded-md p-1.5 transition-colors ${
                        isTracked(row.slug)
                          ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950"
                          : "text-gray-300 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950"
                      }`}
                    >
                      <svg className="h-4 w-4" fill={isTracked(row.slug) ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                      </svg>
                    </button>
                  </td>

                  {/* Report */}
                  <td className="pr-2 py-2.5">
                    <ReportListingButton slug={row.slug} name={row.name} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Compact currency (no decimals, used for the small shipping estimate line).
function formatShort(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

function regionLabel(region: string): string {
  const map: Record<string, string> = {
    US: "🇺🇸 US", CA: "🇨🇦 Canada", EU: "🇪🇺 Europe", UK: "🇬🇧 UK",
    AU: "🇦🇺 Australia", SG: "🇸🇬 Singapore", ASIA: "🌏 Asia",
    CN: "🇨🇳 China", China: "🇨🇳 China", Korea: "🇰🇷 Korea",
    Global: "🌐 Global", GLOBAL: "🌐 Global",
  };
  return map[region] ?? region;
}
