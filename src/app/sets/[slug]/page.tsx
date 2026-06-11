import { notFound } from "next/navigation";
import { SetImageCarousel } from "@/components/set-detail/SetImageCarousel";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { COUNTRY_BY_CODE, DEFAULT_COUNTRY } from "@/data/countries";
import { formatDateRange, normalizeImageUrl } from "@/lib/utils";
import { getSiteUrl } from "@/lib/site-url";
import { SetDetailClient } from "./SetDetailClient";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ country?: string }>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { country = "SG" } = await searchParams;

  const groupBuy = await prisma.groupBuy.findUnique({ where: { slug } });
  if (!groupBuy) return { title: "Not Found" };

  const siteUrl = getSiteUrl();
  const url = `${siteUrl}/sets/${slug}?country=${country}`;

  // WhatsApp / iMessage bots have a ~3s timeout — the dynamic poster API
  // can take longer on cold start (DB query + Firebase image fetch + Satori
  // render), so the actual set photo goes FIRST as og:image (fast CDN URL,
  // always loads). The poster follows as a second image: Discord and
  // dedicated preview apps have longer timeouts and can render the rich card.
  const countryInfo = COUNTRY_BY_CODE[country.toUpperCase()] ?? DEFAULT_COUNTRY;
  const posterUrl = `${siteUrl}/api/poster/${slug}?country=${countryInfo.code}&currency=${countryInfo.currency}`;
  const photoUrl = normalizeImageUrl(groupBuy.imageUrl);

  const ogImages = [
    ...(photoUrl ? [{ url: photoUrl, width: 1200, height: 630, alt: groupBuy.name }] : []),
    { url: posterUrl, width: 900, height: 1020, type: "image/png" as const, alt: groupBuy.name },
  ];

  return {
    title: `${groupBuy.name} — GMK Tracker`,
    description: groupBuy.subtitle ?? groupBuy.description ?? `Compare prices for ${groupBuy.name} from vendors worldwide.`,
    openGraph: {
      title: groupBuy.name,
      description: groupBuy.subtitle ?? `${groupBuy.name} by ${groupBuy.designer}`,
      url,
      images: ogImages,
    },
    twitter: {
      card: "summary_large_image",
      title: groupBuy.name,
      description: groupBuy.subtitle ?? `Compare prices for ${groupBuy.name}`,
      images: [photoUrl ?? posterUrl],
    },
  };
}

export default async function SetDetailPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { country = "SG" } = await searchParams;

  const groupBuy = await prisma.groupBuy.findUnique({
    where: { slug },
    include: {
      kits: {
        where: { type: "BASE" },
        include: {
          vendorKits: {
            include: {
              vendor: {
                include: {
                  shippingZones: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!groupBuy) notFound();

  // Gallery: prefer the multi-image array, fall back to the single hero image.
  // De-duplicate and normalize each Firebase path so all thumbnails load.
  const heroImages = Array.from(
    new Set(
      [...(groupBuy.images ?? []), groupBuy.imageUrl]
        .map((u) => normalizeImageUrl(u))
        .filter((u): u is string => !!u)
    )
  );

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden mb-6">
        {heroImages.length > 0 && (
          <SetImageCarousel images={heroImages} alt={groupBuy.name} />
        )}
        <div className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <StatusBadge status={groupBuy.status} />
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900">{groupBuy.name}</h1>
              {groupBuy.subtitle && (
                <p className="text-gray-500 mt-1">{groupBuy.subtitle}</p>
              )}
              <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500">
                <span>Designer: <strong className="text-gray-700">{groupBuy.designer}</strong></span>
                {(groupBuy.gbStart || groupBuy.gbEnd) && (
                  <span>{formatDateRange(groupBuy.gbStart, groupBuy.gbEnd)}</span>
                )}
                {groupBuy.colorway && <span>Colorway: <strong className="text-gray-700">{groupBuy.colorway}</strong></span>}
              </div>
            </div>
          </div>

          {groupBuy.description && (
            <p className="mt-4 text-sm text-gray-600 leading-relaxed">{groupBuy.description}</p>
          )}
        </div>
      </div>

      {/* Client-side interactive section */}
      <SetDetailClient
        groupBuy={groupBuy as never}
        initialCountry={country}
      />
    </div>
  );
}
