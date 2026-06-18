import "server-only";

import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { createUnsubscribeToken } from "@/lib/tracker-auth";
import { sendTrackerEmail } from "@/lib/tracker-email";
import { getUsdRates, trackerSnapshotFromGroupBuy } from "@/lib/tracker-data";

interface PendingEvent {
  userId: string;
  trackerItemId: string;
  type: string;
  title: string;
  body: string;
  fingerprint: string;
}

function fingerprint(parts: Array<string | number | null | undefined>): string {
  return crypto.createHash("sha256").update(parts.join(":")).digest("hex");
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    INTEREST_CHECK: "Interest Check",
    ACTIVE_GB: "Group Buy Open",
    SHIPPING: "Shipping",
    DELIVERED: "Delivered",
    IN_STOCK: "In Stock",
    CANCELLED: "Cancelled",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

export async function processTrackerNotifications() {
  const [items, rates] = await Promise.all([
    prisma.trackerItem.findMany({
      where: {
        alertsEnabled: true,
        user: { alertsEnabled: true },
      },
      include: {
        user: true,
        groupBuy: {
          include: {
            kits: {
              include: {
                vendorKits: { include: { vendor: true } },
              },
            },
            devUpdates: { orderBy: { postedAt: "desc" }, take: 1 },
          },
        },
      },
    }),
    getUsdRates(),
  ]);

  const events: PendingEvent[] = [];
  const now = Date.now();

  for (const item of items) {
    const current = trackerSnapshotFromGroupBuy(item.groupBuy, rates);
    const name = item.groupBuy.name;
    const statusBecameStock =
      item.lastStatus !== current.lastStatus && current.lastStatus === "IN_STOCK";

    if (item.lastStatus && item.lastStatus !== current.lastStatus) {
      const type =
        current.lastStatus === "ACTIVE_GB"
          ? "group_buy_open"
          : current.lastStatus === "IN_STOCK"
            ? "restock"
            : "status_change";
      events.push({
        userId: item.userId,
        trackerItemId: item.id,
        type,
        title:
          type === "group_buy_open"
            ? `${name} is open`
            : type === "restock"
              ? `${name} is in stock`
              : `${name} moved to ${statusLabel(current.lastStatus)}`,
        body: `Status changed from ${statusLabel(item.lastStatus)} to ${statusLabel(current.lastStatus)}.`,
        fingerprint: fingerprint([
          item.userId,
          item.groupBuyId,
          type,
          item.lastStatus,
          current.lastStatus,
        ]),
      });
    }

    if (current.lastStatus === "ACTIVE_GB" && item.groupBuy.gbEnd) {
      const daysLeft = Math.ceil((item.groupBuy.gbEnd.getTime() - now) / 86_400_000);
      if (daysLeft >= 0 && daysLeft <= 7) {
        events.push({
          userId: item.userId,
          trackerItemId: item.id,
          type: "closing_soon",
          title: `${name} closes ${daysLeft === 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`}`,
          body: "The group-buy window is almost over.",
          fingerprint: fingerprint([
            item.userId,
            item.groupBuyId,
            "closing_soon",
            item.groupBuy.gbEnd.toISOString().slice(0, 10),
          ]),
        });
      }
    }

    if (
      item.lastBestPriceUsd != null &&
      current.lastBestPriceUsd != null &&
      item.lastBestPriceUsd - current.lastBestPriceUsd >= 10 &&
      current.lastBestPriceUsd <= item.lastBestPriceUsd * 0.95
    ) {
      const percent = Math.round(
        ((item.lastBestPriceUsd - current.lastBestPriceUsd) / item.lastBestPriceUsd) * 100
      );
      events.push({
        userId: item.userId,
        trackerItemId: item.id,
        type: "price_drop",
        title: `${name} dropped about ${percent}%`,
        body: `The best tracked price moved from about US$${Math.round(
          item.lastBestPriceUsd
        )} to US$${Math.round(current.lastBestPriceUsd)} before shipping.`,
        fingerprint: fingerprint([
          item.userId,
          item.groupBuyId,
          "price_drop",
          Math.round(current.lastBestPriceUsd),
        ]),
      });
    }

    if (current.lastVendorCount > item.lastVendorCount && !statusBecameStock) {
      const added = current.lastVendorCount - item.lastVendorCount;
      events.push({
        userId: item.userId,
        trackerItemId: item.id,
        type: item.lastVendorCount === 0 ? "restock" : "new_vendor",
        title:
          item.lastVendorCount === 0
            ? `${name} is available`
            : `${name} has ${added} new vendor${added === 1 ? "" : "s"}`,
        body: `${current.lastVendorCount} live vendor listing${current.lastVendorCount === 1 ? " is" : "s are"} now tracked.`,
        fingerprint: fingerprint([
          item.userId,
          item.groupBuyId,
          "vendor_count",
          current.lastVendorCount,
        ]),
      });
    }

    if (
      current.lastDevUpdateAt &&
      (!item.lastDevUpdateAt || current.lastDevUpdateAt > item.lastDevUpdateAt)
    ) {
      const latest = item.groupBuy.devUpdates[0];
      events.push({
        userId: item.userId,
        trackerItemId: item.id,
        type: "development_update",
        title: `${name}: ${latest?.title ?? "new development update"}`,
        body: latest?.content?.slice(0, 240) || "A new development milestone was posted.",
        fingerprint: fingerprint([
          item.userId,
          item.groupBuyId,
          "development_update",
          current.lastDevUpdateAt.toISOString(),
        ]),
      });
    }

    await prisma.trackerItem.update({
      where: { id: item.id },
      data: current,
    });
  }

  if (events.length > 0) {
    await prisma.trackerNotification.createMany({
      data: events,
      skipDuplicates: true,
    });
  }

  const delivered = await deliverPendingTrackerNotifications();
  return { checked: items.length, detected: events.length, delivered };
}

export async function deliverPendingTrackerNotifications(): Promise<number> {
  const pending = await prisma.trackerNotification.findMany({
    where: { sentAt: null, user: { alertsEnabled: true } },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: {
      user: true,
      trackerItem: {
        include: { groupBuy: { select: { slug: true, name: true } } },
      },
    },
  });

  type PendingNotification = (typeof pending)[number];
  const byUser = new Map<string, PendingNotification[]>();
  for (const notification of pending) {
    const list = byUser.get(notification.userId) ?? [];
    list.push(notification);
    byUser.set(notification.userId, list);
  }

  let delivered = 0;
  for (const notifications of Array.from(byUser.values())) {
    const user = notifications[0].user;
    const visible = notifications.slice(0, 20);
    const unsubscribeUrl = `${getSiteUrl()}/api/tracker/unsubscribe?token=${encodeURIComponent(
      createUnsubscribeToken(user.id)
    )}`;
    const rows = visible
      .map((notification: PendingNotification) => {
        const slug = notification.trackerItem?.groupBuy.slug;
        const href = slug ? `${getSiteUrl()}/sets/${encodeURIComponent(slug)}` : `${getSiteUrl()}/tracker`;
        return `
          <li style="margin:0 0 18px">
            <a href="${escapeHtml(href)}" style="font-weight:700;color:#4338ca;text-decoration:none">${escapeHtml(notification.title)}</a>
            <div style="margin-top:4px;color:#4b5563;line-height:1.5">${escapeHtml(notification.body)}</div>
          </li>
        `;
      })
      .join("");

    try {
      await sendTrackerEmail({
        to: user.email,
        subject:
          visible.length === 1
            ? visible[0].title
            : `${visible.length} updates from your GMK Tracker`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827">
            <h1 style="font-size:22px">Your tracker changed</h1>
            <ul style="padding-left:20px">${rows}</ul>
            <p style="margin-top:28px">
              <a href="${getSiteUrl()}/tracker" style="display:inline-block;background:#4f46e5;color:white;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Open my tracker</a>
            </p>
            <p style="margin-top:28px;font-size:12px;color:#9ca3af">
              These are utility alerts for items you tracked.
              <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">Turn off tracker alerts</a>.
            </p>
          </div>
        `,
      });
      await prisma.trackerNotification.updateMany({
        where: {
          id: {
            in: visible.map((notification: PendingNotification) => notification.id),
          },
        },
        data: { sentAt: new Date() },
      });
      delivered += visible.length;
    } catch (error) {
      console.error(`[tracker-notifications] Delivery failed for ${user.email}`, error);
    }
  }

  return delivered;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        char
      ] ?? char
  );
}
