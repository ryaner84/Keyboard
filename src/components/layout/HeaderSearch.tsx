"use client";

// Global set search — command-palette style. A search icon in the header
// opens an overlay with a debounced typeahead over every set (any status).
// Shortcuts: ⌘K / Ctrl+K or "/" to open, ↑↓ to move, Enter to go, Esc to close.
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useTrackedSets } from "@/hooks/useTrackedSets";

interface SearchResult {
  slug: string;
  name: string;
  designer: string | null;
  status: string;
  imageUrl: string | null;
  productType: string;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  ACTIVE_GB: { label: "Active GB", cls: "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-300" },
  INTEREST_CHECK: { label: "IC", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  SHIPPING: { label: "Shipping", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300" },
  IN_STOCK: { label: "In Stock", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300" },
  DELIVERED: { label: "Released", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-300" },
};

export function HeaderSearch() {
  const router = useRouter();
  const { isTracked, toggle } = useTrackedSets();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setHighlighted(0);
  }, []);

  // Global shortcuts: ⌘K / Ctrl+K or "/" (when not typing in a field).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      } else if (
        e.key === "/" &&
        !open &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  // Focus the input when the palette opens; lock body scroll behind it.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [open]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setHighlighted(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
        const data = await res.json();
        setResults(data.results ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  };

  const go = (slug: string) => {
    close();
    router.push(`/sets/${slug}`);
  };

  const showAllResults = () => {
    const search = query.trim();
    if (search.length < 2) return;
    close();
    router.push(`/search?q=${encodeURIComponent(search)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && query.trim().length >= 2) {
      e.preventDefault();
      showAllResults();
    }
  };

  return (
    <>
      {/* Trigger: icon-only on mobile, icon + hint on desktop */}
      <button
        onClick={() => setOpen(true)}
        title="Search sets (⌘K)"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-500 transition-colors text-sm text-gray-500 dark:text-gray-400"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <kbd className="hidden lg:inline text-[10px] text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5">
          ⌘K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 overflow-hidden">
            {/* Input row */}
            <div className="flex items-center gap-3 px-4 border-b border-gray-100 dark:border-gray-800">
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search sets, colorways, designers…"
                className="flex-1 py-3.5 text-sm bg-transparent text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none"
              />
              <button
                onClick={close}
                className="text-[10px] text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 hover:text-gray-600"
              >
                ESC
              </button>
            </div>

            {/* Results */}
            <div className="max-h-[55vh] overflow-y-auto">
              {query.trim().length < 2 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">
                  Type at least 2 characters to search every set — active, upcoming or released.
                </p>
              ) : searching && results.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">Searching…</p>
              ) : results.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 text-center">
                  No sets matching “{query.trim()}”
                </p>
              ) : (
                results.map((r, i) => {
                  const badge = STATUS_BADGE[r.status] ?? STATUS_BADGE.DELIVERED;
                  const tracked = isTracked(r.slug);
                  return (
                    <div
                      key={r.slug}
                      onMouseEnter={() => setHighlighted(i)}
                      className={`flex items-center gap-1 px-4 py-2.5 transition-colors ${
                        i === highlighted ? "bg-indigo-50 dark:bg-indigo-950/50" : ""
                      }`}
                    >
                      {/* Main clickable area — opens the set */}
                      <button
                        onClick={() => go(r.slug)}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left"
                      >
                        <div className="w-12 h-8 rounded-md bg-gray-100 dark:bg-gray-800 overflow-hidden flex-shrink-0 relative">
                          {r.imageUrl && (
                            <Image
                              src={r.imageUrl}
                              alt=""
                              fill
                              sizes="48px"
                              className="object-cover"
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{r.name}</p>
                          <p className="text-xs text-gray-400 truncate">
                            {r.productType === "KEYBOARD" ? "Keyboard" : "Keycap set"}
                            {r.designer ? ` · ${r.designer}` : ""}
                          </p>
                        </div>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </button>

                      {/* Track toggle — add/remove from My Collection without leaving search */}
                      <button
                        onClick={(e) => { e.stopPropagation(); toggle(r.slug); }}
                        title={tracked ? "Remove from My Collection" : "Add to My Collection"}
                        aria-label={tracked ? "Remove from My Collection" : "Add to My Collection"}
                        className={`p-1.5 rounded-lg flex-shrink-0 transition-colors ${
                          tracked
                            ? "text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/50"
                            : "text-gray-300 dark:text-gray-600 hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/50"
                        }`}
                      >
                        <svg className="w-4 h-4" fill={tracked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                        </svg>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            {query.trim().length >= 2 && (
              <button
                onClick={showAllResults}
                className="flex w-full items-center justify-between gap-3 border-t border-gray-100 bg-gray-50 px-4 py-3 text-left text-sm font-semibold text-indigo-700 hover:bg-indigo-50 dark:border-gray-800 dark:bg-gray-950 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
              >
                <span>
                  View full results for “{query.trim()}”
                  <span className="ml-2 font-normal text-gray-400">Compare before opening</span>
                </span>
                <span className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-500 dark:border-gray-700 dark:bg-gray-900">
                  ENTER
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
