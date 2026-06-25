"use client";

import Link from "next/link";
import Image from "next/image";
import { normalizeImageUrl } from "@/lib/utils";
import { deriveDesigner } from "@/lib/keyboard-designers";
import type { GroupBuyWithPricing } from "@/types";

// Browse-only keyboard card for the Showcase gallery. Deliberately has NO track
// button and NO pricing — the Showcase is a place to look at other people's
// boards, not to buy or follow them. Photo-first, with the physical specs a
// collector actually cares about (layout · mount · material) underneath.
export function ShowcaseCard({ kb }: { kb: GroupBuyWithPricing }) {
  const img = normalizeImageUrl(kb.imageUrl);
  const specs = [kb.layout, kb.mountingStyle, kb.material].filter(Boolean);
  // The board name is already cleaned of its scraped source by the API, so the
  // maker can be read straight off it (falls back to the stored designer).
  const designer = deriveDesigner(kb.name, kb.designer);

  return (
    <Link
      href={`/sets/${kb.slug}`}
      className="group block overflow-hidden rounded-2xl border border-gray-100 bg-white transition-all hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-lg dark:border-gray-800 dark:bg-gray-900 dark:hover:border-violet-700"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-gray-100 dark:bg-gray-800">
        {img ? (
          <Image
            src={img}
            alt={kb.name}
            fill
            unoptimized
            className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-4xl text-gray-300">
            ⌨
          </span>
        )}
      </div>

      <div className="p-3.5">
        {designer && (
          <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
            {designer}
          </p>
        )}
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-gray-900 group-hover:text-violet-600 dark:text-white dark:group-hover:text-violet-400">
          {kb.name}
        </h3>

        {specs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {specs.map((spec) => (
              <span
                key={spec as string}
                className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              >
                {spec}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
