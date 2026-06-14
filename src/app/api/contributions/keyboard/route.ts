import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const content = String(body?.content ?? "").trim();
  const handle = String(body?.handle ?? "").trim();

  if (!content || content.length < 5) {
    return NextResponse.json({ error: "Please share something — a URL or a short description." }, { status: 400 });
  }

  await (prisma as any).keyboardContribution.create({
    data: {
      content: content.slice(0, 2000),
      handle: handle ? handle.slice(0, 100) : null,
    },
  });

  return NextResponse.json({ ok: true });
}
