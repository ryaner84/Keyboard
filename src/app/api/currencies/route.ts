import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getExchangeRates } from "@/lib/currency";

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "true";

  if (force) {
    await prisma.currency.updateMany({
      data: { lastUpdated: new Date(0) },
    });
  }

  const rates = await getExchangeRates();
  return NextResponse.json({ rates });
}
