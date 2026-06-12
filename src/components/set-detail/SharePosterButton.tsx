"use client";

import { useState } from "react";

interface SharePosterButtonProps {
  slug: string;
  countryCode: string;
  currency: string;
}

export function SharePosterButton({ slug, countryCode, currency }: SharePosterButtonProps) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const posterUrl = `${origin}/api/poster/${slug}?country=${countryCode}&currency=${currency}`;
  // Share URL is the dedicated /share page — an HTML wrapper that WhatsApp
  // can crawl for og:image so the poster card appears in the link preview.
  const sharePageUrl = `${origin}/share/${slug}?country=${countryCode}&currency=${currency}`;

  // "Save Poster" — fetch the PNG and trigger a browser download.
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setDlError(false);
    try {
      const res = await fetch(posterUrl);
      if (!res.ok) throw new Error("poster fetch failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gmk-${slug}-poster.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setDlError(true);
      setTimeout(() => setDlError(false), 2000);
    } finally {
      setDownloading(false);
    }
  };

  // "Share link" — copy the /share/[slug] page URL, NOT the poster API URL.
  // WhatsApp only shows og:image previews from HTML pages; bare .png URLs
  // never generate a thumbnail. The /share page has og:image = the poster URL
  // so pasting in WhatsApp shows the generated card as the link preview.
  const copyPosterLink = async () => {
    await navigator.clipboard.writeText(sharePageUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      {/* Copy image URL */}
      <button
        onClick={copyPosterLink}
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            Share link
          </>
        )}
      </button>

      {/* Download poster image */}
      <button
        onClick={handleDownload}
        disabled={downloading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-wait transition-colors"
      >
        {downloading ? (
          <>
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Generating…
          </>
        ) : dlError ? (
          <>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Try again
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
