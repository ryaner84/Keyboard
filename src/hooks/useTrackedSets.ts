"use client";

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "tracked_sets";

export function useTrackedSets() {
  const [tracked, setTracked] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setTracked(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, []);

  const persist = useCallback((slugs: string[]) => {
    setTracked(slugs);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slugs));
  }, []);

  const toggle = useCallback(
    (slug: string) => {
      persist(
        tracked.includes(slug)
          ? tracked.filter((s) => s !== slug)
          : [...tracked, slug]
      );
    },
    [tracked, persist]
  );

  const isTracked = useCallback(
    (slug: string) => tracked.includes(slug),
    [tracked]
  );

  const getShareUrl = useCallback(
    (countryCode: string): string => {
      const base =
        typeof window !== "undefined"
          ? window.location.origin
          : (process.env.NEXT_PUBLIC_SITE_URL ?? "");
      const params = new URLSearchParams({
        sets: tracked.join(","),
        country: countryCode,
      });
      return `${base}/tracker?${params}`;
    },
    [tracked]
  );

  return { tracked, toggle, isTracked, getShareUrl };
}
