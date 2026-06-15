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

  await prisma.listingReport.create({
    data: {
      slug: slug.slice(0, 200),
      name: name.slice(0, 200),
      issueType,
      notes: notes ? notes.slice(0, 1000) : null,
    },
  });

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
