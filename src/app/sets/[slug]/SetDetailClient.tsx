"use client";

import { useMemo, useState } from "react";
import { KeyboardPurchasePanel } from "@/components/set-detail/KeyboardPurchasePanel";
import { KeyboardOtherStores } from "@/components/set-detail/KeyboardOtherStores";
import { SharePosterButton } from "@/components/set-detail/SharePosterButton";
import { SuggestVendorPanel } from "@/components/set-detail/SuggestVendorPanel";
import { VendorTable } from "@/components/set-detail/VendorTable";
import { KitAvailability } from "@/components/set-detail/KitAvailability";
import { useLocation } from "@/context/LocationContext";
import { useCurrency } from "@/hooks/useCurrency";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import { priceFreshness } from "@/lib/utils";
import type { Region, VendorKitWithDetails } from "@/types";

interface Kit {
  id: string;
  name: string;
  type: string;
  vendorKits: VendorKitWithDetails[];
}

interface GroupBuyData {
  slug: string;
  name: string;
  status?: string;
  productType?: string;
  basePrice?: number | null;
  priceCurrency?: string | null;
  productUrl?: string | null;
  vendorName?: string | null;
  vendorRegion?: string | null;
  layout?: string | null;
  material?: string | null;
  mountingStyle?: string | null;
  kits: Kit[];
}

const RELEASED_STATUSES = new Set([
  "SHIPPING",
  "DELIVERED",
  "IN_STOCK",
  "CANCELLED",
]);

interface Props {
  groupBuy: GroupBuyData;
  initialCountry?: string;
}

