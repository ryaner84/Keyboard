"use client";

import { useLocation } from "@/context/LocationContext";

// Persistent vertical tab fixed to the right edge — always reminds the user
// which shipping location prices are tailored to, and opens the picker.
export function ShippingLocationTab() {
  const { country, countryCode, setShowModal } = useLocation();
  const hasLocation = Boolean(countryCode);

  return (
    <button
      onClick={() => setShowModal(true)}
      aria-label="Change shipping location"
      className={`flex items-center gap-2 px-2 py-3 rounded-l-xl shadow-lg text-xs font-semibold tracking-wide transition-colors ${
        hasLocation
          ? "bg-green-600 text-white hover:bg-green-700"
          : "bg-amber-500 text-white hover:bg-amber-600 animate-pulse"
      }`}
      style={{ writingMode: "vertical-rl" }}
    >
      <svg className="w-4 h-4 rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.314 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
      {hasLocation ? `Lowest price → ${country?.name ?? countryCode}` : "Select shipping location"}
    </button>
  );
}
