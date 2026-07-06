import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SetImageCarousel } from "@/components/set-detail/SetImageCarousel";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { COUNTRY_BY_CODE, DEFAULT_COUNTRY } from "@/data/countries";
import { formatDateRange, normalizeImageUrl } from "@/lib/utils";
import { cleanDisplayName, isHiddenSlug, isShowcaseSource, isCustomSlug } from "@/lib/showcase";
import { getSiteUrl } from "@/lib/site-url";
import { SetDetailClient } from "./SetDetailClient";
import { ShowcaseDetail } from "@/components/showcase/ShowcaseDetail";
import { KeyboardDetailsPanel } from "@/components/set-detail/KeyboardDetailsPanel";
import { parseKeyboardDetails, hasKeyboardDetails } from "@/lib/keyboard-details";
import { getKeyboardEditionFamily } from "@/data/keyboard-edition-families";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ country?: string }>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { country = "SG" } = await searchParams;

  // Custom collection pieces have no public catalog page — they live only in
  // their owner's collection.
  if (isHiddenSlug(slug) || isCustomSlug(slug)) return { title: "Not Found" };

  const groupBuy = await prisma.groupBuy.findUnique({ where: { slug } });
  if (!groupBuy) return { title: "Not Found" };

  const name = cleanDisplayName(groupBuy.name);
  const siteUrl = getSiteUrl();
  const url = `${siteUrl}/sets/${slug}?country=${country}`;
  // Showcase boards are community photo builds — never frame them as something
  // to "compare prices" for.
  const isShowcase = isShowcaseSource(groupBuy.vendorName);
  const showcaseDescription =
    groupBuy.subtitle ?? groupBuy.description ??
    `${name} — a custom keyboard build in the Showcase gallery.`;

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
    ...(photoUrl ? [{ url: photoUrl, width: 1200, height: 630, alt: name }] : []),
    { url: posterUrl, width: 800, height: 420, type: "image/png" as const, alt: name },
  ];

  return {
    title: `${name} — GMK Tracker`,
    description: isShowcase
      ? showcaseDescription
      : groupBuy.subtitle ?? groupBuy.description ?? `Compare prices for ${name} from vendors worldwide.`,
    openGraph: {
      title: name,
      description: isShowcase
        ? showcaseDescription
        : groupBuy.subtitle ?? `${name} by ${groupBuy.designer}`,
      url,
      images: ogImages,
    },
    twitter: {
      card: "summary_large_image",
      title: name,
      description: isShowcase
        ? showcaseDescription
        : groupBuy.subtitle ?? `Compare prices for ${name}`,
      images: [photoUrl ?? posterUrl],
    },
  };
}

