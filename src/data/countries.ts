import type { Country } from "@/types";

export const COUNTRIES: Country[] = [
  // Singapore — primary focus, listed first
  { code: "SG", name: "Singapore", region: "SG", currency: "SGD", flag: "🇸🇬" },

  // Asia
  { code: "JP", name: "Japan", region: "ASIA", currency: "JPY", flag: "🇯🇵" },
  { code: "KR", name: "South Korea", region: "ASIA", currency: "KRW", flag: "🇰🇷" },
  { code: "CN", name: "China", region: "ASIA", currency: "CNY", flag: "🇨🇳" },
  { code: "TW", name: "Taiwan", region: "ASIA", currency: "TWD", flag: "🇹🇼" },
  { code: "HK", name: "Hong Kong", region: "ASIA", currency: "HKD", flag: "🇭🇰" },
  { code: "MY", name: "Malaysia", region: "ASIA", currency: "MYR", flag: "🇲🇾" },
  { code: "TH", name: "Thailand", region: "ASIA", currency: "THB", flag: "🇹🇭" },
  { code: "PH", name: "Philippines", region: "ASIA", currency: "PHP", flag: "🇵🇭" },
  { code: "ID", name: "Indonesia", region: "ASIA", currency: "IDR", flag: "🇮🇩" },
  { code: "VN", name: "Vietnam", region: "ASIA", currency: "VND", flag: "🇻🇳" },
  { code: "IN", name: "India", region: "ASIA", currency: "INR", flag: "🇮🇳" },

  // United States
  { code: "US", name: "United States", region: "US", currency: "USD", flag: "🇺🇸" },

  // Canada
  { code: "CA", name: "Canada", region: "CA", currency: "CAD", flag: "🇨🇦" },

  // Europe
  { code: "DE", name: "Germany", region: "EU", currency: "EUR", flag: "🇩🇪" },
  { code: "FR", name: "France", region: "EU", currency: "EUR", flag: "🇫🇷" },
  { code: "NL", name: "Netherlands", region: "EU", currency: "EUR", flag: "🇳🇱" },
  { code: "BE", name: "Belgium", region: "EU", currency: "EUR", flag: "🇧🇪" },
  { code: "ES", name: "Spain", region: "EU", currency: "EUR", flag: "🇪🇸" },
  { code: "IT", name: "Italy", region: "EU", currency: "EUR", flag: "🇮🇹" },
  { code: "PT", name: "Portugal", region: "EU", currency: "EUR", flag: "🇵🇹" },
  { code: "AT", name: "Austria", region: "EU", currency: "EUR", flag: "🇦🇹" },
  { code: "SE", name: "Sweden", region: "EU", currency: "SEK", flag: "🇸🇪" },
  { code: "NO", name: "Norway", region: "EU", currency: "NOK", flag: "🇳🇴" },
  { code: "DK", name: "Denmark", region: "EU", currency: "DKK", flag: "🇩🇰" },
  { code: "FI", name: "Finland", region: "EU", currency: "EUR", flag: "🇫🇮" },
  { code: "PL", name: "Poland", region: "EU", currency: "PLN", flag: "🇵🇱" },
  { code: "CZ", name: "Czech Republic", region: "EU", currency: "CZK", flag: "🇨🇿" },
  { code: "HU", name: "Hungary", region: "EU", currency: "HUF", flag: "🇭🇺" },
  { code: "RO", name: "Romania", region: "EU", currency: "RON", flag: "🇷🇴" },
  { code: "GR", name: "Greece", region: "EU", currency: "EUR", flag: "🇬🇷" },
  { code: "CH", name: "Switzerland", region: "EU", currency: "CHF", flag: "🇨🇭" },

  // United Kingdom
  { code: "GB", name: "United Kingdom", region: "UK", currency: "GBP", flag: "🇬🇧" },
  { code: "IE", name: "Ireland", region: "EU", currency: "EUR", flag: "🇮🇪" },

  // Australia & NZ
  { code: "AU", name: "Australia", region: "AU", currency: "AUD", flag: "🇦🇺" },
  { code: "NZ", name: "New Zealand", region: "AU", currency: "NZD", flag: "🇳🇿" },

  // Other
  { code: "BR", name: "Brazil", region: "OTHER", currency: "BRL", flag: "🇧🇷" },
  { code: "MX", name: "Mexico", region: "OTHER", currency: "MXN", flag: "🇲🇽" },
  { code: "ZA", name: "South Africa", region: "OTHER", currency: "ZAR", flag: "🇿🇦" },
  { code: "AE", name: "UAE", region: "OTHER", currency: "AED", flag: "🇦🇪" },
  { code: "SA", name: "Saudi Arabia", region: "OTHER", currency: "SAR", flag: "🇸🇦" },
  { code: "IL", name: "Israel", region: "OTHER", currency: "ILS", flag: "🇮🇱" },
];

export const COUNTRY_BY_CODE: Record<string, Country> = Object.fromEntries(
  COUNTRIES.map((c) => [c.code, c])
);

export const COUNTRIES_BY_REGION = COUNTRIES.reduce(
  (acc, c) => {
    if (!acc[c.region]) acc[c.region] = [];
    acc[c.region].push(c);
    return acc;
  },
  {} as Record<string, Country[]>
);

export const REGION_LABELS: Record<string, string> = {
  SG: "Singapore",
  ASIA: "Asia Pacific",
  US: "United States",
  CA: "Canada",
  EU: "Europe",
  UK: "United Kingdom",
  AU: "Australia & NZ",
  OTHER: "Rest of World",
};

export const DEFAULT_COUNTRY = COUNTRY_BY_CODE["SG"];

// Currencies the user can pick for display (independent of shipping location).
export interface DisplayCurrency {
  code: string;
  symbol: string;
  name: string;
}

export const DISPLAY_CURRENCIES: DisplayCurrency[] = [
  { code: "SGD", symbol: "S$", name: "Singapore Dollar" },
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "CAD", symbol: "CA$", name: "Canadian Dollar" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan" },
  { code: "KRW", symbol: "₩", name: "Korean Won" },
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit" },
  { code: "HKD", symbol: "HK$", name: "Hong Kong Dollar" },
  { code: "NZD", symbol: "NZ$", name: "New Zealand Dollar" },
];

export const CURRENCY_BY_CODE: Record<string, DisplayCurrency> = Object.fromEntries(
  DISPLAY_CURRENCIES.map((c) => [c.code, c])
);
