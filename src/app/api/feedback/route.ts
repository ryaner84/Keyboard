import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Write-only: feedback is read directly in Supabase by the site owner; there
// is deliberately no GET endpoint.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = String(body?.email ?? "").trim();
  const subject = String(body?.subject ?? "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (!subject) {
    return NextResponse.json({ error: "Please write your feedback" }, { status: 400 });
  }

  await prisma.feedback.create({
    data: {
      email: email.slice(0, 200),
      subject: subject.slice(0, 2000),
    },
  });

  return NextResponse.json({ ok: true });
}
