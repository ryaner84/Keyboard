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

  const where = {
    ...(statuses.length > 0 && { status: { in: statuses } }),
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
        : { createdAt: "desc" as const };

  const [total, data] = await Promise.all([
    prisma.groupBuy.count({ where }),
    prisma.groupBuy.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: { kits: { select: { id: true, name: true, type: true } } },
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
