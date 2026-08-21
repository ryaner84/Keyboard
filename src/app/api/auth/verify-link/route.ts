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
  const redirectUrl = new URL("/collection", getSiteUrl());
  try {
    const token = req.nextUrl.searchParams.get("token") ?? "";
    const challenge = token ? await consumeMagicChallenge(token) : null;

    if (!challenge) {
      redirectUrl.searchParams.set("auth", "expired");
      return NextResponse.redirect(redirectUrl);
    }

    // The token is spent by the line above — the same one-shot problem the OTP
    // route has. A throw past this point used to surface as a raw error page
    // with the link already burnt, so the user could not retry it.
    const user = await findOrCreateTrackerUser(challenge.email);

    // Convenience, not authentication: never let it cost the session.
    try {
      await syncTrackerSlugsForUser({
        userId: user.id,
        slugs: challenge.pendingSlugs,
        countryCode: challenge.countryCode,
        region: challenge.region,
        currency: challenge.currency,
      });
    } catch (syncError) {
      console.error("auth/verify-link: slug sync failed after a valid link", syncError);
    }

    redirectUrl.searchParams.set("auth", "verified");
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.set(
      TRACKER_SESSION_COOKIE,
      createTrackerSessionToken(user),
      trackerSessionCookieOptions()
    );
    return response;
  } catch (error) {
    // Land them back on /collection with a message rather than an error page.
    console.error("auth/verify-link failed", error);
    redirectUrl.searchParams.set("auth", "error");
    return NextResponse.redirect(redirectUrl);
  }
}
