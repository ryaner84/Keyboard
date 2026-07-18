"use client";

import { useMemo } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import {
  parseVariants,
  classifyVariant,
  ADDON_VARIANT_RE,
  NONBASE_SUBKIT_RE,
} from "@/lib/kit-variants";
import type { VendorKitWithDetails, ExchangeRates, Region } from "@/types";

// "Complete the set": the inverse of the base-kit price table. The scraper
// stores every variant a vendor lists ([{title, price}]); this section groups
// the NON-base kits — Alphas / Novelties / Spacebars plus named subkits
// (Numpad, Extension, 40s, Hiragana…) — and shows which vendors list each one,
// cheapest first. Unlabeled OTHERS variants are deliberately excluded: on
// single-kit listings they ARE the base ("Default Title"), so surfacing them
// here would duplicate the price table. Accessories (deskmats, artisans) are
// excluded too. Per-subkit stock isn't scraped, so the copy says "listed" and
// links out for the buyer to confirm.

interface KitOffer {
  vendorName: string;
  url: string | null;
  priceLocal: number;
  priceOriginal: number;
  currencyOriginal: string;
  // true/false when the store reported this variant's stock; undefined when
  // the listing didn't expose per-variant availability.
  available?: boolean;
}

// Friendly label for a named non-base subkit title (first matching keyword).
const NAMED_SUBKIT_LABELS: Array<{ re: RegExp; label: string }> = [
  { re: /num(?:ber)?\s*pad/i, label: "Numpad" },
  { re: /\b40s\b|forties/i, label: "40s" },
  { re: /accents?\b/i, label: "Accents" },
  { re: /extension/i, label: "Extension" },
  { re: /hiragana/i, label: "Hiragana" },
  { re: /katakana/i, label: "Katakana" },
  { re: /hangul/i, label: "Hangul" },
  { re: /cyrillic/i, label: "Cyrillic" },
  { re: /norde\b|nordic\b/i, label: "NorDe / Nordics" },
  { re: /\biso\b/i, label: "ISO" },
  { re: /\bicons?\b/i, label: "Icons" },
  { re: /\bmacro\b/i, label: "Macro" },
];

const STANDARD_ORDER = ["Alphas", "Novelties", "Spacebars"];

function categoryLabel(title: string): string | null {
  const category = classifyVariant(title);
  if (category === "ALPHA") return "Alphas";
  if (category === "NOVELTIES") return "Novelties";
  if (category === "SPACEBARS") return "Spacebars";
  if (category === "OTHERS" && NONBASE_SUBKIT_RE.test(title)) {
    for (const { re, label } of NAMED_SUBKIT_LABELS) {
      if (re.test(title)) return label;
    }
  }
  return null; // BASE, accessories, and unlabeled OTHERS stay in the main table
}

