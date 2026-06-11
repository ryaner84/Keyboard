import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Post-group-buy catalog: sets whose run has finished (shipping, delivered,
// or sitting in stock at vendors). The defining question for this section is
// "can I still buy it?", so rows can be filtered by live availability — a set
// counts as available when at least one vendor has a scraped/manual price on
// the BASE kit and stock.
const RELEASED_STATUSES = ["SHIPPING", "DELIVERED", "IN_STOCK"] as const;

const AVAILABLE_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: { some: { price: { not: null }, inStock: true } },
    },
  },
};

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

  const where = {
    status: { in: [...RELEASED_STATUSES] },
    ...yearFilter,
    ...(availability === "available" && AVAILABLE_FILTER),
    ...(availability === "soldout" && { NOT: AVAILABLE_FILTER }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { designer: { contains: search, mode: "insensitive" as const } },
        { colorway: { contains: search, mode: "insensitive" as const } },
      ],
    }),
  };

  // Release date = gbEnd. Sets without one sort to the end either way.
  const orderBy =
    sortBy === "name"
      ? { name: "asc" as const }
      : sortBy === "released-asc"
        ? { gbEnd: { sort: "asc" as const, nulls: "last" as const } }
        : { gbEnd: { sort: "desc" as const, nulls: "last" as const } };

  const releasedWhere = { status: { in: [...RELEASED_STATUSES] } };
  const [total, data, totalReleased, totalAvailable] = await Promise.all([
    prisma.groupBuy.count({ where }),
    prisma.groupBuy.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        kits: {
          include: {
            vendorKits: {
              include: { vendor: { include: { shippingZones: true } } },
            },
          },
        },
      },
    }),
    // Section-wide stats for the hero, independent of active filters.
    prisma.groupBuy.count({ where: releasedWhere }),
    prisma.groupBuy.count({ where: { ...releasedWhere, ...AVAILABLE_FILTER } }),
  ]);

  return NextResponse.json({ data, total, page, limit, totalReleased, totalAvailable });
}
