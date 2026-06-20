"use client";

import { useState } from "react";
import { ShareSetButton } from "@/components/ui/ShareSetButton";

interface SharePosterButtonProps {
  slug: string;
  name: string;
  countryCode: string;
  currency: string;
}

export function SharePosterButton({
  slug,
  name,
  countryCode,
  currency,
}: SharePosterButtonProps) {
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const posterUrl = `${origin}/api/poster/${slug}?country=${countryCode}&currency=${currency}`;

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setDlError(false);
    try {
      const res = await fetch(posterUrl);
      if (!res.ok) throw new Error("poster fetch failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${slug}-poster.png`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch {
      setDlError(true);
      setTimeout(() => setDlError(false), 2000);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <ShareSetButton
        slug={slug}
        name={name}
        countryCode={countryCode}
        currency={currency}
      />

      <button
        onClick={handleDownload}
        disabled={downloading}
        className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
      >
        {downloading ? (
          <>
            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Generating…
          </>
        ) : dlError ? (
          <>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Try again
          </>
        ) : (
          <>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4-4 4m0 0-4-4m4 4V4" />
            </svg>
            Save poster
          </>
        )}
      </button>
    </div>
  );
}
