"use client";

import { useState } from "react";

interface SharePosterButtonProps {
  slug: string;
  countryCode: string;
  currency: string;
  bestPrice?: string;
}

export function SharePosterButton({
  slug,
  countryCode,
  currency,
  bestPrice,
}: SharePosterButtonProps) {
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(false);
  const [copied, setCopied] = useState(false);

  const posterUrl = `/api/poster/${slug}?country=${countryCode}&currency=${currency}${bestPrice ? `&price=${encodeURIComponent(bestPrice)}` : ""}`;
  const shareUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/sets/${slug}?country=${countryCode}`;

  // Web Share API with file support — iOS Safari 15+, Chrome Android 75+.
  // Not available on most desktops; probed at call-time to avoid SSR issues.
  const supportsFileShare = () =>
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";

  const handlePosterAction = async () => {
    if (sharing) return;
    setSharing(true);
    setShareError(false);
    try {
      if (supportsFileShare()) {
        const res = await fetch(posterUrl);
        if (!res.ok) throw new Error("poster fetch failed");
        const blob = await res.blob();
        const file = new File([blob], `gmk-${slug}-poster.png`, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: slug });
          return;
        }
      }
      // Desktop or canShare=false → open in new tab (browser renders PNG directly;
      // user saves via right-click / long-press). Avoids the Windows "unsupported format"
      // error that the old blob-download approach triggered on API errors.
      window.open(posterUrl, "_blank");
    } catch (err) {
      // AbortError = user dismissed the share sheet — not an error
      if (err instanceof Error && err.name !== "AbortError") {
        setShareError(true);
        setTimeout(() => setShareError(false), 2000);
      }
    } finally {
      setSharing(false);
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isMobileShare = supportsFileShare();

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={copyLink}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
      >
        {copied ? (
          <>
            <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-green-600">Copied!</span>
          </>
        ) : (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Share link
          </>
        )}
      </button>

      <button
        onClick={handlePosterAction}
        disabled={sharing}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-wait transition-colors"
      >
        {sharing ? (
          <>
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Generating…
          </>
        ) : shareError ? (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Try again
          </>
        ) : isMobileShare ? (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            Share Image
          </>
        ) : (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Save Poster
          </>
        )}
      </button>
    </div>
  );
}
