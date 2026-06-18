import { NextRequest, NextResponse } from "next/server";
import { getSiteUrl } from "@/lib/site-url";
import {
  consumeMagicChallenge,
  createTrackerSessionToken,
  findOrCreateTrackerUser,
  trackerSessionCookieOptions,
  TRACKER_SESSION_COOKIE,
} from "@/lib/tracker-auth";
import { syncTrackerSlugsForUser } from "@/lib/tracker-data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const challenge = token ? await consumeMagicChallenge(token) : null;
  const redirectUrl = new URL("/tracker", getSiteUrl());

  if (!challenge) {
    redirectUrl.searchParams.set("auth", "expired");
    return NextResponse.redirect(redirectUrl);
  }

  const user = await findOrCreateTrackerUser(challenge.email);
  await syncTrackerSlugsForUser({
    userId: user.id,
    slugs: challenge.pendingSlugs,
    countryCode: challenge.countryCode,
    region: challenge.region,
    currency: challenge.currency,
  });
  redirectUrl.searchParams.set("auth", "verified");
  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set(
    TRACKER_SESSION_COOKIE,
    createTrackerSessionToken(user),
    trackerSessionCookieOptions()
  );
  return response;
}
