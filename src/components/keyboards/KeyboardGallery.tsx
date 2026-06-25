"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { GroupBuyWithPricing } from "@/types";
import { getImageCandidates } from "@/lib/utils";
import { estimateKeyboardShippingUSD } from "@/lib/keyboard-shipping";
import { ReportListingButton } from "@/components/ui/ReportListingButton";
import { ShareSetButton } from "@/components/ui/ShareSetButton";
import { useTrackedSets } from "@/hooks/useTrackedSets";

interface Props {
  rows: GroupBuyWithPricing[];
  currency: string;
  destRegion: string;
  countryCode: string;
  convert: (amount: number, from: string) => number;
  format: (amount: number, from: string) => string;
}

const PAGE_SIZE = 12;
const DAY = 24 * 60 * 60 * 1000;

const STAGE_META: Record<
  string,
  { label: string; badge: string; dot: string }
> = {
  ACTIVE_GB: {
    label: "Group buy open",
    badge:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/90 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  IN_STOCK: {
    label: "In-stock extras",
    badge:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  INTEREST_CHECK: {
    label: "Interest check",
    badge:
      "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/90 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  SHIPPING: {
    label: "Shipping",
    badge:
      "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/90 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  DELIVERED: {
    label: "Delivered",
    badge:
      "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800/90 dark:text-gray-300",
    dot: "bg-gray-400",
  },
  CANCELLED: {
    label: "Cancelled",
    badge:
      "border-red-200 bg-red-50 text-red-500 dark:border-red-900 dark:bg-red-950/90 dark:text-red-400",
    dot: "bg-red-400",
  },
};

const REGION_LABEL: Record<string, string> = {
  US: "US",
  CA: "Canada",
  EU: "Europe",
  UK: "UK",
  AU: "Australia",
  SG: "Singapore",
  ASIA: "Asia",
  CN: "China",
  China: "China",
  Korea: "Korea",
  Global: "Global",
  GLOBAL: "Global",
};

function daysLeft(end: Date | string | null): number | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.ceil(ms / DAY);
}

function formatDate(date: Date | string | null): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatLocal(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

function cleanKeyboardName(name: string): string {
  return name
    .replace(/^\s*(?:\[(?:GB|IC|Group Buy|Pre-Order|In-stock)\]\s*)+/gi, "")
    .replace(/^\s*\*+\s*|\s*\*+\s*$/g, "")
    .replace(/\s*\|\s*(?:GB|IC)\s*(?:live|open)?\s*$/i, "")
    .trim();
}

function KeyboardArtwork({
  row,
  title,
}: {
  row: GroupBuyWithPricing;
  title: string;
}) {
  const candidates = useMemo(
    () => getImageCandidates(row.imageUrl, row.images, row.slug),
    [row.imageUrl, row.images, row.slug]
  );
  const signature = candidates.join("\n");
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [row.id, signature]);

  const src = candidates[index] ?? null;
  if (!src) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-violet-50 via-gray-100 to-indigo-100 text-gray-400 dark:from-violet-950 dark:via-gray-900 dark:to-indigo-950">
        <svg
          className="mb-2 h-12 w-12"
          viewBox="0 0 48 32"
          fill="none"
          stroke="currentColor"
        >
          <rect x="1" y="1" width="46" height="30" rx="5" />
          <path d="M7 9h4M15 9h4M23 9h4M31 9h4M39 9h2M7 16h5M16 16h5M25 16h5M34 16h7M10 23h28" />
        </svg>
        <span className="text-xs font-semibold">Image coming soon</span>
      </div>
    );
  }

  return (
    <Image
      key={src}
      src={src}
      alt={title}
      fill
      sizes="(min-width: 1280px) 390px, (min-width: 768px) 50vw, 100vw"
      className="object-cover transition duration-500 group-hover:scale-[1.04]"
      unoptimized
      onError={() => setIndex((current) => current + 1)}
    />
  );
}

