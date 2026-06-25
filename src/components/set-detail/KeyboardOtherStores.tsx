"use client";

import { formatCurrency } from "@/lib/currency-utils";
import type { VendorKitWithDetails } from "@/types";

interface KeyboardOtherStoresProps {
  // Suggested / discovered stores for a keyboard. Keyboards are single-vendor
  // on the GroupBuy row itself (rendered by KeyboardPurchasePanel); these are
  // the extra vendor links visitors add via "Add a store link", which would
  // otherwise be stored but never shown on a keyboard page.
  vendorKits: VendorKitWithDetails[];
  currency: string;
  convert: (amount: number, fromCurrency: string) => number;
  loading: boolean;
}

export function KeyboardOtherStores({
  vendorKits,
  currency,
  convert,
  loading,
}: KeyboardOtherStoresProps) {
  // Only stores we actually have a link for are worth showing.
  const stores = vendorKits.filter((vk) => vk.productUrl || vk.gbUrl);
  if (stores.length === 0) return null;

  return (
    <section className="mt-5 rounded-2xl border border-gray-100 bg-white p-5">
      <h2 className="mb-1 font-semibold text-gray-900">Other stores</h2>
      <p className="mb-4 text-xs text-gray-400">
        Community-suggested places to buy this board. Prices refresh on the next
        scrape; open the listing for current options.
      </p>

      <ul className="divide-y divide-gray-100">
        {stores.map((vk) => {
          const href = vk.productUrl || vk.gbUrl || vk.vendor.websiteUrl;
          const priceLocal =
            vk.price != null && vk.currency
              ? formatCurrency(convert(vk.price, vk.currency), currency)
              : null;
          return (
            <li
              key={vk.id}
              className="flex items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-gray-900">
                  {vk.vendor.name}
                </p>
                <p className="text-xs text-gray-400">
                  {loading ? (
                    <span className="inline-block h-3 w-16 animate-pulse rounded bg-gray-100" />
                  ) : priceLocal ? (
                    <>
                      {priceLocal}
                      {!vk.inStock && (
                        <span className="ml-2 text-amber-600">out of stock</span>
                      )}
                    </>
                  ) : (
                    "Price pending"
                  )}
                </p>
              </div>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-violet-600 transition hover:border-violet-300 hover:text-violet-800"
              >
                Visit store
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
