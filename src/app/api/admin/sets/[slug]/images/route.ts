import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAdminToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function isAdminAuthorized(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  return !!token && verifyAdminToken(token);
}

// Replace the image gallery for a set. Body: { images: string[] }.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (!(await isAdminAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.images)) {
    return NextResponse.json({ error: "images[] required" }, { status: 400 });
  }

  // Keep only well-formed http(s) URLs, trimmed and de-duplicated, order preserved.
  const images = Array.from(
    new Set(
      body.images
        .map((u: unknown) => (typeof u === "string" ? u.trim() : ""))
        .filter((u: string) => /^https?:\/\//i.test(u))
    )
  ) as string[];

  const existing = await prisma.groupBuy.findUnique({ where: { slug }, select: { id: true } });
  if (!existing) {
    return NextResponse.json({ error: "Set not found" }, { status: 404 });
  }

  await prisma.groupBuy.update({
    where: { slug },
    // Keep imageUrl (the hero/OG image) in sync with the first gallery image.
    data: { images, ...(images.length > 0 ? { imageUrl: images[0] } : {}) },
  });

  return NextResponse.json({ ok: true, images });
}
