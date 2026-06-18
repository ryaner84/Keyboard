"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { useLocation } from "@/context/LocationContext";
import { formatRelativeDate, normalizeImageUrl } from "@/lib/utils";
import type { GroupBuyWithPricing } from "@/types";

export default function TrackerContent() {
  const searchParams = useSearchParams();
  const { countryCode } = useLocation();
  const {
    tracked,
    hydrated,
    authenticated,
    email,
    alertsEnabled,
    toggle,
    getShareUrl,
    openSavePrompt,
  } = useTrackedSets();
  const [sets, setSets] = useState<GroupBuyWithPricing[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const sharedSets = useMemo(
    () => searchParams.get("sets")?.split(",").filter(Boolean).slice(0, 100) ?? [],
    [searchParams]
  );
  const isSharedView = sharedSets.length > 0;
  const displaySlugs = useMemo(
    () => (isSharedView ? sharedSets : tracked),
    [isSharedView, sharedSets, tracked]
  );
  const slugKey = displaySlugs.join(",");

  useEffect(() => {
    if (!hydrated || displaySlugs.length === 0) {
      setSets([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const url =
      authenticated && !isSharedView
        ? "/api/tracker"
        : `/api/group-buys?${displaySlugs
            .map((slug) => `slug=${encodeURIComponent(slug)}`)
            .join("&")}&limit=100`;

    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Tracker request failed");
        return response.json();
      })
      .then((data) => {
        const all: GroupBuyWithPricing[] = data.data ?? [];
        const order = new Map(displaySlugs.map((slug, index) => [slug, index]));
        setSets(
          all.sort(
            (a, b) => (order.get(a.slug) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.slug) ?? Number.MAX_SAFE_INTEGER)
          )
        );
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSets([]);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [authenticated, displaySlugs, hydrated, isSharedView, slugKey]);

  const copyShareUrl = async () => {
    await navigator.clipboard.writeText(getShareUrl(countryCode));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const authMessage = searchParams.get("auth");
  const alertMessage = searchParams.get("alerts");

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {(authMessage === "verified" || alertMessage === "off") && (
        <div className="mb-5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40 px-4 py-3 text-sm text-green-800 dark:text-green-200">
          {authMessage === "verified"
            ? "Email verified. Your tracker is now synced to this address."
            : "Tracker alerts are off. Passwordless email access still works."}
        </div>
      )}
      {authMessage === "expired" && (
        <div className="mb-5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          That sign-in link expired or was already used. Request a new one from the tracker account button.
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {isSharedView ? "Shared Tracker" : "My Tracker"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {isSharedView
              ? "A public snapshot of someone’s keyboard and keycap watchlist"
              : `${tracked.length} item${tracked.length !== 1 ? "s" : ""} tracked`}
          </p>
          {!isSharedView && authenticated && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-950 px-2 py-1 font-medium text-green-700 dark:text-green-300">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                Synced to {email}
              </span>
              <span className="text-gray-400">
                Alerts {alertsEnabled ? "on for important changes" : "off"}
              </span>
            </div>
          )}
        </div>

        {!isSharedView && tracked.length > 0 && (
          <div className="flex items-center gap-2">
            {!authenticated && (
              <button
                onClick={openSavePrompt}
                className="rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950 px-3 py-2 text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900"
              >
                Save and sync
              </button>
            )}
            <button
              onClick={copyShareUrl}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.7 13.3A3 3 0 118.7 10.7l6.6-3.4m-6.6 6 6.6 3.4m0-9.4a3 3 0 110-2.6m0 12a3 3 0 110 2.6" />
              </svg>
              {copied ? "Link copied" : "Share tracker"}
            </button>
          </div>
        )}
      </div>

      {!hydrated || loading ? (
        <TrackerSkeleton />
      ) : sets.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-950 text-indigo-400">
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-2">
            No items tracked yet
          </h2>
          <p className="text-sm text-gray-400 mb-6">
            Browse keycaps or keyboards and use the bookmark button to keep an eye on them.
          </p>
          <div className="flex justify-center gap-2">
            <Link href="/browse" className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">
              Browse keycaps
            </Link>
            <Link href="/keyboards" className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:border-indigo-300">
              Browse keyboards
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {sets.map((set) => (
            <TrackerCard
              key={set.id}
              set={set}
              countryCode={countryCode}
              removable={!isSharedView}
              onRemove={() => toggle(set.slug)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TrackerCard({
  set,
  countryCode,
  removable,
  onRemove,
}: {
  set: GroupBuyWithPricing;
  countryCode: string;
  removable: boolean;
  onRemove: () => void;
}) {
  const imageUrl = normalizeImageUrl(set.imageUrl);
  const isKeyboard = set.productType === "KEYBOARD";
  const liveVendors = set.kits.flatMap((kit) => kit.vendorKits ?? []).filter((item) => item.price != null);

  return (
    <div className="group bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden hover:border-indigo-200 dark:hover:border-indigo-700 hover:shadow-md transition-all">
      <Link href={`/sets/${set.slug}?country=${countryCode}`} className="block">
        <div className="relative aspect-video bg-gray-50 dark:bg-gray-800 overflow-hidden">
          {imageUrl ? (
            <Image
              src={imageUrl}
              alt={set.name}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
              unoptimized
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-4xl text-gray-300">
              ⌨
            </div>
          )}
          <div className="absolute left-3 top-3">
            <StatusBadge status={set.status} size="sm" />
          </div>
          <span className="absolute bottom-2 right-2 rounded-full bg-black/65 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm">
            {isKeyboard ? "Keyboard" : "Keycap set"}
          </span>
        </div>
      </Link>
      <div className="p-4">
        <div className="flex items-start gap-2">
          <Link href={`/sets/${set.slug}?country=${countryCode}`} className="min-w-0 flex-1">
            <h3 className="truncate font-semibold text-gray-900 dark:text-white hover:text-indigo-600">
              {set.name}
            </h3>
            <p className="mt-0.5 text-xs text-gray-400">
              {isKeyboard ? set.vendorName ?? set.designer : `by ${set.designer}`}
            </p>
          </Link>
          {removable && (
            <button
              onClick={onRemove}
              title="Remove from tracker"
              className="rounded-md p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
        <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3 text-xs text-gray-500 dark:text-gray-400">
          {isKeyboard ? (
            <div className="flex items-center justify-between gap-2">
              <span>{[set.layout, set.mountingStyle].filter(Boolean).join(" · ") || "Keyboard group buy"}</span>
              {set.basePrice != null && set.priceCurrency && (
                <strong className="whitespace-nowrap text-gray-800 dark:text-gray-200">
                  {set.priceCurrency} {Math.round(set.basePrice)}
                </strong>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span>{liveVendors.length} live vendor{liveVendors.length === 1 ? "" : "s"}</span>
              {set.updatedAt && <span>Updated {formatRelativeDate(set.updatedAt)}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TrackerSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {[1, 2, 3].map((item) => (
        <div key={item} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
          <div className="aspect-video bg-gray-100 dark:bg-gray-800 animate-pulse" />
          <div className="p-4 space-y-2">
            <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-3/4" />
            <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
