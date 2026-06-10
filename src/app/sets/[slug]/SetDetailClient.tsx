"use client";

import { useMemo } from "react";
import { VendorTable } from "@/components/set-detail/VendorTable";
import { SharePosterButton } from "@/components/set-detail/SharePosterButton";
import { useLocation } from "@/context/LocationContext";
import { useCurrency } from "@/hooks/useCurrency";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { formatCurrency, convertCurrency } from "@/lib/currency-utils";
import type { VendorKitWithDetails, Region } from "@/types";

interface Kit {
  id: string;
  name: string;
  type: string;
  vendorKits: VendorKitWithDetails[];
}

interface GroupBuyData {
  slug: string;
  name: string;
  kits: Kit[];
}

interface Props {
  groupBuy: GroupBuyData;
  initialCountry?: string;
}

export function SetDetailClient({ groupBuy }: Props) {
  const { region, currency, countryCode } = useLocation();
  const { rates, loading } = useCurrency(currency);
  const { isTracked, toggle } = useTrackedSets();

  // Only the base kit is ever shown — buyers use base kit price as the decision
  // factor; add-ons are secondary and researched separately.
  const baseKit = groupBuy.kits[0];

  const vendorKitsForRegion = useMemo(() => {
    if (!baseKit) return [];
    return baseKit.vendorKits.map((vk) => ({
      ...vk,
      vendor: {
        ...vk.vendor,
        shippingZones: vk.vendor.shippingZones.filter(
          (z) => z.destinationRegion === region
        ),
      },
    }));
  }, [baseKit, region]);

  const bestPrice = useMemo(() => {
    if (!rates || Object.keys(rates).length === 0) return null;
    const available = vendorKitsForRegion.filter((vk) => {
      const zone = vk.vendor.shippingZones[0];
      return vk.inStock && zone?.shipsToRegion && vk.price != null && vk.currency != null;
    });
    if (available.length === 0) return null;

    let min = Infinity;
    for (const vk of available) {
      const zone = vk.vendor.shippingZones[0];
      const kit = convertCurrency(vk.price as number, vk.currency as string, currency, rates);
      const ship = zone ? convertCurrency(zone.baseShippingCost, zone.currency, currency, rates) : 0;
      const total = kit + ship;
      if (total < min) min = total;
    }
    return min < Infinity ? formatCurrency(min, currency) : null;
  }, [vendorKitsForRegion, rates, currency]);

  const tracked = isTracked(groupBuy.slug);

  return (
    <div>
      {/* Actions bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <button
          onClick={() => toggle(groupBuy.slug)}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium transition-colors ${
            tracked
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:text-indigo-600"
          }`}
        >
          <svg className="w-4 h-4" fill={tracked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          {tracked ? "Tracked" : "Track this set"}
        </button>

        <SharePosterButton
          slug={groupBuy.slug}

          countryCode={countryCode}
          currency={currency}
          bestPrice={bestPrice ?? undefined}
        />
      </div>

      {/* Best price banner */}
      {bestPrice && !loading && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 mb-5 flex items-center justify-between">
          <div>
            <p className="text-xs text-green-600 font-medium">Best price to {countryCode}</p>
            <p className="text-xl font-bold text-green-800">{bestPrice}</p>
          </div>
          <span className="text-green-400">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </span>
        </div>
      )}

      {/* Vendor price table — base kit only */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">
            Base kit prices to {countryCode} in {currency}
          </h2>
          <span className="text-xs text-gray-400 hidden sm:inline">sorted by total cost</span>
        </div>

        <VendorTable
          vendorKits={vendorKitsForRegion as never}
          userRegion={region as Region}
          userCurrency={currency}
          rates={rates}
          loading={loading}
        />
      </div>
    </div>
  );
}
