import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SHOWCASE_VENDORS, HIDDEN_SLUGS, cleanDisplayName } from "@/lib/showcase";
import { deriveDesigner } from "@/lib/keyboard-designers";

export const dynamic = "force-dynamic";

// Facet endpoint for the Showcase designer filter. The maker isn't a stored
// column for scraped showcase boards, so we derive it from the (cleaned) board
// name across the whole keyboard set and return only designers that actually
// occur, with counts — keeping the filter chips data-driven, not a dead list.
export async function GET() {
  try {
    const rows = await prisma.groupBuy.findMany({
      where: {
        productType: "KEYBOARD",
        ...(HIDDEN_SLUGS.length > 0 && { slug: { notIn: HIDDEN_SLUGS } }),
      },
      select: { name: true, designer: true, vendorName: true },
    });

    const counts = new Map<string, number>();
    for (const row of rows) {
      // Showcase rows carry the source in the name — strip it before parsing so
      // "… — Lightning Keyboards" doesn't poison the match.
      const isShowcase = !!row.vendorName && SHOWCASE_VENDORS.includes(row.vendorName);
      const cleanName = isShowcase ? cleanDisplayName(row.name) : row.name;
      const designer = deriveDesigner(cleanName, row.designer);
      if (!designer) continue;
      counts.set(designer, (counts.get(designer) ?? 0) + 1);
    }

    const designers = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return NextResponse.json({ designers });
  } catch {
    return NextResponse.json({ designers: [] });
  }
}
