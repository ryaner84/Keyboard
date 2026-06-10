"use client";

import { useMemo } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import { variantsInCategory } from "@/lib/kit-variants";
import type { VendorKitWithDetails, ExchangeRates } from "@/types";

interface OtherItemsTableProps {
  vendorKits: VendorKitWithDetails[];
  userCurrency: string;
  rates: ExchangeRates;
  loading: boolean;
}

interface ItemRow {
  key: string;
  vendorName: string;
  vendorCountry: string;
  title: string;
  priceLocal: number;
  url: string | null;
}

// Detailed list of every non-standard item (40s kits, artisans, accents,
// deskmats…) across vendors — shown when the kit filter is set to "Others".
export function OtherItemsTable({ vendorKits, userCurrency, rates, loading }: OtherItemsTableProps) {
  const items: ItemRow[] = useMemo(() => {
    const rows: ItemRow[] = [];
    for (const vk of vendorKits) {
      if (!vk.currency) continue;
      for (const v of variantsInCategory(vk.variants, "OTHERS")) {
        rows.push({
          key: `${vk.id}-${v.title}`,
          vendorName: vk.vendor.name,
          vendorCountry: vk.vendor.country,
          title: v.title,
          priceLocal: convertCurrency(v.price, vk.currency, userCurrency, rates),
          url: vk.gbUrl ?? vk.productUrl ?? null,
        });
      }
    }
    rows.sort((a, b) => a.priceLocal - b.priceLocal);
    return rows;
  }, [vendorKits, userCurrency, rates]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-10 text-gray-400 text-sm">
        No extra items found for this set yet — vendor catalogs are scanned nightly.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 font-medium">Vendor</th>
            <th className="py-2 pr-4 font-medium text-right">Price</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} className="border-b border-gray-50 hover:bg-indigo-50/30">
              <td className="py-2.5 pr-4 text-gray-900">{item.title}</td>
              <td className="py-2.5 pr-4 text-gray-500">
                {item.vendorName}
                <span className="text-gray-300"> · {item.vendorCountry}</span>
              </td>
              <td className="py-2.5 pr-4 text-right font-semibold text-gray-900">
                {formatCurrency(item.priceLocal, userCurrency)}
              </td>
              <td className="py-2.5 text-right">
                {item.url && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2.5 py-1 text-xs font-semibold text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-600 hover:text-white transition-colors whitespace-nowrap"
                  >
                    Buy →
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-400 pt-3">
        Prices exclude shipping — see the vendor&apos;s site for combined shipping at checkout.
      </p>
    </div>
  );
}
