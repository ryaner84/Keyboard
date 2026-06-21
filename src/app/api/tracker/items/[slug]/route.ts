import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";

const CONDITIONS = new Set(["UNBUILT", "EXCELLENT", "GOOD", "FAIR", "PROJECT"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const item = await prisma.trackerItem.findFirst({
    where: { userId: user.id, groupBuy: { slug } },
    select: { id: true, isTracking: true, inCollection: true },
  });
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const data: {
    isTracking?: boolean;
    inCollection?: boolean;
    isPublic?: boolean;
    acquiredAt?: Date | null;
    condition?: string | null;
    purchasePrice?: number | null;
    purchaseCurrency?: string | null;
    showPurchasePrice?: boolean;
    switches?: string | null;
    keycaps?: string | null;
    buildDetails?: string | null;
    notes?: string | null;
    displayOrder?: number;
  } = {};

  if (typeof body.isTracking === "boolean") data.isTracking = body.isTracking;
  if (typeof body.inCollection === "boolean") data.inCollection = body.inCollection;
  if (typeof body.isPublic === "boolean") data.isPublic = body.isPublic;
  if ("acquiredAt" in body) {
    if (!body.acquiredAt) {
      data.acquiredAt = null;
    } else {
      const acquiredAt = new Date(String(body.acquiredAt));
      if (Number.isNaN(acquiredAt.getTime())) {
        return NextResponse.json({ error: "Invalid acquisition date" }, { status: 400 });
      }
      data.acquiredAt = acquiredAt;
    }
  }
  if ("condition" in body) {
    const condition = String(body.condition ?? "").toUpperCase();
    data.condition = condition && CONDITIONS.has(condition) ? condition : null;
  }
  if ("purchasePrice" in body) {
    if (body.purchasePrice === null || body.purchasePrice === "") {
      data.purchasePrice = null;
    } else {
      const purchasePrice = Number(body.purchasePrice);
      if (!Number.isFinite(purchasePrice) || purchasePrice < 0 || purchasePrice > 10_000_000) {
        return NextResponse.json({ error: "Invalid purchase price" }, { status: 400 });
      }
      data.purchasePrice = purchasePrice;
    }
  }
  if ("purchaseCurrency" in body) {
    const currency = String(body.purchaseCurrency ?? "").trim().toUpperCase().slice(0, 8);
    data.purchaseCurrency = currency || null;
  }
  if (typeof body.showPurchasePrice === "boolean") {
    data.showPurchasePrice = body.showPurchasePrice;
  }
  if ("switches" in body) data.switches = cleanOptionalText(body.switches, 160);
  if ("keycaps" in body) data.keycaps = cleanOptionalText(body.keycaps, 160);
  if ("buildDetails" in body) data.buildDetails = cleanOptionalText(body.buildDetails, 500);
  if ("notes" in body) data.notes = cleanOptionalText(body.notes, 1000);
  if (Number.isInteger(body.displayOrder)) {
    data.displayOrder = Math.max(0, Math.min(10_000, body.displayOrder));
  }

  const willBeInCollection = data.inCollection ?? item.inCollection;
  if (!willBeInCollection) {
    data.isPublic = false;
    data.showPurchasePrice = false;
  }
  const willBeTracking = data.isTracking ?? item.isTracking;
  if (!willBeTracking && !willBeInCollection) {
    await prisma.trackerItem.delete({ where: { id: item.id } });
    return NextResponse.json({ ok: true, deleted: true });
  }

  const updated = await prisma.trackerItem.update({
    where: { id: item.id },
    data,
  });

  return NextResponse.json({
    ok: true,
    collection: {
      isTracking: updated.isTracking,
      inCollection: updated.inCollection,
      isPublic: updated.isPublic,
      acquiredAt: updated.acquiredAt,
      condition: updated.condition,
      purchasePrice: updated.purchasePrice,
      purchaseCurrency: updated.purchaseCurrency,
      showPurchasePrice: updated.showPurchasePrice,
      switches: updated.switches,
      keycaps: updated.keycaps,
      buildDetails: updated.buildDetails,
      notes: updated.notes,
      displayOrder: updated.displayOrder,
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const item = await prisma.trackerItem.findFirst({
    where: { userId: user.id, groupBuy: { slug } },
    select: { id: true, inCollection: true },
  });
  if (!item) return NextResponse.json({ ok: true });

  if (item.inCollection) {
    await prisma.trackerItem.update({
      where: { id: item.id },
      data: { isTracking: false, alertsEnabled: false },
    });
  } else {
    await prisma.trackerItem.delete({ where: { id: item.id } });
  }
  return NextResponse.json({ ok: true });
}

function cleanOptionalText(value: unknown, maxLength: number): string | null {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || null;
}
