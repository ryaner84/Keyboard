"use client";

import { useState, useEffect, useCallback } from "react";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import type { ExchangeRates } from "@/types";

export function useCurrency(targetCurrency: string) {
  const [rates, setRates] = useState<ExchangeRates>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/currencies")
      .then((r) => r.json())
      .then((data) => {
        if (data.rates) setRates(data.rates);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
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
