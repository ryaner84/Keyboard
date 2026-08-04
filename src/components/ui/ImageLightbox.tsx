"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";

interface ImageLightboxProps {
  images: string[];
  index: number;
  alt: string;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}

const MAX_ZOOM = 4;
const MIN_ZOOM = 1;
// One click steps straight to a useful magnification — stepping 1x -> 1.2x ->
// 1.4x makes the user click five times to read a legend.
const CLICK_ZOOM = 2.5;

/**
 * Full-screen image viewer.
 *
 * The gallery that opens this crops to `aspect-[21/9] object-cover`, which suits
 * a hero strip but hides most of a keyboard render. Here the image is
 * `object-contain` against the viewport, so the whole frame is visible at its
 * real proportions — that uncropped view is the point, and zoom is the extra.
 */
export function ImageLightbox({
  images,
  index,
  alt,
  onIndexChange,
  onClose,
}: ImageLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // Distinguishes a click (toggle zoom) from the end of a drag (do nothing).
  const draggedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const multiple = images.length > 1;
  const resetView = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (!multiple) return;
      onIndexChange((index + delta + images.length) % images.length);
      resetView();
    },
    [index, images.length, multiple, onIndexChange, resetView]
  );

  // Zoom about the centre; clamp so the image can't be lost off-screen.
  const applyZoom = useCallback((next: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setZoom(clamped);
    if (clamped === MIN_ZOOM) setOffset({ x: 0, y: 0 });
  }, []);

  // Keyboard control. Esc is the expected way out of a modal, and arrows are
  // how people page through a gallery once it is full-screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "+" || e.key === "=") applyZoom(zoom + 0.5);
      else if (e.key === "-") applyZoom(zoom - 0.5);
      else if (e.key === "0") resetView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step, applyZoom, zoom, resetView]);

  // Lock the page behind the overlay, and put focus somewhere sensible so the
  // dialog is reachable by keyboard. Focus is restored to whatever opened it.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      previous?.focus?.();
    };
  }, []);

  // Wheel zoom needs a non-passive listener to call preventDefault, which React's
  // onWheel cannot guarantee — without it the page scrolls behind the overlay.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyZoom(zoom + (e.deltaY < 0 ? 0.3 : -0.3));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom, zoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom === MIN_ZOOM) return;
    draggedRef.current = false;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true;
    setOffset({ x: d.ox + dx, y: d.oy + dy });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onStageClick = () => {
    // A drag that ended over the image must not also toggle zoom.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    applyZoom(zoom > MIN_ZOOM ? MIN_ZOOM : CLICK_ZOOM);
  };

  const src = images[index];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} — image ${index + 1} of ${images.length}`}
      className="fixed inset-0 z-[100] bg-black/95 flex flex-col"
    >
      {/* Controls */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white shrink-0">
        <span className="text-sm font-medium tabular-nums">
          {multiple ? `${index + 1} / ${images.length}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => applyZoom(zoom - 0.5)}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 transition-colors"
          >
            −
          </button>
          <span className="text-xs tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => applyZoom(zoom + 0.5)}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 transition-colors"
          >
            +
          </button>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original image in a new tab"
            className="px-3 h-9 inline-flex items-center rounded-full bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
          >
            Original
          </a>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close image viewer"
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Stage. Clicking the backdrop closes; clicking the image toggles zoom. */}
      <div
        ref={stageRef}
        className="relative flex-1 overflow-hidden"
        onClick={onClose}
      >
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ cursor: zoom > MIN_ZOOM ? (dragRef.current ? "grabbing" : "grab") : "zoom-in" }}
          onClick={(e) => {
            e.stopPropagation();
            onStageClick();
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="relative w-full h-full transition-transform duration-150"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            }}
          >
            <Image
              key={src}
              src={src}
              alt={alt}
              fill
              // The whole point: show the full frame, never a crop.
              className="object-contain select-none"
              sizes="100vw"
              unoptimized
              draggable={false}
              priority
            />
          </div>
        </div>

        {multiple && (
          <>
            <button
              aria-label="Previous image"
              onClick={(e) => {
                e.stopPropagation();
                step(-1);
              }}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/25 text-white text-xl flex items-center justify-center transition-colors"
            >
              ‹
            </button>
            <button
              aria-label="Next image"
              onClick={(e) => {
                e.stopPropagation();
                step(1);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/25 text-white text-xl flex items-center justify-center transition-colors"
            >
              ›
            </button>
          </>
        )}
      </div>

      {multiple && (
        <div className="flex gap-2 px-4 py-3 overflow-x-auto shrink-0 justify-center">
          {images.map((img, i) => (
            <button
              key={img}
              onClick={() => {
                onIndexChange(i);
                resetView();
              }}
              aria-label={`Show image ${i + 1}`}
              aria-current={i === index}
              className={`relative w-16 h-10 flex-shrink-0 rounded-md overflow-hidden border-2 transition-colors ${
                i === index ? "border-white" : "border-transparent opacity-60 hover:opacity-100"
              }`}
            >
              <Image src={img} alt="" fill className="object-cover" unoptimized />
            </button>
          ))}
        </div>
      )}

      <p className="pb-3 text-center text-[11px] text-white/40 shrink-0">
        Click image to zoom · drag to pan · Esc to close
        {multiple ? " · ← → to browse" : ""}
      </p>
    </div>
  );
}
