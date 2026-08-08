"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SetCard } from "@/components/browse/SetCard";
import { KEYCAP_MAKER_LABELS, type KeycapMaker } from "@/lib/set-name";
import type { GroupBuyWithPricing } from "@/types";

const PAGE_SIZE = 12;
const CURRENT_YEAR = new Date().getFullYear();
const OLDEST_YEAR = 2015;

const ALL_MAKERS: KeycapMaker[] = ["GMK", "SP"];

const AVAILABILITY_TABS = [
  { value: "", label: "All" },
  { value: "available", label: "Available now" },
  { value: "soldout", label: "Sold out" },
] as const;

// Sorts are visible pills, not a dropdown — "Biggest savings" is a feature,
// and features hidden behind an unlabeled <select> don't exist to users.
const SORT_OPTIONS = [
  { value: "released-desc", label: "Newest" },
  { value: "price-asc", label: "Lowest price" },
  { value: "savings-desc", label: "💸 Biggest savings" },
  { value: "released-asc", label: "Oldest" },
  { value: "name", label: "A–Z" },
] as const;

export default function ReleasedContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const search = searchParams.get("search") ?? "";
  const availability = searchParams.get("availability") ?? "";
  const year = searchParams.get("year") ?? "";
  const designer = searchParams.get("designer") ?? "";
  const vendor = searchParams.get("vendor") ?? "";
  // Keycaps-only: a maker means nothing on the keyboards tab. A single-select
  // dropdown like designer/vendor/year, not pills — same row, same affordance.
  const maker = searchParams.get("maker") ?? "";
  // The two bargain-hunter toggles. Kept as separate params rather than folded
  // into `availability` because they compose: "on sale" AND "sold as a bundle"
  // is a legitimate, and interesting, combination.
  const onSale = searchParams.get("deals") === "1";
  const bundlesOnly = searchParams.get("bundles") === "1";
  const sortDefault = "released-desc";
  const sortBy = searchParams.get("sort") ?? sortDefault;

  const [sets, setSets] = useState<GroupBuyWithPricing[]>([]);
  const [deals, setDeals] = useState<GroupBuyWithPricing[]>([]);
  const [markdowns, setMarkdowns] = useState<GroupBuyWithPricing[]>([]);
  const [topDesigners, setTopDesigners] = useState<string[]>([]);
  const [topVendors, setTopVendors] = useState<Array<{ slug: string; name: string }>>([]);
  const [total, setTotal] = useState(0);
  const [totalReleased, setTotalReleased] = useState<number | null>(null);
  const [totalAvailable, setTotalAvailable] = useState<number | null>(null);
  const [totalOnSale, setTotalOnSale] = useState<number | null>(null);
  const [totalBundles, setTotalBundles] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [searchDraft, setSearchDraft] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the most recent fetch may write to state — guards against a slow
  // earlier response landing after a newer one and repainting stale results.
  const reqSeq = useRef(0);

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.replace(`/released?${params.toString()}`);
    },
    [searchParams, router]
  );

  // "On sale" means a vendor is discounting a set it will actually sell you, so
  // it and the "Sold out" tab are mutually exclusive by construction — leaving
  // both on would render an empty page that looks like a bug. Whichever the
  // user picked most recently wins, and the other clears.
  const toggleOnSale = useCallback(() => {
    updateParams({
      deals: onSale ? "" : "1",
      ...(!onSale && availability === "soldout" && { availability: "" }),
    });
  }, [updateParams, onSale, availability]);

  const setAvailability = useCallback(
    (value: string) => {
      updateParams({
        availability: value,
        ...(value === "soldout" && onSale && { deals: "" }),
      });
    },
    [updateParams, onSale]
  );

  const onSearchChange = (value: string) => {
    setSearchDraft(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateParams({ search: value }), 350);
  };

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      const seq = ++reqSeq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (availability) params.set("availability", availability);
      if (year) params.set("year", year);
      if (designer) params.set("designer", designer);
      if (vendor) params.set("vendor", vendor);
      if (maker) params.set("maker", maker);
      if (onSale) params.set("deals", "1");
      if (bundlesOnly) params.set("bundles", "1");
      params.set("sort", sortBy);
      params.set("page", String(pageNum));
      params.set("limit", String(PAGE_SIZE));

      try {
        const res = await fetch(`/api/released?${params}`);
        const data = await res.json();
        // Ignore this response if a newer request has since been issued.
        if (seq !== reqSeq.current) return;
        setSets((prev) => (append ? [...prev, ...(data.data ?? [])] : (data.data ?? [])));
        if (!append) {
          setDeals(data.deals ?? []);
          setMarkdowns(data.markdowns ?? []);
          if (data.topDesigners?.length) setTopDesigners(data.topDesigners);
          else setTopDesigners([]);
          if (data.topVendors?.length) setTopVendors(data.topVendors);
          else setTopVendors([]);
        }
        setTotal(data.total ?? 0);
        setTotalReleased(data.totalReleased ?? null);
        setTotalAvailable(data.totalAvailable ?? null);
        setTotalOnSale(data.totalOnSale ?? null);
        // Only sent when the API recomputed it; keep the last known count on
        // pages that don't, so the pill label doesn't blank out mid-browse.
        if (data.totalBundles != null) setTotalBundles(data.totalBundles);
        setPage(pageNum);
      } catch {
        if (seq === reqSeq.current && !append) setSets([]);
      } finally {
        if (seq === reqSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [search, availability, year, designer, vendor, sortBy, maker, onSale, bundlesOnly]
  );

  useEffect(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  const hasMore = sets.length < total;
  const hasFilters = !!(
    search || year || designer || vendor || availability || maker || onSale || bundlesOnly
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 px-6 py-8 sm:px-10 sm:py-10 mb-8">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              "radial-gradient(circle at 80% 20%, white 0%, transparent 45%), radial-gradient(circle at 10% 90%, white 0%, transparent 35%)",
          }}
        />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white backdrop-blur-sm">
            💸 Bargain
          </span>
          <h1 className="mt-3 text-2xl sm:text-3xl font-extrabold text-white">
            Keycap Bargains
          </h1>
          <p className="mt-2 text-emerald-50 text-sm sm:text-base max-w-2xl">
              <>
                Missed the group buy? These sets have finished their run —
                here&apos;s which ones vendors still stock, and where they&apos;re
                cheapest to you.{" "}
                <span className="font-semibold text-white">
                  Prices differ across stores — we find you the lowest.
                </span>
              </>
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <div className="bg-white/15 backdrop-blur-sm rounded-xl px-4 py-2">
              <p className="text-xl font-bold text-white leading-tight">
                {totalReleased ?? "—"}
              </p>
              <p className="text-[11px] text-emerald-100 uppercase tracking-wide">
                released sets
              </p>
            </div>
            {(
              <div className="bg-white/15 backdrop-blur-sm rounded-xl px-4 py-2">
                <p className="text-xl font-bold text-white leading-tight">
                  {totalAvailable ?? "—"}
                </p>
                <p className="text-[11px] text-emerald-100 uppercase tracking-wide">
                  buyable right now
                </p>
              </div>
            )}
            {/* Markdowns are the headline number on a bargain page, so the stat
                doubles as the shortcut into the filter. */}
            {!!totalOnSale && (
              <button
                onClick={() => toggleOnSale()}
                className={`text-left rounded-xl px-4 py-2 transition-colors ${
                  onSale
                    ? "bg-white text-rose-700 shadow-lg"
                    : "bg-rose-500/90 hover:bg-rose-500 text-white"
                }`}
              >
                <p className="text-xl font-bold leading-tight">🔻 {totalOnSale}</p>
                <p className="text-[11px] uppercase tracking-wide opacity-90">
                  {onSale ? "showing sale items" : "on sale today"}
                </p>
              </button>
            )}
          </div>
        </div>
      </div>


      {/* ── Controls ─────────────────────────────────────────────────────── */}
      {/* Row 1: availability (keycaps only) + search */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-3">
        {(
          <div className="inline-flex rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 flex-shrink-0">
            {AVAILABILITY_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setAvailability(tab.value)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  availability === tab.value
                    ? tab.value === "available"
                      ? "bg-emerald-600 text-white"
                      : tab.value === "soldout"
                        ? "bg-gray-700 text-white"
                        : "bg-indigo-600 text-white"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div className="relative flex-1 max-w-md">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
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
            placeholder="Search sets, colorways…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900 transition-colors"
          />
        </div>
      </div>

      {/* Row 1.5: the two bargain toggles.
          Deliberately NOT another <select> in the row below — a discount filter
          buried in "Any …" dropdowns reads as metadata, when it is the reason
          most people open this page. Given their own row, labelled with live
          counts, and coloured to match the badges the cards carry. */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-gray-400 mr-1">Show only</span>
        <button
          onClick={() => toggleOnSale()}
          aria-pressed={onSale}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
            onSale
              ? "bg-gradient-to-r from-rose-500 to-red-600 text-white border-transparent shadow-sm"
              : "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900 hover:border-rose-400"
          }`}
        >
          🔻 On sale
          {totalOnSale != null && (
            <span className={onSale ? "opacity-80" : "opacity-70"}>({totalOnSale})</span>
          )}
        </button>
        <button
          onClick={() => updateParams({ bundles: bundlesOnly ? "" : "1" })}
          aria-pressed={bundlesOnly}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
            bundlesOnly
              ? "bg-violet-600 text-white border-violet-600 shadow-sm"
              : "bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-400 border-violet-200 dark:border-violet-900 hover:border-violet-400"
          }`}
        >
          🎁 Base + extras
          {totalBundles != null && (
            <span className={bundlesOnly ? "opacity-80" : "opacity-70"}>({totalBundles})</span>
          )}
        </button>
        <span className="text-[11px] text-gray-400">
          {bundlesOnly
            ? "Listings that sell the base kit together with novelties, spacebars or alphas."
            : onSale
              ? "Vendors currently marking the set down from their own list price."
              : ""}
        </span>
      </div>

      {/* Row 2: designer + year + sort + clear */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={designer}
          onChange={(e) => updateParams({ designer: e.target.value })}
          className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:border-indigo-400"
        >
          <option value="">Any designer</option>
          {topDesigners.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>

        {(
          <select
            value={vendor}
            onChange={(e) => updateParams({ vendor: e.target.value })}
            className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:border-indigo-400"
          >
            <option value="">Any vendor</option>
            {topVendors.map((v) => (
              <option key={v.slug} value={v.slug}>
                {v.name}
              </option>
            ))}
          </select>
        )}

        <select
          value={year}
          onChange={(e) => updateParams({ year: e.target.value })}
          className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:border-indigo-400"
        >
          <option value="">Any year</option>
          {Array.from({ length: CURRENT_YEAR - OLDEST_YEAR + 1 }, (_, i) => CURRENT_YEAR - i).map(
            (y) => (
              <option key={y} value={String(y)}>
                Released {y}
              </option>
            )
          )}
        </select>

        {(
          <select
            value={maker}
            onChange={(e) => updateParams({ maker: e.target.value })}
            className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:border-indigo-400"
          >
            <option value="">Any maker</option>
            {ALL_MAKERS.map((m) => (
              <option key={m} value={m}>
                {KEYCAP_MAKER_LABELS[m]}
              </option>
            ))}
          </select>
        )}

        {hasFilters && (
          <button
            onClick={() => {
              setSearchDraft("");
              router.replace("/released");
            }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Clear filters
          </button>
        )}
      </div>

      {/* Row 3: sort — visible labeled pills so every sort is discoverable */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="flex items-center gap-1 text-xs text-gray-400 mr-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9M3 12h5m8-8v12m0 0l-4-4m4 4l4-4" />
          </svg>
          Sort by
        </span>
        {SORT_OPTIONS.map((opt) => {
          const active = sortBy === opt.value;
          const isSavings = opt.value === "savings-desc";
          return (
            <button
              key={opt.value}
              onClick={() => updateParams({ sort: opt.value })}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                active
                  ? isSavings
                    ? "bg-gradient-to-r from-amber-500 to-orange-500 text-white border-transparent shadow-sm"
                    : "bg-indigo-600 text-white border-indigo-600"
                  : isSavings
                    ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900 hover:border-amber-400"
                    : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-indigo-300 hover:text-indigo-600"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Designer quick-chips: top 12 most prolific designers as clickable pills */}
      {topDesigners.length > 0 && !search && (
        <div className="flex flex-wrap gap-2 mb-6">
          <span className="text-xs text-gray-400 self-center mr-1">Designer:</span>
          {topDesigners.slice(0, 12).map((d) => (
            <button
              key={d}
              onClick={() => updateParams({ designer: designer === d ? "" : d })}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                designer === d
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-indigo-300 hover:text-indigo-600"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      )}

      {/* ── Markdown rail — leads the page: a store cutting its own price is
             the sale a shopper is looking for. ─────────────────────────────── */}
      {!loading && markdowns.length > 0 && (
        <div className="mb-6 rounded-2xl border-2 border-rose-200 dark:border-rose-900 bg-gradient-to-br from-rose-50 via-red-50 to-rose-50 dark:from-rose-950/40 dark:via-red-950/30 dark:to-rose-950/40 p-5 sm:p-6">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <span className="text-xl">🔻</span> On sale right now
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-rose-700 dark:text-rose-400 uppercase tracking-wide bg-rose-100 dark:bg-rose-900/60 px-2.5 py-1 rounded-full">
                Vendor markdowns
              </span>
              <button
                onClick={() => { if (!onSale) toggleOnSale(); }}
                className="text-xs font-semibold text-rose-700 dark:text-rose-400 hover:text-rose-900 dark:hover:text-rose-300 transition-colors"
              >
                See all {totalOnSale ?? ""} →
              </button>
            </div>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">
            These stores have cut their own list price — the struck-through
            number is what the set cost yesterday.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {markdowns.map((set) => (
              <SetCard key={set.id} set={set} />
            ))}
          </div>
        </div>
      )}

      {/* ── Deals rail (keycaps only) ────────────────────────────────────── */}
      {!loading && deals.length > 0 && !search && !year && !designer && !vendor && !onSale && !bundlesOnly && availability !== "soldout" && (
        <div className="mb-10 rounded-2xl border-2 border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50 via-orange-50 to-amber-50 dark:from-amber-950/40 dark:via-orange-950/30 dark:to-amber-950/40 p-5 sm:p-6">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <span className="text-xl">🔥</span> Biggest savings right now
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide bg-amber-100 dark:bg-amber-900/60 px-2.5 py-1 rounded-full">
                Live price gaps
              </span>
              <button
                onClick={() => updateParams({ sort: "savings-desc" })}
                className="text-xs font-semibold text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-300 transition-colors"
              >
                View all →
              </button>
            </div>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">
            Same set, very different prices — these have the widest gap between
            the cheapest and priciest vendor today.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {deals.map((set) => (
              <SetCard key={set.id} set={set} />
            ))}
          </div>
        </div>
      )}

      {/* ── Result count ─────────────────────────────────────────────────── */}
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {loading
          ? "Loading…"
          : `${total} ${onSale ? "discounted " : ""}${bundlesOnly ? "bundled " : ""}set${total !== 1 ? "s" : ""}${designer ? ` by ${designer}` : ""}${
              vendor ? ` at ${topVendors.find((v) => v.slug === vendor)?.name ?? vendor}` : ""
            }${
              availability === "available"
                ? " you can buy right now"
                : availability === "soldout"
                  ? " not currently stocked"
                  : ""
            }${
              sortBy === "savings-desc"
                ? " — biggest vendor price gap first, so the 💸 Save % runs high to low"
                : ""
            }`}
      </p>

      {/* ── Grid ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden">
              <div className="aspect-video bg-gray-100 dark:bg-gray-800 animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-3/4" />
                <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : sets.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">⌨</p>
          <p className="font-medium text-gray-500 dark:text-gray-300">
            No released sets found
          </p>
          <p className="text-sm mt-1">
            {availability === "available"
              ? "Nothing matching your filters is in stock right now — try widening the year or clearing the search."
              : "Try adjusting your filters"}
          </p>
          {hasFilters && (
            <button
              onClick={() => { setSearchDraft(""); router.replace("/released"); }}
              className="mt-4 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
            >
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {sets.map((set) => (
              <SetCard key={set.id} set={set} />
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={() => fetchPage(page + 1, true)}
                disabled={loadingMore}
                className="px-6 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-700 dark:text-gray-200 hover:border-indigo-300 hover:text-indigo-600 transition-colors disabled:opacity-60"
              >
                {loadingMore
                  ? "Loading…"
                  : `Load more (${sets.length} of ${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
