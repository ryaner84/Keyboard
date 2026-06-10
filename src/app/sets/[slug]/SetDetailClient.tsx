"use client";

import { useState, useMemo } from "react";
import { KitSelector } from "@/components/set-detail/KitSelector";
import { VendorTable } from "@/components/set-detail/VendorTable";
import { OtherItemsTable } from "@/components/set-detail/OtherItemsTable";
import { SharePosterButton } from "@/components/set-detail/SharePosterButton";
import { useLocation } from "@/context/LocationContext";
import { useCurrency } from "@/hooks/useCurrency";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { formatCurrency, convertCurrency } from "@/lib/currency-utils";
import { VARIANT_CATEGORIES, categoryPrice, parseVariants, type VariantCategory } from "@/lib/kit-variants";
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

  const [selectedKitId, setSelectedKitId] = useState<string>(
    groupBuy.kits[0]?.id ?? ""
  );
  const [category, setCategory] = useState<VariantCategory>("BASE");

  const selectedKit = useMemo(
    () => groupBuy.kits.find((k) => k.id === selectedKitId) ?? groupBuy.kits[0],
    [groupBuy.kits, selectedKitId]
  );

  const vendorKitsForRegion = useMemo(() => {
    if (!selectedKit) return [];
    return selectedKit.vendorKits.map((vk) => ({
      ...vk,
      vendor: {
        ...vk.vendor,
        shippingZones: vk.vendor.shippingZones.filter(
          (z) => z.destinationRegion === region
        ),
      },
    }));
  }, [selectedKit, region]);

  // Apply the kit-category filter. For each standard category the vendor's
  // price comes from its scraped variants; vendors whose catalog shows they
  // don't carry that kit are dropped, while vendors not yet scanned keep a
  // null price ("view on vendor site"). BASE falls back to the stored price.
  const vendorKitsForCategory = useMemo(() => {
    if (category === "OTHERS") return vendorKitsForRegion;
    return vendorKitsForRegion
      .map((vk) => {
        const fromVariants = categoryPrice(vk.variants, category);
        if (fromVariants != null) return { ...vk, price: fromVariants };
        if (category === "BASE") return vk; // stored price IS the base price
        // No scanned variants at all → keep with unknown price; scanned but
        // missing this category → vendor doesn't sell it, drop the row.
        return parseVariants(vk.variants).length === 0 ? { ...vk, price: null } : null;
      })
      .filter((vk): vk is NonNullable<typeof vk> => vk !== null);
  }, [vendorKitsForRegion, category]);

  const bestPrice = useMemo(() => {
    if (!rates || Object.keys(rates).length === 0) return null;
    if (category === "OTHERS") return null;
    const available = vendorKitsForCategory.filter((vk) => {
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
  }, [vendorKitsForCategory, category, rates, currency]);

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

      {/* Kit selector */}
      {groupBuy.kits.length > 1 && (
        <div className="mb-4">
          <p className="text-sm font-medium text-gray-500 mb-2">Select kit</p>
          <KitSelector
            kits={groupBuy.kits}
            selectedKitId={selectedKitId}
            onChange={setSelectedKitId}
          />
        </div>
      )}

      {/* Vendor price table */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="font-semibold text-gray-900">
            Prices to {countryCode} in {currency}
          </h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-gray-500">
              Kit
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as VariantCategory)}
                className="px-2.5 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-400"
              >
                {VARIANT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {category !== "OTHERS" && (
              <span className="text-xs text-gray-400 hidden sm:inline">sorted by total cost</span>
            )}
          </div>
        </div>

        {category === "OTHERS" ? (
          <OtherItemsTable
            vendorKits={vendorKitsForCategory as never}
            userCurrency={currency}
            rates={rates}
            loading={loading}
          />
        ) : (
          <VendorTable
            vendorKits={vendorKitsForCategory as never}
            userRegion={region as Region}
            userCurrency={currency}
            rates={rates}
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}
