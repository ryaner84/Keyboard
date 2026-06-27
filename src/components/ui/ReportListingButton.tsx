"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  slug: string;
  name: string;
  /** Extra class on the trigger button (e.g. to position it inside a table cell). */
  className?: string;
}

const ISSUE_TYPES = [
  { value: "wrong_category", label: "Wrong category", emoji: "🔀" },
  { value: "wrong_price",    label: "Wrong price",    emoji: "💰" },
  { value: "inactive",       label: "Inactive / ended", emoji: "📭" },
  { value: "duplicate",      label: "Duplicate entry",  emoji: "👯" },
  { value: "wrong_vendor",   label: "Wrong vendor / region", emoji: "🏷️" },
  { value: "other",          label: "Other",           emoji: "💬" },
] as const;

type IssueValue = (typeof ISSUE_TYPES)[number]["value"];
type Phase = "idle" | "open" | "submitting" | "done" | "error";

export function ReportListingButton({ slug, name, className = "" }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [selected, setSelected] = useState<IssueValue | null>(null);
  const [notes, setNotes] = useState("");

  function open(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPhase("open");
    setSelected(null);
    setNotes("");
  }

  function close() {
    if (phase === "submitting") return;
    setPhase("idle");
  }

  async function submit() {
    if (!selected) return;
    setPhase("submitting");
    try {
      const res = await fetch("/api/listing-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, issueType: selected, notes }),
      });
      setPhase(res.ok ? "done" : "error");
      if (res.ok) setTimeout(() => setPhase("idle"), 2000);
    } catch {
      setPhase("error");
    }
  }

  return (
    <>
      {/* Trigger: small flag icon, subtle until hovered */}
      <button
        type="button"
        onClick={open}
        title="Report an issue with this listing"
        className={`inline-flex items-center justify-center w-6 h-6 rounded text-gray-300 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors ${className}`}
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
          <path fillRule="evenodd" d="M3 6a3 3 0 013-3h10l-1.5 3L16 9H6a3 3 0 01-3-3z" clipRule="evenodd" />
          <path d="M3 9v8a1 1 0 102 0V9H3z" />
        </svg>
      </button>

      {/* Modal — rendered through a portal to document.body so it escapes the
          card's hover transform (a fixed element inside a transformed ancestor
          is positioned relative to that ancestor, which made the dialog jump)
          and so its clicks never bubble into the card link/handlers. */}
      {(phase === "open" || phase === "submitting" || phase === "done" || phase === "error") &&
        typeof document !== "undefined" &&
        createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 w-full max-w-md p-6 space-y-5">
            {phase === "done" ? (
              <div className="text-center py-4 space-y-2">
                <div className="text-3xl">✅</div>
                <p className="font-semibold text-gray-800 dark:text-white">Thanks for the report!</p>
                <p className="text-sm text-gray-500">We review these daily and will fix it soon.</p>
              </div>
            ) : (
              <>
                <div>
                  <h2 className="font-bold text-gray-900 dark:text-white text-base">Report an issue</h2>
                  <p className="text-sm text-gray-500 truncate mt-0.5">{name}</p>
                </div>

                {/* Issue type chips */}
                <div className="grid grid-cols-2 gap-2">
                  {ISSUE_TYPES.map(({ value, label, emoji }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSelected(value)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-all text-left ${
                        selected === value
                          ? "border-red-400 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 dark:border-red-500"
                          : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600"
                      }`}
                    >
                      <span>{emoji}</span>
                      <span className="leading-tight">{label}</span>
                    </button>
                  ))}
                </div>

                {/* Optional notes */}
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional: add any details to help us fix this…"
                  maxLength={500}
                  rows={2}
                  className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-red-300 dark:focus:ring-red-700"
                />

                {phase === "error" && (
                  <p className="text-sm text-red-600 dark:text-red-400">Something went wrong — please try again.</p>
                )}

                <div className="flex gap-3 justify-end">
                  <button
                    type="button"
                    onClick={close}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!selected || phase === "submitting"}
                    className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {phase === "submitting" ? "Sending…" : "Submit report"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
