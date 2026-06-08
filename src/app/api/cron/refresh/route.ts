import { NextRequest, NextResponse } from "next/server";
import { importGmkSets } from "@/lib/import/keycaplendar";
import { refreshPrices } from "@/lib/import/prices";

// Allow up to 300s on Pro, falls back to 60s on Hobby — importing + scraping takes time.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // allow in dev only
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const skipImport = req.nextUrl.searchParams.get("skipImport") === "true";

  try {
    const importResult = skipImport ? null : await importGmkSets();
    const limitParam = req.nextUrl.searchParams.get("limit");
    const priceResult = await refreshPrices({ limit: limitParam ? Number(limitParam) : 200 });

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
