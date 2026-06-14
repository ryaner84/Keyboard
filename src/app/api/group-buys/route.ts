import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { verifyAdminToken } from "@/lib/auth";
import type { GBStatus } from "@/generated/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const statuses = searchParams.getAll("status") as GBStatus[];
  const search = searchParams.get("search") ?? "";
  const sortBy = searchParams.get("sort") ?? "date-desc";
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = parseInt(searchParams.get("limit") ?? "20");
  const finishing = searchParams.get("finishing"); // days until gbEnd
  const newDays = searchParams.get("new"); // days since gbStart
  const productType = searchParams.get("type"); // "KEYCAPS" | "KEYBOARD" | null (all)
  // Keyboard-specific spec filters (multi-value, OR within each group)
  const layouts = searchParams.getAll("layout");
  const mounts = searchParams.getAll("mount");
  const materialsParam = searchParams.getAll("material");

  const now = new Date();
  let dateFilter: Record<string, unknown> = {};
  if (finishing) {
    const end = new Date(now.getTime() + Number(finishing) * 24 * 60 * 60 * 1000);
    dateFilter = { status: "ACTIVE_GB", gbEnd: { gte: now, lte: end } };
  } else if (newDays) {
    const start = new Date(now.getTime() - Number(newDays) * 24 * 60 * 60 * 1000);
    dateFilter = { status: "ACTIVE_GB", gbStart: { gte: start, lte: now } };
  }

  const where = {
    ...(statuses.length > 0 && { status: { in: statuses } }),
    ...dateFilter,
    ...(productType && { productType }),
    ...(layouts.length > 0 && { layout: { in: layouts } }),
    ...(mounts.length > 0 && { mountingStyle: { in: mounts } }),
    ...(materialsParam.length > 0 && { material: { in: materialsParam } }),
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
      : sortBy === "date-asc"
        ? { createdAt: "asc" as const }
        : sortBy === "ending-soon"
          ? { gbEnd: "asc" as const }
          : { createdAt: "desc" as const };

  const [total, data] = await Promise.all([
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
  ]);

  return NextResponse.json({ data, total, page, limit });
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  if (!token || !verifyAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const groupBuy = await prisma.groupBuy.create({ data: body });
  return NextResponse.json(groupBuy, { status: 201 });
}
