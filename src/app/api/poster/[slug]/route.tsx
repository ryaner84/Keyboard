import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { STATUS_LABELS, normalizeImageUrl } from "@/lib/utils";
import { getSiteUrl } from "@/lib/site-url";
import QRCode from "qrcode";
import type { GBStatus } from "@/generated/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function fetchImageDataUri(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/png";
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Status badge colors (dark-theme versions)
const STATUS_BG: Record<GBStatus, string> = {
  INTEREST_CHECK: "rgba(100,116,139,0.25)",
  ACTIVE_GB:      "rgba(16,185,129,0.20)",
  SHIPPING:       "rgba(59,130,246,0.20)",
  DELIVERED:      "rgba(139,92,246,0.20)",
  IN_STOCK:       "rgba(245,158,11,0.20)",
  CANCELLED:      "rgba(239,68,68,0.20)",
};
const STATUS_FG: Record<GBStatus, string> = {
  INTEREST_CHECK: "#94a3b8",
  ACTIVE_GB:      "#34d399",
  SHIPPING:       "#60a5fa",
  DELIVERED:      "#c084fc",
  IN_STOCK:       "#fbbf24",
  CANCELLED:      "#f87171",
};
const STATUS_BORDER: Record<GBStatus, string> = {
  INTEREST_CHECK: "rgba(100,116,139,0.40)",
  ACTIVE_GB:      "rgba(16,185,129,0.40)",
  SHIPPING:       "rgba(59,130,246,0.40)",
  DELIVERED:      "rgba(139,92,246,0.40)",
  IN_STOCK:       "rgba(245,158,11,0.40)",
  CANCELLED:      "rgba(239,68,68,0.40)",
};

// Map ISO-2 country codes → Region enum values
const COUNTRY_TO_REGION: Record<string, string> = {
  SG: "SG",
  MY: "ASIA", TH: "ASIA", PH: "ASIA", ID: "ASIA", VN: "ASIA",
  HK: "ASIA", TW: "ASIA", JP: "ASIA", KR: "ASIA", CN: "ASIA", IN: "ASIA",
  AU: "AU", NZ: "AU",
  US: "US",
  CA: "CA",
  GB: "UK",
  DE: "EU", FR: "EU", NL: "EU", BE: "EU", IT: "EU", ES: "EU", IE: "EU",
  SE: "EU", PL: "EU", AT: "EU", CH: "EU", DK: "EU", NO: "EU", PT: "EU", FI: "EU",
};

const COUNTRY_NAMES: Record<string, string> = {
  SG: "Singapore", MY: "Malaysia", TH: "Thailand", PH: "Philippines",
  ID: "Indonesia", US: "United States", CA: "Canada", AU: "Australia",
  GB: "United Kingdom", DE: "Germany", FR: "France", JP: "Japan",
  KR: "Korea", HK: "Hong Kong", TW: "Taiwan", NZ: "New Zealand",
};

