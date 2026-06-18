import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { verifyUnsubscribeToken } from "@/lib/tracker-auth";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const userId = verifyUnsubscribeToken(token);
  const redirectUrl = new URL("/tracker", getSiteUrl());

  if (!userId) {
    redirectUrl.searchParams.set("alerts", "invalid");
    return NextResponse.redirect(redirectUrl);
  }

  await prisma.trackerUser.updateMany({
    where: { id: userId },
    data: { alertsEnabled: false },
  });
  redirectUrl.searchParams.set("alerts", "off");
  return NextResponse.redirect(redirectUrl);
}
