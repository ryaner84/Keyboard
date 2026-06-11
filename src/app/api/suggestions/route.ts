import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processVendorSuggestions } from "@/lib/import/vendor-overrides";
import { refreshPrices } from "@/lib/import/prices";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || !body.slug || !body.productUrl) {
    return NextResponse.json({ error: "slug and productUrl required" }, { status: 400 });
  }

  const productUrl = String(body.productUrl).trim();
  if (!/^https?:\/\//i.test(productUrl)) {
    return NextResponse.json({ error: "productUrl must be a valid https URL" }, { status: 400 });
  }

  await prisma.vendorSuggestion.create({
    data: {
      slug: String(body.slug).trim().slice(0, 200),
      productUrl: productUrl.slice(0, 500),
      vendorName: body.vendorName ? String(body.vendorName).trim().slice(0, 100) : null,
    },
  });

  // Process inline so the vendor shows up as soon as the user refreshes the
  // page, instead of waiting for the nightly run. Best-effort: if the link or
  // the price fetch fails here (store blocks us, slow page…), the suggestion
  // row and the null priceUpdatedAt put it first in line for the nightly
  // refresh anyway.
  let linkedNow = false;
  try {
    const { linked, vendorKitIds } = await processVendorSuggestions();
    linkedNow = linked > 0;
    if (vendorKitIds.length > 0) {
      await refreshPrices({ ids: vendorKitIds, maxRuntimeMs: 15_000 });
    }
  } catch {
    // nightly cron is the backstop
  }

  return NextResponse.json({ ok: true, linkedNow });
}
