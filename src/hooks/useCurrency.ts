"use client";

import { useState, useEffect, useCallback } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import type { ExchangeRates } from "@/types";

// Module-level cache so every card/component shares a single network request
// for exchange rates instead of fetching per-instance.
let cachedRates: ExchangeRates | null = null;
let inflight: Promise<ExchangeRates> | null = null;

function loadRates(): Promise<ExchangeRates> {
  if (cachedRates) return Promise.resolve(cachedRates);
  if (!inflight) {
    inflight = fetch("/api/currencies")
      .then((r) => r.json())
      .then((d) => {
        const rates = (d.rates as ExchangeRates) ?? {};
        if (Object.keys(rates).length > 0) {
          // Only cache a real result — caching an empty map would freeze the
          // whole session without conversions.
          cachedRates = rates;
        } else {
          inflight = null; // empty payload — let the next mount retry
        }
        return rates;
      })
      .catch(() => {
        // A single failed fetch must NOT poison the session: with the failed
        // promise cached, every later component saw {} forever, so any
        // cross-currency amount (e.g. a JPY purchase viewed in SGD) became
        // "unconvertible" and silently dropped out of the collection's total
        // spent. Reset so the next useCurrency mount retries.
        inflight = null;
        return {} as ExchangeRates;
      });
  }
  return inflight;
}

export function useCurrency(targetCurrency: string) {
  const [rates, setRates] = useState<ExchangeRates>(cachedRates ?? {});
  const [loading, setLoading] = useState(!cachedRates);

  useEffect(() => {
    let mounted = true;
    loadRates().then((r) => {
      if (mounted) {
        setRates(r);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const convert = useCallback(
    (amount: number, fromCurrency: string): number => {
      if (!rates || Object.keys(rates).length === 0) return amount;
      return convertCurrency(amount, fromCurrency, targetCurrency, rates);
    },
    [rates, targetCurrency]
  );

  const format = useCallback(
    (amount: number, fromCurrency: string): string => {
      const converted = convert(amount, fromCurrency);
      return formatCurrency(converted, targetCurrency);
    },
    [convert, targetCurrency]
  );

  return { rates, loading, convert, format };
}
