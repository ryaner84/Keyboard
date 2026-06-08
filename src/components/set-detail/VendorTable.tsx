"use client";

import { useMemo } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import type { VendorKitWithDetails, ExchangeRates } from "@/types";
import type { Region } from "@/types";

interface VendorTableProps {
  vendorKits: VendorKitWithDetails[];
  userRegion: Region;
  userCurrency: string;
  rates: ExchangeRates;
  loading: boolean;
}

interface RowData {
  vk: VendorKitWithDetails;
  kitPriceLocal: number;
  shippingLocal: number | null;
  totalLocal: number;
  shipsToRegion: boolean;
  estimatedDays: string;
}

export function VendorTable({
  vendorKits,
  userRegion,
  userCurrency,
  rates,
  loading,
}: VendorTableProps) {
  const rows: RowData[] = useMemo(() => {
    return vendorKits.map((vk) => {
      const zone = vk.vendor.shippingZones?.[0];
      const kitPriceLocal = convertCurrency(vk.price, vk.currency, userCurrency, rates);

      const shipsToRegion = zone?.shipsToRegion ?? false;
      const shippingLocal =
        zone && shipsToRegion
          ? convertCurrency(zone.baseShippingCost, zone.currency, userCurrency, rates)
          : null;

      const totalLocal = kitPriceLocal + (shippingLocal ?? 0);

      const estimatedDays =
        zone && shipsToRegion && zone.estimatedDaysMin > 0
          ? `${zone.estimatedDaysMin}–${zone.estimatedDaysMax} days`
          : shipsToRegion
            ? "Free shipping"
            : "—";

      return { vk, kitPriceLocal, shippingLocal, totalLocal, shipsToRegion, estimatedDays };
    });
  }, [vendorKits, userRegion, userCurrency, rates]);

  const sorted = useMemo(() => {
    const available = rows.filter((r) => r.shipsToRegion && r.vk.inStock);
    const unavailable = rows.filter((r) => !r.shipsToRegion || !r.vk.inStock);
    available.sort((a, b) => a.totalLocal - b.totalLocal);
    return [...available, ...unavailable];
    // userRegion is intentionally omitted — it's only used to derive rows via prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="text-center py-10 text-gray-400">
        No vendors found for this kit.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sorted.map((row, idx) => {
        const isBest = idx === 0 && row.shipsToRegion && row.vk.inStock;
        const isUnavailable = !row.shipsToRegion || !row.vk.inStock;

        return (
          <div
            key={row.vk.id}
            className={`flex items-center gap-3 p-4 rounded-xl border transition-colors ${
              isBest
                ? "bg-green-50 border-green-200"
                : isUnavailable
                  ? "bg-gray-50 border-gray-100 opacity-60"
                  : "bg-white border-gray-100 hover:border-indigo-100 hover:bg-indigo-50/30"
            }`}
          >
            {/* Vendor info */}
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-bold text-gray-500">
                  {row.vk.vendor.name.slice(0, 2).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <p className={`text-sm font-semibold truncate ${isUnavailable ? "text-gray-400" : "text-gray-900"}`}>
                  {row.vk.vendor.name}
                  {isBest && (
                    <span className="ml-2 px-1.5 py-0.5 bg-green-600 text-white text-xs rounded-full font-medium">
                      Best
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-400">
                  {row.vk.vendor.country} · {row.estimatedDays}
                </p>
              </div>
            </div>

            {/* Prices */}
            {!isUnavailable ? (
              <>
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-gray-400">Kit</p>
                  <p className="text-sm text-gray-700">{formatCurrency(row.kitPriceLocal, userCurrency)}</p>
                </div>
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-gray-400">Shipping</p>
                  <p className="text-sm text-gray-700">
                    {row.shippingLocal === 0
                      ? "Free"
                      : row.shippingLocal !== null
                        ? formatCurrency(row.shippingLocal, userCurrency)
                        : "—"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-400">Total</p>
                  <p className={`text-base font-bold ${isBest ? "text-green-700" : "text-gray-900"}`}>
                    {formatCurrency(row.totalLocal, userCurrency)}
                  </p>
                </div>
                {row.vk.gbUrl && (
                  <a
                    href={row.vk.gbUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap flex-shrink-0"
                  >
                    Buy →
                  </a>
                )}
              </>
            ) : (
              <span className="text-xs text-gray-400 ml-auto">
                {!row.vk.inStock ? "Out of stock" : `Doesn't ship to ${userRegion}`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
