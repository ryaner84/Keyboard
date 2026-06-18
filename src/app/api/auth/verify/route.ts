import { NextRequest, NextResponse } from "next/server";
import {
  createTrackerSessionToken,
  findOrCreateTrackerUser,
  normalizeTrackerEmail,
  trackerSessionCookieOptions,
  verifyOtpChallenge,
  TRACKER_SESSION_COOKIE,
} from "@/lib/tracker-auth";
import { syncTrackerSlugsForUser } from "@/lib/tracker-data";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = normalizeTrackerEmail(body?.email);
  const otp = String(body?.otp ?? "").replace(/\D/g, "").slice(0, 6);
  if (!email || otp.length !== 6) {
    return NextResponse.json({ error: "Enter the 6-digit code" }, { status: 400 });
  }

  const challenge = await verifyOtpChallenge(email, otp);
  if (!challenge) {
    return NextResponse.json(
      { error: "That code is invalid or expired" },
      { status: 401 }
    );
  }

  const user = await findOrCreateTrackerUser(challenge.email);
  await syncTrackerSlugsForUser({
    userId: user.id,
    slugs: challenge.pendingSlugs,
    countryCode: challenge.countryCode,
    region: challenge.region,
    currency: challenge.currency,
  });
  const response = NextResponse.json({
    ok: true,
    user: { email: user.email, alertsEnabled: user.alertsEnabled },
  });
  response.cookies.set(
    TRACKER_SESSION_COOKIE,
    createTrackerSessionToken(user),
    trackerSessionCookieOptions()
  );
  return response;
}
