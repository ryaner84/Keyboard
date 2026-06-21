import { ImageResponse } from "next/og";
import { prisma } from "@/lib/prisma";
import { normalizeImageUrl } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const WIDTH = 800;
const HEIGHT = 420;

async function fetchImageDataUri(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 4_000_000) return null;
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
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
        },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
        select: {
          groupBuy: {
            select: {
              name: true,
              designer: true,
              imageUrl: true,
              productType: true,
            },
          },
        },
      },
    },
  });

  if (!collection) return new Response("Not found", { status: 404 });

  const owner = collection.displayName || "Keyboard collector";
  const title = collection.collectionTitle || `${owner}'s collection`;
  const keyboardCount = collection.items.filter(
    (item) => item.groupBuy.productType === "KEYBOARD"
  ).length;
  const keycapCount = collection.items.length - keyboardCount;
  const candidates = collection.items.slice(0, 3);
  const images = await Promise.all(
    candidates.map(async (item) => {
      const url = normalizeImageUrl(item.groupBuy.imageUrl);
      return url ? fetchImageDataUri(url) : null;
    })
  );

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
            "radial-gradient(circle at 80% 15%, rgba(201,171,114,0.24), transparent 30%), linear-gradient(145deg, #0b0d10 0%, #15191d 58%, #090b0d 100%)",
          color: "#ffffff",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 36,
            top: 32,
            width: 335,
            height: 356,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              color: "#d9bb82",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                width: 32,
                height: 1,
                marginRight: 12,
                display: "flex",
                background: "#d9bb82",
              }}
            />
            Personal archive
          </div>

          <div
            style={{
              marginTop: 36,
              display: "flex",
              color: "rgba(255,255,255,0.58)",
              fontSize: 14,
            }}
          >
            Curated by {owner}
          </div>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              maxWidth: 330,
              color: "#ffffff",
              fontFamily: "Georgia, serif",
              fontSize: title.length > 34 ? 37 : 43,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: "-0.025em",
            }}
          >
            {title}
          </div>
          <div
            style={{
              marginTop: 18,
              display: "flex",
              maxWidth: 320,
              color: "rgba(255,255,255,0.57)",
              fontSize: 14,
              lineHeight: 1.45,
            }}
          >
            {(collection.collectionBio ||
              "A considered selection of keyboards, builds, and keycap sets.")
              .slice(0, 120)}
          </div>

          <div
            style={{
              marginTop: "auto",
              display: "flex",
              alignItems: "center",
              color: "rgba(255,255,255,0.72)",
              fontSize: 12,
            }}
          >
            <span style={{ display: "flex", fontWeight: 700 }}>
              {collection.items.length} displayed
            </span>
            {keyboardCount > 0 && (
              <span style={{ display: "flex", marginLeft: 18 }}>
                {keyboardCount} keyboard{keyboardCount === 1 ? "" : "s"}
              </span>
            )}
            {keycapCount > 0 && (
              <span style={{ display: "flex", marginLeft: 18 }}>
                {keycapCount} keycap set{keycapCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            right: 28,
            top: 27,
            width: 368,
            height: 315,
            display: "flex",
            gap: 10,
          }}
        >
          {candidates.length > 0 ? (
            candidates.map((item, index) => (
              <div
                key={`${item.groupBuy.name}-${index}`}
                style={{
                  width: index === 0 ? 196 : 76,
                  height: 315,
                  display: "flex",
                  position: "relative",
                  overflow: "hidden",
                  borderRadius: 16,
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: "#252a2f",
                  boxShadow: "0 18px 45px rgba(0,0,0,0.35)",
                }}
              >
                {images[index] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={images[index] as string}
                    alt=""
                    width={index === 0 ? 196 : 76}
                    height={315}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "rgba(255,255,255,0.24)",
                      fontSize: 42,
                    }}
                  >
                    ⌨
                  </div>
                )}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    minHeight: index === 0 ? 82 : 0,
                    padding: index === 0 ? "34px 14px 12px" : 0,
                    display: index === 0 ? "flex" : "none",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    background:
                      "linear-gradient(180deg, transparent 0%, rgba(5,7,9,0.94) 75%)",
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      color: "#ffffff",
                      fontSize: 14,
                      fontWeight: 700,
                      lineHeight: 1.2,
                    }}
                  >
                    {item.groupBuy.name.slice(0, 38)}
                  </span>
                  {item.groupBuy.designer && (
                    <span
                      style={{
                        display: "flex",
                        marginTop: 4,
                        color: "rgba(255,255,255,0.58)",
                        fontSize: 10,
                      }}
                    >
                      {item.groupBuy.designer.slice(0, 34)}
                    </span>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 18,
                border: "1px solid rgba(255,255,255,0.14)",
                color: "rgba(255,255,255,0.34)",
                fontSize: 64,
              }}
            >
              ⌨
            </div>
          )}
        </div>

        <div
          style={{
            position: "absolute",
            right: 30,
            bottom: 26,
            display: "flex",
            alignItems: "center",
            color: "#d9bb82",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          Explore this collection · Build and share yours on GMK Tracker
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
      },
    }
  );
}
