import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { CUSTOM_SLUG_PREFIX } from "@/lib/showcase";

const NAME_MAX = 120;

// Add an off-catalog "custom" piece to the owner's collection. When the catalog
// search finds no match, the user can still record something they own. It's
// backed by a private GroupBuy whose `custom-…` slug keeps it out of every
// public catalog surface (enforced in the group-buys / released / search
// queries and the /sets detail page). It is NEVER a tracked group buy — just a
// collection record — so it carries no vendors, prices, or alerts.
export async function POST(req: NextRequest) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, NAME_MAX);
  const productType =
    String(body?.productType ?? "").toUpperCase() === "KEYBOARD"
      ? "KEYBOARD"
      : "KEYCAPS";
  if (!name) {
    return NextResponse.json({ error: "Please enter a name" }, { status: 400 });
  }

  const slug = `${CUSTOM_SLUG_PREFIX}${randomUUID()}`;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const groupBuy = await tx.groupBuy.create({
        data: {
          slug,
          name,
          designer: "",
          // Owned, off-catalog — a terminal status; never shown publicly anyway.
          status: "DELIVERED",
          productType,
        },
        select: { id: true, slug: true },
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
      return groupBuy;
    });

    return NextResponse.json({ ok: true, slug: created.slug }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Could not add this custom piece" },
      { status: 500 }
    );
  }
}

// Deploy trigger: re-run production build so the custom-piece route ships.
