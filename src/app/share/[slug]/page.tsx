import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { COUNTRY_BY_CODE, DEFAULT_COUNTRY } from "@/data/countries";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ country?: string; currency?: string }>;
}

// Dedicated share page so WhatsApp / iMessage can render a rich link preview.
//
// WhatsApp's bot only reads og:image from HTML pages — a bare PNG URL never
// shows a thumbnail. This page wraps the poster API with proper OG tags so
// that pasting the link shows the generated poster card. The poster image is
// the og:image (900×1020 portrait, already Vercel-edge-cached after first
// "Save Poster" click, so the bot rarely hits a cold-start delay).

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { country: rawCountry = "SG", currency: rawCurrency } = await searchParams;
  const country = rawCountry.toUpperCase();
  const countryInfo = COUNTRY_BY_CODE[country] ?? DEFAULT_COUNTRY;
  const currency = rawCurrency ?? countryInfo.currency;

  const gb = await prisma.groupBuy.findUnique({
    where: { slug },
    select: { name: true, designer: true },
  });
  if (!gb) return { title: "Not Found" };

  const siteUrl = getSiteUrl();
  // Landscape 800×420 variant: WhatsApp only renders the LARGE preview card
  // for ~1.91:1 images under ~600KB — the portrait poster gets shrunk to a
  // tiny square thumbnail instead.
  const ogImageUrl = `${siteUrl}/api/poster/${slug}?country=${country}&currency=${currency}&layout=og`;
  const setUrl = `${siteUrl}/sets/${slug}?country=${country}`;

  const title = `${gb.name} — Prices & Comparison`;
  const description = `See the top vendor prices for ${gb.name}${gb.designer ? ` by ${gb.designer}` : ""} shipped to ${country}. Compare vendors on GMK Tracker.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: setUrl,
      type: "website",
      images: [
        // The landscape card is the ONLY og:image — WhatsApp picks the first.
        { url: ogImageUrl, width: 800, height: 420, type: "image/png", alt: gb.name },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImageUrl],
    },
    // Tell crawlers not to index share pages.
    robots: { index: false },
  };
}

export default async function SharePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { country: rawCountry = "SG", currency: rawCurrency } = await searchParams;
  const country = rawCountry.toUpperCase();
  const countryInfo = COUNTRY_BY_CODE[country] ?? DEFAULT_COUNTRY;
  const currency = rawCurrency ?? countryInfo.currency;

  const gb = await prisma.groupBuy.findUnique({
    where: { slug },
    select: { name: true },
  });
  if (!gb) notFound();

  const siteUrl = getSiteUrl();
  const posterUrl = `${siteUrl}/api/poster/${slug}?country=${country}&currency=${currency}`;
  const setUrl = `/sets/${slug}?country=${country}`;

  return (
    <main className="min-h-screen bg-[#080d16] flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm flex flex-col items-center gap-5">
        {/* Poster image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={posterUrl}
          alt={gb.name}
          className="w-full rounded-2xl shadow-2xl"
          style={{ maxWidth: 420 }}
        />

        {/* Actions */}
        <div className="flex flex-col gap-3 w-full">
          <a
            href={posterUrl}
            download={`gmk-${slug}-poster.png`}
            className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Save Poster
          </a>
          <a
            href={setUrl}
            className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-white/10 hover:bg-white/20 text-white text-sm font-medium rounded-xl transition-colors border border-white/10"
          >
            View full price comparison →
          </a>
        </div>

        <p className="text-xs text-gray-600 text-center">
          Prices shown for {country} · {currency} · GMK Tracker
        </p>
      </div>
    </main>
  );
}
