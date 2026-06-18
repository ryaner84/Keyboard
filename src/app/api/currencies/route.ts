import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getExchangeRates } from "@/lib/currency";
import { processTrackerNotifications } from "@/lib/tracker-notifications";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "true";

  if (force) {
    if (!isAuthorizedCron(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    await prisma.currency.updateMany({
      data: { lastUpdated: new Date(0) },
    });
  }

  const rates = await getExchangeRates();
  const trackerNotifications = force ? await processTrackerNotifications() : null;
  return NextResponse.json({ rates, trackerNotifications });
}
