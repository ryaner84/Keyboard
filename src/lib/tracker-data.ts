import "server-only";

import { prisma } from "@/lib/prisma";

export interface TrackerSnapshot {
  lastStatus: string;
  lastBestPriceUsd: number | null;
  lastVendorCount: number;
  lastDevUpdateAt: Date | null;
}

const trackerCatalogInclude = {
  kits: {
    include: {
      vendorKits: {
        include: {
          vendor: {
            include: { shippingZones: true },
          },
        },
      },
    },
  },
  devUpdates: {
    orderBy: { postedAt: "desc" as const },
    take: 1,
  },
};

type SnapshotGroupBuy = {
  status: string;
  productType: string;
  basePrice: number | null;
  priceCurrency: string | null;
  kits: Array<{
    vendorKits: Array<{
      price: number | null;
      currency: string | null;
      inStock: boolean;
      vendor: { currency: string };
    }>;
  }>;
  devUpdates: Array<{ postedAt: Date }>;
};

export async function getUsdRates(): Promise<Record<string, number>> {
  const rows = await prisma.currency.findMany({
    select: { code: true, exchangeRateToUSD: true },
  });
  return Object.fromEntries(rows.map((row) => [row.code, row.exchangeRateToUSD]));
}

export function trackerSnapshotFromGroupBuy(
  groupBuy: SnapshotGroupBuy,
  rates: Record<string, number>
): TrackerSnapshot {
  let bestPriceUsd: number | null = null;
  let vendorCount = 0;

  if (
    groupBuy.productType === "KEYBOARD" &&
    groupBuy.basePrice != null &&
    groupBuy.priceCurrency
  ) {
    const rate = rates[groupBuy.priceCurrency] ?? 1;
    bestPriceUsd = groupBuy.basePrice / rate;
    vendorCount = 1;
  } else {
    for (const kit of groupBuy.kits) {
      for (const vendorKit of kit.vendorKits) {
        if (vendorKit.price == null || !vendorKit.inStock) continue;
        vendorCount++;
        const currency = vendorKit.currency ?? vendorKit.vendor.currency ?? "USD";
        const rate = rates[currency] ?? 1;
        const priceUsd = vendorKit.price / rate;
        bestPriceUsd = bestPriceUsd == null ? priceUsd : Math.min(bestPriceUsd, priceUsd);
      }
    }
  }

  return {
    lastStatus: groupBuy.status,
    lastBestPriceUsd: bestPriceUsd,
    lastVendorCount: vendorCount,
    lastDevUpdateAt: groupBuy.devUpdates[0]?.postedAt ?? null,
  };
}

export async function getGroupBuyForTracking(slug: string) {
  return prisma.groupBuy.findUnique({
    where: { slug },
    include: trackerCatalogInclude,
  });
}

export async function getTrackerSnapshot(groupBuyId: string) {
  const [groupBuy, rates] = await Promise.all([
    prisma.groupBuy.findUnique({
      where: { id: groupBuyId },
      include: trackerCatalogInclude,
    }),
    getUsdRates(),
  ]);
  return groupBuy ? trackerSnapshotFromGroupBuy(groupBuy, rates) : null;
}

export async function getTrackerItemsForUser(userId: string) {
  return prisma.trackerItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      groupBuy: {
        include: trackerCatalogInclude,
      },
    },
  });
}

export async function syncTrackerSlugsForUser({
  userId,
  slugs,
  countryCode,
  region,
  currency,
}: {
  userId: string;
  slugs: string[];
  countryCode?: string | null;
  region?: string | null;
  currency?: string | null;
}) {
  const normalizedSlugs = Array.from(new Set(slugs.map(String).filter(Boolean))).slice(0, 200);
  const [groupBuys, rates] = await Promise.all([
    prisma.groupBuy.findMany({
      where: { slug: { in: normalizedSlugs } },
      include: {
        kits: { include: { vendorKits: { include: { vendor: true } } } },
        devUpdates: { orderBy: { postedAt: "desc" }, take: 1 },
      },
    }),
    getUsdRates(),
  ]);

  await prisma.$transaction([
    ...groupBuys.map((groupBuy) =>
      prisma.trackerItem.upsert({
        where: {
          userId_groupBuyId: { userId, groupBuyId: groupBuy.id },
        },
        update: { isTracking: true, alertsEnabled: true },
        create: {
          userId,
          groupBuyId: groupBuy.id,
          ...trackerSnapshotFromGroupBuy(groupBuy, rates),
        },
      })
    ),
    prisma.trackerUser.update({
      where: { id: userId },
      data: {
        countryCode: countryCode?.slice(0, 8) || undefined,
        region: region?.slice(0, 16) || undefined,
        currency: currency?.slice(0, 8) || undefined,
      },
    }),
  ]);

  const items = await prisma.trackerItem.findMany({
    where: { userId, isTracking: true },
    select: { groupBuy: { select: { slug: true } } },
  });
  return items.map((item) => item.groupBuy.slug);
}
