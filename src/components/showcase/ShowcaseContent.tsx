"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ShowcaseCard } from "@/components/showcase/ShowcaseCard";
import type { GroupBuyWithPricing } from "@/types";

const PAGE_SIZE = 24;

// Physical layouts a collector scans by — these match the values the keyboard
// importer writes, so they map cleanly onto the API's `layout` filter.
const LAYOUTS = [
  "40%",
  "60%",
  "65%",
  "75%",
  "TKL",
  "Full-size",
  "Alice/Arisu",
  "Other",
];

// Showcase has no pricing, so the only meaningful orderings are by recency
// (when we scraped it) and alphabetically — kept as visible pills.
const SORT_OPTIONS = [
  { value: "date-desc", label: "Newest" },
  { value: "name", label: "A–Z" },
  { value: "date-asc", label: "Oldest" },
] as const;

export default function ShowcaseContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const search = searchParams.get("search") ?? "";
  const layouts = searchParams.getAll("layout");
  const designers = searchParams.getAll("designer");
  const sortBy = searchParams.get("sort") ?? "date-desc";

  const [boards, setBoards] = useState<GroupBuyWithPricing[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Designer facets (maker + count), fetched once — drives the maker filter.
  const [designerFacets, setDesignerFacets] = useState<
    { name: string; count: number }[]
  >([]);
  const [showAllDesigners, setShowAllDesigners] = useState(false);

  const [searchDraft, setSearchDraft] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id: only the most recent fetch may write to state, so a
  // slow earlier response (e.g. the unfiltered mount fetch) can't land after a
  // newer one (e.g. "kohaku") and repaint stale, non-matching results.
  const reqSeq = useRef(0);

  const updateParams = useCallback(
    (updates: Record<string, string | string[]>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        params.delete(key);
        if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
        else if (value) params.set(key, value);
      }
      router.replace(`/showcase?${params.toString()}`);
    },
    [searchParams, router]
  );

  const onSearchChange = (value: string) => {
    setSearchDraft(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateParams({ search: value }), 350);
  };

  const toggleLayout = (layout: string) => {
    const next = layouts.includes(layout)
      ? layouts.filter((l) => l !== layout)
      : [...layouts, layout];
    updateParams({ layout: next });
  };

  const toggleDesigner = (designer: string) => {
    const next = designers.includes(designer)
      ? designers.filter((d) => d !== designer)
      : [...designers, designer];
    updateParams({ designer: next });
  };

  // Load the maker facets once on mount — independent of the active filters.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/showcase/designers")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setDesignerFacets(data.designers ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      const seq = ++reqSeq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      const params = new URLSearchParams();
      params.set("type", "KEYBOARD");
      // Showcase = community photo sources only (Lightning Keyboards). Vendor
      // boards (Oblotzky, ClickClack, …) live in the Keyboard Catalog instead.
      params.set("showcaseOnly", "1");
      if (search) params.set("search", search);
      layouts.forEach((l) => params.append("layout", l));
      designers.forEach((d) => params.append("designer", d));
      params.set("sort", sortBy);
      params.set("page", String(pageNum));
      params.set("limit", String(PAGE_SIZE));

      try {
        const res = await fetch(`/api/group-buys?${params}`);
        const data = await res.json();
        // Ignore this response if a newer request has since been issued.
        if (seq !== reqSeq.current) return;
        setBoards((prev) =>
          append ? [...prev, ...(data.data ?? [])] : data.data ?? []
        );
        setTotal(data.total ?? 0);
        setPage(pageNum);
      } catch {
        if (seq === reqSeq.current && !append) setBoards([]);
      } finally {
        if (seq === reqSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [search, layouts, designers, sortBy]
  );

  useEffect(() => {
    fetchPage(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, JSON.stringify(layouts), JSON.stringify(designers), sortBy]);

  const hasMore = boards.length < total;
  const hasFilters = !!(search || layouts.length > 0 || designers.length > 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="relative mb-8 overflow-hidden rounded-2xl bg-gradient-to-br from-violet-700 via-purple-700 to-fuchsia-700 px-6 py-8 sm:px-10 sm:py-10">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              "radial-gradient(circle at 80% 20%, white 0%, transparent 45%), radial-gradient(circle at 10% 90%, white 0%, transparent 35%)",
          }}
        />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white backdrop-blur-sm">
            🖼️ Showcase
          </span>
          <h1 className="mt-3 text-2xl font-extrabold text-white sm:text-3xl">
            Keyboard Showcase
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-violet-50 sm:text-base">
            A gallery of custom keyboards from the community — just browse and
            admire the builds. No tracking, no prices, only the boards.
          </p>
          <div className="mt-5 inline-flex rounded-xl bg-white/15 px-4 py-2 backdrop-blur-sm">
            <p className="text-xl font-bold leading-tight text-white">
              {loading ? "—" : total}
            </p>
            <p className="ml-2 self-center text-[11px] uppercase tracking-wide text-violet-100">
              boards on display
            </p>
          </div>
        </div>
      </div>

      {/* ── Search ───────────────────────────────────────────────────────── */}
      <div className="relative mb-4 max-w-md">
        <svg
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={searchDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by board, maker or designer…"
          className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 transition-colors focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:focus:ring-violet-900"
        />
      </div>

      {/* ── Layout filter chips ──────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs text-gray-400">Layout</span>
        {LAYOUTS.map((layout) => {
          const active = layouts.includes(layout);
          return (
            <button
              key={layout}
              onClick={() => toggleLayout(layout)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "border-violet-600 bg-violet-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
              }`}
            >
              {layout}
            </button>
          );
        })}
      </div>

      {/* ── Designer / maker filter ──────────────────────────────────────── */}
      {designerFacets.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-gray-400">Designer</span>
          {(showAllDesigners ? designerFacets : designerFacets.slice(0, 12)).map(
            (facet) => {
              const active = designers.includes(facet.name);
              return (
                <button
                  key={facet.name}
                  onClick={() => toggleDesigner(facet.name)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? "border-violet-600 bg-violet-600 text-white"
                      : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                  }`}
                >
                  {facet.name}
                  <span
                    className={`text-[10px] font-medium ${
                      active ? "text-violet-100" : "text-gray-400"
                    }`}
                  >
                    {facet.count}
                  </span>
                </button>
              );
            }
          )}
          {designerFacets.length > 12 && (
            <button
              onClick={() => setShowAllDesigners((v) => !v)}
              className="rounded-full px-2.5 py-1.5 text-xs font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
            >
              {showAllDesigners
                ? "Show less"
                : `+${designerFacets.length - 12} more`}
            </button>
          )}
        </div>
      )}

      {/* ── Sort pills + clear ───────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="mr-1 flex items-center gap-1 text-xs text-gray-400">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9M3 12h5m8-8v12m0 0l-4-4m4 4l4-4" />
          </svg>
          Sort by
        </span>
        {SORT_OPTIONS.map((opt) => {
          const active = sortBy === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => updateParams({ sort: opt.value })}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "border-violet-600 bg-violet-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
        {hasFilters && (
          <button
            onClick={() => {
              setSearchDraft("");
              router.replace("/showcase");
            }}
            className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Clear
          </button>
        )}
      </div>

      {/* ── Result count ─────────────────────────────────────────────────── */}
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        {loading ? "Loading…" : `${total} keyboard${total !== 1 ? "s" : ""}`}
      </p>

      {/* ── Grid ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900">
              <div className="aspect-[4/3] animate-pulse bg-gray-100 dark:bg-gray-800" />
              <div className="space-y-2 p-3.5">
                <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
              </div>
            </div>
          ))}
        </div>
      ) : boards.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white py-20 text-center dark:border-gray-800 dark:bg-gray-900">
          <p className="mb-2 text-4xl text-gray-300">⌨</p>
          <p className="font-semibold text-gray-700 dark:text-gray-300">No keyboards found</p>
          <p className="mt-1 text-sm text-gray-400">Try clearing the filters above.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {boards.map((kb) => (
              <ShowcaseCard key={kb.id} kb={kb} />
            ))}
          </div>

          {hasMore && (
            <div className="mt-8 flex justify-center">
              <button
                onClick={() => fetchPage(page + 1, true)}
                disabled={loadingMore}
                className="rounded-xl border border-gray-200 bg-white px-6 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:border-violet-300 hover:text-violet-600 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              >
                {loadingMore ? "Loading…" : `Load more (${boards.length} of ${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
