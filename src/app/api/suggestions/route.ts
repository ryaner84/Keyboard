import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || !body.slug || !body.productUrl) {
    return NextResponse.json({ error: "slug and productUrl required" }, { status: 400 });
  }

  const productUrl = String(body.productUrl).trim();
  if (!/^https?:\/\//i.test(productUrl)) {
    return NextResponse.json({ error: "productUrl must be a valid https URL" }, { status: 400 });
  }

  await prisma.vendorSuggestion.create({
    data: {
      slug: String(body.slug).trim().slice(0, 200),
      productUrl: productUrl.slice(0, 500),
      vendorName: body.vendorName ? String(body.vendorName).trim().slice(0, 100) : null,
    },
  });

  return NextResponse.json({ ok: true });
}
