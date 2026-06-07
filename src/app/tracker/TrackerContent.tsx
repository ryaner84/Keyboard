"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { useLocation } from "@/context/LocationContext";
import type { GroupBuyWithKits } from "@/types";

export default function TrackerContent() {
  const searchParams = useSearchParams();
  const { countryCode } = useLocation();
  const { tracked, toggle, getShareUrl } = useTrackedSets();
  const [sets, setSets] = useState<GroupBuyWithKits[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const sharedSets = searchParams.get("sets")?.split(",").filter(Boolean) ?? [];
  const displaySlugs = sharedSets.length > 0 ? sharedSets : tracked;
  const slugKey = displaySlugs.join(",");

  useEffect(() => {
    if (displaySlugs.length === 0) {
      setSets([]);
      return;
    }
    setLoading(true);
    fetch(`/api/group-buys?limit=50`)
      .then((r) => r.json())
      .then((data) => {
        const all: GroupBuyWithKits[] = data.data ?? [];
        setSets(all.filter((s) => displaySlugs.includes(s.slug)));
      })
      .catch(() => setSets([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugKey]);

  const copyShareUrl = async () => {
    const url = getShareUrl(countryCode);
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isSharedView = sharedSets.length > 0;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {isSharedView ? "Shared Tracker" : "My Tracker"}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {isSharedView
              ? "Someone shared this list with you"
              : `${tracked.length} set${tracked.length !== 1 ? "s" : ""} tracked`}
          </p>
        </div>

        {!isSharedView && tracked.length > 0 && (
          <button
            onClick={copyShareUrl}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            {copied ? (
              <>
                <svg className="w-4 h-4 text-green-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Link copied!
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                Share tracker
              </>
            )}
          </button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="aspect-video bg-gray-100 animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-gray-100 rounded animate-pulse w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : sets.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-gray-100">
          <p className="text-5xl mb-4">📋</p>
          <h2 className="text-lg font-semibold text-gray-700 mb-2">No sets tracked yet</h2>
          <p className="text-sm text-gray-400 mb-6">
            Browse group buys and click the bookmark icon to add sets to your tracker.
          </p>
          <Link
            href="/browse"
            className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            Browse Sets
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {sets.map((set) => (
            <div
              key={set.id}
              className="group bg-white rounded-2xl border border-gray-100 overflow-hidden hover:border-indigo-200 hover:shadow-md transition-all duration-200"
            >
              <Link href={`/sets/${set.slug}?country=${countryCode}`} className="block">
                <div className="relative aspect-video bg-gray-50 overflow-hidden">
                  {set.imageUrl ? (
                    <Image
                      src={set.imageUrl}
                      alt={set.name}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                      unoptimized
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-indigo-50 to-purple-50">
                      <span className="text-5xl opacity-30">⌨</span>
                    </div>
                  )}
                  <div className="absolute top-3 left-3">
                    <StatusBadge status={set.status} size="sm" />
                  </div>
                </div>
              </Link>
              <div className="p-4 flex items-start justify-between gap-2">
                <Link href={`/sets/${set.slug}?country=${countryCode}`} className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate hover:text-indigo-600 transition-colors">
                    {set.name}
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5">by {set.designer}</p>
                </Link>
                {!isSharedView && (
                  <button
                    onClick={() => toggle(set.slug)}
                    title="Remove from tracker"
                    className="flex-shrink-0 p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
