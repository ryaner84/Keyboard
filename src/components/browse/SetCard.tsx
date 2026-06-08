"use client";

import Link from "next/link";
import Image from "next/image";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateRange } from "@/lib/utils";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import type { GroupBuyWithKits } from "@/types";

interface SetCardProps {
  set: GroupBuyWithKits;
}

export function SetCard({ set }: SetCardProps) {
  const { isTracked, toggle } = useTrackedSets();
  const tracked = isTracked(set.slug);

  return (
    <div className="group bg-white rounded-2xl border border-gray-100 overflow-hidden hover:border-indigo-200 hover:shadow-md transition-all duration-200">
      <Link href={`/sets/${set.slug}`} className="block">
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

      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <Link href={`/sets/${set.slug}`} className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 truncate hover:text-indigo-600 transition-colors">
              {set.name}
            </h3>
            {set.subtitle && (
              <p className="text-xs text-gray-500 mt-0.5 truncate">{set.subtitle}</p>
            )}
          </Link>
          <button
            onClick={() => toggle(set.slug)}
            title={tracked ? "Remove from tracker" : "Add to tracker"}
            className={`flex-shrink-0 p-1.5 rounded-lg transition-colors ${
              tracked
                ? "text-indigo-600 bg-indigo-50"
                : "text-gray-400 hover:text-indigo-600 hover:bg-indigo-50"
            }`}
          >
            <svg className="w-4 h-4" fill={tracked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-gray-400">by {set.designer}</span>
          <span className="text-xs text-gray-400">{formatDateRange(set.gbStart, set.gbEnd)}</span>
        </div>

        {set.kits.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {set.kits.slice(0, 3).map((kit) => (
              <span
                key={kit.id}
                className="px-2 py-0.5 bg-gray-50 text-gray-500 text-xs rounded-full border border-gray-100"
              >
                {kit.name}
              </span>
            ))}
            {set.kits.length > 3 && (
              <span className="px-2 py-0.5 bg-gray-50 text-gray-400 text-xs rounded-full border border-gray-100">
                +{set.kits.length - 3} more
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
