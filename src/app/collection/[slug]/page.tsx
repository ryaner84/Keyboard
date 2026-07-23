import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { normalizeImageUrl } from "@/lib/utils";
import { cleanDisplayName, isCustomSlug } from "@/lib/showcase";
import { getSiteUrl } from "@/lib/site-url";
import {
  KEYCAP_CONDITION_LABELS,
  keycapPurchasePhoto,
  normalizeKeycapAcquisitions,
} from "@/lib/keycap-collection";
import type { CollectionItemDetails, KeycapPairing } from "@/types";
import ReportPhotoButton from "@/components/collection/ReportPhotoButton";
import { CollectionCardGallery } from "@/components/collection/CollectionCardGallery";
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
          hiddenBuilds: true,
          keycapAcquisitions: true,
          updatedAt: true,
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
  searchParams: Promise<{ share?: string; type?: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  await searchParams;
  const collection = await getPublicCollection(slug);
  if (!collection) return { title: "Collection not found" };

  const owner = collection.displayName || "A keyboard collector";
  const title = collection.collectionTitle || `${owner}'s collection`;
  const description =
    collection.collectionBio ||
    `Explore ${owner}'s curated keyboard and keycap collection.`;
  const siteUrl = getSiteUrl();
  const canonicalUrl = `${siteUrl}/collection/${slug}`;
  const latestUpdate = Math.max(
    collection.updatedAt.getTime(),
    ...collection.items.map((item) => item.updatedAt.getTime())
  );
  const pageUrl = `${siteUrl}${collectionSharePath(slug)}`;
  const posterUrl = `${siteUrl}${collectionPosterPath(slug, latestUpdate.toString(36))}`;

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
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { slug } = await params;
  const { type } = await searchParams;
  const collection = await getPublicCollection(slug);
  if (!collection) notFound();

  const owner = collection.displayName || "Private collector";
  const title = collection.collectionTitle || `${owner}'s collection`;
  // A piece whose builds are ALL hidden is effectively private — drop it from
  // the page and the counts entirely.
  const allVisibleItems = collection.items.filter((item) => {
    if (item.groupBuy.productType !== "KEYBOARD") {
      return publicKeycapAcquisitions(item).length > 0;
    }
    const qty = Math.max(1, item.quantity || 1);
    const hidden = new Set(
      Array.isArray(item.hiddenBuilds)
        ? (item.hiddenBuilds as unknown[]).map((n) => Number(n))
        : []
    );
    let visible = 0;
    for (let i = 0; i < qty; i++) if (!hidden.has(i)) visible++;
    return visible > 0;
  });
  const category = type === "keyboards" || type === "keycaps" ? type : "all";
  const visibleItems = allVisibleItems.filter((item) =>
    category === "all"
      ? true
      : category === "keyboards"
        ? item.groupBuy.productType === "KEYBOARD"
        : item.groupBuy.productType !== "KEYBOARD"
  );
  const keyboardCount = allVisibleItems.filter(
    (item) => item.groupBuy.productType === "KEYBOARD"
  ).length;
  const keycapCount = allVisibleItems.length - keyboardCount;
  const publicKeyboardBuilds = new Set<string>();
  const publicKeyboardNames = new Map<string, string>();
  for (const item of allVisibleItems) {
    if (item.groupBuy.productType !== "KEYBOARD") continue;
    publicKeyboardNames.set(item.groupBuy.slug, cleanDisplayName(item.groupBuy.name));
    const hidden = new Set(
      Array.isArray(item.hiddenBuilds)
        ? (item.hiddenBuilds as unknown[]).map((value) => Number(value))
        : []
    );
    for (let index = 0; index < Math.max(1, item.quantity || 1); index++) {
      if (!hidden.has(index)) publicKeyboardBuilds.add(`${item.groupBuy.slug}|${index}`);
    }
  }

  return (
    <main className="min-h-screen bg-[#efede7] pb-20 dark:bg-[#080a0c]">
      <section className="relative overflow-hidden bg-[#111417] text-white">
        <div className="absolute inset-0 opacity-80 [background:radial-gradient(circle_at_78%_18%,rgba(201,171,114,0.24),transparent_26%),radial-gradient(circle_at_12%_92%,rgba(68,55,32,0.35),transparent_28%)]" />
        <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 lg:py-28">
          <div className="flex max-w-4xl items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-[#c9ab72]">
            <span className="h-px w-10 bg-[#c9ab72]" />
            Curated collection archive
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
            <span>{allVisibleItems.length} displayed pieces</span>
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

        <div className="mt-5 flex flex-wrap gap-2" aria-label="Filter public collection">
          <PublicCollectionFilter slug={slug} active={category === "all"} type="all" label="All pieces" count={allVisibleItems.length} />
          <PublicCollectionFilter slug={slug} active={category === "keyboards"} type="keyboards" label="Keyboards" count={keyboardCount} />
          <PublicCollectionFilter slug={slug} active={category === "keycaps"} type="keycaps" label="Keycap sets" count={keycapCount} />
        </div>

        {visibleItems.length === 0 ? (
          <div className="py-24 text-center">
            <p className="font-serif text-3xl text-gray-500 dark:text-gray-400">
              This display case is being prepared.
            </p>
          </div>
        ) : (
          <div className="mt-8 grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
            {visibleItems.map((item, index) => (
              <PublicCollectionCard
                key={item.groupBuy.id}
                item={item}
                number={index + 1}
                collectionSlug={slug}
                publicKeyboardBuilds={publicKeyboardBuilds}
                publicKeyboardNames={publicKeyboardNames}
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
  publicKeyboardBuilds,
  publicKeyboardNames,
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
    hiddenBuilds: unknown;
    keycapAcquisitions: unknown;
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
  publicKeyboardBuilds: Set<string>;
  publicKeyboardNames: Map<string, string>;
}) {
  if (item.groupBuy.productType !== "KEYBOARD") {
    return (
      <PublicKeycapCollectionCard
        item={item}
        number={number}
        collectionSlug={collectionSlug}
        publicKeyboardBuilds={publicKeyboardBuilds}
        publicKeyboardNames={publicKeyboardNames}
      />
    );
  }
  const acquiredYear = item.acquiredAt?.getFullYear();
  const specs = [
    item.groupBuy.layout,
    item.groupBuy.mountingStyle,
    item.groupBuy.material,
  ].filter(Boolean);
  // Per-unit visibility: the owner can publish only selected units of a
  // multi-unit piece. hiddenBuilds holds the 0-based ORIGINAL build indexes to
  // exclude — keep the original index on each visible build so photo reports
  // still reference the right unit.
  const hiddenBuilds = new Set(
    Array.isArray(item.hiddenBuilds)
      ? (item.hiddenBuilds as unknown[]).map((n) => Number(n))
      : []
  );
  const builds = assemblePublicBuilds(item)
    .map((build, originalIndex) => ({ build, originalIndex }))
    .filter(({ originalIndex }) => !hiddenBuilds.has(originalIndex));
  const multiBuild = builds.length > 1;
  // Never surface the scraped showcase source in a saved board's name.
  const setName = cleanDisplayName(item.groupBuy.name);

  // One gallery slide per build. A build with its own uploaded photo shows that
  // (and can be reported); a build without one falls back to the shared render.
  const groupImage = normalizeImageUrl(item.groupBuy.imageUrl);
  const slides = builds.map(({ build, originalIndex }) => ({
    imageUrl: build.imageUrl || groupImage,
    isCustom: Boolean(build.imageUrl),
    buildIndex: originalIndex,
  }));

  return (
    <article className="group overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_14px_45px_rgba(29,25,18,0.07)] dark:border-white/10 dark:bg-[#111417]">
      <CollectionCardGallery
        slides={slides}
        setSlug={item.groupBuy.slug}
        setName={setName}
        number={number}
        buildsCount={builds.length}
        collectionSlug={collectionSlug}
        trackerItemId={item.id}
      />

      <div className="p-5 sm:p-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          {item.groupBuy.vendorName || item.groupBuy.designer || "Independent design"}
        </p>
        {isCustomSlug(item.groupBuy.slug) ? (
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-gray-950 dark:text-white">
            {setName}
          </h3>
        ) : (
          <Link href={`/sets/${item.groupBuy.slug}`}>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-gray-950 hover:text-[#8b6d38] dark:text-white">
              {setName}
            </h3>
          </Link>
        )}
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
                label={item.quantity > 1 ? "Price per unit" : "Acquired for"}
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
            {builds.map(({ build, originalIndex }) => (
              <PublicBuild
                key={originalIndex}
                build={build}
                index={originalIndex}
                collectionSlug={collectionSlug}
                trackerItemId={item.id}
                label={setName}
                showPurchasePrice={item.showPurchasePrice}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function PublicKeycapCollectionCard({
  item,
  number,
  collectionSlug,
  publicKeyboardBuilds,
  publicKeyboardNames,
}: {
  item: {
    id: string;
    acquiredAt: Date | null;
    purchasePrice: number | null;
    purchaseCurrency: string | null;
    showPurchasePrice: boolean;
    quantity: number;
    customImageUrl: string | null;
    keycapAcquisitions: unknown;
    groupBuy: {
      slug: string;
      name: string;
      designer: string;
      imageUrl: string | null;
      vendorName: string | null;
    };
  };
  number: number;
  collectionSlug: string;
  publicKeyboardBuilds: Set<string>;
  publicKeyboardNames: Map<string, string>;
}) {
  const purchases = publicKeycapAcquisitions(item);
  const setName = cleanDisplayName(item.groupBuy.name);
  const catalogImage = normalizeImageUrl(item.groupBuy.imageUrl);
  const slides = purchases.map((purchase, index) => ({
    imageUrl: keycapPurchasePhoto(purchase, catalogImage),
    isCustom: purchase.photoSource === "CUSTOM" && Boolean(purchase.imageUrl),
    buildIndex: index,
  }));
  const isCustom = isCustomSlug(item.groupBuy.slug);

  return (
    <article className="group overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_14px_45px_rgba(29,25,18,0.07)] dark:border-white/10 dark:bg-[#111417]">
      <CollectionCardGallery
        slides={slides}
        setSlug={item.groupBuy.slug}
        setName={setName}
        number={number}
        buildsCount={purchases.length}
        recordLabel="purchase"
        collectionSlug={collectionSlug}
        trackerItemId={item.id}
      />
      <div className="p-5 sm:p-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          {item.groupBuy.vendorName || item.groupBuy.designer || "Independent design"}
        </p>
        {isCustom ? (
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-gray-950 dark:text-white">{setName}</h3>
        ) : (
          <Link href={`/sets/${item.groupBuy.slug}`}>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-gray-950 hover:text-[#8b6d38] dark:text-white">{setName}</h3>
          </Link>
        )}
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{purchases.length === 1 ? "One recorded purchase" : `${purchases.length} recorded purchases`}</p>

        <div className="mt-5 space-y-3 border-t border-gray-100 pt-5 dark:border-white/10">
          {purchases.map((purchase, index) => {
            const pairing = publicKeycapPairing(
              purchase.pairing,
              publicKeyboardBuilds,
              publicKeyboardNames
            );
            const specs = [
              purchase.acquiredAt
                ? `Collected ${new Date(purchase.acquiredAt).getFullYear()}`
                : null,
              purchase.condition
                ? KEYCAP_CONDITION_LABELS[purchase.condition] || purchase.condition
                : null,
              purchase.quantity > 1 ? `${purchase.quantity} copies` : null,
              item.showPurchasePrice && purchase.purchasePrice != null
                ? `${purchase.purchaseCurrency || "USD"} ${purchase.purchasePrice.toLocaleString()}`
                : null,
            ].filter(Boolean);
            return (
              <div key={purchase.id} className="rounded-xl bg-gray-50 p-3 dark:bg-white/[0.04]">
                <p className="text-[11px] font-semibold text-gray-900 dark:text-white">Purchase {index + 1}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {purchase.kits.map((kit) => (
                    <span key={`${kit.kitId || "custom"}-${kit.name}`} className="rounded-full bg-[#f7f1e5] px-2 py-0.5 text-[10px] font-semibold text-[#71552b] dark:bg-[#2b251b] dark:text-[#dfc284]">{kit.name}</span>
                  ))}
                </div>
                {specs.length > 0 && <p className="mt-2 text-[11px] leading-4 text-gray-500 dark:text-gray-400">{specs.join(" · ")}</p>}
                {pairing && <p className="mt-1 text-[11px] leading-4 text-[#80632f] dark:text-[#d5b779]">Paired with {pairing}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

function publicKeycapAcquisitions(item: {
  acquiredAt: Date | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  quantity: number;
  customImageUrl: string | null;
  keycapAcquisitions: unknown;
}) {
  const details = {
    isTracking: false,
    inCollection: true,
    isPublic: true,
    acquiredAt: item.acquiredAt,
    condition: null,
    purchasePrice: item.purchasePrice,
    purchaseCurrency: item.purchaseCurrency,
    showPurchasePrice: false,
    switches: null,
    keycaps: null,
    buildDetails: null,
    notes: null,
    displayOrder: 0,
    color: null,
    quantity: item.quantity || 1,
    customImageUrl: item.customImageUrl,
    units: null,
    hiddenBuilds: null,
    keycapAcquisitions: Array.isArray(item.keycapAcquisitions)
      ? item.keycapAcquisitions
      : null,
  } as CollectionItemDetails;
  return normalizeKeycapAcquisitions(details).filter((purchase) => purchase.isPublic);
}

function publicKeycapPairing(
  pairing: KeycapPairing,
  publicKeyboardBuilds: Set<string>,
  publicKeyboardNames: Map<string, string>
) {
  if (!pairing || !pairing.showPublic) return null;
  if (pairing.kind === "free_text") return pairing.label;
  const key = `${pairing.keyboardSlug}|${pairing.buildIndex}`;
  if (!publicKeyboardBuilds.has(key)) return null;
  const name = publicKeyboardNames.get(pairing.keyboardSlug);
  return name ? `${name} · Build ${pairing.buildIndex + 1}` : null;
}

function PublicCollectionFilter({
  slug,
  active,
  type,
  label,
  count,
}: {
  slug: string;
  active: boolean;
  type: "all" | "keyboards" | "keycaps";
  label: string;
  count: number;
}) {
  const href = type === "all" ? `/collection/${slug}` : `/collection/${slug}?type=${type}`;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? "border-[#9a7a42] bg-[#9a7a42] text-white"
          : "border-black/10 bg-white text-gray-600 hover:border-[#c9ab72] hover:text-gray-950 dark:border-white/15 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:text-white"
      }`}
    >
      {label} <span className="ml-1 opacity-70">{count}</span>
    </Link>
  );
}

type PublicBuildShape = {
  acquiredAt: string | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
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
  acquiredAt: Date | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
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
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
    purchasePrice: item.purchasePrice,
    purchaseCurrency: item.purchaseCurrency,
    color: item.color,
    condition: item.condition,
    switches: item.switches,
    keycaps: item.keycaps,
    buildDetails: item.buildDetails,
    imageUrl: item.customImageUrl,
  };
  const extra = Array.isArray(item.units)
    ? (item.units as Record<string, unknown>[]).map((u) => ({
        acquiredAt:
          u?.acquiredAt === undefined
            ? item.acquiredAt?.toISOString() ?? null
            : (u?.acquiredAt as string) ?? null,
        purchasePrice:
          u?.purchasePrice === undefined
            ? item.purchasePrice
            : typeof u?.purchasePrice === "number"
              ? u.purchasePrice
              : null,
        purchaseCurrency:
          u?.purchaseCurrency === undefined
            ? item.purchaseCurrency
            : (u?.purchaseCurrency as string) ?? null,
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
      acquiredAt: null,
      purchasePrice: null,
      purchaseCurrency: null,
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
  showPurchasePrice,
}: {
  build: PublicBuildShape;
  index: number;
  collectionSlug: string;
  trackerItemId: string;
  label: string;
  showPurchasePrice: boolean;
}) {
  const specs = [
    build.acquiredAt
      ? `Collected ${new Date(build.acquiredAt).getFullYear()}`
      : null,
    showPurchasePrice && build.purchasePrice != null
      ? `${build.purchaseCurrency || "USD"} ${build.purchasePrice.toLocaleString()}`
      : null,
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
            className="h-full w-full rounded-lg bg-gray-100 object-contain dark:bg-gray-800"
          />
          {index > 0 && (
            <ReportPhotoButton
              collectionSlug={collectionSlug}
              trackerItemId={trackerItemId}
              buildIndex={index}
              label={`${label}, build ${index + 1}`}
              className="absolute -bottom-1.5 -right-1.5 !h-6 !w-6"
            />
          )}
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
