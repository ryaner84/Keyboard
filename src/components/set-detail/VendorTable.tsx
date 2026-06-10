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
  onSuggestVendor?: () => void;
}

interface RowData {
  vk: VendorKitWithDetails;
  kitPriceLocal: number;
  shippingLocal: number;
  totalLocal: number;
  estimatedDays: string;
}

export function VendorTable({
  vendorKits,
  userRegion,
  userCurrency,
  rates,
  loading,
  onSuggestVendor,
}: VendorTableProps) {
  const rows: RowData[] = useMemo(() => {
    const out: RowData[] = [];
    for (const vk of vendorKits) {
      // Vendors without a scraped/manual kit price are not shown at all —
      // a row with no price is noise, not information.
      if (vk.price == null || !vk.currency) continue;

      // Pick the shipping zone for the *user's* region.
      const zone = vk.vendor.shippingZones?.find(
        (z) => z.destinationRegion === userRegion
      );
      if (!zone?.shipsToRegion || !vk.inStock) continue;

      const kitPriceLocal = convertCurrency(
        vk.price as number,
        vk.currency as string,
        userCurrency,
        rates
      );
      const shippingLocal = convertCurrency(
        zone.baseShippingCost,
        zone.currency,
        userCurrency,
        rates
      );
      const estimatedDays =
        zone.estimatedDaysMin > 0
          ? `${zone.estimatedDaysMin}–${zone.estimatedDaysMax} days`
          : "Standard shipping";

      out.push({
        vk,
        kitPriceLocal,
        shippingLocal,
        totalLocal: kitPriceLocal + shippingLocal,
        estimatedDays,
      });
    }
    // Cheapest total first.
    out.sort((a, b) => a.totalLocal - b.totalLocal);
    return out;
  }, [vendorKits, userRegion, userCurrency, rates]);

  // Vendors that exist but aren't shown (no price yet) — surfaced only as a
  // nudge to contribute a product link.
  const hiddenCount = useMemo(
    () => vendorKits.length - rows.length,
    [vendorKits, rows]
  );

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-gray-400 mb-3">No pricing data available for this region yet.</p>
        {onSuggestVendor && (
          <button
            onClick={onSuggestVendor}
            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium underline underline-offset-2"
          >
            Know a vendor? Add a link →
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => {
        const isBest = idx === 0;

        return (
          <div
            key={row.vk.id}
            className={`flex items-center gap-3 p-4 rounded-xl border transition-colors ${
              isBest
                ? "bg-green-50 border-green-200"
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
                <p className="text-sm font-semibold truncate text-gray-900">
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

            {/* Kit price (hidden on the smallest screens) */}
            <div className="text-right hidden sm:block w-20">
              <p className="text-xs text-gray-400">Kit</p>
              <p className="text-sm text-gray-700">{formatCurrency(row.kitPriceLocal, userCurrency)}</p>
            </div>

            {/* Shipping — DHL estimate */}
            <div className="text-right w-24">
              <p className="text-xs text-gray-400">
                Ship <span className="text-gray-300">· DHL est.</span>
              </p>
              <p className="text-sm text-gray-700">
                {row.shippingLocal === 0 ? "Free" : formatCurrency(row.shippingLocal, userCurrency)}
              </p>
            </div>

            {/* Total */}
            <div className="text-right w-24">
              <p className="text-xs text-gray-400">Total</p>
              <p className={`text-base font-bold ${isBest ? "text-green-700" : "text-gray-900"}`}>
                {formatCurrency(row.totalLocal, userCurrency)}
              </p>
              {row.vk.priceUpdatedAt && (
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Updated {formatRelativeDate(row.vk.priceUpdatedAt)}
                </p>
              )}
            </div>

            {/* Buy button */}
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
          </div>
        );
      })}

      {/* Footer: DHL disclaimer + vendor-link nudge */}
      <div className="flex items-start justify-between gap-4 pt-2">
        <p className="text-xs text-gray-400 flex-1">
          Shipping is an estimate via DHL Express (~1&nbsp;kg parcel) to {userRegion}. The
          final shipping cost is set at checkout on the vendor&apos;s own site.
        </p>
        {hiddenCount > 0 && onSuggestVendor && (
          <button
            onClick={onSuggestVendor}
            className="text-xs text-indigo-500 hover:text-indigo-700 whitespace-nowrap font-medium shrink-0"
          >
            + Add vendor link
          </button>
        )}
      </div>
    </div>
  );
}
