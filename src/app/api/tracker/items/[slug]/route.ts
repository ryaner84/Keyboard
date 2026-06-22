import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { cleanCollectionPhoto } from "@/lib/collection-photo";
import type { CollectionUnit } from "@/types";

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
    color?: string | null;
    quantity?: number;
    customImageUrl?: string | null;
    units?: Prisma.InputJsonValue;
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
  if ("color" in body) data.color = cleanOptionalText(body.color, 80);
  if (typeof body.quantity === "number" && Number.isInteger(body.quantity)) {
    data.quantity = Math.max(1, Math.min(99, body.quantity));
  }
  if ("customImageUrl" in body) {
    const photo = cleanCollectionPhoto(body.customImageUrl);
    if (body.customImageUrl && !photo) {
      return NextResponse.json({ error: "Invalid keyboard photo" }, { status: 400 });
    }
    data.customImageUrl = photo;
  }
  if ("units" in body) {
    const raw: unknown[] = Array.isArray(body.units) ? body.units.slice(0, 49) : [];
    if (
      raw.some((unit) => {
        const imageUrl =
          unit && typeof unit === "object"
            ? (unit as Record<string, unknown>).imageUrl
            : null;
        return Boolean(imageUrl) && !cleanCollectionPhoto(imageUrl);
      })
    ) {
      return NextResponse.json({ error: "Invalid keyboard photo" }, { status: 400 });
    }
    try {
      data.units = raw.map(cleanUnit) as unknown as Prisma.InputJsonValue;
    } catch (unitError) {
      return NextResponse.json(
        {
          error:
            unitError instanceof Error
              ? unitError.message
              : "Invalid build purchase details",
        },
        { status: 400 }
      );
    }
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
      color: updated.color,
      quantity: updated.quantity,
      customImageUrl: updated.customImageUrl,
      units: Array.isArray(updated.units) ? updated.units : [],
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

function cleanCondition(value: unknown): string | null {
  const c = String(value ?? "").toUpperCase();
  return c && CONDITIONS.has(c) ? c : null;
}

function cleanUnit(u: unknown): CollectionUnit {
  const o = (u ?? {}) as Record<string, unknown>;
  return {
    acquiredAt: cleanUnitDate(o.acquiredAt),
    purchasePrice: cleanUnitPrice(o.purchasePrice),
    purchaseCurrency: cleanUnitCurrency(o.purchaseCurrency),
    color: cleanOptionalText(o.color, 80),
    condition: cleanCondition(o.condition),
    switches: cleanOptionalText(o.switches, 160),
    keycaps: cleanOptionalText(o.keycaps, 160),
    buildDetails: cleanOptionalText(o.buildDetails, 500),
    notes: cleanOptionalText(o.notes, 1000),
    imageUrl: cleanCollectionPhoto(o.imageUrl),
  };
}

function cleanUnitDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid acquisition date for one of the builds");
  }
  return date.toISOString();
}

function cleanUnitPrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 10_000_000) {
    throw new Error("Invalid purchase price for one of the builds");
  }
  return price;
}

function cleanUnitCurrency(value: unknown): string | null {
  const currency = String(value ?? "").trim().toUpperCase().slice(0, 8);
  return currency || null;
}
