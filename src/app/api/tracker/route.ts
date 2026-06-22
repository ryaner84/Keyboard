import { NextRequest, NextResponse } from "next/server";
import { ensureCollectionSlug, getTrackerSessionUser } from "@/lib/tracker-auth";
import { getTrackerItemsForUser } from "@/lib/tracker-data";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await getTrackerItemsForUser(user.id);
  return NextResponse.json({
    user: {
      email: user.email,
      alertsEnabled: user.alertsEnabled,
      displayName: user.displayName,
      collectionTitle: user.collectionTitle,
      collectionBio: user.collectionBio,
      collectionPublished: user.collectionPublished,
      collectionSlug: user.collectionSlug,
    },
    data: items.map((item) => ({
      ...item.groupBuy,
      collection: {
        isTracking: item.isTracking,
        inCollection: item.inCollection,
        isPublic: item.isPublic,
        acquiredAt: item.acquiredAt,
        condition: item.condition,
        purchasePrice: item.purchasePrice,
        purchaseCurrency: item.purchaseCurrency,
        showPurchasePrice: item.showPurchasePrice,
        switches: item.switches,
        keycaps: item.keycaps,
        buildDetails: item.buildDetails,
        notes: item.notes,
        displayOrder: item.displayOrder,
        color: item.color,
        quantity: item.quantity ?? 1,
        customImageUrl: item.customImageUrl ?? null,
        units: Array.isArray(item.units) ? item.units : [],
      },
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const data: {
    alertsEnabled?: boolean;
    countryCode?: string;
    region?: string;
    currency?: string;
    displayName?: string | null;
    collectionTitle?: string | null;
    collectionBio?: string | null;
    collectionPublished?: boolean;
  } = {};
  if (typeof body?.alertsEnabled === "boolean") data.alertsEnabled = body.alertsEnabled;
  if (typeof body?.countryCode === "string") data.countryCode = body.countryCode.slice(0, 8);
  if (typeof body?.region === "string") data.region = body.region.slice(0, 16);
  if (typeof body?.currency === "string") data.currency = body.currency.slice(0, 8);
  if ("displayName" in (body ?? {})) {
    data.displayName = cleanOptionalText(body.displayName, 80);
  }
  if ("collectionTitle" in (body ?? {})) {
    data.collectionTitle = cleanOptionalText(body.collectionTitle, 120);
  }
  if ("collectionBio" in (body ?? {})) {
    data.collectionBio = cleanOptionalText(body.collectionBio, 500);
  }
  if (typeof body?.collectionPublished === "boolean") {
    data.collectionPublished = body.collectionPublished;
  }

  const updated = await prisma.trackerUser.update({ where: { id: user.id }, data });
  const collectionSlug =
    updated.collectionPublished || body?.ensureCollectionSlug === true
      ? await ensureCollectionSlug(user.id)
      : updated.collectionSlug;

  return NextResponse.json({
    ok: true,
    user: {
      email: updated.email,
      alertsEnabled: updated.alertsEnabled,
      displayName: updated.displayName,
      collectionTitle: updated.collectionTitle,
      collectionBio: updated.collectionBio,
      collectionPublished: updated.collectionPublished,
      collectionSlug,
    },
  });
}

function cleanOptionalText(value: unknown, maxLength: number): string | null {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || null;
}
