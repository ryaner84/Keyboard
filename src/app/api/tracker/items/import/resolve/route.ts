import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { HIDDEN_SLUGS, notCustomWhere } from "@/lib/showcase";
import {
  buildKeycapSetIndex,
  resolveSetName,
  type ImportSetCandidate,
} from "@/lib/collection-import";
import {
  IMPORT_MAX_ROWS,
  type ImportRowPayload,
  type ImportSetSummary,
  type ResolveImportResponse,
  type ResolvedImportRow,
} from "@/lib/collection-import-types";

// Dry run for the CSV importer: match every row against the catalog and report
// what WOULD happen. Writes nothing — the collector reviews these results and
// only then calls /commit. Keeping resolve read-only is what makes the preview
// step trustworthy.
export const dynamic = "force-dynamic";

function toSummary(candidate: ImportSetCandidate): ImportSetSummary {
  return {
    slug: candidate.slug,
    name: candidate.name,
    imageUrl: candidate.imageUrl,
    designer: candidate.designer,
    status: candidate.status,
  };
}

export async function POST(req: NextRequest) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const rawRows = Array.isArray(body?.rows) ? (body.rows as ImportRowPayload[]) : null;
  if (!rawRows) {
    return NextResponse.json({ error: "No rows to import" }, { status: 400 });
  }
  if (rawRows.length > IMPORT_MAX_ROWS) {
    return NextResponse.json(
      {
        error: `That file has ${rawRows.length} rows — the limit is ${IMPORT_MAX_ROWS}. Split it and import in batches.`,
      },
      { status: 400 }
    );
  }

  // One query builds the whole index for the batch.
  const sets = await prisma.groupBuy.findMany({
    where: {
      productType: "KEYCAPS",
      ...notCustomWhere,
      ...(HIDDEN_SLUGS.length > 0 ? { slug: { notIn: HIDDEN_SLUGS } } : {}),
    },
    select: {
      slug: true,
      name: true,
      imageUrl: true,
      designer: true,
      status: true,
      gbStart: true,
    },
  });
  const index = buildKeycapSetIndex(sets as ImportSetCandidate[]);

  // What the collector already owns, so a row can be flagged before it is written.
  const owned = await prisma.trackerItem.findMany({
    where: { userId: user.id, inCollection: true },
    select: { keycapAcquisitions: true, groupBuy: { select: { slug: true } } },
  });
  const ownedBySlug = new Map(
    owned.map((item) => [
      item.groupBuy.slug,
      Array.isArray(item.keycapAcquisitions) ? item.keycapAcquisitions.length : 0,
    ])
  );

  const rows: ResolvedImportRow[] = rawRows.map((row) => {
    const name = String(row?.name ?? "").trim();
    const errors = Array.isArray(row?.errors) ? row.errors.filter(Boolean) : [];

    if (!name || errors.length > 0) {
      return {
        line: Number(row?.line) || 0,
        name,
        status: "INVALID",
        match: null,
        candidates: [],
        errors: errors.length > 0 ? errors : ["Missing set name"],
      };
    }

    const resolved = resolveSetName(name, index);
    if (!resolved.match) {
      return {
        line: row.line,
        name,
        status: "UNMATCHED",
        match: null,
        candidates: [],
        errors: [],
      };
    }

    const ownedCount = ownedBySlug.get(resolved.match.slug);
    const status = ownedCount !== undefined
      ? "ALREADY_IN_COLLECTION"
      : resolved.ambiguous
        ? "AMBIGUOUS"
        : "MATCHED";

    return {
      line: row.line,
      name,
      status,
      match: toSummary(resolved.match),
      candidates: resolved.candidates.map(toSummary),
      ...(ownedCount !== undefined ? { existingPurchaseCount: ownedCount } : {}),
      errors: [],
    };
  });

  const summary = {
    matched: rows.filter((row) => row.status === "MATCHED").length,
    needsReview: rows.filter(
      (row) => row.status === "AMBIGUOUS" || row.status === "UNMATCHED"
    ).length,
    alreadyOwned: rows.filter((row) => row.status === "ALREADY_IN_COLLECTION").length,
    invalid: rows.filter((row) => row.status === "INVALID").length,
  };

  const payload: ResolveImportResponse = { rows, summary };
  return NextResponse.json(payload);
}
