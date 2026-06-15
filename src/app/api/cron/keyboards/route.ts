import { NextRequest, NextResponse } from "next/server";
import { importAllKeyboardVendors } from "@/lib/import/keyboard-vendors";
import { importZFrontierKeyboards } from "@/lib/import/zfrontier";
import { importMatrixLabNotion } from "@/lib/import/matrixlab-notion";
import { ensureKeyboardSchema } from "@/lib/import/ensure-keyboard-schema";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Make sure the keyboard columns exist before any writes — the build-time
  // migration can silently skip when Vercel's build can't reach the DB.
  const schema = await ensureKeyboardSchema();

  // Run all three sources in parallel — each is independent.
  const [vendorResults, zfResult, matrixResult] = await Promise.all([
    importAllKeyboardVendors({ maxRuntimeMs: 45_000 }),
    importZFrontierKeyboards(),
    importMatrixLabNotion(),
  ]);

  const vendorSummary = vendorResults.reduce(
    (acc, r) => ({
      fetched: acc.fetched + r.fetched,
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      skipped: acc.skipped + r.skipped,
      errors: acc.errors + r.errors.length,
    }),
    { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 }
  );

  return NextResponse.json({
    ok: true,
    schema,
    vendors: vendorResults,
    vendorSummary,
    zfrontier: zfResult,
    matrixlab: matrixResult,
  });
}
