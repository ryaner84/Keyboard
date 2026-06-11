"use client";

import { useState } from "react";

interface Props {
  slug: string;
  isOpen: boolean;
  onClose: () => void;
}

export function SuggestVendorPanel({ slug, isOpen, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed) { setError("Please paste a product page URL."); return; }
    if (!/^https?:\/\//i.test(trimmed)) { setError("URL must start with https://"); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, productUrl: trimmed, vendorName: vendorName.trim() }),
      });
      if (!res.ok) throw new Error("server error");
      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setDone(false);
    setUrl("");
    setVendorName("");
    setError("");
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Slide-out panel */}
      <div
        className={`fixed right-0 top-0 h-full w-80 bg-white shadow-2xl z-50 flex flex-col transform transition-transform duration-300 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-semibold text-gray-900">Add a vendor link</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Help us track prices from more vendors
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-0.5 p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {done ? (
          /* Success state */
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
              <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-gray-900">Thanks for helping to boost the website!</p>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                We strongly suggest supporting your local store if the set is
                available locally.
              </p>
            </div>
            <button
              onClick={reset}
              className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          /* Form */
          <div className="flex-1 flex flex-col p-5 gap-4 overflow-y-auto">
            {/* Help box */}
            <div className="bg-indigo-50 rounded-xl p-3.5">
              <p className="text-xs font-semibold text-indigo-700 mb-1">How to find the URL</p>
              <p className="text-xs text-indigo-600 leading-relaxed">
                Go to the vendor&apos;s website, find this set&apos;s product page, and paste the URL below. Works with Shopify stores (CannonKeys, KBDfans, Ktechs, Oblotzky, etc).
              </p>
            </div>

            {/* Example URLs */}
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Examples</p>
              {[
                "ktechs.store/products/gmk-…",
                "kbdfans.com/products/gmk-…",
                "oblotzky.industries/products/gmk-…",
              ].map((ex) => (
                <p key={ex} className="text-[11px] text-gray-400 font-mono truncate">{ex}</p>
              ))}
            </div>

            {/* URL input */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Product page URL <span className="text-red-400">*</span>
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="https://vendor.com/products/..."
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-colors"
              />
            </div>

            {/* Vendor name */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Vendor name{" "}
                <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="e.g. Ktechs, KBDfans…"
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-colors"
              />
            </div>

            {error && (
              <p className="text-xs text-red-500 flex items-center gap-1">
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {error}
              </p>
            )}

            <button
              onClick={submit}
              disabled={submitting || !url.trim()}
              className="w-full py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Submitting…" : "Submit vendor link"}
            </button>

            <p className="text-[11px] text-gray-400 text-center leading-relaxed">
              Submitted links are reviewed and pricing usually appears within 24 hours.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
