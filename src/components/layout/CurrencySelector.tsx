"use client";

import { useState, useRef, useEffect } from "react";
import { useLocation } from "@/context/LocationContext";
import { DISPLAY_CURRENCIES, CURRENCY_BY_CODE } from "@/data/countries";

export function CurrencySelector() {
  const { currency, setCurrency } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const active = CURRENCY_BY_CODE[currency];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-500 transition-colors text-sm"
      >
        <span className="font-semibold text-gray-700 dark:text-gray-200">
          {active?.symbol ?? ""} {currency}
        </span>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-48 max-h-72 overflow-y-auto bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700 py-1 z-50">
          {DISPLAY_CURRENCIES.map((c) => (
            <button
              key={c.code}
              onClick={() => {
                setCurrency(c.code);
                setOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700 ${
                currency === c.code ? "text-indigo-600 dark:text-indigo-400 font-medium" : "text-gray-700 dark:text-gray-200"
              }`}
            >
              <span>{c.name}</span>
              <span className="text-gray-400">{c.symbol} {c.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
