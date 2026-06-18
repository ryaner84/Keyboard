import { NextResponse } from "next/server";
import { getTrackerSessionUser } from "@/lib/tracker-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getTrackerSessionUser();
  if (!user) return NextResponse.json({ authenticated: false });

  return NextResponse.json({
    authenticated: true,
    user: {
      email: user.email,
      alertsEnabled: user.alertsEnabled,
      countryCode: user.countryCode,
      region: user.region,
      currency: user.currency,
    },
  });
}
