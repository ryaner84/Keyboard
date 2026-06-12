import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const setSlug = String(body?.setSlug ?? "").trim();
  const vendorKitId = String(body?.vendorKitId ?? "").trim();
  const vendorName = String(body?.vendorName ?? "").trim();
  const reason = String(body?.reason ?? "").trim();

  if (!setSlug || !vendorKitId || !vendorName) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  await prisma.priceReport.create({
    data: {
      setSlug: setSlug.slice(0, 200),
      vendorKitId: vendorKitId.slice(0, 200),
      vendorName: vendorName.slice(0, 200),
      reason: reason ? reason.slice(0, 1000) : null,
    },
  });

  return NextResponse.json({ ok: true });
}
