import { NextRequest, NextResponse } from "next/server";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { getTrackerItemsForUser } from "@/lib/tracker-data";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await getTrackerItemsForUser(user.id);
  return NextResponse.json({
    user: { email: user.email, alertsEnabled: user.alertsEnabled },
    data: items.map((item) => item.groupBuy),
  });
}

export async function PATCH(req: NextRequest) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const data: {
    alertsEnabled?: boolean;
    countryCode?: string;
    region?: string;
    currency?: string;
  } = {};
  if (typeof body?.alertsEnabled === "boolean") data.alertsEnabled = body.alertsEnabled;
  if (typeof body?.countryCode === "string") data.countryCode = body.countryCode.slice(0, 8);
  if (typeof body?.region === "string") data.region = body.region.slice(0, 16);
  if (typeof body?.currency === "string") data.currency = body.currency.slice(0, 8);

  const updated = await prisma.trackerUser.update({ where: { id: user.id }, data });
  return NextResponse.json({
    ok: true,
    user: { email: updated.email, alertsEnabled: updated.alertsEnabled },
  });
}
