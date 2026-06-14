"use client";

import { useState, useRef, useEffect } from "react";

type Phase = "form" | "submitting" | "done" | "error";

// ── Controlled modal ─────────────────────────────────────────────────────────
export function ContributeModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("form");
  const [content, setContent] = useState("");
  const [handle, setHandle] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset to a fresh form each time it opens; focus the textarea.
  useEffect(() => {
    if (isOpen) {
      setPhase("form");
      setContent("");
      setHandle("");
      setTimeout(() => textareaRef.current?.focus(), 60);
    }
  }, [isOpen]);

  // Close on Escape (unless mid-submit).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "submitting") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, phase, onClose]);

  async function submit() {
    const text = content.trim();
    if (!text) return;
    setPhase("submitting");
    try {
      const res = await fetch("/api/contributions/keyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, handle: handle.trim() }),
      });
      if (!res.ok) throw new Error("server");
      setPhase("done");
      setTimeout(onClose, 3500);
    } catch {
      setPhase("error");
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && phase !== "submitting" && onClose()}
    >
      <div className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-white">
                Know a keyboard GB we&apos;re missing?
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Paste a vendor URL, a zFrontier link, or just describe it — we&apos;ll take it from there.
              </p>
            </div>
            <button
              onClick={onClose}
              disabled={phase === "submitting"}
              className="mt-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        {phase === "done" ? (
          <div className="px-6 py-10 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-50 dark:bg-green-950 mb-4">
              <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-semibold text-gray-800 dark:text-gray-200 text-base">Thank you!</p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xs mx-auto">
              We&apos;ll review this and add it to the tracker. The keyboard community is better because of you. 🙏
            </p>
          </div>
        ) : (
          <div className="px-6 py-5 space-y-4">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={phase === "submitting"}
              placeholder={'https://vendor.com/products/keyboard  —  or describe it:  "Matrix 8XV2 by MatrixLab, $480, gasket TKL"'}
              rows={4}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none transition"
            />
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              disabled={phase === "submitting"}
              placeholder="Your Discord / Reddit handle — optional, for credit"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-400 transition"
            />
            {phase === "error" && (
              <p className="text-xs text-red-500">Something went wrong — please try again.</p>
            )}
            <div className="flex items-center justify-between pt-1">
              <p className="text-[11px] text-gray-400 dark:text-gray-500">No login needed · all tips welcome</p>
              <button
                onClick={submit}
                disabled={!content.trim() || phase === "submitting"}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
              >
                {phase === "submitting" ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Sending…
                  </>
                ) : (
                  "Submit tip"
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inline ribbon CTA (matches the set-detail "Add vendor link" nudge) ───────
export function ContributeRibbon({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group w-full flex items-center justify-between gap-4 px-5 py-3.5 rounded-2xl border border-violet-200 dark:border-violet-800 bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-violet-950 dark:to-indigo-950 hover:border-violet-300 dark:hover:border-violet-600 hover:shadow-sm transition-all text-left"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-violet-100 dark:bg-violet-900 text-violet-600 dark:text-violet-300 shrink-0">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
            Spot a keyboard GB we&apos;re missing?
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            Paste a link or a quick note — help grow the tracker for everyone.
          </p>
        </div>
      </div>
      <span className="hidden sm:inline-flex items-center gap-1 text-sm font-semibold text-violet-600 dark:text-violet-300 whitespace-nowrap group-hover:gap-1.5 transition-all">
        Contribute
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
      </span>
    </button>
  );
}

// ── Floating action button (persistent mobile entry) ─────────────────────────
export function ContributeFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Contribute keyboard info"
      className="sm:hidden fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-violet-600 hover:bg-violet-700 active:scale-95 text-white text-sm font-semibold shadow-lg shadow-violet-200 dark:shadow-violet-900 transition-all"
    >
      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
      </svg>
      Contribute
    </button>
  );
}
