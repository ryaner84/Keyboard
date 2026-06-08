import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma";
import type { Region, KitType } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import groupBuysData from "../src/data/seed/group-buys.json";
import vendorsData from "../src/data/seed/vendors.json";
import kitsData from "../src/data/seed/kits.json";
import vendorKitsData from "../src/data/seed/vendor-kits.json";
import shippingZonesData from "../src/data/seed/shipping-zones.json";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const CURRENCIES = [
  { code: "USD", name: "US Dollar", symbol: "$", exchangeRateToUSD: 1.0 },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$", exchangeRateToUSD: 1.35 },
  { code: "EUR", name: "Euro", symbol: "€", exchangeRateToUSD: 0.92 },
  { code: "GBP", name: "British Pound", symbol: "£", exchangeRateToUSD: 0.79 },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$", exchangeRateToUSD: 1.37 },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", exchangeRateToUSD: 1.54 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", exchangeRateToUSD: 150.5 },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥", exchangeRateToUSD: 7.24 },
  { code: "KRW", name: "South Korean Won", symbol: "₩", exchangeRateToUSD: 1340 },
  { code: "MYR", name: "Malaysian Ringgit", symbol: "RM", exchangeRateToUSD: 4.71 },
  { code: "THB", name: "Thai Baht", symbol: "฿", exchangeRateToUSD: 35.8 },
  { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$", exchangeRateToUSD: 1.64 },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$", exchangeRateToUSD: 7.82 },
  { code: "TWD", name: "New Taiwan Dollar", symbol: "NT$", exchangeRateToUSD: 32.1 },
  { code: "SEK", name: "Swedish Krona", symbol: "kr", exchangeRateToUSD: 10.5 },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr", exchangeRateToUSD: 10.8 },
  { code: "DKK", name: "Danish Krone", symbol: "kr", exchangeRateToUSD: 6.89 },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF", exchangeRateToUSD: 0.89 },
  { code: "PLN", name: "Polish Zloty", symbol: "zł", exchangeRateToUSD: 4.02 },
];

async function main() {
  console.log("Seeding database...");

  // Currencies
  for (const c of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: c.code },
      update: { exchangeRateToUSD: c.exchangeRateToUSD },
      create: { ...c, lastUpdated: new Date() },
    });
  }
  console.log(`Seeded ${CURRENCIES.length} currencies`);

  // Vendors
  for (const v of vendorsData) {
    const vendorData = { ...v, region: v.region as Region };
    await prisma.vendor.upsert({
      where: { slug: v.slug },
      update: vendorData,
      create: vendorData,
    });
  }
  console.log(`Seeded ${vendorsData.length} vendors`);

  // Group buys
  for (const gb of groupBuysData) {
    await prisma.groupBuy.upsert({
      where: { slug: gb.slug },
      update: {
        ...gb,
        gbStart: gb.gbStart ? new Date(gb.gbStart) : null,
        gbEnd: gb.gbEnd ? new Date(gb.gbEnd) : null,
        status: gb.status as never,
      },
      create: {
        ...gb,
        gbStart: gb.gbStart ? new Date(gb.gbStart) : null,
        gbEnd: gb.gbEnd ? new Date(gb.gbEnd) : null,
        status: gb.status as never,
      },
    });
  }
  console.log(`Seeded ${groupBuysData.length} group buys`);

  // Kits
  for (const k of kitsData) {
    const groupBuy = await prisma.groupBuy.findUnique({ where: { slug: k.groupBuySlug } });
    if (!groupBuy) continue;

    const existing = await prisma.kit.findFirst({
      where: { groupBuyId: groupBuy.id, name: k.name },
    });
    if (!existing) {
      await prisma.kit.create({
        data: { name: k.name, type: k.type as KitType, groupBuyId: groupBuy.id },
      });
    }
  }
  console.log(`Seeded kits`);

  // Vendor kits
  for (const vk of vendorKitsData) {
    const groupBuy = await prisma.groupBuy.findUnique({ where: { slug: vk.groupBuySlug } });
    if (!groupBuy) continue;

    const kit = await prisma.kit.findFirst({
      where: { groupBuyId: groupBuy.id, name: vk.kitName },
    });
    const vendor = await prisma.vendor.findUnique({ where: { slug: vk.vendorSlug } });
    if (!kit || !vendor) continue;

    await prisma.vendorKit.upsert({
      where: { kitId_vendorId: { kitId: kit.id, vendorId: vendor.id } },
      update: { price: vk.price, currency: vk.currency, inStock: vk.inStock, gbUrl: vk.gbUrl },
      create: {
        kitId: kit.id,
        vendorId: vendor.id,
        price: vk.price,
        currency: vk.currency,
        inStock: vk.inStock,
        gbUrl: vk.gbUrl,
      },
    });
  }
  console.log(`Seeded vendor kits`);

  // Shipping zones
  for (const sz of shippingZonesData) {
    const vendor = await prisma.vendor.findUnique({ where: { slug: sz.vendorSlug } });
    if (!vendor) continue;

    await prisma.shippingZone.upsert({
      where: {
        vendorId_destinationRegion: {
          vendorId: vendor.id,
          destinationRegion: sz.destinationRegion as Region,
        },
      },
      update: sz as never,
      create: {
        vendorId: vendor.id,
        destinationRegion: sz.destinationRegion as Region,
        baseShippingCost: sz.baseShippingCost,
        currency: sz.currency,
        estimatedDaysMin: sz.estimatedDaysMin,
        estimatedDaysMax: sz.estimatedDaysMax,
        shipsToRegion: sz.shipsToRegion,
      },
    });
  }
  console.log(`Seeded shipping zones`);

  console.log("Done!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
