"use client";

import { useState } from "react";

// Second right-edge ribbon, stacked under the shipping-location tab. Lets any
// visitor tell us about a product we're not tracking yet — they paste a URL and
// we queue it for the scraper/review (KeyboardContribution). Intentionally
// minimal: one URL field, optional credit handle, nothing else to think about.
export function SuggestProductTab() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Tell us about a new product"
        className="flex items-center gap-2 px-2 py-3 rounded-l-xl shadow-lg text-xs font-semibold tracking-wide transition-colors bg-sky-600 text-white hover:bg-sky-700"
        style={{ writingMode: "vertical-rl" }}
      >
        <svg className="w-4 h-4 rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        Suggest a product
      </button>

      <SuggestProductPanel isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

type Phase = "form" | "submitting" | "done" | "error";

function SuggestProductPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("form");
  const [url, setUrl] = useState("");
  const [handle, setHandle] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  function reset() {
    setPhase("form");
    setUrl("");
    setHandle("");
    setErrorMsg("");
    onClose();
  }

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed) { setErrorMsg("Please paste a product or store URL."); return; }
    if (!/^https?:\/\//i.test(trimmed)) { setErrorMsg("URL must start with https://"); return; }
    setPhase("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/contributions/keyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The contributions endpoint takes free-text `content`; a bare URL is a
        // valid tip and goes straight into the scrape/review queue.
        body: JSON.stringify({ content: trimmed, handle: handle.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "server error");
      setPhase("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong — please try again.");
      setPhase("error");
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className={`fixed right-0 top-0 h-full w-80 bg-white dark:bg-gray-900 shadow-2xl z-50 flex flex-col transform transition-transform duration-300 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Suggest a product</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Know a keyboard or keycap set we&apos;re missing? Paste its link.
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-0.5 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {phase === "done" ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 flex items-center justify-center">
              <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-gray-900 dark:text-white">Got it — thanks! 🎉</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                We&apos;ll review the link and add it to the tracker.
              </p>
            </div>
            <button
              onClick={reset}
              className="px-5 py-2 rounded-xl bg-sky-600 text-white text-sm font-medium hover:bg-sky-700 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col p-5 gap-4 overflow-y-auto">
            <div className="bg-sky-50 dark:bg-sky-950/40 rounded-xl p-3.5">
              <p className="text-xs text-sky-700 dark:text-sky-300 leading-relaxed">
                Paste the product page or group-buy URL from any vendor. We&apos;ll
                fetch the details and add it to the scraper.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Product / store URL <span className="text-red-400">*</span>
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setErrorMsg(""); }}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="https://vendor.com/products/..."
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 dark:focus:ring-sky-900 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Your handle <span className="text-gray-400 font-normal">(optional, for credit)</span>
              </label>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="Discord / Reddit handle"
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 dark:focus:ring-sky-900 transition-colors"
              />
            </div>

            {(errorMsg || phase === "error") && (
              <p className="text-xs text-red-500 flex items-center gap-1">
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {errorMsg || "Something went wrong — please try again."}
              </p>
            )}

            <button
              onClick={submit}
              disabled={phase === "submitting" || !url.trim()}
              className="w-full py-2.5 rounded-xl bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {phase === "submitting" ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Submitting…
                </>
              ) : (
                "Submit"
              )}
            </button>

            <p className="text-[11px] text-gray-400 text-center">
              No login needed · we review every submission before it goes live
            </p>
          </div>
        )}
      </div>
    </>
  );
}
