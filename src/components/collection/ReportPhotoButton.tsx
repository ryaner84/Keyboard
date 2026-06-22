"use client";

import { useState } from "react";

const REASONS = [
  ["not_keyboard", "This is not a keyboard photo"],
  ["stolen", "Photo may belong to someone else"],
  ["offensive", "Offensive or unsafe content"],
  ["spam", "Spam or advertising"],
  ["other", "Another issue"],
] as const;

export default function ReportPhotoButton({
  collectionSlug,
  trackerItemId,
  buildIndex,
  label,
  className = "",
}: {
  collectionSlug: string;
  trackerItemId: string;
  buildIndex: number;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>("not_keyboard");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState("");

  async function submit() {
    setStatus("submitting");
    setError("");
    try {
      const response = await fetch("/api/collection-photo-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionSlug,
          trackerItemId,
          buildIndex,
          issueType: reason,
          notes,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not submit report");
      setStatus("done");
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Could not submit report"
      );
      setStatus("idle");
    }
  }

  function close() {
    setOpen(false);
    setError("");
    if (status === "done") {
      setStatus("idle");
      setNotes("");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Report photo for ${label}`}
        title="Report owner photo"
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white/80 shadow-sm backdrop-blur transition hover:bg-black/80 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/70 ${className}`}
      >
        <FlagIcon />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-4 backdrop-blur-sm sm:items-center"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Report collection photo"
            className="w-full max-w-md rounded-2xl bg-white p-5 text-left shadow-2xl dark:bg-[#15181c]"
          >
            {status === "done" ? (
              <div className="py-4 text-center">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  ✓
                </span>
                <h2 className="mt-4 text-lg font-semibold text-gray-950 dark:text-white">
                  Report received
                </h2>
                <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">
                  We recorded the exact uploaded photo so a replacement image is
                  treated separately.
                </p>
                <button
                  type="button"
                  onClick={close}
                  className="mt-5 rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-950"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
                      Community safety
                    </p>
                    <h2 className="mt-1 text-xl font-semibold text-gray-950 dark:text-white">
                      Report this photo
                    </h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Only report the collector-uploaded image, not the keyboard listing.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={close}
                    aria-label="Close report"
                    className="rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-white"
                  >
                    ×
                  </button>
                </div>

                <label className="mt-5 block text-xs font-semibold text-gray-700 dark:text-gray-200">
                  Reason
                  <select
                    value={reason}
                    onChange={(event) =>
                      setReason(event.target.value as (typeof REASONS)[number][0])
                    }
                    className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-[#9a7a42] focus:ring-2 focus:ring-[#9a7a42]/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  >
                    {REASONS.map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="mt-4 block text-xs font-semibold text-gray-700 dark:text-gray-200">
                  Details <span className="font-normal text-gray-400">(optional)</span>
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value.slice(0, 1000))}
                    rows={3}
                    placeholder="Add context that will help review this photo."
                    className="mt-2 w-full resize-none rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-[#9a7a42] focus:ring-2 focus:ring-[#9a7a42]/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  />
                </label>

                {error && (
                  <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
                )}

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-full px-4 py-2.5 text-sm font-semibold text-gray-500 hover:text-gray-900 dark:hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={status === "submitting"}
                    onClick={submit}
                    className="rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-gray-950"
                  >
                    {status === "submitting" ? "Sending…" : "Submit report"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function FlagIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 21V5m0 0c4-3 8 3 12 0v9c-4 3-8-3-12 0" />
    </svg>
  );
}
