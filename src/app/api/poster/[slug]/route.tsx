import { ImageResponse } from "@vercel/og";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { STATUS_LABELS } from "@/lib/utils";
import QRCode from "qrcode";
import type { GBStatus } from "@/generated/prisma";

export const runtime = "nodejs";

const STATUS_BG: Record<GBStatus, string> = {
  INTEREST_CHECK: "#e2e8f0",
  ACTIVE_GB: "#dcfce7",
  SHIPPING: "#dbeafe",
  DELIVERED: "#f3e8ff",
  IN_STOCK: "#fef3c7",
  CANCELLED: "#fee2e2",
};

const STATUS_FG: Record<GBStatus, string> = {
  INTEREST_CHECK: "#475569",
  ACTIVE_GB: "#15803d",
  SHIPPING: "#1d4ed8",
  DELIVERED: "#7e22ce",
  IN_STOCK: "#b45309",
  CANCELLED: "#b91c1c",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const country = req.nextUrl.searchParams.get("country") ?? "SG";
  const currency = req.nextUrl.searchParams.get("currency") ?? "SGD";
  const priceDisplay = req.nextUrl.searchParams.get("price") ?? "";

  const groupBuy = await prisma.groupBuy.findUnique({ where: { slug } });
  if (!groupBuy) {
    return new Response("Not found", { status: 404 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gmktracker.com";
  const setUrl = `${siteUrl}/sets/${slug}?country=${country}`;

  // Generate QR code as data URL
  const qrDataUrl = await QRCode.toDataURL(setUrl, {
    width: 180,
    margin: 2,
    color: { dark: "#1e293b", light: "#ffffff" },
  });

  const statusLabel = STATUS_LABELS[groupBuy.status];
  const statusBg = STATUS_BG[groupBuy.status];
  const statusFg = STATUS_FG[groupBuy.status];

  return new ImageResponse(
    (
      <div
        style={{
          width: 600,
          height: 800,
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)",
          fontFamily: "sans-serif",
          padding: 0,
          position: "relative",
        }}
      >
        {/* Background pattern overlay */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 20% 20%, rgba(99,102,241,0.15) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(16,185,129,0.10) 0%, transparent 50%)",
          }}
        />

        {/* Header bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 28px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
              }}
            >
              ⌨
            </div>
            <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, letterSpacing: 1 }}>
              GMK TRACKER
            </span>
          </div>
          <span style={{ color: "#64748b", fontSize: 12 }}>gmktracker.com</span>
        </div>

        {/* Set image */}
        {groupBuy.imageUrl && (
          <div style={{ display: "flex", padding: "0" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={groupBuy.imageUrl}
              alt={groupBuy.name}
              style={{
                width: "100%",
                height: 260,
                objectFit: "cover",
              }}
            />
          </div>
        )}

        {/* Content */}
        <div style={{ display: "flex", flexDirection: "column", padding: "20px 28px", flex: 1 }}>
          {/* Status badge */}
          <div style={{ display: "flex", marginBottom: 12 }}>
            <span
              style={{
                background: statusBg,
                color: statusFg,
                fontSize: 11,
                fontWeight: 700,
                padding: "4px 10px",
                borderRadius: 20,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              {statusLabel}
            </span>
          </div>

          {/* Set name */}
          <div
            style={{
              color: "#f8fafc",
              fontSize: 32,
              fontWeight: 800,
              lineHeight: 1.1,
              marginBottom: 6,
            }}
          >
            {groupBuy.name}
          </div>
          {groupBuy.subtitle && (
            <div style={{ color: "#94a3b8", fontSize: 14, marginBottom: 8 }}>
              {groupBuy.subtitle}
            </div>
          )}
          <div style={{ color: "#64748b", fontSize: 12, marginBottom: 20 }}>
            Designed by {groupBuy.designer}
          </div>

          {/* Price highlight */}
          {priceDisplay && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                marginBottom: 20,
                padding: "14px 18px",
                background: "rgba(99,102,241,0.12)",
                border: "1px solid rgba(99,102,241,0.25)",
                borderRadius: 12,
              }}
            >
              <span style={{ color: "#a5b4fc", fontSize: 12 }}>Best price to {country}</span>
              <span style={{ color: "#ffffff", fontSize: 28, fontWeight: 800 }}>
                {priceDisplay}
              </span>
              <span style={{ color: "#64748b", fontSize: 11 }}>{currency}</span>
            </div>
          )}

          {/* Bottom: QR + CTA */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              marginTop: "auto",
              paddingTop: 16,
              borderTop: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            {/* QR code */}
            <div
              style={{
                background: "#ffffff",
                padding: 8,
                borderRadius: 10,
                display: "flex",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="QR" style={{ width: 90, height: 90 }} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>
                Scan to compare prices
              </span>
              <span style={{ color: "#64748b", fontSize: 11 }}>
                See all vendors & shipping costs
              </span>
              <span style={{ color: "#6366f1", fontSize: 11, marginTop: 4 }}>
                {setUrl.replace("https://", "")}
              </span>
            </div>
          </div>
        </div>
      </div>
    ),
    { width: 600, height: 800 }
  );
}
