import { NextResponse } from "next/server";
import { TRACKER_SESSION_COOKIE } from "@/lib/tracker-auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(TRACKER_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: new Date(0),
    path: "/",
  });
  return response;
}
