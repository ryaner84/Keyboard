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
  try {
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

    // The code is CONSUMED by the line above, so from here on a thrown error
    // is unrecoverable for the user: retyping the same correct code would be
    // rejected as "invalid or expired", which is exactly the dead end this
    // handler used to produce.
    const user = await findOrCreateTrackerUser(challenge.email);

    // Identity is proven. Syncing the slugs someone tracked before signing in
    // is a convenience, not part of authentication — so a failure here must
    // not cost them the session their (now spent) code paid for. Logged, not
    // thrown; the next page load re-syncs anyway.
    try {
      await syncTrackerSlugsForUser({
        userId: user.id,
        slugs: challenge.pendingSlugs,
        countryCode: challenge.countryCode,
        region: challenge.region,
        currency: challenge.currency,
      });
    } catch (syncError) {
      console.error("auth/verify: slug sync failed after a valid code", syncError);
    }

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
  } catch (error) {
    // An unhandled throw here returns an EMPTY body, and the client parses the
    // response as JSON — which is where "Unexpected end of JSON input" came
    // from, a message that tells the user nothing they can act on. Always
    // answer with JSON, and say what to do next.
    console.error("auth/verify failed", error);
    return NextResponse.json(
      {
        error:
          "Something went wrong signing you in. Request a new code and try again.",
      },
      { status: 500 }
    );
  }
}
