import { NextRequest, NextResponse } from "next/server";
import { getTrackerSessionUser } from "@/lib/tracker-auth";
import { syncTrackerSlugsForUser } from "@/lib/tracker-data";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getTrackerSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const rawSlugs: unknown[] = Array.isArray(body?.slugs) ? body.slugs : [];
  const slugs: string[] = Array.from(
    new Set(
      rawSlugs
        .map((slug: unknown) => String(slug).trim())
        .filter(Boolean)
        .slice(0, 200)
    )
  );

  const syncedSlugs = await syncTrackerSlugsForUser({
    userId: user.id,
    slugs,
    countryCode: typeof body?.countryCode === "string" ? body.countryCode : null,
    region: typeof body?.region === "string" ? body.region : null,
    currency: typeof body?.currency === "string" ? body.currency : null,
  });
  return NextResponse.json({ ok: true, slugs: syncedSlugs });
}
