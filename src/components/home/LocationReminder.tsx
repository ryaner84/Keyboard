"use client";

import { useLocation } from "@/context/LocationContext";

// Confirms the active shipping location (so users know prices are tailored)
// or nudges them to pick one for the best bargains.
export function LocationReminder() {
  const { country, countryCode, setShowModal } = useLocation();
  const hasLocation = Boolean(countryCode);

  if (hasLocation) {
    return (
      <button
        onClick={() => setShowModal(true)}
        className="inline-flex items-center gap-2 px-4 py-2 bg-green-50 text-green-700 rounded-full text-sm font-medium border border-green-200 hover:bg-green-100 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Showing cheapest prices shipping to {country?.flag} {country?.name}
        <span className="text-green-500 underline">change</span>
      </button>
    );
  }

  return (
    <button
      onClick={() => setShowModal(true)}
      className="inline-flex items-center gap-2 px-4 py-2 bg-amber-50 text-amber-700 rounded-full text-sm font-medium border border-amber-200 hover:bg-amber-100 transition-colors animate-pulse"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.314 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
      Select your shipping location for the best bargains →
    </button>
  );
}
