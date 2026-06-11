import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const RELEASED_STATUSES = ["SHIPPING", "DELIVERED", "IN_STOCK"] as const;

// "Available" means at least one vendor has a current price — the inStock flag
// is set by the GB-lifecycle importer (false for DELIVERED/SHIPPING) and is
// unreliable for released sets. A non-null scraped price is the real signal.
const AVAILABLE_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: { some: { price: { not: null } } },
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
    if (vk.price == null) continue;
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
  const availability = searchParams.get("availability") ?? "";
  const year = searchParams.get("year") ?? "";
  const designer = searchParams.get("designer") ?? "";
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

  const priceSort = sortBy === "price-asc";
  const effectiveAvailability = priceSort ? "available" : availability;

  const where = {
    status: { in: [...RELEASED_STATUSES] },
    ...yearFilter,
    ...(effectiveAvailability === "available" && AVAILABLE_FILTER),
    ...(effectiveAvailability === "soldout" && { NOT: AVAILABLE_FILTER }),
    ...(designer && { designer: { equals: designer, mode: "insensitive" as const } }),
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

  const [totalReleased, totalAvailable] = await Promise.all([
    prisma.groupBuy.count({ where: releasedWhere }),
    prisma.groupBuy.count({ where: { ...releasedWhere, ...AVAILABLE_FILTER } }),
  ]);

  // Top designers for the filter dropdown — only returned on page 1 with no
  // active designer filter, so the list reflects the full catalog.
  let topDesigners: string[] = [];
  if (page === 1 && !designer) {
    const rows = await prisma.groupBuy.groupBy({
      by: ["designer"],
      where: releasedWhere,
      _count: { designer: true },
      orderBy: { _count: { designer: "desc" } },
      take: 30,
    });
    topDesigners = rows.map((r) => r.designer).filter(Boolean);
  }

  // "Biggest savings" deals rail
  let deals: unknown[] = [];
  if (page === 1 && !search && !year && !designer && availability !== "soldout") {
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

  return NextResponse.json({ data, total, page, limit, totalReleased, totalAvailable, deals, topDesigners });
}
