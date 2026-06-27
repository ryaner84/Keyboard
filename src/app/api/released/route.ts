import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notHiddenWhere } from "@/lib/showcase";

const RELEASED_STATUSES = ["SHIPPING", "DELIVERED", "IN_STOCK"] as const;

// "Available" means at least one vendor has a current price and its selected
// base-kit variant is currently purchasable.
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
  const availability = searchParams.get("availability") ?? "";
  const year = searchParams.get("year") ?? "";
  const designer = searchParams.get("designer") ?? "";
  const vendor = searchParams.get("vendor") ?? "";
  const sortBy = searchParams.get("sort") ?? "released-desc";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const limit = Math.min(48, Math.max(1, parseInt(searchParams.get("limit") ?? "24")));
  // Released sets split into two categories. Keycaps keep the multi-vendor
  // price-compare experience; keyboards are single-vendor (price on the row),
  // so the available/savings/deals machinery is skipped for them.
  // Accept the type param case-insensitively and in either spelling — the UI
  // sends "KEYBOARD", but a hand-typed / shared link uses "keyboards", and that
  // must NOT silently fall through to keycaps (which is what surfaced GMK
  // keycap sets under /released?type=keyboards).
  const typeParam = (searchParams.get("type") ?? "").toLowerCase();
  const productType = typeParam === "keyboard" || typeParam === "keyboards" ? "KEYBOARD" : "KEYCAPS";
  const isKeyboard = productType === "KEYBOARD";

  let yearFilter: Record<string, unknown> = {};
  if (/^\d{4}$/.test(year)) {
    yearFilter = {
      gbEnd: {
        gte: new Date(`${year}-01-01T00:00:00Z`),
        lt: new Date(`${Number(year) + 1}-01-01T00:00:00Z`),
      },
    };
  }

  // The price/savings sorts and availability filter are keycap-only (they read
  // multi-vendor VendorKit prices). Keyboards ignore them entirely.
  const priceSort = !isKeyboard && sortBy === "price-asc";
  const savingsSort = !isKeyboard && sortBy === "savings-desc";
  const effectiveAvailability = isKeyboard
    ? ""
    : priceSort || savingsSort
      ? "available"
      : availability;

  const where = {
    status: { in: [...RELEASED_STATUSES] },
    productType,
    ...notHiddenWhere,
    ...yearFilter,
    ...(effectiveAvailability === "available" && AVAILABLE_FILTER),
    ...(effectiveAvailability === "soldout" && { NOT: AVAILABLE_FILTER }),
    ...(designer && { designer: { equals: designer, mode: "insensitive" as const } }),
    // Vendor filter = "this vendor stocks it right now".
    ...(vendor && {
      kits: {
        some: {
          type: "BASE" as const,
          vendorKits: {
            some: {
              price: { not: null },
              inStock: true,
              vendor: { slug: vendor },
            },
          },
        },
      },
    }),
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

  const releasedWhere = { status: { in: [...RELEASED_STATUSES] }, productType, ...notHiddenWhere };

  const needRates = priceSort || savingsSort || page === 1;
  const usdRates: Record<string, number> = {};
  if (needRates) {
    const rateRows = await prisma.currency.findMany({
      select: { code: true, exchangeRateToUSD: true },
    });
    for (const r of rateRows) usdRates[r.code] = r.exchangeRateToUSD;
  }

  let data: unknown[];
  let total: number;

  if (priceSort || savingsSort) {
    const all = await prisma.groupBuy.findMany({
      where,
      include: PRICING_INCLUDE,
      take: RANKING_CAP,
    });
    let ranked = all
      .map((set) => ({ set, stats: priceStats(set as never, usdRates) }))
      .filter((r) => r.stats !== null);
    if (savingsSort) {
      // Spread % between priciest and cheapest vendor; single-vendor sets
      // have no spread, so they're excluded from this view. Child-kit rounds
      // (NordeUK addons, alphas-only) are too: their £35–55 kits compared
      // against full base kits produce meaningless 60%+ "savings".
      ranked = ranked
        .filter(
          (r) =>
            r.stats!.pricedVendors >= 2 &&
            r.stats!.maxUsd > 0 &&
            !/-addon$|alphas/.test((r.set as { slug: string }).slug)
        )
        .sort(
          (a, b) =>
            (b.stats!.maxUsd - b.stats!.minUsd) / b.stats!.maxUsd -
            (a.stats!.maxUsd - a.stats!.minUsd) / a.stats!.maxUsd
        );
    } else {
      ranked = ranked.sort((a, b) => a.stats!.minUsd - b.stats!.minUsd);
    }
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

  // Per-category released counts power the Keycaps / Keyboards tab badges.
  const baseReleased = { status: { in: [...RELEASED_STATUSES] }, ...notHiddenWhere };
  const [totalReleased, totalAvailable, countKeycaps, countKeyboards] = await Promise.all([
    prisma.groupBuy.count({ where: releasedWhere }),
    isKeyboard
      ? Promise.resolve(0)
      : prisma.groupBuy.count({ where: { ...releasedWhere, ...AVAILABLE_FILTER } }),
    prisma.groupBuy.count({ where: { ...baseReleased, productType: "KEYCAPS" } }),
    prisma.groupBuy.count({ where: { ...baseReleased, productType: "KEYBOARD" } }),
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

  // Vendors that stock at least one released set right now — for the filter
  // dropdown. Page 1 only, like topDesigners.
  let topVendors: Array<{ slug: string; name: string }> = [];
  if (page === 1) {
    topVendors = await prisma.vendor.findMany({
      where: {
        vendorKits: {
          some: {
            price: { not: null },
            inStock: true,
            kit: { type: "BASE", groupBuy: releasedWhere },
          },
        },
      },
      select: { slug: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  // "Biggest savings" deals rail (keycap-only — needs multi-vendor pricing)
  let deals: unknown[] = [];
  if (!isKeyboard && page === 1 && !search && !year && !designer && !vendor && availability !== "soldout") {
    const available = await prisma.groupBuy.findMany({
      where: { ...releasedWhere, ...AVAILABLE_FILTER },
      include: PRICING_INCLUDE,
      take: RANKING_CAP,
    });
    deals = available
      .map((set) => ({ set, stats: priceStats(set as never, usdRates) }))
      .filter(
        (r): r is { set: (typeof available)[number]; stats: NonNullable<ReturnType<typeof priceStats>> } =>
          r.stats !== null &&
          r.stats.pricedVendors >= 2 &&
          r.stats.maxUsd > 0 &&
          !/-addon$|alphas/.test(r.set.slug)
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

  return NextResponse.json({ data, total, page, limit, totalReleased, totalAvailable, countKeycaps, countKeyboards, deals, topDesigners, topVendors });
}
