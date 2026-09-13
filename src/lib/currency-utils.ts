// Pure client-safe currency utilities — no Prisma dependency

export function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rates: Record<string, number>
): number {
  if (fromCurrency === toCurrency) return amount;
  const fromRate = rates[fromCurrency] ?? 1;
  const toRate = rates[toCurrency] ?? 1;
  return (amount / fromRate) * toRate;
}

export function formatCurrency(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currencyCode} ${Math.round(amount)}`;
  }
}

// The same amount with its ISO code spelled out: "USD 124", "SGD 185".
//
// formatCurrency pins the locale to en-SG, where the LOCAL currency gets the
// bare symbol and every other one gets a distinguishing prefix — SGD renders
// "$185" while USD renders "US$124". On a line showing one currency that is
// correct and compact. On a line showing TWO it is unreadable: "Paid US$124 ·
// Sold $185 · +$18" invites the reader to treat all three as dollars and
// conclude the gain should have been 61, when $185 and $18 are Singapore
// dollars and the sum is right. Which symbol is bare also depends on the
// locale, so the ambiguity moves rather than disappears if that pin changes.
//
// Use this wherever a single line can carry more than one currency; keep
// formatCurrency where the currency is fixed and stated elsewhere.
export function formatCurrencyWithCode(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "code",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currencyCode} ${Math.round(amount)}`;
  }
}
