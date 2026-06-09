"use client";

import { useState } from "react";
import Image from "next/image";

interface SetImageCarouselProps {
  images: string[];
  alt: string;
}

// Swipeable image gallery for the set hero. Falls back to a single image when
// only one is available; shows arrows, dots, and a thumbnail strip otherwise.
export function SetImageCarousel({ images, alt }: SetImageCarouselProps) {
  const [index, setIndex] = useState(0);
  const valid = images.filter(Boolean);

  if (valid.length === 0) return null;

  const current = valid[Math.min(index, valid.length - 1)];
  const multiple = valid.length > 1;

  const go = (next: number) => {
    setIndex(((next % valid.length) + valid.length) % valid.length);
  };

  return (
    <div className="relative">
      <div className="relative aspect-[21/9] w-full overflow-hidden bg-gray-50">
        <Image
          key={current}
          src={current}
          alt={alt}
          fill
          className="object-cover"
          unoptimized
          priority
        />

        {multiple && (
          <>
            <button
              aria-label="Previous image"
              onClick={() => go(index - 1)}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center backdrop-blur-sm transition-colors"
            >
              ‹
            </button>
            <button
              aria-label="Next image"
              onClick={() => go(index + 1)}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center backdrop-blur-sm transition-colors"
            >
              ›
            </button>

            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
              {valid.map((_, i) => (
                <button
                  key={i}
                  aria-label={`Go to image ${i + 1}`}
                  onClick={() => go(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === index ? "w-5 bg-white" : "w-1.5 bg-white/50 hover:bg-white/80"
                  }`}
                />
              ))}
            </div>

            <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-black/50 text-white text-xs font-medium">
              {index + 1} / {valid.length}
            </span>
          </>
        )}
      </div>

      {multiple && (
        <div className="flex gap-2 p-3 overflow-x-auto">
          {valid.map((img, i) => (
            <button
              key={img}
              onClick={() => go(i)}
              className={`relative w-20 h-12 flex-shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${
                i === index ? "border-indigo-500" : "border-transparent hover:border-gray-200"
              }`}
            >
              <Image src={img} alt={`${alt} ${i + 1}`} fill className="object-cover" unoptimized />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
