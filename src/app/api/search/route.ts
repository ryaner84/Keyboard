import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SHOWCASE_VENDORS, HIDDEN_SLUGS, notCustomWhere } from "@/lib/showcase";

// Slim global search for the header palette: every set, any status, no
// pricing joins — fast enough to hit on every keystroke (debounced client-side).
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  const limit = Math.min(
    48,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 8) || 8)
  );

  const terms = q.split(/\s+/).filter(Boolean);
  const fieldOR = (term: string) => ({
    OR: [
      { name: { contains: term, mode: "insensitive" as const } },
      { colorway: { contains: term, mode: "insensitive" as const } },
      { designer: { contains: term, mode: "insensitive" as const } },
      { vendorName: { contains: term, mode: "insensitive" as const } },
    ],
  });
  const searchWhere =
    terms.length === 1 ? fieldOR(terms[0]) : { AND: terms.map(fieldOR) };
  // Keep Lightning Keyboards (showcase-only) out of the global palette, but
  // preserve rows with no vendor (NULL would otherwise be dropped by notIn).
  const where = {
    AND: [
      searchWhere,
      {
        OR: [
          { vendorName: null },
          { vendorName: { notIn: SHOWCASE_VENDORS } },
        ],
      },
      ...(HIDDEN_SLUGS.length > 0 ? [{ slug: { notIn: HIDDEN_SLUGS } }] : []),
      // Custom collection pieces are private — never in global search.
      notCustomWhere,
    ],
  };

  const results = await prisma.groupBuy.findMany({
    where,
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
