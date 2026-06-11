import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Post-group-buy catalog: sets whose run has finished (shipping, delivered,
// or sitting in stock at vendors). The defining question for this section is
// "can I still buy it?", so rows can be filtered by live availability — a set
// counts as available when at least one vendor has a scraped/manual price on
// the BASE kit and stock. For bargain hunters the API also supports
// lowest-price sorting and a "biggest savings" deals ranking, both normalized
// to USD server-side (the client re-renders amounts in the user's currency).
const RELEASED_STATUSES = ["SHIPPING", "DELIVERED", "IN_STOCK"] as const;

const AVAILABLE_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: { some: { price: { not: null }, inStock: true } },
    },
  },
};

const PRICING_INCLUDE = {
  kits: {
    include: {
      vendorKits: {
        include: { vendor: { include: { shippingZones: true } } },
      },
    },
  },
} as const;

// Cap for the in-memory price ranking — available released sets are a small
// subset (vendors only stock so much), so this covers everything in practice.
const RANKING_CAP = 400;

interface PricedSet {
  set: { id: string; kits: Array<{ type: string; vendorKits: Array<{ price: number | null; currency: string | null; inStock: boolean }> }> };
  minUsd: number;
  maxUsd: number;
  pricedVendors: number;
}

function priceStats(
  set: PricedSet["set"],
  usdRates: Record<string, number>
): { minUsd: number; maxUsd: number; pricedVendors: number } | null {
  const base = set.kits.find((k) => k.type === "BASE") ?? set.kits[0];
  if (!base) return null;
  let min = Infinity;
  let max = 0;
  let count = 0;
  for (const vk of base.vendorKits) {
    if (vk.price == null || !vk.inStock) continue;
    const rate = usdRates[vk.currency ?? "USD"] ?? 1;
    const usd = vk.price / rate;
    count++;
    if (usd < min) min = usd;
    if (usd > max) max = usd;
  }
  if (count === 0 || !isFinite(min)) return null;
  return { minUsd: min, maxUsd: max, pricedVendors: count };
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search") ?? "";
  const availability = searchParams.get("availability") ?? ""; // "" | "available" | "soldout"
  const year = searchParams.get("year") ?? "";
  const sortBy = searchParams.get("sort") ?? "released-desc";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const limit = Math.min(48, Math.max(1, parseInt(searchParams.get("limit") ?? "24")));

  let yearFilter: Record<string, unknown> = {};
  if (/^\d{4}$/.test(year)) {
    yearFilter = {
      gbEnd: {
        gte: new Date(`${year}-01-01T00:00:00Z`),
        lt: new Date(`${Number(year) + 1}-01-01T00:00:00Z`),
      },
    };
  }

  // Price sorting only makes sense over sets that HAVE a price.
  const priceSort = sortBy === "price-asc";
  const effectiveAvailability = priceSort ? "available" : availability;

  const where = {
    status: { in: [...RELEASED_STATUSES] },
    ...yearFilter,
    ...(effectiveAvailability === "available" && AVAILABLE_FILTER),
    ...(effectiveAvailability === "soldout" && { NOT: AVAILABLE_FILTER }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { designer: { contains: search, mode: "insensitive" as const } },
        { colorway: { contains: search, mode: "insensitive" as const } },
      ],
    }),
  };

  const orderBy =
    sortBy === "name"
      ? { name: "asc" as const }
      : sortBy === "released-asc"
        ? { gbEnd: { sort: "asc" as const, nulls: "last" as const } }
        : { gbEnd: { sort: "desc" as const, nulls: "last" as const } };

  const releasedWhere = { status: { in: [...RELEASED_STATUSES] } };

  // USD rates for server-side ranking (stored as "1 USD = X local").
  const needRates = priceSort || page === 1;
  const usdRates: Record<string, number> = {};
  if (needRates) {
    const rateRows = await prisma.currency.findMany({
      select: { code: true, exchangeRateToUSD: true },
    });
    for (const r of rateRows) usdRates[r.code] = r.exchangeRateToUSD;
  }

  let data: unknown[];
  let total: number;

  if (priceSort) {
    // In-memory ranking: fetch every matching available set (small, capped),
    // rank by the cheapest vendor's kit price in USD, then paginate.
    const all = await prisma.groupBuy.findMany({
      where,
      include: PRICING_INCLUDE,
      take: RANKING_CAP,
    });
    const ranked = all
      .map((set) => ({ set, stats: priceStats(set as never, usdRates) }))
      .filter((r) => r.stats !== null)
      .sort((a, b) => a.stats!.minUsd - b.stats!.minUsd);
    total = ranked.length;
    data = ranked.slice((page - 1) * limit, page * limit).map((r) => r.set);
  } else {
    [total, data] = await Promise.all([
      prisma.groupBuy.count({ where }),
      prisma.groupBuy.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: PRICING_INCLUDE,
      }),
    ]);
  }

  // Section-wide stats for the hero, independent of active filters.
  const [totalReleased, totalAvailable] = await Promise.all([
    prisma.groupBuy.count({ where: releasedWhere }),
    prisma.groupBuy.count({ where: { ...releasedWhere, ...AVAILABLE_FILTER } }),
  ]);

  // "Biggest savings" deals rail: available released sets where 2+ vendors
  // disagree on price, ranked by the relative spread. Only computed for the
  // unfiltered first page — the rail is a discovery surface, not a result set.
  let deals: unknown[] = [];
  if (page === 1 && !search && !year && availability !== "soldout") {
    const available = await prisma.groupBuy.findMany({
      where: { ...releasedWhere, ...AVAILABLE_FILTER },
      include: PRICING_INCLUDE,
      take: RANKING_CAP,
    });
    deals = available
      .map((set) => ({ set, stats: priceStats(set as never, usdRates) }))
      .filter(
        (r): r is { set: (typeof available)[number]; stats: NonNullable<ReturnType<typeof priceStats>> } =>
          r.stats !== null && r.stats.pricedVendors >= 2 && r.stats.maxUsd > 0
      )
      .map((r) => ({
        set: r.set,
        spreadPct: ((r.stats.maxUsd - r.stats.minUsd) / r.stats.maxUsd) * 100,
      }))
      .filter((r) => r.spreadPct >= 5)
      .sort((a, b) => b.spreadPct - a.spreadPct)
      .slice(0, 4)
      .map((r) => r.set);
  }

  return NextResponse.json({ data, total, page, limit, totalReleased, totalAvailable, deals });
}
