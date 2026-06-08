"use client";
import { useState } from "react";

interface ImportResult {
  ok: boolean;
  error?: string;
  import?: { sets: number; vendors: number; vendorKits: number } | null;
  prices?: { attempted: number; updated: number; failed: number };
  ranAt?: string;
}

export default function ImportButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function runImport() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceLimit: 200 }),
      });
      const data: ImportResult = await res.json();
      setResult(data);
    } catch {
      setResult({ ok: false, error: "Network error — check console" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-semibold text-gray-900">Import &amp; Refresh Prices</p>
          <p className="text-sm text-gray-400 mt-0.5">
            Pull latest GMK sets from KeycapLendar, then scrape vendor prices.
            <br />
            Runs automatically every night at 00:00 SGT.
          </p>
        </div>
        <button
          onClick={runImport}
          disabled={loading}
          className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-medium transition-colors"
        >
          {loading ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Running…
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Run Now
            </>
          )}
        </button>
      </div>

      {result && (
        <div
          className={`mt-4 rounded-xl p-3 text-sm ${result.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}
        >
          {result.ok ? (
            <div className="space-y-1">
              {result.import && (
                <p>
                  Imported <strong>{result.import.sets}</strong> sets ·{" "}
                  <strong>{result.import.vendors}</strong> vendors ·{" "}
                  <strong>{result.import.vendorKits}</strong> listings
                </p>
              )}
              {result.prices && (
                <p>
                  Prices: <strong>{result.prices.attempted}</strong> attempted ·{" "}
                  <strong>{result.prices.updated}</strong> updated ·{" "}
                  <strong>{result.prices.failed}</strong> failed
                </p>
              )}
              <p className="text-xs opacity-60">
                Ran at {result.ranAt ? new Date(result.ranAt).toLocaleString() : "—"}
              </p>
            </div>
          ) : (
            <p>{result.error ?? "Import failed"}</p>
          )}
        </div>
      )}
    </div>
  );
}
