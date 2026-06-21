import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { getGroupBuyForTracking, getUsdRates, trackerSnapshotFromGroupBuy } from "@/lib/tracker-data";

export async function POST(req: NextRequest) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? "").trim();
  if (!slug) return NextResponse.json({ error: "Missing slug" }, { status: 400 });

  const [groupBuy, rates] = await Promise.all([getGroupBuyForTracking(slug), getUsdRates()]);
  if (!groupBuy) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.trackerItem.upsert({
    where: { userId_groupBuyId: { userId: user.id, groupBuyId: groupBuy.id } },
    update: { isTracking: true, alertsEnabled: true },
    create: {
      userId: user.id,
      groupBuyId: groupBuy.id,
      ...trackerSnapshotFromGroupBuy(groupBuy, rates),
    },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
