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
}

const LocationContext = createContext<LocationContextValue>({
  countryCode: "SG",
  region: "SG",
  currency: "SGD",
  country: DEFAULT_COUNTRY,
  showModal: false,
  setLocation: () => {},
  setShowModal: () => {},
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

  useEffect(() => {
    const urlParam = new URLSearchParams(window.location.search).get("country");
    const saved = localStorage.getItem("user_country");
    const resolved = urlParam ?? saved ?? deriveFromBrowserLocale();

    if (resolved && COUNTRY_BY_CODE[resolved]) {
      applyCountry(resolved);
    } else if (!saved) {
      setShowModal(true);
    }
    // applyCountry is stable (useCallback), but we only want to run this once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyCountry = useCallback((code: string) => {
    const country = COUNTRY_BY_CODE[code];
    if (!country) return;
    setState({
      countryCode: code,
      region: country.region,
      currency: country.currency,
      country,
    });
    localStorage.setItem("user_country", code);
  }, []);

  const setLocation = useCallback(
    (code: string) => {
      applyCountry(code);
      setShowModal(false);
    },
    [applyCountry]
  );

  return (
    <LocationContext.Provider
      value={{ ...state, setLocation, showModal, setShowModal }}
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
