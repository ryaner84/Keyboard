import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { cleanCollectionPhoto } from "@/lib/collection-photo";
import { isCustomSlug } from "@/lib/showcase";
// Keycap purchase validation is shared with the CSV batch importer — one
// definition of what a stored acquisition may contain.
import {
  cleanKeycapAcquisition,
  cleanOptionalText,
  cleanSaleDate,
  cleanSaleFields,
  cleanSalePrice,
  cleanUnitCurrency,
  cleanUnitPrice,
} from "@/lib/keycap-acquisition-server";
import type { CollectionUnit, KeycapAcquisition, KeycapPairing } from "@/types";

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
    select: {
      id: true,
      isTracking: true,
      inCollection: true,
      groupBuy: {
        select: {
          productType: true,
          kits: { select: { id: true, name: true, type: true } },
        },
      },
    },
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
    isSold?: boolean;
    soldAt?: Date | null;
    soldPrice?: number | null;
    soldCurrency?: string | null;
    showSoldStatus?: boolean;
    hiddenBuilds?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    switches?: string | null;
    keycaps?: string | null;
    plateType?: string | null;
    mountType?: string | null;
    buildDetails?: string | null;
    notes?: string | null;
    displayOrder?: number;
    color?: string | null;
    quantity?: number;
    customImageUrl?: string | null;
    units?: Prisma.InputJsonValue;
    keycapAcquisitions?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
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
  // Build 1's sale record. Reuses the same sanitizers as the per-unit records
  // in `units` so the two paths can never diverge on what they accept.
  if (typeof body.isSold === "boolean") data.isSold = body.isSold;
  if ("soldAt" in body) {
    const iso = cleanSaleDate(body.soldAt);
    data.soldAt = iso ? new Date(iso) : null;
  }
  if ("soldPrice" in body) data.soldPrice = cleanSalePrice(body.soldPrice);
  if ("soldCurrency" in body) data.soldCurrency = cleanUnitCurrency(body.soldCurrency);
  if (typeof body.showSoldStatus === "boolean") {
    data.showSoldStatus = body.showSoldStatus;
  }
  if ("hiddenBuilds" in body) {
    // Build indexes (0-based) excluded from the public page — lets an owner
    // publish only selected units of a multi-unit piece. Owner-supplied;
    // sanitize to a bounded, deduped int list. Empty → null (all shown).
    const cleaned = Array.isArray(body.hiddenBuilds)
      ? Array.from(
          new Set(
            (body.hiddenBuilds as unknown[])
              .map((n) => Number(n))
              .filter((n) => Number.isInteger(n) && n >= 0 && n < 99)
          )
        ).sort((a, b) => a - b)
      : [];
    data.hiddenBuilds =
      cleaned.length > 0 ? (cleaned as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
  }
  if ("switches" in body) data.switches = cleanOptionalText(body.switches, 160);
  if ("keycaps" in body) data.keycaps = cleanOptionalText(body.keycaps, 160);
  if ("plateType" in body) data.plateType = cleanOptionalText(body.plateType, 160);
  if ("mountType" in body) data.mountType = cleanOptionalText(body.mountType, 160);
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
      return NextResponse.json({ error: "Invalid collection photo" }, { status: 400 });
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
  if ("keycapAcquisitions" in body) {
    if (item.groupBuy.productType === "KEYBOARD") {
      return NextResponse.json(
        { error: "Keycap purchase records can only be added to keycap sets" },
        { status: 400 }
      );
    }
    const raw: unknown[] = Array.isArray(body.keycapAcquisitions)
      ? body.keycapAcquisitions.slice(0, 50)
      : [];
    try {
      const knownKits = new Map(
        item.groupBuy.kits.map((kit) => [kit.id, { name: kit.name, type: kit.type }])
      );
      const acquisitions = raw.map((acquisition) =>
        cleanKeycapAcquisition(acquisition, knownKits)
      );
      await validateKeycapPairings(user.id, acquisitions);
      data.keycapAcquisitions = acquisitions as unknown as Prisma.InputJsonValue;
    } catch (acquisitionError) {
      return NextResponse.json(
        {
          error:
            acquisitionError instanceof Error
              ? acquisitionError.message
              : "Invalid keycap purchase details",
        },
        { status: 400 }
      );
    }
  }

  const willBeInCollection = data.inCollection ?? item.inCollection;
  if (!willBeInCollection) {
    data.isPublic = false;
    data.showPurchasePrice = false;
    // Sold state is a fact about the piece and is kept; only the decision to
    // PUBLISH it resets, exactly like the other two publication switches.
    data.showSoldStatus = false;
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
      isSold: updated.isSold,
      soldAt: updated.soldAt,
      soldPrice: updated.soldPrice,
      soldCurrency: updated.soldCurrency,
      showSoldStatus: updated.showSoldStatus,
      switches: updated.switches,
      keycaps: updated.keycaps,
      plateType: updated.plateType,
      mountType: updated.mountType,
      buildDetails: updated.buildDetails,
      notes: updated.notes,
      displayOrder: updated.displayOrder,
      color: updated.color,
      quantity: updated.quantity,
      customImageUrl: updated.customImageUrl,
      units: Array.isArray(updated.units) ? updated.units : [],
      hiddenBuilds: Array.isArray(updated.hiddenBuilds) ? updated.hiddenBuilds : [],
      keycapAcquisitions: Array.isArray(updated.keycapAcquisitions)
        ? updated.keycapAcquisitions
        : [],
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
    select: { id: true, inCollection: true, groupBuyId: true },
  });
  if (!item) return NextResponse.json({ ok: true });

  // A custom (off-catalog) piece exists solely for this owner: deleting it
  // removes the backing private GroupBuy too (the TrackerItem goes with it via
  // cascade). Without this, "removing" a custom piece left it orphaned — not
  // tracked, not in the collection, but forever occupying its name in the DB.
  if (isCustomSlug(slug)) {
    await prisma.groupBuy.delete({ where: { id: item.groupBuyId } });
    return NextResponse.json({ ok: true });
  }

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
    plateType: cleanOptionalText(o.plateType, 160),
    mountType: cleanOptionalText(o.mountType, 160),
    buildDetails: cleanOptionalText(o.buildDetails, 500),
    notes: cleanOptionalText(o.notes, 1000),
    imageUrl: cleanCollectionPhoto(o.imageUrl),
    ...cleanSaleFields(o),
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

async function validateKeycapPairings(userId: string, acquisitions: KeycapAcquisition[]) {
  const pairings = acquisitions
    .map((acquisition) => acquisition.pairing)
    .filter((pairing): pairing is Extract<KeycapPairing, { kind: "collection" }> =>
      pairing?.kind === "collection"
    );
  if (pairings.length === 0) return;

  const slugs = Array.from(new Set(pairings.map((pairing) => pairing.keyboardSlug)));
  const targets = await prisma.trackerItem.findMany({
    where: {
      userId,
      inCollection: true,
      groupBuy: { productType: "KEYBOARD", slug: { in: slugs } },
    },
    select: { quantity: true, groupBuy: { select: { slug: true } } },
  });
  const targetBySlug = new Map(
    targets.map((target) => [target.groupBuy.slug, Math.max(1, target.quantity || 1)])
  );
  for (const pairing of pairings) {
    const quantity = targetBySlug.get(pairing.keyboardSlug);
    if (!quantity || pairing.buildIndex >= quantity) {
      throw new Error("The paired keyboard build is no longer in your collection");
    }
  }
}
