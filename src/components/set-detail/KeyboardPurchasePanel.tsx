"use client";

import { estimateKeyboardShippingUSD } from "@/lib/keyboard-shipping";
import { formatCurrency } from "@/lib/currency-utils";

interface KeyboardPurchasePanelProps {
  keyboard: {
    status?: string;
    basePrice?: number | null;
    priceCurrency?: string | null;
    productUrl?: string | null;
    vendorName?: string | null;
    vendorRegion?: string | null;
    layout?: string | null;
    material?: string | null;
    mountingStyle?: string | null;
  };
  destinationRegion: string;
  countryCode: string;
  currency: string;
  loading: boolean;
  convert: (amount: number, fromCurrency: string) => number;
}

export function KeyboardPurchasePanel({
  keyboard,
  destinationRegion,
  countryCode,
  currency,
  loading,
  convert,
}: KeyboardPurchasePanelProps) {
  const shipping = estimateKeyboardShippingUSD(
    keyboard.vendorRegion,
    destinationRegion
  );
  const priceLocal =
    keyboard.basePrice != null && keyboard.priceCurrency
      ? convert(keyboard.basePrice, keyboard.priceCurrency)
      : null;
  const shippingLocal = convert(shipping.usd, "USD");
  const landed = priceLocal == null ? null : priceLocal + shippingLocal;
  const vendor = keyboard.vendorName || "Official vendor";
  const specs = [
    keyboard.layout,
    keyboard.mountingStyle,
    keyboard.material,
  ].filter(Boolean) as string[];
  const isOpen =
    keyboard.status === "ACTIVE_GB" || keyboard.status === "IN_STOCK";

  return (
    <section className="overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 bg-gradient-to-r from-gray-950 via-violet-950 to-indigo-900 px-5 py-5 text-white sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-violet-200">
              Official purchase
            </p>
            <h2 className="mt-1 text-xl font-bold">Buy from {vendor}</h2>
            <p className="mt-1 text-sm text-indigo-100/75">
              Direct vendor pricing with a landed-cost estimate for {countryCode}.
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold ${
              isOpen
                ? "border-emerald-300/30 bg-emerald-300/15 text-emerald-100"
                : "border-white/15 bg-white/10 text-indigo-100"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isOpen ? "bg-emerald-400" : "bg-gray-300"
              }`}
            />
            {keyboard.status === "IN_STOCK"
              ? "Available now"
              : keyboard.status === "ACTIVE_GB"
                ? "Group buy open"
                : "Check vendor status"}
          </span>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-sm font-black text-violet-700">
            {vendor.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="font-bold text-gray-950">{vendor}</p>
            <p className="text-xs text-gray-500">Official product listing</p>
          </div>
          {keyboard.productUrl && (
            <a
              href={keyboard.productUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto hidden items-center gap-1.5 text-xs font-semibold text-violet-600 hover:text-violet-800 sm:inline-flex"
            >
              Visit store
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 4h6m0 0v6m0-6L10 14m8 0v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />
              </svg>
            </a>
          )}
        </div>

        {specs.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2">
            {specs.map((spec) => (
              <span
                key={spec}
                className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-600"
              >
                {spec}
              </span>
            ))}
          </div>
        )}

        {loading ? (
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
            ))}
          </div>
        ) : priceLocal != null && keyboard.priceCurrency ? (
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-400">
                Starting price
              </p>
              <p className="mt-2 text-2xl font-black text-gray-950">
                {formatCurrency(priceLocal, currency)}
              </p>
              <p className="mt-1 text-[11px] text-gray-400">
                {keyboard.priceCurrency} {keyboard.basePrice?.toFixed(2)} at vendor
              </p>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-400">
                Est. shipping
              </p>
              <p className="mt-2 text-2xl font-black text-gray-950">
                {formatCurrency(shippingLocal, currency)}
              </p>
              <p className="mt-1 text-[11px] capitalize text-gray-400">
                {shipping.band} keyboard parcel
              </p>
            </div>
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-500">
                Est. landed
              </p>
              <p className="mt-2 text-2xl font-black text-violet-700">
                {formatCurrency(landed!, currency)}
              </p>
              <p className="mt-1 text-[11px] text-violet-500/70">
                Price + estimated shipping
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-5 py-6">
            <p className="font-semibold text-gray-800">
              Configuration pricing varies
            </p>
            <p className="mt-1 text-sm text-gray-500">
              Open the vendor listing to see current options and availability.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          {keyboard.productUrl ? (
            <a
              href={keyboard.productUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gray-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-violet-700"
            >
              Open {vendor} listing
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 4h6m0 0v6m0-6L10 14m8 0v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />
              </svg>
            </a>
          ) : (
            <span className="inline-flex flex-1 items-center justify-center rounded-xl bg-gray-100 px-5 py-3 text-sm font-semibold text-gray-400">
              Vendor link unavailable
            </span>
          )}
          <p className="text-xs leading-5 text-gray-400 sm:max-w-xs">
            Final configuration, taxes, and shipping are confirmed by the vendor at checkout.
          </p>
        </div>
      </div>
    </section>
  );
}