function formatCurrency(amount: number, code: string): string {
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${code} ${Math.round(amount)}`;
  }
}

function convertCurrency(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>
): number {
  if (from === to) return amount;
  return (amount / (rates[from] ?? 1)) * (rates[to] ?? 1);
}

// Rank badge: colored circle with number
function RankBadge({ rank }: { rank: number }) {
  const colors = ["#fbbf24", "#94a3b8", "#cd7f32"];
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        background: rank === 0 ? "rgba(251,191,36,0.15)" : "rgba(148,163,184,0.10)",
        border: `2px solid ${colors[rank]}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <span style={{ color: colors[rank], fontSize: 13, fontWeight: 800 }}>
        {rank + 1}
      </span>
    </div>
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const country = (req.nextUrl.searchParams.get("country") ?? "SG").toUpperCase();
  const currency = req.nextUrl.searchParams.get("currency") ?? "SGD";
  const region = COUNTRY_TO_REGION[country] ?? "OTHER";
  const countryName = COUNTRY_NAMES[country] ?? country;

  const groupBuy = await prisma.groupBuy.findUnique({
    where: { slug },
    include: {
      kits: {
        where: { type: "BASE" },
        take: 1,
        include: {
          vendorKits: {
            where: { price: { not: null }, inStock: true },
            include: {
              vendor: {
                include: {
                  shippingZones: {
                    where: { destinationRegion: region as never, shipsToRegion: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!groupBuy) return new Response("Not found", { status: 404 });

  // Load exchange rates
  const rateRows = await prisma.currency.findMany({ select: { code: true, exchangeRateToUSD: true } });
  const rates: Record<string, number> = {};
  for (const r of rateRows) rates[r.code] = r.exchangeRateToUSD;

  // Compute top-3 cheapest vendors for this region
  interface PriceRow { vendorName: string; kitLocal: number; shipLocal: number; totalLocal: number }
  const baseKit = groupBuy.kits[0];
  const rows: PriceRow[] = [];

  if (baseKit) {
    for (const vk of baseKit.vendorKits) {
      if (!vk.price || !vk.currency) continue;
      const zone = vk.vendor.shippingZones[0];
      if (!zone) continue;
      const kitLocal = convertCurrency(vk.price, vk.currency, currency, rates);
      const shipLocal = convertCurrency(zone.baseShippingCost, zone.currency, currency, rates);
      rows.push({ vendorName: vk.vendor.name, kitLocal, shipLocal, totalLocal: kitLocal + shipLocal });
    }
    rows.sort((a, b) => a.totalLocal - b.totalLocal);
  }
  const top3 = rows.slice(0, 3);

  const siteUrl = getSiteUrl();
  const setUrl = `${siteUrl}/sets/${slug}?country=${country}`;

  const qrDataUrl = await QRCode.toDataURL(setUrl, {
    width: 96,
    margin: 1,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  const rawImageUrl = normalizeImageUrl(groupBuy.imageUrl);
  const heroImage = rawImageUrl ? await fetchImageDataUri(rawImageUrl) : null;
  const statusLabel = STATUS_LABELS[groupBuy.status].toUpperCase();
  const statusBg = STATUS_BG[groupBuy.status];
  const statusFg = STATUS_FG[groupBuy.status];
  const statusBorder = STATUS_BORDER[groupBuy.status];

  const today = new Date().toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });

  // Card: 900 × 1020 portrait
  const W = 900;
  const H = 1020;

  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(155deg, #080d16 0%, #0f1825 55%, #080d16 100%)",
          fontFamily: "sans-serif",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Ambient glow blobs */}
        <div
          style={{
            position: "absolute",
            top: -60,
            right: -80,
            width: 420,
            height: 420,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(99,102,241,0.18) 0%, transparent 70%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 120,
            left: -60,
            width: 360,
            height: 360,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(16,185,129,0.12) 0%, transparent 70%)",
          }}
        />

        {/* ── Header ─────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "22px 32px 18px",
            zIndex: 1,
          }}
        >
          {/* Logo wordmark */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 9,
                background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span style={{ color: "#fff", fontSize: 20, fontWeight: 900 }}>K</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ color: "#f1f5f9", fontSize: 15, fontWeight: 800, letterSpacing: 1.8 }}>
                GMK TRACKER
              </span>
              <span style={{ color: "#475569", fontSize: 10, letterSpacing: 0.5 }}>
                {siteUrl.replace(/^https?:\/\//, "")}
              </span>
            </div>
          </div>

          {/* Region pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(99,102,241,0.15)",
              border: "1px solid rgba(99,102,241,0.35)",
              borderRadius: 20,
              padding: "5px 14px",
            }}
          >
            <span style={{ color: "#a5b4fc", fontSize: 12, fontWeight: 700 }}>
              {country}
            </span>
            <span style={{ color: "#475569", fontSize: 12 }}>·</span>
            <span style={{ color: "#818cf8", fontSize: 12, fontWeight: 600 }}>
              {currency}
            </span>
          </div>
        </div>

        {/* ── Keyboard image ───────────────────────────────── */}
        <div
          style={{
            display: "flex",
            position: "relative",
            width: "100%",
            height: 310,
            overflow: "hidden",
          }}
        >
          {heroImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={heroImage}
              alt={groupBuy.name}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span style={{ color: "#334155", fontSize: 80, fontWeight: 900 }}>⌨</span>
            </div>
          )}
          {/* Bottom gradient fade into card */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 90,
              background: "linear-gradient(to bottom, transparent, #080d16)",
            }}
          />
        </div>

        {/* ── Set info ─────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "0 32px",
            zIndex: 1,
            marginTop: -16,
          }}
        >
          {/* Status badge */}
          <div style={{ display: "flex", marginBottom: 10 }}>
            <span
              style={{
                background: statusBg,
                color: statusFg,
                border: `1px solid ${statusBorder}`,
                fontSize: 10,
                fontWeight: 700,
                padding: "4px 12px",
                borderRadius: 20,
                letterSpacing: 1.2,
              }}
            >
              {statusLabel}
            </span>
          </div>

          {/* Set name */}
          <div
            style={{
              color: "#f8fafc",
              fontSize: 34,
              fontWeight: 800,
              lineHeight: 1.15,
              marginBottom: 6,
            }}
          >
            {groupBuy.name}
          </div>

          <div style={{ color: "#475569", fontSize: 13, marginBottom: 4 }}>
            {`by ${groupBuy.designer ?? "unknown"}`}
          </div>
          {/* GB end / release date so recipients know when to act */}
          {(groupBuy.gbEnd ?? groupBuy.gbStart) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 6,
              }}
            >
              <span
                style={{
                  background: "rgba(99,102,241,0.15)",
                  border: "1px solid rgba(99,102,241,0.30)",
                  color: "#a5b4fc",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "3px 10px",
                  borderRadius: 20,
                  letterSpacing: 0.5,
                }}
              >
                {groupBuy.status === "ACTIVE_GB" && groupBuy.gbEnd
                  ? `GB ends ${new Date(groupBuy.gbEnd).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}`
                  : groupBuy.status === "INTEREST_CHECK" && groupBuy.gbStart
                  ? `Starts ${new Date(groupBuy.gbStart).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}`
                  : groupBuy.gbEnd
                  ? `Released ${new Date(groupBuy.gbEnd).toLocaleDateString("en-SG", { month: "short", year: "numeric" })}`
                  : ""}
              </span>
            </div>
          )}
        </div>

        {/* ── Divider ──────────────────────────────────────── */}
        <div style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "16px 32px" }} />

        {/* ── Price section ────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", padding: "0 32px", zIndex: 1 }}>
          {/* Section label */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: 4,
                background: "rgba(16,185,129,0.20)",
                border: "1px solid rgba(16,185,129,0.40)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span style={{ color: "#34d399", fontSize: 11, fontWeight: 800 }}>$</span>
            </div>
            <span style={{ color: "#64748b", fontSize: 12, fontWeight: 600, letterSpacing: 1 }}>
              {`TOP PRICES TO ${countryName.toUpperCase()} · BASE KIT + SHIPPING`}
            </span>
          </div>

          {/* Price rows */}
          {top3.length === 0 ? (
            <div
              style={{
                padding: "20px 20px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 12,
                color: "#475569",
                fontSize: 14,
              }}
            >
              Prices not yet available — visit the site to check vendors
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {top3.map((row, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    background: i === 0
                      ? "rgba(16,185,129,0.08)"
                      : "rgba(255,255,255,0.03)",
                    border: i === 0
                      ? "1px solid rgba(16,185,129,0.22)"
                      : "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 12,
                    padding: "14px 18px",
                  }}
                >
                  <RankBadge rank={i} />

                  {/* Vendor name + breakdown */}
                  <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 3 }}>
                    <span
                      style={{
                        color: i === 0 ? "#e2e8f0" : "#94a3b8",
                        fontSize: 15,
                        fontWeight: 700,
                      }}
                    >
                      {row.vendorName.length > 22 ? row.vendorName.slice(0, 21) + "…" : row.vendorName}
                    </span>
                    <span style={{ color: "#334155", fontSize: 11 }}>
                      {`Kit ${formatCurrency(row.kitLocal, currency)}  +  Ship ${formatCurrency(row.shipLocal, currency)}`}
                    </span>
                  </div>

                  {/* Total */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <span
                      style={{
                        color: i === 0 ? "#10b981" : "#cbd5e1",
                        fontSize: 22,
                        fontWeight: 800,
                        lineHeight: 1,
                      }}
                    >
                      {formatCurrency(row.totalLocal, currency)}
                    </span>
                    {i === 0 && (
                      <span style={{ color: "#059669", fontSize: 10, fontWeight: 600, marginTop: 3 }}>
                        BEST PRICE
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            margin: "auto 32px 0",
            padding: "18px 0 26px",
            borderTop: "1px solid rgba(255,255,255,0.07)",
            zIndex: 1,
          }}
        >
          {/* QR code */}
          <div
            style={{
              background: "#ffffff",
              padding: 7,
              borderRadius: 10,
              display: "flex",
              flexShrink: 0,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt="QR" style={{ width: 86, height: 86 }} />
          </div>

          {/* CTA text */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
            <span style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 700 }}>
              Scan to compare all vendors
            </span>
            <span style={{ color: "#6366f1", fontSize: 12 }}>
              {setUrl.replace(/^https?:\/\//, "")}
            </span>
            <span style={{ color: "#334155", fontSize: 11 }}>
              {`Shared on ${today}`}
            </span>
          </div>

          {/* "From <best price>" stamp when prices exist */}
          {top3.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                padding: "10px 16px",
                background: "rgba(16,185,129,0.08)",
                border: "1px solid rgba(16,185,129,0.20)",
                borderRadius: 10,
                flexShrink: 0,
              }}
            >
              <span style={{ color: "#10b981", fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>
                FROM
              </span>
              <span style={{ color: "#34d399", fontSize: 20, fontWeight: 800, lineHeight: 1 }}>
                {formatCurrency(top3[0].totalLocal, currency)}
              </span>
              <span style={{ color: "#475569", fontSize: 10 }}>{`to ${countryName}`}</span>
            </div>
          )}
        </div>
      </div>
    ),
    { width: W, height: H }
  );
}
