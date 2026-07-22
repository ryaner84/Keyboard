import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { verifyAdminToken } from "@/lib/auth";

// Read-only counts for the site owner. Admin-cookie gated, same as the other
// /api/admin/* routes. Every TrackerUser is an email-verified account (verifiedAt
// is required), so `users` is the real signed-up count.
export const dynamic = "force-dynamic";

async function isAuthorized(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  return !!token && verifyAdminToken(token);
}

export async function GET() {
  if (!(await isAuthorized())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [users, publishedCollections, engaged, trackedItems, alertsOn] =
    await Promise.all([
      prisma.trackerUser.count(),
      prisma.trackerUser.count({ where: { collectionPublished: true } }),
      // Distinct users who have added at least one tracked/collected item.
      prisma.trackerItem
        .groupBy({ by: ["userId"] })
        .then((rows) => rows.length),
      prisma.trackerItem.count(),
      prisma.trackerUser.count({ where: { alertsEnabled: true } }),
    ]);

  return NextResponse.json({
    users,
    usersWithItems: engaged,
    publishedCollections,
    trackedItems,
    alertsEnabled: alertsOn,
    generatedAt: new Date().toISOString(),
  });
}
