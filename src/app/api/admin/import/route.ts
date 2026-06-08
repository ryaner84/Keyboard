import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAdminToken } from "@/lib/auth";
import { importGmkSets } from "@/lib/import/keycaplendar";
import { refreshPrices } from "@/lib/import/prices";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

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
    const importResult = skipImport ? null : await importGmkSets();
    const priceResult = await refreshPrices({ limit: priceLimit ?? 200, maxAgeHours: 0 });

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
