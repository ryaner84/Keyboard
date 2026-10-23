import { ImageResponse } from "next/og";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { normalizeImageUrl } from "@/lib/utils";
import { buildPosterModel, posterVersion } from "@/lib/public-collection";
import { HIDDEN_SLUGS } from "@/lib/showcase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const WIDTH = 800;
const HEIGHT = 420;

function posterThumbnailUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "cdn.shopify.com") {
      url.searchParams.set("width", "480");
    } else if (url.hostname.endsWith("squarespace.com")) {
      url.searchParams.set("format", "500w");
    } else if (url.hostname === "i.imgur.com") {
      url.pathname = url.pathname.replace(
        /(\.[a-z]+)$/i,
        (_, extension: string) => `l${extension}`
      );
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    if (url.startsWith("data:image/")) {
      const encoded = url.split(",", 2)[1];
      const buffer = encoded ? Buffer.from(encoded, "base64") : null;
      return buffer && buffer.length <= 1_500_000 ? buffer : null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(posterThumbnailUrl(url), {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 1_500_000) return null;
    return buffer;
  } catch {
    return null;
  }
}

async function createGalleryDataUri(
  images: Array<Buffer | null>
): Promise<string | null> {
  const slots = [
    { left: 0, top: 0, width: 256, height: 270 },
    { left: 264, top: 0, width: 124, height: 131 },
    { left: 396, top: 0, width: 124, height: 131 },
    { left: 264, top: 139, width: 124, height: 131 },
    { left: 396, top: 139, width: 124, height: 131 },
  ];

  try {
    const composites = await Promise.all(
      slots.map(async (slot, index) => {
        const image = images[index];
        const input = image
          ? await sharp(image)
              .rotate()
              .resize(slot.width, slot.height, { fit: "cover" })
              .jpeg({ quality: 78 })
              .toBuffer()
          : await sharp({
              create: {
                width: slot.width,
                height: slot.height,
                channels: 3,
                background: "#20262a",
              },
            })
              .jpeg({ quality: 78 })
              .toBuffer();
        return { input, left: slot.left, top: slot.top };
      })
    );

    const gallery = await sharp({
      create: {
        width: 520,
        height: 270,
        channels: 3,
        background: "#151a1e",
      },
    })
      .composite(composites)
      .jpeg({ quality: 82 })
      .toBuffer();
    return `data:image/jpeg;base64,${gallery.toString("base64")}`;
  } catch (error) {
    console.error("[collection-poster] gallery composition failed", error);
    return null;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const collection = await prisma.trackerUser.findFirst({
    where: {
      collectionSlug: slug,
      collectionPublished: true,
    },
    select: {
      displayName: true,
      collectionTitle: true,
      collectionBio: true,
      items: {
        where: {
          inCollection: true,
          isPublic: true,
          // Same rule as the public page: a privacy-pulled board never shows.
          groupBuy: { slug: { notIn: HIDDEN_SLUGS } },
        },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
        select: {
          customImageUrl: true,
          quantity: true,
          hiddenBuilds: true,
          // Builds 2..N carry their own photos; the poster must be able to
          // draw a VISIBLE build's photo when build 1 is hidden.
          units: true,
          keycapAcquisitions: true,
          groupBuy: {
            select: {
              name: true,
              designer: true,
              imageUrl: true,
              productType: true,
              layout: true,
              vendorName: true,
            },
          },
        },
      },
    },
  });

  if (!collection) return new Response("Not found", { status: 404 });

  // Everything drawn below comes from the shared, tested model — see
  // src/lib/public-collection.ts for what a visitor may see and why.
  const model = buildPosterModel(collection);
  // The page links this image as ?v=<hash of the model it saw>. Only a request
  // whose v matches what is drawn NOW may be cached: otherwise an old link
  // fetched while a since-hidden piece was public would cache that picture
  // under a version the page can advertise again once the piece is hidden.
  const requestedVersion = new URL(request.url).searchParams.get("v");
  const cacheable = requestedVersion === posterVersion(model);
  const { owner, title, keycapCount, layoutCounts, brandCounts, keycapMix } = model;
  const candidates = model.imageUrls.map((imageUrl) => ({ imageUrl }));
  const imageBuffers = await Promise.all(
    candidates.map(async (item) => {
      const url = normalizeImageUrl(item.imageUrl);
      return url ? fetchImageBuffer(url) : null;
    })
  );
  const galleryImage = await createGalleryDataUri(imageBuffers);

  return new ImageResponse(
    (
      <div
        style={{
          width: WIDTH,
          height: HEIGHT,
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background:
            "radial-gradient(circle at 88% 6%, rgba(201,171,114,0.19), transparent 28%), linear-gradient(145deg, #090c0f 0%, #11171b 56%, #080a0c 100%)",
          color: "#ffffff",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 28,
            top: 24,
            width: 205,
            height: 265,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              color: "#d9bb82",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.19em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                width: 24,
                height: 1,
                marginRight: 10,
                display: "flex",
                background: "#d9bb82",
              }}
            />
            Personal archive
          </div>

          <div
            style={{
              marginTop: 24,
              display: "flex",
              color: "rgba(255,255,255,0.55)",
              fontSize: 12,
            }}
          >
            Curated by {owner.slice(0, 34)}
          </div>
          <div
            style={{
              marginTop: 7,
              display: "flex",
              maxWidth: 205,
              color: "#ffffff",
              fontFamily: "Georgia, serif",
              fontSize: title.length > 34 ? 27 : 32,
              fontWeight: 700,
              lineHeight: 1.06,
              letterSpacing: "-0.025em",
            }}
          >
            {title.slice(0, 58)}
          </div>

          <div
            style={{
              marginTop: "auto",
              display: "flex",
              alignItems: "baseline",
            }}
          >
            <span
              style={{
                display: "flex",
                color: "#d9bb82",
                fontFamily: "Georgia, serif",
                fontSize: 36,
                fontWeight: 700,
              }}
            >
              {model.keyboards}
            </span>
            <span
              style={{
                display: "flex",
                marginLeft: 8,
                color: "#ffffff",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              keyboard{model.keyboards === 1 ? "" : "s"}
            </span>
          </div>
          <div
            style={{
              marginTop: 2,
              display: "flex",
              color: "rgba(255,255,255,0.46)",
              fontSize: 10,
            }}
          >
            {model.displayed} displayed
            {keycapCount > 0
              ? ` · ${keycapCount} keycap set${keycapCount === 1 ? "" : "s"}`
              : ""}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 252,
            top: 20,
            width: 520,
            height: 270,
            display: "flex",
            gap: 8,
          }}
        >
          {galleryImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={galleryImage}
              alt=""
              width={520}
              height={270}
              style={{
                width: 520,
                height: 270,
                objectFit: "cover",
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.13)",
                boxShadow: "0 14px 30px rgba(0,0,0,0.3)",
              }}
            />
          ) : (
            <div
              style={{
                width: 520,
                height: 270,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.13)",
                background: "#20262a",
                color: "rgba(255,255,255,0.22)",
                fontSize: 48,
              }}
            >
              ⌨
            </div>
          )}
        </div>

        <div
          style={{
            position: "absolute",
            left: 28,
            right: 28,
            top: 306,
            height: 78,
            display: "flex",
            gap: 12,
          }}
        >
          <StatPanel
            title="Layout mix"
            values={layoutCounts}
            emptyLabel="Layout details coming soon"
            width={keycapCount > 0 ? 240 : 366}
          />
          <StatPanel
            title="Top brands"
            values={brandCounts}
            emptyLabel="Independent collection"
            width={keycapCount > 0 ? 240 : 366}
          />
          {keycapCount > 0 && (
            <StatPanel
              title="Keycap mix"
              values={keycapMix}
              emptyLabel="Keycap details coming soon"
              width={240}
            />
          )}
        </div>

        <div
          style={{
            position: "absolute",
            left: 28,
            right: 28,
            bottom: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "rgba(255,255,255,0.42)",
            fontSize: 9,
          }}
        >
          <span style={{ display: "flex" }}>
            {model.bio
              ? model.bio.slice(0, 72)
              : "A collector's personal keyboard and keycap archive"}
          </span>
          <span
            style={{
              display: "flex",
              color: "#d9bb82",
              fontWeight: 700,
            }}
          >
            Explore · Build yours on GMK Tracker
          </span>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      // Lowercase on purpose: ImageResponse sets its own lowercase
      // "cache-control: public, immutable, max-age=31536000" and spreads ours
      // after it, so a "Cache-Control" key was APPENDED to that default
      // rather than replacing it — every poster was cached immutable for a year.
      headers: {
        "cache-control": cacheable
          ? "public, max-age=300, s-maxage=300, stale-while-revalidate=3600"
          : "no-store",
      },
    }
  );
}

function StatPanel({
  title,
  values,
  emptyLabel,
  width = 366,
}: {
  title: string;
  values: Array<{ label: string; count: number }>;
  emptyLabel: string;
  width?: number;
}) {
  return (
    <div
      style={{
        width,
        height: 78,
        display: "flex",
        flexDirection: "column",
        padding: "11px 13px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.1)",
        background: "rgba(255,255,255,0.045)",
      }}
    >
      <span
        style={{
          display: "flex",
          color: "rgba(255,255,255,0.42)",
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </span>
      <div
        style={{
          marginTop: 9,
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        {values.length > 0 ? (
          values.map((value) => (
            <span
              key={value.label}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "5px 8px",
                borderRadius: 999,
                background: "rgba(217,187,130,0.11)",
                border: "1px solid rgba(217,187,130,0.22)",
                color: "#eee2cb",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {value.count} {value.label}
            </span>
          ))
        ) : (
          <span
            style={{
              display: "flex",
              color: "rgba(255,255,255,0.42)",
              fontSize: 10,
            }}
          >
            {emptyLabel}
          </span>
        )}
      </div>
    </div>
  );
}
