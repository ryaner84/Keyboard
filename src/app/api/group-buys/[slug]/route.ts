import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { verifyAdminToken } from "@/lib/auth";
import type { Region } from "@/generated/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const region = (req.nextUrl.searchParams.get("region") ?? "SG") as Region;

  const groupBuy = await prisma.groupBuy.findUnique({
    where: { slug },
    include: {
      kits: {
        include: {
          vendorKits: {
            include: {
              vendor: {
                include: {
                  shippingZones: {
                    where: { destinationRegion: region },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!groupBuy) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(groupBuy);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  if (!token || !verifyAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const body = await req.json();
  const groupBuy = await prisma.groupBuy.update({ where: { slug }, data: body });
  return NextResponse.json(groupBuy);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  if (!token || !verifyAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  await prisma.groupBuy.delete({ where: { slug } });
  return NextResponse.json({ success: true });
}
