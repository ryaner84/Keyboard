"use client";

import { useEffect, useRef, useState } from "react";
import { useTrackedSets } from "@/hooks/useTrackedSets";

export function TrackerAccountButton() {
  const {
    tracked,
    hydrated,
    authenticated,
    email,
    alertsEnabled,
    openSavePrompt,
    logout,
    setAlertsEnabled,
  } = useTrackedSets();
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!hydrated) {
    return <div className="h-8 w-8 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />;
  }

  if (!authenticated) {
    return (
      <button
        onClick={openSavePrompt}
        title="Save and sync tracker"
        className="relative flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-300 hover:border-indigo-300 hover:text-indigo-600"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
        {tracked.length > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-indigo-600 px-1 text-[9px] font-bold leading-4 text-white">
            {tracked.length > 99 ? "99+" : tracked.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((value) => !value)}
        title="Tracker account"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 text-green-700 dark:text-green-300"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 shadow-xl">
          <p className="text-xs font-semibold uppercase text-gray-400">Tracker synced</p>
          <p className="mt-1 truncate text-sm font-medium text-gray-900 dark:text-white">
            {email}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">{tracked.length} items saved</p>

          <label className="mt-3 flex items-center justify-between gap-3 border-t border-gray-100 dark:border-gray-800 pt-3">
            <span>
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                Email alerts
              </span>
              <span className="block text-xs text-gray-400">Important changes only</span>
            </span>
            <input
              type="checkbox"
              checked={alertsEnabled}
              disabled={updating}
              onChange={async (event) => {
                setUpdating(true);
                try {
                  await setAlertsEnabled(event.target.checked);
                } finally {
                  setUpdating(false);
                }
              }}
              className="h-4 w-4 accent-indigo-600"
            />
          </label>
          <button
            onClick={async () => {
              await logout();
              setOpen(false);
            }}
            className="mt-3 w-full rounded-md px-3 py-2 text-left text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white"
          >
            Sign out on this device
          </button>
        </div>
      )}
    </div>
  );
}
