"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import keyboardData from "@/data/keycap-visualizer/keyboards.json";
import packData from "@/data/keycap-visualizer/packs.json";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { KeyboardRender } from "./KeyboardRender";
import { HEX, LAYOUTS, type DesignPack, type Finish, type KeycapSet, type VisualizerKeyboard } from "@/lib/keycap-visualizer";
import type { GBStatus } from "@/types";

/** A visualizer colorway joined with its tracker row (status, display name). */
export type VisualizerSet = KeycapSet & { status: GBStatus | null };

interface Look {
  board: string;
  keycap: string;
  caseHex: string;
  caseName: string;
}

type Step = "keyboard" | "keycaps" | "case" | "packs";
type Family = "All" | "GMK" | "SP DCS";

const KEYBOARDS = keyboardData.keyboards as VisualizerKeyboard[];
const GENERIC = keyboardData.generic as VisualizerKeyboard[];
const GENERIC_FINISHES: Finish[] = keyboardData.genericFinishes;
const MAX_COMPARE = 3;
const NEW_DAYS = 7;
const STORAGE_KEY = "kbv-compare";

const STEPS: Array<{ value: Step; label: string; emoji: string }> = [
  { value: "keyboard", label: "Keyboard", emoji: "⌨️" },
  { value: "keycaps", label: "Keycaps", emoji: "🎨" },
  { value: "case", label: "Case finish", emoji: "🪵" },
  { value: "packs", label: "Design packs", emoji: "✨" },
];

const findBoard = (id: string) => KEYBOARDS.find((b) => b.id === id) ?? GENERIC.find((b) => b.id === id);
const finishesFor = (b: VisualizerKeyboard) => b.finishes ?? GENERIC_FINISHES;
const isNew = (date?: string) => !!date && (Date.now() - new Date(date).getTime()) / 864e5 <= NEW_DAYS;

function finishName(board: VisualizerKeyboard, hex: string) {
  return finishesFor(board).find((f) => f.hex.toLowerCase() === hex.toLowerCase())?.name ?? `Custom ${hex.toUpperCase()}`;
}

