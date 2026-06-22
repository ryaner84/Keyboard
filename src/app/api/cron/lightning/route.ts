import { NextRequest, NextResponse } from "next/server";
import { importLightning } from "@/lib/import/lightning";

// Vercel Hobby caps serverless functions at 60s. Stay safely under that.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const REQUEST_BUDGET_MS = 50_000;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

// Scrape lightningkeyboards.com build showcase into the catalog. Idempotent and
// resumable — hit it repeatedly to finish a large first backfill; the summary's
// `stoppedEarly` flag says whether more remains. Safe to run as a daily cron.
//
// Ad-hoc verification:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//        https://<site>/api/cron/lightning
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await importLightning({ maxRuntimeMs: REQUEST_BUDGET_MS });
    return NextResponse.json({ ok: true, lightning: result, ranAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
