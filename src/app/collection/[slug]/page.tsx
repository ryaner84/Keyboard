import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { normalizeImageUrl } from "@/lib/utils";
import { getSiteUrl } from "@/lib/site-url";
import ReportPhotoButton from "@/components/collection/ReportPhotoButton";
import {
  collectionPosterPath,
  collectionSharePath,
} from "@/lib/collection-share";

export const dynamic = "force-dynamic";

const getPublicCollection = cache(async (slug: string) =>
  prisma.trackerUser.findFirst({
    where: {
      collectionSlug: slug,
      collectionPublished: true,
    },
    select: {
      displayName: true,
      collectionTitle: true,
      collectionBio: true,
      updatedAt: true,
      items: {
        where: {
          inCollection: true,
          isPublic: true,
        },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          acquiredAt: true,
          condition: true,
          purchasePrice: true,
          purchaseCurrency: true,
          showPurchasePrice: true,
          switches: true,
          keycaps: true,
          buildDetails: true,
          color: true,
          quantity: true,
          customImageUrl: true,
          units: true,
          groupBuy: {
            select: {
              id: true,
              slug: true,
              name: true,
              designer: true,
              imageUrl: true,
              productType: true,
              layout: true,
              mountingStyle: true,
              material: true,
              vendorName: true,
            },
          },
        },
      },
    },
  })
);

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ share?: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { share } = await searchParams;
  const collection = await getPublicCollection(slug);
  if (!collection) return { title: "Collection not found" };

  const owner = collection.displayName || "A keyboard collector";
  const title = collection.collectionTitle || `${owner}'s keyboard collection`;
  const description =
    collection.collectionBio ||
    `Explore ${owner}'s curated mechanical keyboard collection.`;
  const siteUrl = getSiteUrl();
  const canonicalUrl = `${siteUrl}/collection/${slug}`;
  const pageUrl = `${siteUrl}${collectionSharePath(slug, share)}`;
  const posterUrl = `${siteUrl}${collectionPosterPath(slug, share)}`;

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title,
      description,
      type: "website",
      url: pageUrl,
      siteName: "GMK Tracker",
      images: [
        {
          url: posterUrl,
          width: 800,
          height: 420,
          alt: `${title} collection preview`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [posterUrl],
    },
  };
}

export default async function PublicCollectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const collection = await getPublicCollection(slug);
  if (!collection) notFound();

  const owner = collection.displayName || "Private collector";
  const title = collection.collectionTitle || `${owner}'s keyboard collection`;
  const keyboardCount = collection.items.filter(
    (item) => item.groupBuy.productType === "KEYBOARD"
  ).length;
  const keycapCount = collection.items.length - keyboardCount;

  return (
    <main className="min-h-screen bg-[#efede7] pb-20 dark:bg-[#080a0c]">
      <section className="relative overflow-hidden bg-[#111417] text-white">
        <div className="absolute inset-0 opacity-80 [background:radial-gradient(circle_at_78%_18%,rgba(201,171,114,0.24),transparent_26%),radial-gradient(circle_at_12%_92%,rgba(68,55,32,0.35),transparent_28%)]" />
        <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 lg:py-28">
          <div className="flex max-w-4xl items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-[#c9ab72]">
            <span className="h-px w-10 bg-[#c9ab72]" />
            Curated keyboard archive
          </div>
          <p className="mt-10 text-sm text-white/55">{owner}</p>
          <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
            {title}
          </h1>
          {collection.collectionBio && (
            <p className="mt-7 max-w-2xl text-base leading-7 text-white/60 sm:text-lg">
              {collection.collectionBio}
            </p>
          )}
          <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3 text-xs uppercase tracking-[0.14em] text-white/45">
            <span>{collection.items.length} displayed pieces</span>
            {keyboardCount > 0 && <span>{keyboardCount} keyboards</span>}
            {keycapCount > 0 && <span>{keycapCount} keycap sets</span>}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="-mt-1 flex items-center justify-between border-b border-black/10 py-7 dark:border-white/10">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9a7a42] dark:text-[#c9ab72]">
              The collection
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">
              Pieces on display
            </h2>
          </div>
          <Link
            href="/collection"
            className="hidden rounded-full border border-black/15 px-4 py-2 text-xs font-semibold text-gray-700 hover:border-black/40 dark:border-white/20 dark:text-gray-200 dark:hover:border-white/50 sm:block"
          >
            Build your collection
          </Link>
        </div>

        {collection.items.length === 0 ? (
          <div className="py-24 text-center">
            <p className="font-serif text-3xl text-gray-500 dark:text-gray-400">
              This display case is being prepared.
            </p>
          </div>
        ) : (
          <div className="mt-8 grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
            {collection.items.map((item, index) => (
              <PublicCollectionCard
                key={item.groupBuy.id}
                item={item}
                number={index + 1}
                collectionSlug={slug}
              />
            ))}
          </div>
        )}

        <div className="mt-14 flex justify-center sm:hidden">
          <Link
            href="/collection"
            className="rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-950"
          >
            Build your collection
          </Link>
        </div>
      </section>
    </main>
  );
}

