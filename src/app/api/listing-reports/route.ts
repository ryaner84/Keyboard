import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const VALID_ISSUE_TYPES = [
  "wrong_category",
  "wrong_price",
  "inactive",
  "duplicate",
  "wrong_vendor",
  "other",
] as const;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? "").trim();
  const name = String(body?.name ?? "").trim();
  const issueType = String(body?.issueType ?? "").trim();
  const notes = String(body?.notes ?? "").trim();

  if (!slug || !name || !(VALID_ISSUE_TYPES as readonly string[]).includes(issueType)) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    await prisma.listingReport.create({
      data: {
        slug: slug.slice(0, 200),
        name: name.slice(0, 200),
        issueType,
        notes: notes ? notes.slice(0, 1000) : null,
      },
    });
  } catch (err) {
    // Most likely the ListingReport table is missing (created on deploy by
    // scripts/db-setup.mjs). Log it so the cause is visible in the server logs
    // and return a clean 500 instead of an unhandled throw.
    console.error("[listing-reports] failed to save report:", err);
    return NextResponse.json({ error: "Could not save report" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// Owner's daily review feed — returns the 100 most recent reports.
export async function GET() {
  const reports = await prisma.listingReport.findMany({
    orderBy: { submittedAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ reports });
}
