"use client";

import { useEffect } from "react";

// Shared modal chrome for the collection surfaces. Extracted from
// CollectionContent.tsx so components in their own files (the CSV importer)
// render identical modals instead of re-implementing the shell.

export const inputClass =
  "w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-[#9a7a42] focus:ring-2 focus:ring-[#9a7a42]/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white";
export const primaryButtonClass =
  "rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#9a7a42] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-950 dark:hover:bg-[#c9ab72]";
export const secondaryButtonClass =
  "rounded-full border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 hover:border-gray-400 hover:text-gray-950 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white";

export function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function useModalBodyLock() {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);
}

// Like Field but a <div>, not a <label>. Use it for controls that contain their
// own inputs — a <label> wrapping a hidden <input type="file"> makes the whole
// field area (its empty whitespace included) open the file picker on any click.
export function FieldBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-200">
        {label}
      </span>
      {children}
    </div>
  );
}

export function ModalShell({
  children,
  onClose,
  label,
  narrow = false,
  wide = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
  narrow?: boolean;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <button
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`relative w-full overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-[#111417] ${
          wide ? "max-w-4xl" : narrow ? "max-w-xl" : "max-w-2xl"
        }`}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 rounded-full bg-gray-100 p-2 text-gray-500 hover:text-gray-900 dark:bg-gray-800 dark:text-gray-300 dark:hover:text-white"
        >
          <CloseIcon />
        </button>
        {children}
      </section>
    </div>
  );
}