export function SetDetailClient({ groupBuy }: Props) {
  const { region, currency, countryCode } = useLocation();
  const { rates, loading, convert } = useCurrency(currency);
  const { isTracked, toggle } = useTrackedSets();
  const [suggestOpen, setSuggestOpen] = useState(false);
  const isKeyboard = groupBuy.productType === "KEYBOARD";
  // Note: showcase boards (Lightning Keyboards) never reach this component —
  // the set-detail page renders a dedicated ShowcaseDetail view for them.

  const baseKit = groupBuy.kits[0];
  const vendorKitsForRegion = useMemo(() => {
    if (!baseKit) return [];
    return baseKit.vendorKits.map((vendorKit) => ({
      ...vendorKit,
      vendor: {
        ...vendorKit.vendor,
        shippingZones: vendorKit.vendor.shippingZones.filter(
          (zone) => zone.destinationRegion === region
        ),
      },
    }));
  }, [baseKit, region]);

  const bestPrice = useMemo(() => {
    if (isKeyboard || !rates || Object.keys(rates).length === 0) return null;
    const available = vendorKitsForRegion.filter((vendorKit) => {
      const zone = vendorKit.vendor.shippingZones[0];
      return (
        zone?.shipsToRegion &&
        vendorKit.inStock &&
        vendorKit.price != null &&
        vendorKit.currency != null
      );
    });
    if (available.length === 0) return null;

    let minimum = Infinity;
    let winner: (typeof available)[number] | null = null;
    for (const vendorKit of available) {
      const zone = vendorKit.vendor.shippingZones[0];
      const kit = convertCurrency(
        vendorKit.price as number,
        vendorKit.currency as string,
        currency,
        rates
      );
      const shipping = zone
        ? convertCurrency(
            zone.baseShippingCost,
            zone.currency,
            currency,
            rates
          )
        : 0;
      if (kit + shipping < minimum) {
        minimum = kit + shipping;
        winner = vendorKit;
      }
    }
    if (!(minimum < Infinity) || !winner) return null;
    return {
      formatted: formatCurrency(minimum, currency),
      // Freshness of the WINNING vendor's price, so the banner can say how
      // recently the headline number was actually checked.
      priceUpdatedAt: winner.priceUpdatedAt ?? null,
      isManual: winner.priceSource === "MANUAL",
    };
  }, [currency, isKeyboard, rates, vendorKitsForRegion]);

  const tracked = isTracked(groupBuy.slug);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={() => toggle(groupBuy.slug)}
          className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
            tracked
              ? "border-indigo-600 bg-indigo-600 text-white"
              : "border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:text-indigo-600"
          }`}
        >
          <svg
            className="h-4 w-4"
            fill={tracked ? "currentColor" : "none"}
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
            />
          </svg>
          {tracked ? "Tracked" : "Track this set"}
        </button>

        <SharePosterButton
          slug={groupBuy.slug}
          name={groupBuy.name}
          countryCode={countryCode}
          currency={currency}
        />
      </div>

      {bestPrice && !loading && (
        <div className="mb-5 flex items-center justify-between rounded-xl border border-green-200 bg-green-50 px-4 py-3">
          <div>
            <p className="text-xs font-medium text-green-600">
              Best price to {countryCode}
            </p>
            <p className="text-xl font-bold text-green-800">{bestPrice.formatted}</p>
            {(() => {
              if (bestPrice.isManual) {
                return <p className="text-[10px] text-green-600/80">Verified price</p>;
              }
              const freshness = priceFreshness(bestPrice.priceUpdatedAt);
              if (!freshness) return null;
              return freshness.stale ? (
                <p
                  className="text-[10px] font-medium text-amber-600"
                  title="This price hasn't been re-checked recently and may be outdated."
                >
                  ⚠ checked {freshness.label}
                </p>
              ) : (
                <p className="text-[10px] text-green-600/80">checked {freshness.label}</p>
              );
            })()}
          </div>
          <svg
            className="h-5 w-5 text-green-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
      )}

      {isKeyboard ? (
        <>
          <KeyboardPurchasePanel
            keyboard={groupBuy}
            destinationRegion={region}
            countryCode={countryCode}
            currency={currency}
            loading={loading}
            convert={convert}
          />
          <KeyboardOtherStores
            vendorKits={vendorKitsForRegion as never}
            currency={currency}
            convert={convert}
            loading={loading}
          />
        </>
      ) : (
        <>
          <div className="rounded-2xl border border-gray-100 bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">
                Base kit prices to {countryCode} in {currency}
              </h2>
              <span className="hidden text-xs text-gray-400 sm:inline">
                sorted by total cost
              </span>
            </div>

            <VendorTable
              slug={groupBuy.slug}
              vendorKits={vendorKitsForRegion as never}
              userRegion={region as Region}
              userCurrency={currency}
              rates={rates}
              loading={loading}
              showUnpriced={!RELEASED_STATUSES.has(groupBuy.status ?? "")}
              onSuggestVendor={() => setSuggestOpen(true)}
            />
          </div>

          {/* Subkit availability across vendors — the inverse of the base
              table, for collectors completing a set. */}
          <KitAvailability
            vendorKits={vendorKitsForRegion as never}
            userRegion={region as Region}
            userCurrency={currency}
            rates={rates}
          />
        </>
      )}

      {/* Suggest-vendor tab — visible on both keyboard and keycap set pages so
          anyone can point us at another store that carries this set/board. */}
      <button
        onClick={() => setSuggestOpen(true)}
        className="fixed bottom-6 right-0 z-30 flex items-center gap-2 rounded-l-xl bg-indigo-600 px-2 py-3 text-xs font-semibold tracking-wide text-white shadow-lg transition-colors hover:bg-indigo-700"
        style={{ writingMode: "vertical-rl" }}
        aria-label="Suggest a vendor link"
      >
        <svg
          className="h-4 w-4 rotate-90"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4v16m8-8H4"
          />
        </svg>
        {isKeyboard ? "Add a store link" : "Add vendor link"}
      </button>

      <SuggestVendorPanel
        slug={groupBuy.slug}
        isOpen={suggestOpen}
        onClose={() => setSuggestOpen(false)}
      />
    </div>
  );
}
