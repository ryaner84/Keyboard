"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { COUNTRY_BY_CODE, DEFAULT_COUNTRY } from "@/data/countries";
import type { Country, LocationState } from "@/types";

interface LocationContextValue extends LocationState {
  setLocation: (countryCode: string) => void;
  showModal: boolean;
  setShowModal: (v: boolean) => void;
  // true once the user has explicitly chosen a location (saved / URL / picker),
  // false while we're only showing the SG default or a locale guess.
  selected: boolean;
  // Display currency — defaults to the location's currency but can be overridden
  // independently so users can view prices in any currency.
  setCurrency: (code: string) => void;
}

const LocationContext = createContext<LocationContextValue>({
  countryCode: "SG",
  region: "SG",
  currency: "SGD",
  country: DEFAULT_COUNTRY,
  showModal: false,
  selected: false,
  setLocation: () => {},
  setShowModal: () => {},
  setCurrency: () => {},
});

function deriveFromBrowserLocale(): string | null {
  try {
    const lang = navigator.language || "";
    const parts = lang.split("-");
    if (parts.length >= 2) {
      const code = parts[parts.length - 1].toUpperCase();
      if (COUNTRY_BY_CODE[code]) return code;
    }
  } catch {
    // SSR or unavailable
  }
  return null;
}

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LocationState>({
    countryCode: "SG",
    region: "SG",
    currency: "SGD",
    country: DEFAULT_COUNTRY,
  });
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState(false);
  const [currencyOverridden, setCurrencyOverridden] = useState(false);

  useEffect(() => {
    const urlParam = new URLSearchParams(window.location.search).get("country");
    const saved = localStorage.getItem("user_country");
    const savedCurrency = localStorage.getItem("user_currency");
    const explicit = urlParam ?? saved;

    if (explicit && COUNTRY_BY_CODE[explicit]) {
      applyCountry(explicit, true);
    } else {
      // No explicit choice — guess from locale for sensible defaults, but keep
      // `selected` false and prompt the user to confirm their shipping location.
      const guess = deriveFromBrowserLocale();
      if (guess) applyCountry(guess, false);
      setShowModal(true);
    }

    if (savedCurrency) {
      setCurrencyOverridden(true);
      setState((s) => ({ ...s, currency: savedCurrency }));
    }
    // applyCountry is stable (useCallback), but we only want to run this once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyCountry = useCallback(
    (code: string, markSelected: boolean) => {
      const country = COUNTRY_BY_CODE[code];
      if (!country) return;
      setState((prev) => ({
        countryCode: code,
        region: country.region,
        // Keep the user's chosen display currency if they overrode it.
        currency: currencyOverridden ? prev.currency : country.currency,
        country,
      }));
      if (markSelected) {
        setSelected(true);
        localStorage.setItem("user_country", code);
      }
    },
    [currencyOverridden]
  );

  const setLocation = useCallback(
    (code: string) => {
      applyCountry(code, true);
      setShowModal(false);
    },
    [applyCountry]
  );

  const setCurrency = useCallback((code: string) => {
    setCurrencyOverridden(true);
    setState((s) => ({ ...s, currency: code }));
    localStorage.setItem("user_currency", code);
  }, []);

  return (
    <LocationContext.Provider
      value={{ ...state, selected, setLocation, setCurrency, showModal, setShowModal }}
    >
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation(): LocationContextValue {
  return useContext(LocationContext);
}

export function useCountry(): Country | null {
  return useContext(LocationContext).country;
}
