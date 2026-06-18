import "server-only";

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

const SESSION_COOKIE = "tracker_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function secret(): string {
  return process.env.TRACKER_AUTH_SECRET || process.env.JWT_SECRET || "dev-tracker-secret";
}

export function normalizeTrackerEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

export function hashTrackerValue(value: string): string {
  return crypto.createHash("sha256").update(`${secret()}:${value}`).digest("hex");
}

export function generateTrackerChallenge() {
  const magicToken = crypto.randomBytes(32).toString("base64url");
  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  return {
    magicToken,
    magicTokenHash: hashTrackerValue(magicToken),
    otp,
    otpHash: hashTrackerValue(otp),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  };
}

export function trackerIpHash(forwardedFor: string | null): string | null {
  const ip = forwardedFor?.split(",")[0]?.trim();
  return ip ? hashTrackerValue(ip) : null;
}

export function createTrackerSessionToken(user: { id: string; email: string }): string {
  return jwt.sign({ sub: user.id, email: user.email, kind: "tracker" }, secret(), {
    expiresIn: SESSION_MAX_AGE_SECONDS,
  });
}

export function trackerSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  };
}

export async function getTrackerSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, secret()) as {
      sub?: string;
      kind?: string;
    };
    if (payload.kind !== "tracker" || !payload.sub) return null;
    return prisma.trackerUser.findUnique({ where: { id: payload.sub } });
  } catch {
    return null;
  }
}

export async function consumeMagicChallenge(token: string) {
  const now = new Date();
  const challenge = await prisma.trackerAuthChallenge.findUnique({
    where: { magicTokenHash: hashTrackerValue(token) },
  });
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) return null;

  const consumed = await prisma.trackerAuthChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  return consumed.count === 1 ? challenge : null;
}

export async function verifyOtpChallenge(email: string, otp: string) {
  const now = new Date();
  const challenge = await prisma.trackerAuthChallenge.findFirst({
    where: { email, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { requestedAt: "desc" },
  });
  if (!challenge || challenge.attempts >= 5) return null;

  if (challenge.otpHash !== hashTrackerValue(otp)) {
    await prisma.trackerAuthChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    return null;
  }

  const consumed = await prisma.trackerAuthChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  return consumed.count === 1 ? challenge : null;
}

export async function findOrCreateTrackerUser(email: string) {
  const now = new Date();
  return prisma.trackerUser.upsert({
    where: { email },
    update: { verifiedAt: now },
    create: { email, verifiedAt: now },
  });
}

export function createUnsubscribeToken(userId: string): string {
  return jwt.sign({ sub: userId, kind: "tracker-unsubscribe" }, secret(), {
    expiresIn: "365d",
  });
}

export function verifyUnsubscribeToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, secret()) as { sub?: string; kind?: string };
    return payload.kind === "tracker-unsubscribe" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export const TRACKER_SESSION_COOKIE = SESSION_COOKIE;
