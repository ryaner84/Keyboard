import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { normalizeImageUrl } from "@/lib/utils";
import { HIDDEN_SLUGS, notCustomWhere } from "@/lib/showcase";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  ACTIVE_GB: "Active group buy",
  INTEREST_CHECK: "Interest check",
  PREORDER: "Pre-order",
  IN_STOCK: "In stock",
  EXTRA_DROP: "Extras",
  SHIPPING: "Shipping",
  DELIVERED: "Released",
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): Promise<Metadata> {
  const query = singleValue(searchParams.q).trim();
  return {
    title: query ? `Search results for ${query}` : "Search",
    description: "Search and compare keyboards and keycap sets.",
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const query = singleValue(searchParams.q).trim().slice(0, 120);
  const requestedType = singleValue(searchParams.type).toUpperCase();
  const type =
    requestedType === "KEYBOARD" || requestedType === "KEYCAPS"
      ? requestedType
      : "ALL";

  const results =
    query.length >= 2
      ? await prisma.groupBuy.findMany({
          where: {
            ...(type === "ALL" ? {} : { productType: type }),
            ...(HIDDEN_SLUGS.length > 0 && {
              NOT: { slug: { in: HIDDEN_SLUGS } },
            }),
            // Custom collection pieces are private — never in search results.
            AND: [notCustomWhere],
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { colorway: { contains: query, mode: "insensitive" } },
              { designer: { contains: query, mode: "insensitive" } },
              { vendorName: { contains: query, mode: "insensitive" } },
              { slug: { contains: query.replace(/\s+/g, "-"), mode: "insensitive" } },
            ],
          },
          select: {
            id: true,
            slug: true,
            name: true,
            subtitle: true,
            colorway: true,
            designer: true,
            status: true,
            imageUrl: true,
            productType: true,
            vendorName: true,
            layout: true,
            mountingStyle: true,
            material: true,
            gbStart: true,
            gbEnd: true,
          },
          take: 96,
        })
      : [];

  const sortedResults = results.sort(
    (a, b) => relevance(a, query) - relevance(b, query) || a.name.localeCompare(b.name)
  );
  const keyboardCount = sortedResults.filter(
    (result) => result.productType === "KEYBOARD"
  ).length;
  const keycapCount = sortedResults.length - keyboardCount;

  return (
    <main className="min-h-screen bg-[#f6f5f1] pb-20 dark:bg-[#090b0d]">
      <section className="border-b border-black/10 bg-white dark:border-white/10 dark:bg-[#111417]">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9a7a42] dark:text-[#c9ab72]">
            Catalog search
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-gray-950 dark:text-white sm:text-4xl">
            Find the exact piece
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Compare names, photos, product types, designers, and release status before
            opening a result.
          </p>

          <form action="/search" method="get" className="mt-7 flex max-w-3xl gap-2">
            <label className="relative flex-1">
              <span className="sr-only">Search keyboards and keycap sets</span>
              <SearchIcon />
              <input
                name="q"
                defaultValue={query}
                autoFocus
                placeholder="Search keyboards, keycap sets, designers…"
                className="w-full rounded-xl border border-gray-200 bg-white py-3 pl-11 pr-4 text-sm text-gray-950 outline-none focus:border-[#9a7a42] focus:ring-2 focus:ring-[#9a7a42]/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </label>
            <button className="rounded-xl bg-gray-950 px-5 py-3 text-sm font-semibold text-white hover:bg-[#9a7a42] dark:bg-white dark:text-gray-950 dark:hover:bg-[#c9ab72]">
              Search
            </button>
          </form>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {query.length < 2 ? (
          <SearchEmpty
            title="Enter at least two characters"
            copy="Try a board name, keycap set, designer, or vendor."
          />
        ) : (
          <>
            <div className="flex flex-col gap-4 border-b border-black/10 pb-5 dark:border-white/10 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {sortedResults.length} result{sortedResults.length === 1 ? "" : "s"} for
                </p>
                <h2 className="mt-1 text-2xl font-semibold text-gray-950 dark:text-white">
                  “{query}”
                </h2>
              </div>
              <div className="flex w-fit rounded-full bg-black/5 p-1 dark:bg-white/10">
                <FilterLink
                  query={query}
                  type="ALL"
                  active={type === "ALL"}
                  label="All"
                  count={sortedResults.length}
                />
                <FilterLink
                  query={query}
                  type="KEYBOARD"
                  active={type === "KEYBOARD"}
                  label="Keyboards"
                  count={keyboardCount}
                />
                <FilterLink
                  query={query}
                  type="KEYCAPS"
                  active={type === "KEYCAPS"}
                  label="Keycaps"
                  count={keycapCount}
                />
              </div>
            </div>

            {sortedResults.length === 0 ? (
              <SearchEmpty
                title="No matching catalog items"
                copy="Try a shorter name, remove the product-type filter, or search by designer."
              />
            ) : (
              <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {sortedResults.map((result) => (
                  <SearchResultCard key={result.id} result={result} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function SearchResultCard({
  result,
}: {
  result: {
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    colorway: string | null;
    designer: string;
    status: string;
    imageUrl: string | null;
    productType: string;
    vendorName: string | null;
    layout: string | null;
    mountingStyle: string | null;
    material: string | null;
    gbStart: Date | null;
    gbEnd: Date | null;
  };
}) {
  const imageUrl = normalizeImageUrl(result.imageUrl);
  const isKeyboard = result.productType === "KEYBOARD";
  const maker = result.vendorName || result.designer || "Independent design";
  const specifications = isKeyboard
    ? [result.layout, result.mountingStyle, result.material].filter(Boolean)
    : [result.colorway, result.subtitle].filter(Boolean);

  return (
    <Link
      href={`/sets/${result.slug}`}
      className="group overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_10px_35px_rgba(25,22,16,0.05)] transition hover:-translate-y-0.5 hover:border-[#c9ab72] hover:shadow-[0_18px_45px_rgba(25,22,16,0.10)] dark:border-white/10 dark:bg-[#111417]"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-gray-100 dark:bg-gray-900">
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={result.name}
            fill
            unoptimized
            className="object-cover transition duration-500 group-hover:scale-[1.025]"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-4xl text-gray-300 dark:text-gray-700">
            ⌨
          </div>
        )}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <span className="rounded-full bg-black/65 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur">
            {isKeyboard ? "Keyboard" : "Keycap set"}
          </span>
          <span className="rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-gray-800 backdrop-blur">
            {STATUS_LABELS[result.status] || result.status.replaceAll("_", " ")}
          </span>
        </div>
      </div>
      <div className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#9a7a42] dark:text-[#c9ab72]">
          {maker}
        </p>
        <h3 className="mt-1 line-clamp-2 min-h-12 text-base font-semibold leading-6 text-gray-950 group-hover:text-[#80632f] dark:text-white">
          {result.name}
        </h3>
        <p className="mt-2 line-clamp-2 min-h-10 text-xs leading-5 text-gray-500 dark:text-gray-400">
          {specifications.length > 0
            ? specifications.join(" · ")
            : isKeyboard
              ? "Mechanical keyboard"
              : "Keycap collection"}
        </p>
        <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3 text-xs dark:border-white/10">
          <span className="text-gray-400">{dateContext(result.gbStart, result.gbEnd)}</span>
          <span className="font-semibold text-gray-800 group-hover:text-[#80632f] dark:text-gray-200">
            View details →
          </span>
        </div>
      </div>
    </Link>
  );
}

function FilterLink({
  query,
  type,
  active,
  label,
  count,
}: {
  query: string;
  type: "ALL" | "KEYBOARD" | "KEYCAPS";
  active: boolean;
  label: string;
  count: number;
}) {
  const params = new URLSearchParams({ q: query });
  if (type !== "ALL") params.set("type", type);
  return (
    <Link
      href={`/search?${params}`}
      className={`rounded-full px-3 py-2 text-xs font-semibold ${
        active
          ? "bg-white text-gray-950 shadow-sm dark:bg-gray-800 dark:text-white"
          : "text-gray-500 hover:text-gray-950 dark:text-gray-400 dark:hover:text-white"
      }`}
    >
      {label} <span className="ml-1 opacity-55">{count}</span>
    </Link>
  );
}

function SearchEmpty({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-black/15 bg-white/60 px-6 py-20 text-center dark:border-white/15 dark:bg-white/[0.03]">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#eee7d9] text-[#8b6d38] dark:bg-[#2a241a] dark:text-[#c9ab72]">
        <SearchIcon centered />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-gray-950 dark:text-white">{title}</h2>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{copy}</p>
    </div>
  );
}

function SearchIcon({ centered = false }: { centered?: boolean }) {
  return (
    <svg
      className={
        centered
          ? "h-5 w-5"
          : "pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
      }
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
    >
      <circle cx="11" cy="11" r="7" strokeWidth={1.8} />
      <path strokeLinecap="round" strokeWidth={1.8} d="M16.5 16.5L21 21" />
    </svg>
  );
}

function dateContext(start: Date | null, end: Date | null) {
  const date = start || end;
  if (!date) return "Catalog record";
  return `${start ? "Started" : "Released"} ${date.getFullYear()}`;
}

function relevance(
  result: { name: string; designer: string; vendorName: string | null },
  query: string
) {
  const normalized = query.toLowerCase();
  const name = result.name.toLowerCase();
  if (name === normalized) return 0;
  if (name.startsWith(normalized)) return 1;
  if (name.includes(normalized)) return 2;
  if (result.designer.toLowerCase().includes(normalized)) return 3;
  if (result.vendorName?.toLowerCase().includes(normalized)) return 3;
  return 4;
}

function singleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}
