"use client";

import Link from "next/link";
import { useState } from "react";
import ReportPhotoButton from "@/components/collection/ReportPhotoButton";

export interface GallerySlide {
  // The image to show for this build. May be the build's own uploaded photo
  // or the shared group-buy render fallback.
  imageUrl: string | null;
  // True only when `imageUrl` is the collector's own uploaded photo (so the
  // report button is offered for that specific build).
  isCustom: boolean;
  // Index of the build within the item (build 1 = 0) — used for reporting.
  buildIndex: number;
}

// Top-of-card image area for a public collection piece. When a piece has more
// than one build photo, this turns the single hero image into a small gallery
// with prev/next arrows and dot indicators so viewers can flip through every
// build (build 1, build 2, …) instead of only ever seeing build 1.
export function CollectionCardGallery({
  slides,
  setSlug,
  setName,
  number,
  buildsCount,
  collectionSlug,
  trackerItemId,
}: {
  slides: GallerySlide[];
  setSlug: string;
  setName: string;
  number: number;
  buildsCount: number;
  collectionSlug: string;
  trackerItemId: string;
}) {
  const [active, setActive] = useState(0);
  const total = slides.length;
  const hasMultiple = total > 1;
  const current = slides[Math.min(active, total - 1)] ?? slides[0];

  const go = (next: number) => {
    setActive((next + total) % total);
  };

  return (
    <div className="relative">
      <Link href={`/sets/${setSlug}`} className="block">
        <div className="relative aspect-[4/3] overflow-hidden bg-[#ddd9cf] dark:bg-gray-900">
          {current?.imageUrl ? (
            // Plain img so owner-uploaded data: URLs render.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={current.imageUrl}
              alt={
                hasMultiple
                  ? `${setName}, build ${current.buildIndex + 1}`
                  : setName
              }
              className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-5xl text-gray-300 dark:text-gray-700">
              ⌨
            </div>
          )}

          <span className="absolute left-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 font-serif text-sm text-white backdrop-blur">
            {String(number).padStart(2, "0")}
          </span>
          {buildsCount > 1 && (
            <span className="absolute right-4 top-4 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur">
              {buildsCount} builds
            </span>
          )}
        </div>
      </Link>

      {hasMultiple && (
        <>
          {/* Prev / next arrows — stop propagation so they don't follow the link. */}
          <button
            type="button"
            aria-label="Previous build photo"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              go(active - 1);
            }}
            className="absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-white/70"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Next build photo"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              go(active + 1);
            }}
            className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-white/70"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {/* Dot indicators */}
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
            {slides.map((slide, index) => (
              <button
                key={slide.buildIndex}
                type="button"
                aria-label={`Show build ${slide.buildIndex + 1}`}
                aria-current={index === active}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActive(index);
                }}
                className={`h-1.5 rounded-full transition-all ${
                  index === active ? "w-5 bg-white" : "w-1.5 bg-white/55 hover:bg-white/80"
                }`}
              />
            ))}
          </div>
        </>
      )}

      {/* Report only the collector's own uploaded photo for the current build. */}
      {current?.isCustom && (
        <ReportPhotoButton
          collectionSlug={collectionSlug}
          trackerItemId={trackerItemId}
          buildIndex={current.buildIndex}
          label={`${setName}, build ${current.buildIndex + 1}`}
          className="absolute bottom-4 right-4"
        />
      )}
    </div>
  );
}
