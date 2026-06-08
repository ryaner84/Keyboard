import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAdminToken } from "@/lib/auth";
import { importGmkSets } from "@/lib/import/keycaplendar";
import { refreshPrices } from "@/lib/import/prices";

// Vercel Hobby caps serverless functions at 60s. The price scrape is time-boxed
// against the remaining budget below so the request always returns gracefully.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Wall-clock ceiling for the whole request, with a small margin under maxDuration.
const REQUEST_BUDGET_MS = 55_000;

async function isAdminAuthorized(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  return !!token && verifyAdminToken(token);
}

export async function POST(req: NextRequest) {
  if (!(await isAdminAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { skipImport, priceLimit } = await req.json().catch(() => ({}));

  try {
    const start = Date.now();
    const importResult = skipImport ? null : await importGmkSets();

    // Give the price scrape whatever time is left after the import so the two
    // together stay within the function limit.
    const remaining = REQUEST_BUDGET_MS - (Date.now() - start);
    const priceResult = await refreshPrices({
      limit: priceLimit ?? 200,
      maxAgeHours: 0,
      maxRuntimeMs: Math.max(5_000, remaining),
    });

    return NextResponse.json({
      ok: true,
      import: importResult,
      prices: priceResult,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
