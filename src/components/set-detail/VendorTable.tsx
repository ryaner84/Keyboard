"use client";

import { useMemo } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import { dhlShippingUsd, dhlEstimatedDays } from "@/lib/import/shipping";
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
      if (vk.price == null || !vk.inStock) continue;
      // No stored currency → the price is in the vendor's own store currency.
      const kitCurrency = vk.currency ?? vk.vendor.currency ?? "USD";

      // Pick the shipping zone for the *user's* region. Only an explicit
      // "doesn't ship here" excludes the vendor; a missing zone row (vendor
      // created between deploy-time backfills) falls back to the DHL lane
      // estimate instead of hiding a priced listing.
      const zone = vk.vendor.shippingZones?.find(
        (z) => z.destinationRegion === userRegion
      );
      if (zone && !zone.shipsToRegion) continue;

      const kitPriceLocal = convertCurrency(
        vk.price as number,
        kitCurrency,
        userCurrency,
        rates
      );
      const shippingLocal = zone
        ? convertCurrency(zone.baseShippingCost, zone.currency, userCurrency, rates)
        : convertCurrency(
            dhlShippingUsd(vk.vendor.region, userRegion),
            "USD",
            userCurrency,
            rates
          );
      const [daysMin, daysMax] = zone
        ? [zone.estimatedDaysMin, zone.estimatedDaysMax]
        : dhlEstimatedDays(vk.vendor.region, userRegion);
      const estimatedDays =
        daysMin > 0 ? `${daysMin}–${daysMax} days` : "Standard shipping";

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

  // Vendors with a URL but no live price yet — shown below priced rows as
  // direct store links so users can still buy even if we can't scrape the price.
  const unpricedRows = useMemo(() => {
    const pricedIds = new Set(rows.map((r) => r.vk.id));
    return vendorKits.filter((vk) => {
      if (pricedIds.has(vk.id)) return false;
      const zone = vk.vendor.shippingZones?.find((z) => z.destinationRegion === userRegion);
      // A missing zone row means "no data", not "doesn't ship" — keep the link.
      return !!(vk.gbUrl || vk.productUrl) && !(zone && !zone.shipsToRegion);
    });
  }, [vendorKits, rows, userRegion]);

  const hiddenCount = useMemo(
    () => vendorKits.length - rows.length - unpricedRows.length,
    [vendorKits, rows, unpricedRows]
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

      {/* Vendors with no live price yet — show as direct store links */}
      {unpricedRows.length > 0 && (
        <div className="mt-1 pt-3 border-t border-gray-100">
          <p className="text-xs text-gray-400 mb-2">No live price yet — check vendor site directly:</p>
          <div className="space-y-1.5">
            {unpricedRows.map((vk) => (
              <a
                key={vk.id}
                href={(vk.gbUrl || vk.productUrl)!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-dashed border-gray-200 hover:border-indigo-200 hover:bg-indigo-50/30 transition-colors"
              >
                <div className="w-7 h-7 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-gray-500">
                    {vk.vendor.name.slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-700 truncate">{vk.vendor.name}</p>
                  <p className="text-xs text-gray-400">{vk.vendor.country}</p>
                </div>
                <span className="text-xs text-indigo-500 font-medium flex-shrink-0">Visit store →</span>
              </a>
            ))}
          </div>
        </div>
      )}

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
