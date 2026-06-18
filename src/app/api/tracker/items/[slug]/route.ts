import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  await prisma.trackerItem.deleteMany({
    where: { userId: user.id, groupBuy: { slug } },
  });
  return NextResponse.json({ ok: true });
}