function CountdownBadge({ row }: { row: GroupBuyWithPricing }) {
  if (row.status === "IN_STOCK") {
    return (
      <span className="rounded-full bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm">
        Available now
      </span>
    );
  }

  if (row.status !== "ACTIVE_GB") return null;
  const remaining = daysLeft(row.gbEnd ?? null);
  if (remaining === null || remaining < 0) return null;

  const urgent = remaining <= 7;
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[11px] font-bold text-white shadow-sm ${
        urgent ? "bg-rose-500" : "bg-gray-900/80 backdrop-blur-sm"
      }`}
    >
      {remaining === 0
        ? "Closes today"
        : `${remaining} day${remaining === 1 ? "" : "s"} left`}
    </span>
  );
}

export function KeyboardGallery({
  rows,
  currency,
  destRegion,
  countryCode,
  convert,
  format,
}: Props) {
  const { isTracked, toggle } = useTrackedSets();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [rows]);

  const visible = rows.slice(0, visibleCount);

  return (
    <div className="space-y-7">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((row) => {
          const meta = STAGE_META[row.status] ?? STAGE_META.DELIVERED;
          const title = cleanKeyboardName(row.name);
          const tracked = isTracked(row.slug);
          const shipping = estimateKeyboardShippingUSD(
            row.vendorRegion,
            destRegion
          );
          const shippingLocal = convert(shipping.usd, "USD");
          const priceLocal =
            row.basePrice != null && row.priceCurrency
              ? convert(row.basePrice, row.priceCurrency)
              : null;
          const landed =
            priceLocal === null ? null : priceLocal + shippingLocal;
          const closes = formatDate(row.gbEnd ?? null);
          const specs = [row.layout, row.mountingStyle, row.material].filter(
            Boolean
          ) as string[];
          const vendor =
            row.vendorName || row.designer || "Community group buy";
          const region =
            REGION_LABEL[row.vendorRegion ?? ""] ?? row.vendorRegion ?? null;

          return (
            <article
              key={row.id}
              className="group flex min-h-full flex-col overflow-hidden rounded-3xl border border-gray-200/80 bg-white shadow-sm transition duration-300 hover:-translate-y-1 hover:border-violet-300 hover:shadow-xl hover:shadow-violet-100/60 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-violet-700 dark:hover:shadow-none"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-950">
                <Link
                  href={`/sets/${row.slug}?country=${countryCode}`}
                  className="absolute inset-0"
                  aria-label={`View ${title}`}
                >
                  <KeyboardArtwork row={row} title={title} />
                  <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent" />
                </Link>

                <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold shadow-sm backdrop-blur ${meta.badge}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                    {meta.label}
                  </span>
                </div>

                <div className="pointer-events-none absolute bottom-3 left-3">
                  <CountdownBadge row={row} />
                </div>

                <div className="absolute right-3 top-3 z-10 flex flex-col gap-2">
                  <button
                    onClick={() => toggle(row.slug)}
                    title={tracked ? "Remove from tracker" : "Add to tracker"}
                    className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg backdrop-blur transition ${
                      tracked
                        ? "border-violet-500 bg-violet-600 text-white"
                        : "border-white/70 bg-white/90 text-gray-700 hover:bg-violet-600 hover:text-white dark:border-gray-700 dark:bg-gray-900/90 dark:text-gray-200"
                    }`}
                  >
                    <svg
                      className="h-[18px] w-[18px]"
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
                  </button>
                  <ShareSetButton
                    slug={row.slug}
                    name={title}
                    countryCode={countryCode}
                    currency={currency}
                    variant="icon"
                  />
                </div>
              </div>

              <div className="flex flex-1 flex-col p-5">
                <div className="mb-4">
                  <Link href={`/sets/${row.slug}?country=${countryCode}`}>
                    <h2 className="line-clamp-2 text-lg font-bold leading-snug text-gray-950 transition-colors group-hover:text-violet-700 dark:text-white dark:group-hover:text-violet-300">
                      {title}
                    </h2>
                  </Link>
                  <p className="mt-1.5 flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
                    <span className="font-medium text-gray-700 dark:text-gray-300">
                      {vendor}
                    </span>
                    {region && (
                      <>
                        <span className="text-gray-300 dark:text-gray-700">•</span>
                        <span>{region}</span>
                      </>
                    )}
                  </p>
                </div>

                {specs.length > 0 ? (
                  <div className="mb-5 flex flex-wrap gap-1.5">
                    {specs.map((spec) => (
                      <span
                        key={spec}
                        className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] font-semibold text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                      >
                        {spec}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mb-5 text-xs text-gray-400">
                    Full specifications on the official listing
                  </p>
                )}

                <div className="mt-auto rounded-2xl bg-gray-50 p-4 dark:bg-gray-800/70">
                  {priceLocal !== null && row.priceCurrency ? (
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gray-400">
                          Starting at
                        </p>
                        <p className="mt-1 text-xl font-black text-gray-950 dark:text-white">
                          {format(row.basePrice!, row.priceCurrency)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-500">
                          Est. landed
                        </p>
                        <p className="mt-1 text-base font-bold text-violet-700 dark:text-violet-300">
                          {formatLocal(landed!, currency)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                          Pricing to be confirmed
                        </p>
                        <p className="mt-0.5 text-xs text-gray-400">
                          Check the official listing for configurations.
                        </p>
                      </div>
                      <span className="rounded-full bg-gray-200 px-2.5 py-1 text-[10px] font-bold uppercase text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                        Check vendor
                      </span>
                    </div>
                  )}
                  {priceLocal !== null && (
                    <p className="mt-2 text-[11px] text-gray-400">
                      Includes ~{formatLocal(shippingLocal, currency)} estimated{" "}
                      {shipping.band} shipping to {countryCode}
                    </p>
                  )}
                </div>

                <div className="mt-4 flex min-h-5 items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
                  <span>
                    {row.status === "ACTIVE_GB" && closes
                      ? `Orders close ${closes}`
                      : row.status === "IN_STOCK"
                        ? "Available while stock lasts"
                        : "See listing for latest timeline"}
                  </span>
                  <ReportListingButton slug={row.slug} name={row.name} />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Link
                    href={`/sets/${row.slug}?country=${countryCode}`}
                    className="inline-flex items-center justify-center rounded-xl border border-gray-200 px-3 py-2.5 text-sm font-bold text-gray-700 transition hover:border-violet-300 hover:text-violet-700 dark:border-gray-700 dark:text-gray-200 dark:hover:border-violet-600 dark:hover:text-violet-300"
                  >
                    View details
                  </Link>
                  {row.productUrl ? (
                    <a
                      href={row.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gray-950 px-3 py-2.5 text-sm font-bold text-white transition hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500"
                    >
                          {row.status === "IN_STOCK" ? "Shop now" : "Open listing"}
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </a>
                  ) : (
                    <span className="inline-flex items-center justify-center rounded-xl bg-gray-100 px-3 py-2.5 text-sm font-semibold text-gray-400 dark:bg-gray-800">
                      No sale link
                    </span>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {visibleCount < rows.length && (
        <div className="flex flex-col items-center gap-3 border-t border-gray-200 pt-7 dark:border-gray-800">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Showing {visible.length} of {rows.length} keyboards
          </p>
          <button
            onClick={() =>
              setVisibleCount((count) =>
                Math.min(count + PAGE_SIZE, rows.length)
              )
            }
            className="rounded-xl border border-gray-300 bg-white px-6 py-3 text-sm font-bold text-gray-800 shadow-sm transition hover:border-violet-400 hover:text-violet-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            Show {Math.min(PAGE_SIZE, rows.length - visibleCount)} more
          </button>
        </div>
      )}
    </div>
  );
}