export function KitAvailability({
  vendorKits,
  userRegion,
  userCurrency,
  rates,
}: {
  vendorKits: VendorKitWithDetails[];
  userRegion: Region;
  userCurrency: string;
  rates: ExchangeRates;
}) {
  const categories = useMemo(() => {
    const byLabel = new Map<string, KitOffer[]>();
    for (const vk of vendorKits) {
      // Same region rule as the price table: only an explicit "doesn't ship
      // here" excludes the vendor.
      const zone = vk.vendor.shippingZones?.find(
        (z) => z.destinationRegion === userRegion
      );
      if (zone && !zone.shipsToRegion) continue;

      const kitCurrency = vk.currency ?? vk.vendor.currency ?? "USD";
      for (const variant of parseVariants(vk.variants)) {
        if (ADDON_VARIANT_RE.test(variant.title)) continue;
        const label = categoryLabel(variant.title);
        if (!label) continue;
        const list = byLabel.get(label) ?? [];
        list.push({
          vendorName: vk.vendor.name,
          url: vk.productUrl ?? vk.gbUrl ?? null,
          priceLocal: convertCurrency(variant.price, kitCurrency, userCurrency, rates),
          priceOriginal: variant.price,
          currencyOriginal: kitCurrency,
          available: variant.available,
        });
        byLabel.set(label, list);
      }
    }
    // Cheapest first within each kit; standard kits first, named others after.
    const entries = Array.from(byLabel.entries()).map(([label, offers]) => ({
      label,
      // Same ordering convention as the base-kit table: purchasable listings
      // rank first (sold-out sinks), then cheapest within each group. Unknown
      // stock sorts with purchasable — it's a lead worth showing.
      offers: offers.sort((a, b) => {
        const aOut = a.available === false ? 1 : 0;
        const bOut = b.available === false ? 1 : 0;
        if (aOut !== bOut) return aOut - bOut;
        return a.priceLocal - b.priceLocal;
      }),
    }));
    entries.sort((a, b) => {
      const ai = STANDARD_ORDER.indexOf(a.label);
      const bi = STANDARD_ORDER.indexOf(b.label);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      return a.label.localeCompare(b.label);
    });
    return entries;
  }, [vendorKits, userRegion, userCurrency, rates]);

  if (categories.length === 0) return null;

  return (
    <section className="mt-6 rounded-2xl border border-gray-100 bg-white p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-gray-900">Complete the set</h2>
        <span className="text-xs text-gray-400">prices exclude shipping</span>
      </div>
      <p className="mb-4 text-xs leading-5 text-gray-500">
        Add-on kits vendors list alongside the base kit. A green dot means the
        vendor reports it in stock, a gray dot sold out; kits without a dot
        don&apos;t report stock — check the product page before ordering.
      </p>

      <div className="space-y-3">
        {categories.map(({ label, offers }) => (
          <div
            key={label}
            className="flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50/60 px-3.5 py-3 sm:flex-row sm:items-center"
          >
            <span className="w-28 shrink-0 text-sm font-semibold text-gray-800">
              {label}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap gap-2">
              {offers.map((offer, index) => {
                const soldOut = offer.available === false;
                const isCheapest = index === 0 && !soldOut && offers.length > 1;
                const chip = (
                  <>
                    {/* Same stock language as the base-kit rows: emerald dot =
                        in stock, gray dot = sold out; no dot when the store
                        didn't report per-variant stock. */}
                    {offer.available !== undefined && (
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          soldOut ? "bg-gray-400" : "bg-emerald-500"
                        }`}
                      />
                    )}
                    <span
                      className={`truncate font-medium ${
                        soldOut ? "text-gray-400" : "text-gray-700"
                      }`}
                    >
                      {offer.vendorName}
                    </span>
                    <span
                      className={`shrink-0 font-semibold ${
                        soldOut
                          ? "text-gray-400"
                          : isCheapest
                            ? "text-emerald-700"
                            : "text-gray-900"
                      }`}
                    >
                      {formatCurrency(offer.priceLocal, userCurrency)}
                    </span>
                    {isCheapest && (
                      <span className="shrink-0 rounded bg-emerald-100 px-1 text-[9px] font-bold uppercase tracking-wide text-emerald-700">
                        Cheapest
                      </span>
                    )}
                    {soldOut && (
                      <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] font-bold uppercase tracking-wide text-gray-500">
                        Sold out
                      </span>
                    )}
                  </>
                );
                const chipClass =
                  "inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-xs " +
                  (soldOut
                    ? "border-gray-200 opacity-75"
                    : isCheapest
                      ? "border-emerald-200"
                      : "border-gray-200");
                const stockTitle = soldOut
                  ? "sold out at this vendor"
                  : offer.available === true
                    ? "in stock at this vendor"
                    : "stock not reported — check the product page";
                return offer.url ? (
                  <a
                    key={`${offer.vendorName}-${index}`}
                    href={offer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${chipClass} transition-colors hover:border-indigo-300`}
                    title={`${offer.vendorName}: ${formatCurrency(offer.priceOriginal, offer.currencyOriginal)} (${stockTitle}) — open product page`}
                  >
                    {chip}
                  </a>
                ) : (
                  <span
                    key={`${offer.vendorName}-${index}`}
                    className={chipClass}
                    title={stockTitle}
                  >
                    {chip}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
