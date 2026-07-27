import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { CUSTOM_SLUG_PREFIX } from "@/lib/showcase";
import { cleanKeycapAcquisition } from "@/lib/keycap-acquisition-server";
import { getTrackerSnapshot } from "@/lib/tracker-data";
import {
  IMPORT_MAX_ROWS,
  type CommitImportResponse,
  type ImportDecision,
  type ImportRowPayload,
} from "@/lib/collection-import-types";
import type { KeycapAcquisition } from "@/types";

// Applies the decisions the collector confirmed on the review screen. Rows are
// processed SEQUENTIALLY and each is wrapped on its own, so one bad row reports
// a failure instead of aborting the batch — and so a file listing the same set
// twice sees its own first write (reported as already-collected, not duplicated).
export const dynamic = "force-dynamic";

const NAME_MAX = 120;
const MAX_ACQUISITIONS = 50;

// Imported purchases follow fixed product defaults: the price is private and
// the set is publicly displayable unless the collector flipped the master
// "keep everything private" toggle on the review screen.
const SHOW_PURCHASE_PRICE = false;

function buildAcquisition(row: ImportRowPayload): KeycapAcquisition {
  // CSV kits are always free-text (kitId: null) — the same shape the in-app kit
  // picker writes. Passing an empty catalog-kit map is therefore safe and keeps
  // cleanKeycapKits from ever throwing "kit no longer belongs to this set".
  return cleanKeycapAcquisition(
    {
      kits: row.kits.map((name) => ({ kitId: null, name, type: "" })),
      quantity: row.quantity,
      acquiredAt: row.acquiredAt,
      purchasePrice: row.price,
      purchaseCurrency: row.currency,
      condition: row.condition,
      notes: row.notes,
      isPublic: true,
      pairing: null,
    },
    new Map()
  );
}

export async function POST(req: NextRequest) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const decisions = Array.isArray(body?.decisions)
    ? (body.decisions as ImportDecision[])
    : null;
  if (!decisions) {
    return NextResponse.json({ error: "Nothing to import" }, { status: 400 });
  }
  if (decisions.length > IMPORT_MAX_ROWS) {
    return NextResponse.json(
      { error: `Too many rows — the limit is ${IMPORT_MAX_ROWS}.` },
      { status: 400 }
    );
  }
  const isPublic = body?.allPrivate !== true;

  const results: CommitImportResponse["results"] = [];
  const summary = { added: 0, appended: 0, replaced: 0, ignored: 0, failed: 0 };

  for (const decision of decisions) {
    const line = Number(decision?.line) || 0;
    const row = decision?.row;
    const name = String(row?.name ?? "").trim();

    if (!decision || decision.action === "IGNORE") {
      summary.ignored++;
      results.push({ line, ok: true, name, action: "IGNORE" });
      continue;
    }

    try {
      if (!name) throw new Error("Missing set name");

      const acquisition = buildAcquisition(row);
      let slug: string;
      let created = false;

      if (decision.action === "CUSTOM") {
        // Mint a private off-catalog piece, mirroring /api/tracker/items/custom.
        slug = `${CUSTOM_SLUG_PREFIX}${randomUUID()}`;
        await prisma.$transaction(async (tx) => {
          const groupBuy = await tx.groupBuy.create({
            data: {
              slug,
              name: name.slice(0, NAME_MAX),
              designer: "",
              status: "DELIVERED",
              productType: "KEYCAPS",
            },
            select: { id: true },
          });
          await tx.trackerItem.create({
            data: {
              userId: user.id,
              groupBuyId: groupBuy.id,
              inCollection: true,
              isTracking: false,
              alertsEnabled: false,
            },
          });
        });
        created = true;
      } else {
        slug = String(decision.slug ?? "").trim();
        if (!slug) throw new Error("No set chosen for this row");
      }

      const groupBuy = await prisma.groupBuy.findUnique({
        where: { slug },
        select: { id: true, productType: true },
      });
      if (!groupBuy) throw new Error("That set is no longer in the catalog");
      if (groupBuy.productType === "KEYBOARD") {
        throw new Error("That entry is a keyboard, not a keycap set");
      }

      const existing = await prisma.trackerItem.findFirst({
        where: { userId: user.id, groupBuyId: groupBuy.id },
        select: { id: true, inCollection: true, keycapAcquisitions: true },
      });

      const previous: KeycapAcquisition[] =
        existing && Array.isArray(existing.keycapAcquisitions)
          ? (existing.keycapAcquisitions as unknown as KeycapAcquisition[])
          : [];
      const alreadyCollected = Boolean(existing?.inCollection) && previous.length > 0;
      const replace = decision.onExisting === "REPLACE";

      const next = replace || !alreadyCollected ? [acquisition] : [...previous, acquisition];
      if (next.length > MAX_ACQUISITIONS) {
        throw new Error(
          `That set already has ${previous.length} purchases (limit ${MAX_ACQUISITIONS})`
        );
      }

      const data = {
        inCollection: true,
        isPublic,
        showPurchasePrice: SHOW_PURCHASE_PRICE,
        keycapAcquisitions: next as unknown as Prisma.InputJsonValue,
      };

      if (existing) {
        await prisma.trackerItem.update({ where: { id: existing.id }, data });
      } else {
        // First time this catalog set enters the collection — seed the pricing
        // snapshot the same way POST /api/tracker/items does.
        const snapshot = await getTrackerSnapshot(groupBuy.id);
        await prisma.trackerItem.create({
          data: {
            userId: user.id,
            groupBuyId: groupBuy.id,
            isTracking: false,
            alertsEnabled: false,
            ...(snapshot ?? {}),
            ...data,
          },
        });
      }

      if (created) summary.added++;
      else if (alreadyCollected && replace) summary.replaced++;
      else if (alreadyCollected) summary.appended++;
      else summary.added++;

      results.push({
        line,
        ok: true,
        name,
        slug,
        action: created ? "CUSTOM" : alreadyCollected ? (replace ? "REPLACE" : "APPEND") : "LINK",
      });
    } catch (error) {
      summary.failed++;
      results.push({
        line,
        ok: false,
        name,
        action: decision?.action ?? "LINK",
        error: error instanceof Error ? error.message : "Could not import this row",
      });
    }
  }

  const payload: CommitImportResponse = { results, summary };
  return NextResponse.json(payload);
}
