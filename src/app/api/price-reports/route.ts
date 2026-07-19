import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// A report does not just sit in a triage table — it self-heals:
//  1. Every report re-queues the listing for re-scraping: clearing
//     priceUpdatedAt puts it at the FRONT of both scrape queues
//     (`ORDER BY priceUpdatedAt ASC NULLS FIRST`), so the GitHub Actions
//     6-hourly refresh or the nightly WorkSpace run re-verifies it next.
//  2. A second independent report within 7 days nulls the price immediately —
//     the row disappears from the site until a fresh scrape writes a verified
//     price. One report alone never hides a price (abuse resistance).
//  Manual prices are never touched; those are the owner's explicit overrides.
const CONFIRM_REPORTS = 2;
const REPORT_WINDOW_DAYS = 7;

// Review feed: PENDING reports with the listing's current state, so the
// report-review routine (or a workflow log step) can read them through the
// live site even when GitHub has no direct DB credentials. Reports contain
// nothing sensitive — set slug, vendor name, optional reason.
//
// A report drops out of this feed once its job is done, so each scheduled
// review only sees genuinely open items instead of every historical report:
//  • the flagged bad price is gone (listing deleted or price nulled), or
//  • the listing was re-scraped AFTER the report was filed — the re-queue
//    worked and a fresh scrape re-verified the price. If that fresh price is
//    still wrong, a visitor re-report opens a new case (and its 2nd-report
//    auto-null still fires), so nothing wrong stays hidden for long.
// Resolution is stamped in resolvedAt — the same flag the visitor-inbox
// feed reads — rather than filtered per-read, so both feeds stay in step.
export async function GET() {
  const reports = await prisma.priceReport.findMany({
    where: { resolvedAt: null },
    orderBy: { submittedAt: "desc" },
    take: 50,
  });
  const vendorKits = await prisma.vendorKit.findMany({
    where: { id: { in: Array.from(new Set(reports.map((r) => r.vendorKitId))) } },
    select: {
      id: true,
      price: true,
      currency: true,
      priceSource: true,
      priceUpdatedAt: true,
      productUrl: true,
    },
  });
  const vkById = new Map(vendorKits.map((vk) => [vk.id, vk]));

  const resolvedIds = new Set(
    reports
      .filter((r) => {
        const vk = vkById.get(r.vendorKitId);
        if (!vk || vk.price == null) return true;
        return vk.priceUpdatedAt != null && vk.priceUpdatedAt > r.submittedAt;
      })
      .map((r) => r.id)
  );
  if (resolvedIds.size > 0) {
    try {
      await prisma.priceReport.updateMany({
        where: { id: { in: Array.from(resolvedIds) } },
        data: { resolvedAt: new Date() },
      });
    } catch {
      // The feed must render even if the resolution write fails; the same
      // reports simply resolve on the next read.
    }
  }

  return NextResponse.json({
    reports: reports
      .filter((r) => !resolvedIds.has(r.id))
      .map((r) => ({
        submittedAt: r.submittedAt,
        setSlug: r.setSlug,
        vendorName: r.vendorName,
        reason: r.reason,
        listing: vkById.get(r.vendorKitId) ?? null,
      })),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const setSlug = String(body?.setSlug ?? "").trim();
  const vendorKitId = String(body?.vendorKitId ?? "").trim();
  const vendorName = String(body?.vendorName ?? "").trim();
  const reason = String(body?.reason ?? "").trim();

  if (!setSlug || !vendorKitId || !vendorName) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  await prisma.priceReport.create({
    data: {
      setSlug: setSlug.slice(0, 200),
      vendorKitId: vendorKitId.slice(0, 200),
      vendorName: vendorName.slice(0, 200),
      reason: reason ? reason.slice(0, 1000) : null,
    },
  });

  // Auto-repair. Failures here must not fail the report submission.
  try {
    const vk = await prisma.vendorKit.findUnique({
      where: { id: vendorKitId },
      select: { id: true, priceSource: true },
    });
    if (vk && vk.priceSource !== "MANUAL") {
      const windowStart = new Date(Date.now() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const recentReports = await prisma.priceReport.count({
        where: { vendorKitId, submittedAt: { gte: windowStart } },
      });

      await prisma.vendorKit.update({
        where: { id: vendorKitId },
        data: {
          // Front of the scrape queue on the next run.
          priceUpdatedAt: null,
          // Confirmed wrong (2+ reports): hide until a fresh scrape verifies.
          ...(recentReports >= CONFIRM_REPORTS ? { price: null } : {}),
        },
      });
    }
  } catch {
    // report stored; repair will happen via the normal scrape rotation
  }

  return NextResponse.json({ ok: true });
}
