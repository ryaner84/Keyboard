import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { cleanCollectionPhoto } from "@/lib/collection-photo";
import { isCustomSlug } from "@/lib/showcase";
import type { CollectionUnit, KeycapAcquisition, KeycapKitSelection, KeycapPairing } from "@/types";

const CONDITIONS = new Set(["UNBUILT", "EXCELLENT", "GOOD", "FAIR", "PROJECT"]);
const KEYCAP_CONDITIONS = new Set([
  "SEALED",
  "OPEN_UNUSED",
  "MOUNTED",
  "USED",
  "INCOMPLETE",
]);

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
    hiddenBuilds?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    switches?: string | null;
    keycaps?: string | null;
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

function cleanKeycapAcquisition(
  value: unknown,
  knownKits: Map<string, { name: string; type: string }>
): KeycapAcquisition {
  const source = (value ?? {}) as Record<string, unknown>;
  const id = cleanIdentifier(source.id) || randomUUID();
  const kits = cleanKeycapKits(source.kits, knownKits);
  const quantity = Math.max(1, Math.min(99, Math.floor(Number(source.quantity) || 1)));
  const acquiredAt = cleanKeycapDate(source.acquiredAt);
  const purchasePrice = cleanUnitPrice(source.purchasePrice);
  const purchaseCurrency = cleanUnitCurrency(source.purchaseCurrency);
  const condition = cleanKeycapCondition(source.condition);
  const imageUrl = cleanCollectionPhoto(source.imageUrl);
  if (source.imageUrl && !imageUrl) {
    throw new Error("Invalid keycap photo");
  }
  const photoSource = source.photoSource === "CUSTOM" && imageUrl ? "CUSTOM" : "CATALOG";
  return {
    id,
    kits,
    quantity,
    acquiredAt,
    purchasePrice,
    purchaseCurrency,
    condition,
    imageUrl,
    photoSource,
    notes: cleanOptionalText(source.notes, 1000),
    isPublic: source.isPublic !== false,
    pairing: cleanKeycapPairing(source.pairing),
  };
}

function cleanIdentifier(value: unknown): string | null {
  const id = String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  return id || null;
}

function cleanKeycapKits(
  value: unknown,
  knownKits: Map<string, { name: string; type: string }>
): KeycapKitSelection[] {
  const raw = Array.isArray(value) ? value.slice(0, 12) : [];
  const seen = new Set<string>();
  const kits = raw
    .map((kit) => {
      const source = (kit ?? {}) as Record<string, unknown>;
      const requestedId = cleanIdentifier(source.kitId);
      if (requestedId) {
        const catalogKit = knownKits.get(requestedId);
        if (!catalogKit) throw new Error("A selected kit no longer belongs to this keycap set");
        if (seen.has(`catalog:${requestedId}`)) return null;
        seen.add(`catalog:${requestedId}`);
        return { kitId: requestedId, name: catalogKit.name, type: catalogKit.type || "" };
      }
      const name = cleanOptionalText(source.name, 80);
      if (!name) return null;
      const key = `custom:${name.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        kitId: null,
        name,
        type: cleanOptionalText(source.type, 50) || "",
      };
    })
    .filter((kit): kit is KeycapKitSelection => Boolean(kit));

  return kits.length > 0
    ? kits
    : [{ kitId: null, name: "Set / kits not specified", type: "" }];
}

function cleanKeycapDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid acquisition date for one of the keycap purchases");
  }
  return date.toISOString();
}

function cleanKeycapCondition(value: unknown): KeycapAcquisition["condition"] {
  const condition = String(value ?? "").trim().toUpperCase();
  if (!condition) return null;
  if (!KEYCAP_CONDITIONS.has(condition)) {
    throw new Error("Invalid keycap condition");
  }
  return condition as KeycapAcquisition["condition"];
}

function cleanKeycapPairing(value: unknown): KeycapPairing {
  if (value == null) return null;
  const source = value as Record<string, unknown>;
  if (source.kind === "collection") {
    const keyboardSlug = String(source.keyboardSlug ?? "").trim().slice(0, 160);
    const buildIndex = Number(source.buildIndex);
    if (!keyboardSlug || !Number.isInteger(buildIndex) || buildIndex < 0 || buildIndex > 98) {
      throw new Error("Choose a valid keyboard build to pair with this keycap purchase");
    }
    return {
      kind: "collection",
      keyboardSlug,
      buildIndex,
      showPublic: source.showPublic === true,
    };
  }
  if (source.kind === "free_text") {
    const label = cleanOptionalText(source.label, 120);
    if (!label) throw new Error("Enter the keyboard name for the free-text pairing");
    return { kind: "free_text", label, showPublic: source.showPublic === true };
  }
  throw new Error("Invalid keyboard pairing");
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
