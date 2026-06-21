import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Slim global search for the header palette: every set, any status, no
// pricing joins — fast enough to hit on every keystroke (debounced client-side).
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  const limit = Math.min(
    48,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 8) || 8)
  );

  const results = await prisma.groupBuy.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { colorway: { contains: q, mode: "insensitive" } },
        { designer: { contains: q, mode: "insensitive" } },
        { vendorName: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      slug: true,
      name: true,
      designer: true,
      status: true,
      imageUrl: true,
      productType: true,
    },
    orderBy: { name: "asc" },
    take: limit,
  });

  return NextResponse.json({ results });
}
