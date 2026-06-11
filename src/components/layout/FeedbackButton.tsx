"use client";

import { useState } from "react";

// Header feedback panel: email + message only. Submissions go straight to the
// Feedback table (viewed in Supabase by the owner) — nothing is shown publicly.
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email.");
      return;
    }
    if (!subject.trim()) {
      setError("Please write your feedback.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), subject: subject.trim() }),
      });
      if (!res.ok) throw new Error("server error");
      setDone(true);
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    setOpen(false);
    // Reset after the close animation so reopening starts fresh.
    setTimeout(() => {
      setDone(false);
      setEmail("");
      setSubject("");
      setError("");
    }, 300);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Send feedback"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-500 transition-colors text-sm text-gray-600 dark:text-gray-300"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
          />
        </svg>
        <span className="hidden md:inline font-medium">Feedback</span>
      </button>

      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={close}
      />

      {/* Panel */}
      <div
        className={`fixed left-1/2 top-20 -translate-x-1/2 w-[calc(100%-2rem)] max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-2xl z-50 transition-all duration-300 ${
          open ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 -translate-y-3 pointer-events-none"
        }`}
      >
        <div className="flex items-start justify-between p-5 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Feedback</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Spotted a wrong price? Missing vendor? Tell us.
            </p>
          </div>
          <button
            onClick={close}
            className="mt-0.5 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
              <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-gray-900 dark:text-white">Thanks for the feedback!</p>
              <p className="text-sm text-gray-500 mt-1">We read every message.</p>
            </div>
            <button
              onClick={close}
              className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-5 flex flex-col gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Your email <span className="text-red-400">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(""); }}
                placeholder="you@example.com"
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Your feedback <span className="text-red-400">*</span>
              </label>
              <textarea
                value={subject}
                onChange={(e) => { setSubject(e.target.value); setError(""); }}
                placeholder="Wrong price, missing vendor, feature idea…"
                rows={4}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900 transition-colors resize-none"
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
              disabled={submitting || !email.trim() || !subject.trim()}
              className="w-full py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Sending…" : "Send feedback"}
            </button>

            <p className="text-[11px] text-gray-400 text-center">
              Your email is only used if we need to follow up — never shared.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
