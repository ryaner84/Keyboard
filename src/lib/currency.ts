import "server-only";
import { prisma } from "./prisma";
export { convertCurrency, formatCurrency } from "./currency-utils";

const STALE_HOURS = 24;

export async function getExchangeRates(): Promise<Record<string, number>> {
  const currencies = await prisma.currency.findMany();

  const isStale =
    currencies.length === 0 ||
    currencies.some((c) => {
      const ageMs = Date.now() - c.lastUpdated.getTime();
      return ageMs > STALE_HOURS * 60 * 60 * 1000;
    });

  if (isStale) {
    try {
      const apiKey = process.env.EXCHANGE_RATE_API_KEY;
      if (apiKey && apiKey !== "placeholder") {
        const res = await fetch(
          `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
        );
        const data = await res.json();
        if (data.result === "success") {
          const rates: Record<string, number> = data.conversion_rates;
          await Promise.all(
            Object.entries(rates).map(([code, rate]) =>
              prisma.currency.upsert({
                where: { code },
                update: { exchangeRateToUSD: rate, lastUpdated: new Date() },
                create: {
                  code,
                  name: code,
                  symbol: code,
                  exchangeRateToUSD: rate,
                  lastUpdated: new Date(),
                },
              })
            )
          );
          return rates;
        }
      }
    } catch {
      // Fall through to cached values
    }
  }

  return Object.fromEntries(currencies.map((c) => [c.code, c.exchangeRateToUSD]));
}