function PublicCollectionCard({
  item,
  number,
  collectionSlug,
}: {
  item: {
    id: string;
    acquiredAt: Date | null;
    condition: string | null;
    purchasePrice: number | null;
    purchaseCurrency: string | null;
    showPurchasePrice: boolean;
    switches: string | null;
    keycaps: string | null;
    buildDetails: string | null;
    color: string | null;
    quantity: number;
    customImageUrl: string | null;
    units: unknown;
    groupBuy: {
      id: string;
      slug: string;
      name: string;
      designer: string;
      imageUrl: string | null;
      productType: string;
      layout: string | null;
      mountingStyle: string | null;
      material: string | null;
      vendorName: string | null;
    };
  };
  number: number;
  collectionSlug: string;
}) {
  const imageUrl = item.customImageUrl || normalizeImageUrl(item.groupBuy.imageUrl);
  const acquiredYear = item.acquiredAt?.getFullYear();
  const specs = [
    item.groupBuy.layout,
    item.groupBuy.mountingStyle,
    item.groupBuy.material,
  ].filter(Boolean);
  const builds = assemblePublicBuilds(item);
  const multiBuild = builds.length > 1;

  return (
    <article className="group overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_14px_45px_rgba(29,25,18,0.07)] dark:border-white/10 dark:bg-[#111417]">
      <div className="relative">
        <Link href={`/sets/${item.groupBuy.slug}`} className="block">
          <div className="relative aspect-[4/3] overflow-hidden bg-[#ddd9cf] dark:bg-gray-900">
          {imageUrl ? (
            // Plain img so owner-uploaded data: URLs render.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={item.groupBuy.name}
              className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-5xl text-gray-300 dark:text-gray-700">
              ⌨
            </div>
          )}
          <span className="absolute left-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 font-serif text-sm text-white backdrop-blur">
            {String(number).padStart(2, "0")}
          </span>
          {multiBuild && (
            <span className="absolute right-4 top-4 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur">
              {builds.length} builds
            </span>
          )}
          </div>
        </Link>
        {item.customImageUrl && (
          <ReportPhotoButton
            collectionSlug={collectionSlug}
            trackerItemId={item.id}
            buildIndex={0}
            label={`${item.groupBuy.name}, build 1`}
            className="absolute bottom-4 right-4"
          />
        )}
      </div>

      <div className="p-5 sm:p-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          {item.groupBuy.vendorName || item.groupBuy.designer || "Independent design"}
        </p>
        <Link href={`/sets/${item.groupBuy.slug}`}>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-gray-950 hover:text-[#8b6d38] dark:text-white">
            {item.groupBuy.name}
          </h3>
        </Link>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {[
            item.condition ? formatCondition(item.condition) : null,
            acquiredYear ? `Collected ${acquiredYear}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "From the private collection"}
        </p>

        {!multiBuild && (specs.length > 0 || item.switches || item.keycaps || item.color) && (
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-gray-100 pt-5 dark:border-white/10">
            {specs.length > 0 && <PublicSpec label="Format" value={specs.join(" · ")} />}
            {item.color && <PublicSpec label="Colour" value={item.color} />}
            {item.switches && <PublicSpec label="Switches" value={item.switches} />}
            {item.keycaps && <PublicSpec label="Keycaps" value={item.keycaps} />}
            {item.showPurchasePrice && item.purchasePrice != null && (
              <PublicSpec
                label="Acquired for"
                value={`${item.purchaseCurrency || "USD"} ${item.purchasePrice.toLocaleString()}`}
              />
            )}
          </dl>
        )}
        {!multiBuild && item.buildDetails && (
          <p className="mt-5 border-t border-gray-100 pt-5 text-sm leading-6 text-gray-600 dark:border-white/10 dark:text-gray-300">
            {item.buildDetails}
          </p>
        )}

        {multiBuild && (
          <div className="mt-5 space-y-3 border-t border-gray-100 pt-5 dark:border-white/10">
            {builds.map((build, index) => (
              <PublicBuild
                key={index}
                build={build}
                index={index}
                collectionSlug={collectionSlug}
                trackerItemId={item.id}
                label={item.groupBuy.name}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

type PublicBuildShape = {
  color: string | null;
  condition: string | null;
  switches: string | null;
  keycaps: string | null;
  buildDetails: string | null;
  imageUrl: string | null;
};

// Expand a public item into per-build rows (build 1 = top-level fields, the
// rest from the `units` JSON). Returns exactly `quantity` builds.
function assemblePublicBuilds(item: {
  color: string | null;
  condition: string | null;
  switches: string | null;
  keycaps: string | null;
  buildDetails: string | null;
  customImageUrl: string | null;
  quantity: number;
  units: unknown;
}): PublicBuildShape[] {
  const qty = Math.max(1, item.quantity || 1);
  const first: PublicBuildShape = {
    color: item.color,
    condition: item.condition,
    switches: item.switches,
    keycaps: item.keycaps,
    buildDetails: item.buildDetails,
    imageUrl: item.customImageUrl,
  };
  const extra = Array.isArray(item.units)
    ? (item.units as Record<string, unknown>[]).map((u) => ({
        color: (u?.color as string) ?? null,
        condition: (u?.condition as string) ?? null,
        switches: (u?.switches as string) ?? null,
        keycaps: (u?.keycaps as string) ?? null,
        buildDetails: (u?.buildDetails as string) ?? null,
        imageUrl: (u?.imageUrl as string) ?? null,
      }))
    : [];
  const builds = [first, ...extra].slice(0, qty);
  while (builds.length < qty) {
    builds.push({
      color: null,
      condition: null,
      switches: null,
      keycaps: null,
      buildDetails: null,
      imageUrl: null,
    });
  }
  return builds;
}

function PublicBuild({
  build,
  index,
  collectionSlug,
  trackerItemId,
  label,
}: {
  build: PublicBuildShape;
  index: number;
  collectionSlug: string;
  trackerItemId: string;
  label: string;
}) {
  const specs = [
    build.color,
    build.condition ? formatCondition(build.condition) : null,
    build.switches,
    build.keycaps,
  ].filter(Boolean) as string[];
  return (
    <div className="flex gap-3">
      {build.imageUrl ? (
        <div className="relative h-14 w-14 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={build.imageUrl}
            alt={`Build ${index + 1}`}
            className="h-full w-full rounded-lg object-cover"
          />
          <ReportPhotoButton
            collectionSlug={collectionSlug}
            trackerItemId={trackerItemId}
            buildIndex={index}
            label={`${label}, build ${index + 1}`}
            className="absolute -bottom-1.5 -right-1.5 !h-6 !w-6"
          />
        </div>
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg text-gray-300 dark:bg-gray-800 dark:text-gray-600">
          ⌨
        </div>
      )}
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-900 dark:text-white">
          Build {index + 1}
        </p>
        <p className="mt-0.5 text-[11px] leading-4 text-gray-500 dark:text-gray-400">
          {specs.join(" · ") || "Details coming soon"}
        </p>
        {build.buildDetails && (
          <p className="mt-1 text-[11px] leading-4 text-gray-400 dark:text-gray-500">
            {build.buildDetails}
          </p>
        )}
      </div>
    </div>
  );
}

function PublicSpec({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] font-semibold uppercase tracking-[0.14em] text-gray-400">
        {label}
      </dt>
      <dd className="mt-1 text-xs font-medium leading-5 text-gray-700 dark:text-gray-200">
        {value}
      </dd>
    </div>
  );
}

function formatCondition(condition: string) {
  const labels: Record<string, string> = {
    UNBUILT: "New / unbuilt",
    EXCELLENT: "Built · excellent",
    GOOD: "Good",
    FAIR: "Fair",
    PROJECT: "Project board",
  };
  return labels[condition] || condition;
}
