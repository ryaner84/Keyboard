import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import {
  generateTrackerChallenge,
  normalizeTrackerEmail,
  trackerIpHash,
} from "@/lib/tracker-auth";
import { sendTrackerLoginEmail } from "@/lib/tracker-email";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = normalizeTrackerEmail(body?.email);
  if (!email) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const minuteAgo = new Date(now.getTime() - 60 * 1000);
  const ipHash = trackerIpHash(req.headers.get("x-forwarded-for"));
  const [hourlyCount, hourlyIpCount, recent] = await Promise.all([
    prisma.trackerAuthChallenge.count({
      where: { email, requestedAt: { gte: hourAgo } },
    }),
    ipHash
      ? prisma.trackerAuthChallenge.count({
          where: { ipHash, requestedAt: { gte: hourAgo } },
        })
      : Promise.resolve(0),
    prisma.trackerAuthChallenge.findFirst({
      where: { email, requestedAt: { gte: minuteAgo } },
      select: { id: true },
    }),
    prisma.trackerAuthChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    }),
  ]);

  if (hourlyCount >= 5 || hourlyIpCount >= 20) {
    return NextResponse.json(
      { error: "Too many codes requested. Try again in an hour." },
      { status: 429 }
    );
  }
  if (recent) {
    return NextResponse.json(
      { error: "A code was just sent. Please wait before requesting another." },
      { status: 429 }
    );
  }

  const challenge = generateTrackerChallenge();
  const pendingSlugs: string[] = Array.from(
    new Set(
      (Array.isArray(body?.slugs) ? body.slugs : [])
        .map((slug: unknown) => String(slug).trim())
        .filter(Boolean)
        .slice(0, 200)
    )
  );
  await prisma.trackerAuthChallenge.create({
    data: {
      email,
      magicTokenHash: challenge.magicTokenHash,
      otpHash: challenge.otpHash,
      expiresAt: challenge.expiresAt,
      ipHash,
      pendingSlugs,
      countryCode:
        typeof body?.countryCode === "string" ? body.countryCode.slice(0, 8) : null,
      region: typeof body?.region === "string" ? body.region.slice(0, 16) : null,
      currency: typeof body?.currency === "string" ? body.currency.slice(0, 8) : null,
    },
  });

  const magicUrl = `${getSiteUrl()}/api/auth/verify-link?token=${encodeURIComponent(
    challenge.magicToken
  )}`;

  try {
    await sendTrackerLoginEmail({
      email,
      magicUrl,
      otp: challenge.otp,
    });
    if (process.env.NODE_ENV !== "production" && !process.env.RESEND_API_KEY) {
      console.info(`[tracker-auth] Development magic link: ${magicUrl}`);
      console.info(`[tracker-auth] Development OTP for ${email}: ${challenge.otp}`);
    }
  } catch (error) {
    console.error("[tracker-auth] Login email failed", error);
    return NextResponse.json(
      { error: "We could not send the email. Please try again shortly." },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true, expiresIn: 600 });
}
