import { NextRequest, NextResponse } from "next/server";
import { importGmkSets } from "@/lib/import/keycaplendar";
import { refreshPrices } from "@/lib/import/prices";
import { auditPrices } from "@/lib/import/price-audit";
import { enrichImagesFromGmk } from "@/lib/import/enrich-images";
import { applyVendorLinkOverrides, processVendorSuggestions } from "@/lib/import/vendor-overrides";
import { discoverGmkProducts } from "@/lib/import/discovery";

// Vercel Hobby caps serverless functions at 60s. We stay safely under that and
// let refreshPrices() time-box itself, so the run always returns gracefully.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Wall-clock ceiling for the whole request, with a small margin under maxDuration.
const REQUEST_BUDGET_MS = 55_000;

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
    const start = Date.now();
    // The import is diff-based (bulk reads + writes only for changed rows), so
    // it normally finishes in seconds; the budget is a safety net for first
    // runs or KeycapLendar slowness.
    const importResult = skipImport
      ? null
      : await importGmkSets({ maxRuntimeMs: REQUEST_BUDGET_MS * 0.6 });

    // Hand-curated vendor links + user-submitted suggestions become scrapeable
    // VendorKits before the price run (cheap DB-only work, a handful of rows).
    const overrides = await applyVendorLinkOverrides();
    const suggestions = await processVendorSuggestions();

    // Catalog discovery: walk a few vendors' own group-buy/catalog pages for
    // GMK listings and (re)link them to tracked sets. Oldest-scanned first, so
    // the whole roster is re-crawled every few days.
    const discovery = await discoverGmkProducts({
      vendorLimit: 6,
      maxRuntimeMs: Math.max(5_000, (REQUEST_BUDGET_MS - (Date.now() - start)) * 0.25),
    });

    // Give the price scrape whatever time is left in the budget after the import,
    // so import + scrape together never exceed the function limit.
    const remaining = REQUEST_BUDGET_MS - (Date.now() - start);
    const limitParam = req.nextUrl.searchParams.get("limit");
    // Split the remaining budget: most to prices, a slice to image enrichment.
    const priceResult = await refreshPrices({
      limit: limitParam ? Number(limitParam) : 1000,
      maxRuntimeMs: Math.max(5_000, remaining * 0.7),
    });

    // Accuracy check on everything stored (DB-only, fast): fixes prices that
    // don't match the BASE variant and purges implausible ones for re-scrape.
    const auditResult = await auditPrices({
      maxRuntimeMs: Math.max(2_000, (REQUEST_BUDGET_MS - (Date.now() - start)) * 0.4),
    });

    const imgBudget = REQUEST_BUDGET_MS - (Date.now() - start);
    const imageResult = await enrichImagesFromGmk({
      maxRuntimeMs: Math.max(3_000, imgBudget),
    });

    return NextResponse.json({
      ok: true,
      import: importResult,
      overrides,
      suggestions,
      discovery,
      prices: priceResult,
      audit: auditResult,
      images: imageResult,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
