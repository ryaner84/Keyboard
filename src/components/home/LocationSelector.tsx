"use client";

import { useState, useMemo } from "react";
import { COUNTRIES, REGION_LABELS } from "@/data/countries";
import { useLocation } from "@/context/LocationContext";
import { Modal } from "@/components/ui/Modal";
import type { Country } from "@/types";

export function LocationSelector() {
  const { showModal, setShowModal, setLocation, countryCode } = useLocation();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? COUNTRIES.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.code.toLowerCase().includes(q) ||
            c.currency.toLowerCase().includes(q)
        )
      : COUNTRIES;
  }, [search]);

  const grouped = useMemo(() => {
    const map: Record<string, Country[]> = {};
    for (const c of filtered) {
      if (!map[c.region]) map[c.region] = [];
      map[c.region].push(c);
    }
    return map;
  }, [filtered]);

  const regionOrder = ["SG", "ASIA", "US", "CA", "EU", "UK", "AU", "OTHER"];

  return (
    <Modal open={showModal} title="Select your location" onClose={() => setShowModal(false)}>
      <div className="p-4">
        <p className="text-sm text-gray-500 mb-4">
          Choose your country to see prices and shipping costs in your local currency.
        </p>
        <input
          type="text"
          placeholder="Search country..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-4"
          autoFocus
        />
        <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {regionOrder.map((region) => {
            const countries = grouped[region];
            if (!countries?.length) return null;
            return (
              <div key={region}>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1">
                  {REGION_LABELS[region]}
                </p>
                <div className="space-y-0.5">
                  {countries.map((country) => (
                    <button
                      key={country.code}
                      onClick={() => setLocation(country.code)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                        countryCode === country.code
                          ? "bg-indigo-50 text-indigo-700"
                          : "hover:bg-gray-50 text-gray-700"
                      }`}
                    >
                      <span className="text-xl">{country.flag}</span>
                      <span className="flex-1 text-sm font-medium">{country.name}</span>
                      <span className="text-xs text-gray-400">{country.currency}</span>
                      {countryCode === country.code && (
                        <svg className="w-4 h-4 text-indigo-600" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
