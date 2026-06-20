"use client";

import { useState } from "react";

interface ShareSetButtonProps {
  slug: string;
  name: string;
  countryCode: string;
  currency: string;
  variant?: "icon" | "button";
  className?: string;
}

export function ShareSetButton({
  slug,
  name,
  countryCode,
  currency,
  variant = "button",
  className = "",
}: ShareSetButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const url = `${window.location.origin}/share/${slug}?country=${countryCode}&currency=${currency}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: name,
          text: `Check out ${name}`,
          url,
        });
        return;
      }

      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        // The browser blocked both native sharing and clipboard access.
      }
    }
  };

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={handleShare}
        aria-label={copied ? "Link copied" : `Share ${name}`}
        title={copied ? "Link copied" : "Share"}
        className={`flex h-10 w-10 items-center justify-center rounded-full border border-white/70 bg-white/90 text-gray-700 shadow-lg backdrop-blur transition hover:bg-violet-600 hover:text-white dark:border-gray-700 dark:bg-gray-900/90 dark:text-gray-200 ${className}`}
      >
        {copied ? (
          <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342A3 3 0 109 12c0-.482-.114-.938-.316-1.342m0 2.684 6.632 3.316m-6.632-6 6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684Zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684Z" />
          </svg>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      className={`inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-violet-300 hover:text-violet-700 ${className}`}
    >
      {copied ? (
        <svg className="h-4 w-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342A3 3 0 109 12c0-.482-.114-.938-.316-1.342m0 2.684 6.632 3.316m-6.632-6 6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684Zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684Z" />
        </svg>
      )}
      {copied ? "Link copied" : "Share"}
    </button>
  );
}