export default async function SetDetailPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { country = "SG" } = await searchParams;

  // Privacy denylist — pretend the board doesn't exist even if the row remains.
  if (isHiddenSlug(slug) || isCustomSlug(slug)) notFound();

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

  const displayName = cleanDisplayName(groupBuy.name);
  const editionFamily = getKeyboardEditionFamily(slug);
  const relatedEditions = editionFamily
    ? await prisma.groupBuy.findMany({
        where: { slug: { in: editionFamily.slugs } },
        select: {
          slug: true,
          name: true,
          subtitle: true,
          imageUrl: true,
          status: true,
        },
      })
    : [];
  const orderedEditions = editionFamily
    ? editionFamily.slugs
        .map((editionSlug) =>
          relatedEditions.find((edition) => edition.slug === editionSlug)
        )
        .filter((edition): edition is NonNullable<typeof edition> => Boolean(edition))
    : [];

  // Gallery: prefer the multi-image array, fall back to the single hero image.
  // De-duplicate and normalize each Firebase path so all thumbnails load.
  const heroImages = Array.from(
    new Set(
      [...(groupBuy.images ?? []), groupBuy.imageUrl]
        .map((u) => normalizeImageUrl(u))
        .filter((u): u is string => !!u)
    )
  );

  // Showcase boards are community photo builds, not group buys — give them a
  // purpose-built collector view (gallery + spec sheet) instead of the GB/price
  // layout, which would only render an empty vendor table and a dead "Track"
  // button for them.
  if (isShowcaseSource(groupBuy.vendorName)) {
    return (
      <ShowcaseDetail
        board={groupBuy}
        images={heroImages}
        displayName={displayName}
      />
    );
  }

  // Keyboard group-buy descriptions (esp. Geekhack-scraped boards) bury the
  // dates, regional vendors, specs and per-edition pricing in one wall of prose.
  // Parse them out so we can present the key info as structured panels and tuck
  // the raw text into a collapsible instead of dumping the whole chunk.
  const isKeyboard = (groupBuy as { productType?: string }).productType === "KEYBOARD";
  const keyboardDetails = isKeyboard ? parseKeyboardDetails(groupBuy.description) : null;
  const showStructuredDetails = !!keyboardDetails && hasKeyboardDetails(keyboardDetails);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden mb-6">
        {heroImages.length > 0 && (
          <SetImageCarousel images={heroImages} alt={displayName} />
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
              <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900">{displayName}</h1>
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
            showStructuredDetails ? (
              // Key info is surfaced in the panels below — keep the original
              // post available but collapsed so it doesn't dominate the page.
              <details className="group mt-4">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-gray-500 hover:text-violet-600">
                  <svg className="h-4 w-4 transition group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  Full description
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                  {groupBuy.description}
                </p>
              </details>
            ) : (
              <p className="mt-4 text-sm text-gray-600 leading-relaxed">{groupBuy.description}</p>
            )
          )}
        </div>
      </div>

      {/* Structured key info extracted from the description */}
      {showStructuredDetails && keyboardDetails && (
        <KeyboardDetailsPanel details={keyboardDetails} />
      )}

      {editionFamily && orderedEditions.length > 1 && (
        <section className="mb-6 overflow-hidden rounded-2xl border border-[#dfd2b9] bg-[#faf7f0] dark:border-[#4b402d] dark:bg-[#1d1a15]">
          <div className="border-b border-[#e7dcc8] px-5 py-5 dark:border-[#4b402d] sm:px-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#d0b278]">
              Collector identification
            </p>
            <h2 className="mt-1 text-xl font-semibold text-gray-950 dark:text-white">
              Choose the exact {editionFamily.familyName} edition
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600 dark:text-gray-400">
              These are separate keyboards with different construction and
              production runs. Open the version you own before adding it to your
              collection.
            </p>
          </div>

          <div className="grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
            {orderedEditions.map((edition) => {
              const imageUrl = normalizeImageUrl(edition.imageUrl);
              const active = edition.slug === slug;
              return (
                <article
                  key={edition.slug}
                  className={`overflow-hidden rounded-xl border bg-white dark:bg-[#111417] ${
                    active
                      ? "border-[#9a7a42] ring-2 ring-[#9a7a42]/20 dark:border-[#d0b278]"
                      : "border-black/10 dark:border-white/10"
                  }`}
                >
                  <Link href={`/sets/${edition.slug}?country=${country}`} className="block">
                    <div className="relative aspect-[16/9] overflow-hidden bg-gray-100 dark:bg-gray-900">
                      {imageUrl ? (
                        <Image
                          src={imageUrl}
                          alt={cleanDisplayName(edition.name)}
                          fill
                          unoptimized
                          className="object-cover transition duration-500 hover:scale-[1.025]"
                        />
                      ) : (
                        <span className="absolute inset-0 flex items-center justify-center text-3xl text-gray-300">
                          ⌨
                        </span>
                      )}
                      {active && (
                        <span className="absolute left-3 top-3 rounded-full bg-[#9a7a42] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white">
                          Current edition
                        </span>
                      )}
                    </div>
                    <div className="p-4">
                      <h3 className="font-semibold text-gray-950 dark:text-white">
                        {cleanDisplayName(edition.name)}
                      </h3>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {edition.subtitle || "Collector catalog edition"}
                      </p>
                    </div>
                  </Link>
                  <Link
                    href={`/collection?find=${encodeURIComponent(edition.name)}`}
                    className="block border-t border-gray-100 px-4 py-3 text-xs font-semibold text-[#80632f] hover:bg-[#f5efe3] dark:border-white/10 dark:text-[#d0b278] dark:hover:bg-white/5"
                  >
                    Add this exact edition to collection →
                  </Link>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* Client-side interactive section */}
      <SetDetailClient
        groupBuy={{ ...groupBuy, name: displayName } as never}
        initialCountry={country}
      />
    </div>
  );
}
