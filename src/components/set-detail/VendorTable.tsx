"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import { dhlShippingUsd, dhlEstimatedDays } from "@/lib/import/shipping";
import { priceFreshness } from "@/lib/utils";
import { variantsInCategory, type KitVariant } from "@/lib/kit-variants";
import type { VendorKitWithDetails, ExchangeRates } from "@/types";
import type { Region } from "@/types";

interface VendorTableProps {
  slug: string;
  vendorKits: VendorKitWithDetails[];
  userRegion: Region;
  userCurrency: string;
  rates: ExchangeRates;
  loading: boolean;
  // Released sets hide unpriced vendor links entirely (stale GB leftovers);
  // active GBs keep them — the GB page link is useful before prices exist.
  showUnpriced?: boolean;
  onSuggestVendor?: () => void;
}

interface RowData {
  vk: VendorKitWithDetails;
  kitPriceLocal: number;
  shippingLocal: number;
  totalLocal: number;
  estimatedDays: string;
  // Some sets sell several base kits (e.g. Hiragana Base / Latin Base) —
  // when a vendor lists 2+, each is shown as its own line under the row.
  baseVariants: Array<KitVariant & { priceLocal: number }>;
}

// Small flag button + inline popover for reporting a wrong price.
function ReportPriceButton({
  slug,
  vendorKitId,
  vendorName,
}: {
  slug: string;
  vendorKitId: string;
  vendorName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "done">("idle");
  const ref = useRef<HTMLDivElement>(null);

  // Close popover when clicking outside.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const submit = async () => {
    setState("submitting");
    try {
      await fetch("/api/price-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setSlug: slug, vendorKitId, vendorName, reason }),
      });
      setState("done");
      setTimeout(() => {
        setOpen(false);
        setState("idle");
        setReason("");
      }, 1500);
    } catch {
      setState("idle");
    }
  };

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Report wrong price"
        className="flex items-center gap-0.5 text-[11px] text-gray-300 hover:text-red-400 transition-colors px-1 py-0.5 rounded"
      >
        {/* flag icon */}
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
          <path d="M3.5 2a.5.5 0 0 1 .5.5V3h8.146l-1.5 3 1.5 3H4v4.5a.5.5 0 0 1-1 0V2.5a.5.5 0 0 1 .5-.5z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-50 w-56 bg-white rounded-xl shadow-xl border border-gray-100 p-3">
          {state === "done" ? (
            <p className="text-xs text-green-600 font-medium text-center py-1">Thanks for the report!</p>
          ) : (
            <>
              <p className="text-xs font-semibold text-gray-700 mb-2">Report wrong price</p>
              <p className="text-[11px] text-gray-400 mb-2">
                Optional: tell us what&apos;s wrong (e.g. wrong currency, product mismatch)
              </p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                rows={2}
                className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-300 mb-2"
              />
              <div className="flex gap-2">
                <button
                  onClick={submit}
                  disabled={state === "submitting"}
                  className="flex-1 text-xs bg-red-500 hover:bg-red-600 text-white font-medium rounded-lg py-1.5 transition-colors disabled:opacity-60"
                >
                  {state === "submitting" ? "Sending…" : "Report"}
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="text-xs text-gray-400 hover:text-gray-600 px-2"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function VendorTable({
  slug,
  vendorKits,
  userRegion,
  userCurrency,
  rates,
  loading,
  showUnpriced = true,
  onSuggestVendor,
}: VendorTableProps) {
  const rows: RowData[] = useMemo(() => {
    const out: RowData[] = [];
    for (const vk of vendorKits) {
      // Vendors without a scraped/manual kit price are not shown at all —
      // a row with no price is noise, not information.
      if (vk.price == null) continue;
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

      // All BASE-classified variants this vendor carries (Hiragana Base,
      // Latin Base, …) converted to the viewer's currency. Only meaningful
      // when there are 2+ — a single base is already the row's Kit price.
      const baseVariants = variantsInCategory(vk.variants, "BASE").map((v) => ({
        ...v,
        priceLocal: convertCurrency(v.price, kitCurrency, userCurrency, rates),
      }));

      // With 2+ bases the row shows "from <cheapest>" — sort/total on that
      // same number so the Best badge and the displayed price agree.
      const effectiveKitLocal =
        baseVariants.length > 1
          ? Math.min(...baseVariants.map((v) => v.priceLocal))
          : kitPriceLocal;

      out.push({
        vk,
        kitPriceLocal: effectiveKitLocal,
        shippingLocal,
        totalLocal: effectiveKitLocal + shippingLocal,
        estimatedDays,
        baseVariants,
      });
    }
    // Purchasable listings rank first, then cheapest total within each group.
    out.sort((a, b) => {
      if (a.vk.inStock !== b.vk.inStock) return a.vk.inStock ? -1 : 1;
      return a.totalLocal - b.totalLocal;
    });
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

  if (rows.length === 0 && (!showUnpriced || unpricedRows.length === 0)) {
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

  const bestVendorId = rows.find((candidate) => candidate.vk.inStock)?.vk.id;

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const isBest = row.vk.id === bestVendorId;
        const multiBase = row.baseVariants.length > 1;

        return (
          <div
            key={row.vk.id}
            className={`p-4 rounded-xl border transition-colors ${
              !row.vk.inStock
                ? "bg-gray-50 border-gray-200"
                : isBest
                ? "bg-green-50 border-green-200"
                : "bg-white border-gray-100 hover:border-indigo-100 hover:bg-indigo-50/30"
            }`}
          >
          <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
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
              <p className="text-sm text-gray-700">
                {multiBase && <span className="text-xs text-gray-400">from </span>}
                {formatCurrency(row.kitPriceLocal, userCurrency)}
              </p>
            </div>

            {/* Shipping — DHL estimate */}
            <div className="text-right hidden md:block w-24">
              <p className="text-xs text-gray-400">
                Ship <span className="text-gray-300">· DHL est.</span>
              </p>
              <p className="text-sm text-gray-700">
                {row.shippingLocal === 0 ? "Free" : formatCurrency(row.shippingLocal, userCurrency)}
              </p>
            </div>

            {/* Vendor inventory status */}
            <div className="w-20 text-right sm:w-24 sm:text-center">
              <p className="text-xs text-gray-400">Stock</p>
              <span
                className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${
                  row.vk.inStock
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-gray-200 text-gray-600"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    row.vk.inStock ? "bg-emerald-500" : "bg-gray-400"
                  }`}
                />
                {row.vk.inStock ? "In stock" : "Sold out"}
              </span>
            </div>

            {/* Total + report flag */}
            <div className="text-right w-20 sm:w-24">
              <p className="text-xs text-gray-400">Total</p>
              <p className={`text-base font-bold ${isBest ? "text-green-700" : "text-gray-900"}`}>
                {formatCurrency(row.totalLocal, userCurrency)}
              </p>
              {/* Freshness: MANUAL prices are curated and deliberately never
                  re-scraped, so they'd read "stale" forever — label them
                  verified instead of aging them. */}
              {row.vk.priceSource === "MANUAL" ? (
                <p className="text-[10px] text-gray-400 mt-0.5">Verified price</p>
              ) : (
                (() => {
                  const freshness = priceFreshness(row.vk.priceUpdatedAt);
                  if (!freshness) return null;
                  return freshness.stale ? (
                    <p
                      className="mt-0.5 text-[10px] font-medium text-amber-600"
                      title="This price hasn't been re-checked recently and may be outdated."
                    >
                      ⚠ checked {freshness.label}
                    </p>
                  ) : (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      checked {freshness.label}
                    </p>
                  );
                })()
              )}
            </div>

            {/* Buy button */}
            {row.vk.inStock && (row.vk.gbUrl || row.vk.productUrl) ? (
              <a
                href={(row.vk.gbUrl || row.vk.productUrl)!}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap flex-shrink-0"
              >
                Buy →
              </a>
            ) : !row.vk.inStock ? (
              <span className="ml-1 rounded-lg bg-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-500 whitespace-nowrap flex-shrink-0">
                Sold out
              </span>
            ) : null}

            {/* Report wrong price — small flag, opens popover */}
            <ReportPriceButton
              slug={slug}
              vendorKitId={row.vk.id}
              vendorName={row.vk.vendor.name}
            />
          </div>

          {/* Multiple base kits (e.g. Hiragana Base / Latin Base) — list each
              one so buyers see exactly which base they'd be ordering. */}
          {multiBase && (
            <div className="mt-3 pt-2 border-t border-gray-100 flex flex-wrap gap-x-5 gap-y-1">
              {row.baseVariants.map((v) => (
                <p key={v.title} className="text-xs text-gray-500">
                  {v.title}{" "}
                  <span className="font-semibold text-gray-700">
                    {formatCurrency(v.priceLocal, userCurrency)}
                  </span>
                </p>
              ))}
            </div>
          )}
          </div>
        );
      })}

      {/* Vendors with no live price yet — show as direct store links */}
      {showUnpriced && unpricedRows.length > 0 && (
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
