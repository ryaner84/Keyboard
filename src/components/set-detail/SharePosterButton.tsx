"use client";

import { useState } from "react";

interface SharePosterButtonProps {
  slug: string;
  countryCode: string;
  currency: string;
}

export function SharePosterButton({ slug, countryCode, currency }: SharePosterButtonProps) {
  const [copied, setCopied] = useState(false);

  const posterUrl = `/api/poster/${slug}?country=${countryCode}&currency=${currency}`;
  const shareUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/sets/${slug}?country=${countryCode}`;

  // Open the poster in a new tab — the browser renders the PNG directly and
  // the user saves it from there (right-click / long-press). The previous
  // fetch+blob download saved error responses as .png files that Windows
  // rejected with "unsupported format".
  const openPoster = () => window.open(posterUrl, "_blank");

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
        onClick={openPoster}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        Save Poster
      </button>
    </div>
  );
}
