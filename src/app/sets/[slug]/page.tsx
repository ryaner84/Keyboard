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
  // layout=og → landscape 800×420, the shape WhatsApp's large card needs.
  const posterUrl = `${siteUrl}/api/poster/${slug}?country=${countryInfo.code}&currency=${countryInfo.currency}&layout=og`;
  const photoUrl = normalizeImageUrl(groupBuy.imageUrl);

  const ogImages = [
    ...(photoUrl ? [{ url: photoUrl, width: 1200, height: 630, alt: groupBuy.name }] : []),
    { url: posterUrl, width: 800, height: 420, type: "image/png" as const, alt: groupBuy.name },
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
            // GMK is the manufacturer, not a vendor — its rows only carry the
            // gmk.net catalog/image URL and are never shown as a place to buy.
            // The OR keeps NULL-productUrl rows (manual prices) visible: a bare
            // NOT-contains would drop them under SQL three-valued logic.
            where: {
              vendor: { slug: { not: "gmk" } },
              OR: [{ productUrl: null }, { NOT: { productUrl: { contains: "gmk.net" } } }],
            },
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
                {/* Product type chip — subtle, tells the user what they're looking at */}
                {(groupBuy as { productType?: string }).productType === "KEYBOARD" ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><rect x="2" y="6" width="20" height="12" rx="2" strokeWidth={2}/><line x1="6" y1="10" x2="6" y2="10" strokeWidth={2.5} strokeLinecap="round"/><line x1="10" y1="10" x2="10" y2="10" strokeWidth={2.5} strokeLinecap="round"/><line x1="14" y1="10" x2="14" y2="10" strokeWidth={2.5} strokeLinecap="round"/><line x1="18" y1="10" x2="18" y2="10" strokeWidth={2.5} strokeLinecap="round"/><line x1="8" y1="14" x2="16" y2="14" strokeWidth={2.5} strokeLinecap="round"/></svg>
                    Keyboard GB
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><rect x="3" y="8" width="18" height="10" rx="1.5" strokeWidth={1.8}/><rect x="6" y="11" width="2" height="2" rx="0.4" fill="currentColor" strokeWidth={0}/><rect x="10" y="11" width="2" height="2" rx="0.4" fill="currentColor" strokeWidth={0}/><rect x="14" y="11" width="2" height="2" rx="0.4" fill="currentColor" strokeWidth={0}/><rect x="8" y="14" width="6" height="1.5" rx="0.4" fill="currentColor" strokeWidth={0}/></svg>
                    Keycap Set
                  </span>
                )}
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
