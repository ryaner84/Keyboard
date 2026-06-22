import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getTrackerSessionUser,
  trackerIpHash,
} from "@/lib/tracker-auth";
import { collectionPhotoAtBuild } from "@/lib/collection-photo";

export const dynamic = "force-dynamic";

const ISSUE_TYPES = new Set([
  "not_keyboard",
  "stolen",
  "offensive",
  "spam",
  "other",
]);
const MAX_REPORTS_PER_HOUR = 8;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const collectionSlug = String(body?.collectionSlug ?? "").trim().slice(0, 200);
  const trackerItemId = String(body?.trackerItemId ?? "").trim().slice(0, 200);
  const buildIndex = Number(body?.buildIndex);
  const issueType = String(body?.issueType ?? "").trim();
  const notes = String(body?.notes ?? "").trim().slice(0, 1000);

  if (
    !collectionSlug ||
    !trackerItemId ||
    !Number.isInteger(buildIndex) ||
    buildIndex < 0 ||
    buildIndex > 98 ||
    !ISSUE_TYPES.has(issueType)
  ) {
    return NextResponse.json({ error: "Invalid report" }, { status: 400 });
  }

  const item = await prisma.trackerItem.findFirst({
    where: {
      id: trackerItemId,
      inCollection: true,
      isPublic: true,
      user: {
        collectionSlug,
        collectionPublished: true,
      },
    },
    select: {
      id: true,
      customImageUrl: true,
      units: true,
    },
  });
  if (!item) {
    return NextResponse.json({ error: "Photo is no longer public" }, { status: 404 });
  }

  const photo = collectionPhotoAtBuild(
    item.customImageUrl,
    item.units,
    buildIndex
  );
  if (!photo) {
    return NextResponse.json({ error: "Photo is no longer available" }, { status: 404 });
  }

  const [reporter, ipHash] = await Promise.all([
    getTrackerSessionUser(),
    Promise.resolve(trackerIpHash(req.headers.get("x-forwarded-for"))),
  ]);
  const identityFilters = [
    ...(reporter ? [{ reporterUserId: reporter.id }] : []),
    ...(ipHash ? [{ reporterIpHash: ipHash }] : []),
  ];
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  if (identityFilters.length > 0) {
    const recentCount = await prisma.collectionPhotoReport.count({
      where: {
        submittedAt: { gte: hourAgo },
        OR: identityFilters,
      },
    });
    if (recentCount >= MAX_REPORTS_PER_HOUR) {
      return NextResponse.json(
        { error: "Too many reports. Please try again later." },
        { status: 429 }
      );
    }
  }

  const imageHash = createHash("sha256").update(photo).digest("hex");
  if (identityFilters.length > 0) {
    const duplicate = await prisma.collectionPhotoReport.findFirst({
      where: {
        trackerItemId,
        buildIndex,
        imageHash,
        OR: identityFilters,
      },
      select: { id: true },
    });
    if (duplicate) return NextResponse.json({ ok: true, duplicate: true });
  }

  await prisma.collectionPhotoReport.create({
    data: {
      trackerItemId,
      collectionSlug,
      buildIndex,
      imageHash,
      issueType,
      notes: notes || null,
      reporterIpHash: ipHash,
      reporterUserId: reporter?.id ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}
