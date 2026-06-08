"use client";

import { useMemo } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import { formatRelativeDate } from "@/lib/utils";
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
  hasPrice: boolean;
  kitPriceLocal: number | null;
  shippingLocal: number | null;
  totalLocal: number | null;
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
      const shipsToRegion = zone?.shipsToRegion ?? false;

      const hasPrice = vk.price != null && vk.currency != null;
      const kitPriceLocal = hasPrice
        ? convertCurrency(vk.price as number, vk.currency as string, userCurrency, rates)
        : null;

      const shippingLocal =
        zone && shipsToRegion
          ? convertCurrency(zone.baseShippingCost, zone.currency, userCurrency, rates)
          : null;

      const totalLocal =
        kitPriceLocal != null ? kitPriceLocal + (shippingLocal ?? 0) : null;

      const estimatedDays =
        zone && shipsToRegion && zone.estimatedDaysMin > 0
          ? `${zone.estimatedDaysMin}–${zone.estimatedDaysMax} days`
          : shipsToRegion
            ? "Free/standard shipping"
            : "—";

      return { vk, hasPrice, kitPriceLocal, shippingLocal, totalLocal, shipsToRegion, estimatedDays };
    });
  }, [vendorKits, userCurrency, rates]);

  const sorted = useMemo(() => {
    // Priced + ships-here rows first (cheapest first), then the rest.
    const priced = rows.filter((r) => r.totalLocal != null && r.shipsToRegion && r.vk.inStock);
    const rest = rows.filter((r) => !(r.totalLocal != null && r.shipsToRegion && r.vk.inStock));
    priced.sort((a, b) => (a.totalLocal! - b.totalLocal!));
    return [...priced, ...rest];
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
        No vendors listed for this set yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sorted.map((row, idx) => {
        const isBest = idx === 0 && row.totalLocal != null && row.shipsToRegion && row.vk.inStock;
        const unavailable = !row.shipsToRegion || !row.vk.inStock;

        return (
          <div
            key={row.vk.id}
            className={`flex items-center gap-3 p-4 rounded-xl border transition-colors ${
              isBest
                ? "bg-green-50 border-green-200"
                : unavailable
                  ? "bg-gray-50 border-gray-100 opacity-70"
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
                <p className={`text-sm font-semibold truncate ${unavailable ? "text-gray-400" : "text-gray-900"}`}>
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

            {/* Price area */}
            {row.hasPrice && !unavailable ? (
              <>
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-gray-400">Kit</p>
                  <p className="text-sm text-gray-700">{formatCurrency(row.kitPriceLocal!, userCurrency)}</p>
                </div>
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-gray-400">Shipping</p>
                  <p className="text-sm text-gray-700">
                    {row.shippingLocal === 0
                      ? "Free"
                      : row.shippingLocal != null
                        ? formatCurrency(row.shippingLocal, userCurrency)
                        : "—"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-400">Total</p>
                  <p className={`text-base font-bold ${isBest ? "text-green-700" : "text-gray-900"}`}>
                    {formatCurrency(row.totalLocal!, userCurrency)}
                  </p>
                  {row.vk.priceUpdatedAt && (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Updated {formatRelativeDate(row.vk.priceUpdatedAt)}
                    </p>
                  )}
                </div>
                {(row.vk.gbUrl || row.vk.productUrl) && (
                  <a
                    href={(row.vk.gbUrl || row.vk.productUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap flex-shrink-0"
                  >
                    Buy →
                  </a>
                )}
              </>
            ) : (
              <div className="flex items-center gap-3 ml-auto">
                <span className="text-xs text-gray-400 text-right">
                  {!row.vk.inStock
                    ? "Out of stock"
                    : !row.shipsToRegion
                      ? `Doesn't ship to ${userRegion}`
                      : "Price not available"}
                </span>
                {(row.vk.gbUrl || row.vk.productUrl) && (
                  <a
                    href={(row.vk.gbUrl || row.vk.productUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 border border-gray-200 text-gray-600 text-xs font-medium rounded-lg hover:border-indigo-300 hover:text-indigo-600 transition-colors whitespace-nowrap flex-shrink-0"
                  >
                    View on vendor site →
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