function SwatchDot({ colors, size = "lg" }: { colors: string[]; size?: "lg" | "sm" }) {
  const dim = size === "lg" ? "w-14 h-14" : "w-6 h-6";
  return (
    <span className={`relative block ${dim} rounded-full overflow-hidden ring-1 ring-black/10 shadow-sm`}>
      <span className="absolute inset-0" style={{ background: colors[0] }} />
      {colors[1] && <span className="absolute inset-0" style={{ background: colors[1], clipPath: "polygon(50% 50%,100% 0,100% 100%)" }} />}
      {colors[2] && <span className="absolute inset-0" style={{ background: colors[2], clipPath: "polygon(50% 50%,100% 100%,0 100%)" }} />}
    </span>
  );
}

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
    active ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"
  }`;

const card = (active: boolean) =>
  `text-left bg-white dark:bg-gray-900 rounded-2xl border p-3 flex flex-col gap-1.5 transition-all ${
    active
      ? "border-indigo-500 ring-1 ring-indigo-500"
      : "border-gray-100 dark:border-gray-800 hover:border-indigo-200 dark:hover:border-indigo-600 hover:shadow-md"
  }`;

export function KeycapVisualizer({ sets, initialSlug }: { sets: VisualizerSet[]; initialSlug?: string }) {
  const packs = useMemo(() => (packData.packs as DesignPack[]).filter((p) => sets.some((s) => s.id === p.keycap)), [sets]);
  const first = KEYBOARDS[0];
  const [look, setLook] = useState<Look>({
    board: first.id,
    keycap: (sets.find((s) => s.slug === initialSlug) ?? sets[0])?.id ?? "",
    caseHex: first.finishes![0].hex,
    caseName: first.finishes![0].name,
  });
  const [step, setStep] = useState<Step>("keycaps");
  const [family, setFamily] = useState<Family>("All");
  const [query, setQuery] = useState("");
  const [hexInput, setHexInput] = useState("");
  const [hexError, setHexError] = useState("");
  const [pack, setPack] = useState<string | null>(null);
  const [saved, setSaved] = useState<Look[]>([]);
  const [sameBoard, setSameBoard] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Look[];
      setSaved(stored.filter((l) => findBoard(l.board) && sets.some((s) => s.id === l.keycap)).slice(0, MAX_COMPARE));
    } catch {
      // storage unavailable: compare starts empty
    }
  }, [sets]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 2200);
    return () => clearTimeout(t);
  }, [notice]);

  const board = findBoard(look.board) ?? first;
  const caps = sets.find((s) => s.id === look.keycap) ?? sets[0];
  if (!caps) {
    return <p className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center text-gray-500">No keycap sets are ready to visualize yet.</p>;
  }

  const storeSaved = (next: Look[]) => {
    setSaved(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: compare lasts for this visit only
    }
  };

  const chooseBoard = (b: VisualizerKeyboard) => {
    const finishes = finishesFor(b);
    const keep = finishes.find((f) => f.hex.toLowerCase() === look.caseHex.toLowerCase());
    setLook({ ...look, board: b.id, caseHex: keep?.hex ?? finishes[0].hex, caseName: keep?.name ?? finishes[0].name });
    setPack(null);
  };

  const applyHex = () => {
    const v = hexInput.trim();
    if (!HEX.test(v.startsWith("#") ? v : `#${v}`)) {
      setHexError("Enter a 6-digit HEX code, like #1E1F22");
      return;
    }
    const hex = (v.startsWith("#") ? v : `#${v}`).toUpperCase();
    setLook({ ...look, caseHex: hex, caseName: finishName(board, hex) });
    setPack(null);
  };

  const saveLook = () => {
    if (saved.some((s) => JSON.stringify(s) === JSON.stringify(look))) return setNotice("This look is already in compare");
    if (saved.length >= MAX_COMPARE) return setNotice(`Compare holds ${MAX_COMPARE} looks — remove one first`);
    storeSaved([...saved, look]);
    setNotice(saved.length ? `${saved.length + 1} looks ready to compare` : "Saved — add another look to compare");
  };

  const q = query.trim().toLowerCase();
  const visibleSets = sets
    .filter((s) => family === "All" || s.family === family)
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded) || a.name.localeCompare(b.name));

  return (
    <section id="visualizer">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2 flex-wrap">
              <span>🎨</span> Visualize
              <span className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 text-xs font-semibold border border-indigo-100 dark:border-indigo-900">
                New
              </span>
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Try GMK and DCS sets on a keyboard before you buy — then compare up to {MAX_COMPARE} looks side by side.
            </p>
          </div>
          {saved.length > 0 && (
            <a href="#visualizer-compare" className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-medium">
              Compare ({saved.length}) →
            </a>
          )}
        </div>

        {/* Stage */}
        <div className="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-950 overflow-hidden">
          <div className="px-4 sm:px-8 pt-6 pb-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              {board.name} · {LAYOUTS[board.layout].label}
            </p>
            <h3 className="text-3xl sm:text-4xl font-extrabold text-gray-900 dark:text-white tracking-tight mt-1">{caps.name}</h3>
            <div className="flex items-center justify-center gap-2 mt-2 min-h-[26px]">
              {caps.status && <StatusBadge status={caps.status} size="sm" />}
              <span className="px-2 py-0.5 rounded-full text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300">
                {caps.family}
              </span>
              {isNew(caps.dateAdded) && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900">
                  Just added
                </span>
              )}
            </div>
            <div className="max-w-4xl mx-auto mt-5 transition-opacity">
              <KeyboardRender
                layout={board.layout}
                colors={caps.colors}
                profile={caps.profile}
                caseHex={look.caseHex}
                label={`${caps.name} on ${board.name}`}
              />
            </div>
            <p className="text-xs text-gray-400 mt-2">{look.caseName} case · colors are a close preview</p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-6 py-3 bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 dark:text-white truncate">{caps.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {board.name} · {look.caseName}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveLook}
                className="flex-1 sm:flex-none px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
              >
                Save to compare
              </button>
              <Link
                href={`/sets/${caps.slug}`}
                className="flex-1 sm:flex-none text-center px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors shadow-sm"
              >
                Compare prices →
              </Link>
            </div>
          </div>
        </div>

        {/* Steps */}
        <div className="mt-5 inline-flex flex-wrap rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 gap-1">
          {STEPS.map((s) => (
            <button key={s.value} onClick={() => setStep(s.value)} className={pill(step === s.value)}>
              <span className="mr-1">{s.emoji}</span>
              {s.label}
            </button>
          ))}
        </div>

        <div className="pt-4 min-h-[180px]">
          {step === "keyboard" && (
            <div className="space-y-5">
              {[{ title: "Popular keyboards", list: KEYBOARDS }, { title: "Not listed? Pick your layout", list: GENERIC }].map((group) => (
                <div key={group.title}>
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">{group.title}</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {group.list.map((b) => (
                      <button key={b.id} onClick={() => chooseBoard(b)} className={card(b.id === look.board)}>
                        <div className="rounded-xl bg-gray-50 dark:bg-gray-800 p-2">
                          <KeyboardRender
                            layout={b.layout}
                            colors={caps.colors}
                            profile={caps.profile}
                            caseHex={b.finishes ? b.finishes[0].hex : look.caseHex}
                            legends={false}
                            shadow={false}
                          />
                        </div>
                        <span className="flex items-center justify-between gap-1">
                          <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">{b.name}</span>
                          {isNew(b.dateAdded) && <span className="text-[10px] font-bold text-emerald-600">NEW</span>}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {LAYOUTS[b.layout].label} · {b.finishes ? `${b.finishes.length} finishes` : "any case color"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {step === "keycaps" && (
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="inline-flex rounded-xl border border-gray-200 dark:border-gray-700 p-1 gap-1">
                  {(["All", "GMK", "SP DCS"] as Family[]).map((f) => (
                    <button key={f} onClick={() => setFamily(f)} className={pill(family === f)}>
                      {f}
                    </button>
                  ))}
                </div>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search colorways"
                  className="w-full sm:w-56 sm:ml-auto px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-indigo-400"
                />
              </div>
              {visibleSets.length === 0 ? (
                <p className="text-sm text-gray-500">No colorways match that search.</p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-8 gap-x-2 gap-y-4">
                  {visibleSets.map((s) => {
                    const active = s.id === look.keycap;
                    return (
                      <button
                        key={s.id}
                        onClick={() => {
                          setLook({ ...look, keycap: s.id });
                          setPack(null);
                        }}
                        className="flex flex-col items-center gap-1.5 text-center group"
                      >
                        <span className={`rounded-full p-0.5 transition ${active ? "ring-2 ring-indigo-500" : "group-hover:scale-105"}`}>
                          <SwatchDot colors={[s.colors.alpha, s.colors.mod, s.colors.accent]} />
                        </span>
                        <span className={`text-xs leading-tight ${active ? "font-semibold text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"}`}>
                          {s.name.replace(/^GMK (CYL )?|^DCS /, "")}
                        </span>
                        {isNew(s.dateAdded) && <span className="text-[10px] font-bold text-emerald-600">NEW</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {step === "case" && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {board.finishes ? `${board.name} finishes` : "Case colors"}
              </p>
              <div className="flex flex-wrap gap-4">
                {finishesFor(board).map((f) => {
                  const active = f.hex.toLowerCase() === look.caseHex.toLowerCase();
                  return (
                    <button
                      key={f.hex}
                      onClick={() => {
                        setLook({ ...look, caseHex: f.hex, caseName: f.name });
                        setPack(null);
                      }}
                      className="flex flex-col items-center gap-1.5 w-20 text-center group"
                    >
                      <span className={`rounded-full p-0.5 transition ${active ? "ring-2 ring-indigo-500" : "group-hover:scale-105"}`}>
                        <SwatchDot colors={[f.hex]} />
                      </span>
                      <span className={`text-xs ${active ? "font-semibold text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"}`}>{f.name}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  value={look.caseHex}
                  onChange={(e) => setLook({ ...look, caseHex: e.target.value, caseName: finishName(board, e.target.value) })}
                  aria-label="Pick a custom case color"
                  className="w-10 h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent cursor-pointer"
                />
                <input
                  value={hexInput}
                  onChange={(e) => {
                    setHexInput(e.target.value);
                    setHexError("");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && applyHex()}
                  placeholder="#1E1F22"
                  maxLength={7}
                  aria-label="Custom case color HEX code"
                  className="w-28 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm uppercase text-gray-900 dark:text-white focus:outline-none focus:border-indigo-400"
                />
                <button onClick={applyHex} className="px-3 py-2 rounded-xl text-sm font-semibold border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:border-indigo-400">
                  Apply
                </button>
                {hexError && <span className="text-sm text-red-600">{hexError}</span>}
              </div>
            </div>
          )}

          {step === "packs" && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {packs.map((p) => {
                const s = sets.find((x) => x.id === p.keycap)!;
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      setLook({ ...look, keycap: p.keycap, caseHex: p.caseHex, caseName: p.caseName });
                      setPack(p.id);
                    }}
                    className={card(pack === p.id)}
                  >
                    <span className="flex gap-1">
                      {[p.caseHex, s.colors.alpha, s.colors.mod, s.colors.accent].map((c, i) => (
                        <SwatchDot key={i} colors={[c]} size="sm" />
                      ))}
                    </span>
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">{p.name}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{p.description}</span>
                    <span className="text-xs text-gray-400">
                      {s.name} · {p.caseName} case
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Compare */}
        {saved.length > 0 && (
          <div id="visualizer-compare" className="mt-8">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Compare looks</h3>
              <label className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <input type="checkbox" checked={sameBoard} onChange={(e) => setSameBoard(e.target.checked)} className="rounded" />
                Show all on {board.name}
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {saved.map((l, i) => {
                const s = sets.find((x) => x.id === l.keycap);
                const b = findBoard(sameBoard ? look.board : l.board);
                if (!s || !b) return null;
                return (
                  <div key={i} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-4 flex flex-col gap-2">
                    <div className="rounded-xl bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 p-3">
                      <KeyboardRender
                        layout={b.layout}
                        colors={s.colors}
                        profile={s.profile}
                        caseHex={sameBoard ? look.caseHex : l.caseHex}
                        shadow={false}
                        label={`${s.name} on ${b.name}`}
                      />
                    </div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 dark:text-white truncate">{s.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {b.name} · {sameBoard ? look.caseName : l.caseName}
                        </p>
                      </div>
                      {s.status && <StatusBadge status={s.status} size="sm" />}
                    </div>
                    <div className="flex gap-2 mt-1">
                      <button
                        onClick={() => {
                          setLook(l);
                          document.getElementById("visualizer")?.scrollIntoView({ behavior: "smooth" });
                        }}
                        className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:border-indigo-400"
                      >
                        View
                      </button>
                      <button
                        onClick={() => storeSaved(saved.filter((_, j) => j !== i))}
                        className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:border-red-300 hover:text-red-600"
                      >
                        Remove
                      </button>
                      <Link
                        href={`/sets/${s.slug}`}
                        className="flex-1 text-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700"
                      >
                        Prices
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {notice && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-gray-900 text-white text-sm shadow-lg">
          {notice}
        </div>
      )}
    </section>
  );
}
