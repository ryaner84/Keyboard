import { NextRequest, NextResponse } from "next/server";
import { importGmkSets } from "@/lib/import/keycaplendar";
import { refreshPrices } from "@/lib/import/prices";

// Allow up to 60s — importing + scraping takes time.
export const maxDuration = 60;
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
    const priceResult = await refreshPrices({ limit: 40 });

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
