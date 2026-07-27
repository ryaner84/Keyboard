"use client";

import { useEffect, useRef, useState } from "react";
import {
  FieldBlock,
  ModalShell,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  useModalBodyLock,
} from "@/components/collection/ModalShell";
import { buildKeycapTemplateCsv, parseKeycapImportCsv } from "@/lib/csv";
import type {
  CommitImportResponse,
  ImportDecision,
  ImportOnExisting,
  ImportRowPayload,
  ImportSetSummary,
  ResolveImportResponse,
  ResolvedImportRow,
} from "@/lib/collection-import-types";

type Stage = "start" | "review" | "result";

interface RowDecision {
  action: "LINK" | "CUSTOM" | "IGNORE";
  slug?: string;
  onExisting?: ImportOnExisting;
  // A set the collector picked by hand for a row we could not match.
  picked?: ImportSetSummary;
}

function defaultDecision(row: ResolvedImportRow): RowDecision {
  switch (row.status) {
    case "MATCHED":
    case "AMBIGUOUS":
      return { action: "LINK", slug: row.match?.slug };
    case "ALREADY_IN_COLLECTION":
      return { action: "LINK", slug: row.match?.slug, onExisting: "APPEND" };
    case "UNMATCHED":
      return { action: "CUSTOM" };
    default:
      return { action: "IGNORE" };
  }
}

function downloadTemplate() {
  const blob = new Blob([buildKeycapTemplateCsv()], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "keycap-collection-template.csv";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// Inline catalog search so an unmatched row can still be linked to a real set
// (rather than only offering "add as custom").
function SetSearchPicker({
  onPick,
  onCancel,
}: {
  onPick: (set: ImportSetSummary) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ImportSetSummary[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(search)}&type=KEYCAPS&limit=8`,
          { signal: controller.signal }
        );
        const payload = await response.json();
        if (response.ok) setResults(payload.results ?? []);
      } catch {
        /* aborted or offline — leave the previous results */
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="mt-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search the keycap catalog…"
        className={inputClass}
      />
      <div className="mt-2 max-h-40 overflow-y-auto">
        {searching && results.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-gray-400">Searching…</p>
        )}
        {results.map((result) => (
          <button
            key={result.slug}
            type="button"
            onClick={() => onPick(result)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-white/5"
          >
            <span className="truncate font-medium text-gray-800 dark:text-gray-100">
              {result.name}
            </span>
          </button>
        ))}
        {!searching && query.trim().length >= 2 && results.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-gray-400">No catalog matches.</p>
        )}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="mt-1 text-[11px] font-semibold text-gray-500 hover:text-gray-900 dark:hover:text-white"
      >
        Cancel
      </button>
    </div>
  );
}

const STATUS_META: Record<
  ResolvedImportRow["status"],
  { label: string; tone: string }
> = {
  MATCHED: {
    label: "Matched",
    tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  AMBIGUOUS: {
    label: "Check match",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  },
  UNMATCHED: {
    label: "Not in catalog",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  },
  ALREADY_IN_COLLECTION: {
    label: "Already owned",
    tone: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  },
  INVALID: {
    label: "Needs fixing",
    tone: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  },
};

export function ImportKeycapsModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  // Parent refreshes the collection and shows the toast.
  onImported: (summary: CommitImportResponse["summary"]) => Promise<void>;
}) {
  useModalBodyLock();
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("start");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ResolvedImportRow[]>([]);
  const [payloads, setPayloads] = useState<Map<number, ImportRowPayload>>(new Map());
  const [summary, setSummary] = useState<ResolveImportResponse["summary"] | null>(null);
  const [decisions, setDecisions] = useState<Record<number, RowDecision>>({});
  const [searchingLine, setSearchingLine] = useState<number | null>(null);
  const [allPrivate, setAllPrivate] = useState(false);
  const [result, setResult] = useState<CommitImportResponse | null>(null);

  function setDecision(line: number, patch: Partial<RowDecision>) {
    setDecisions((current) => ({ ...current, [line]: { ...current[line], ...patch } }));
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const text = await file.text();
      const parsed = parseKeycapImportCsv(text);
      if (parsed.fileErrors.length > 0) throw new Error(parsed.fileErrors[0]);
      if (parsed.rows.length === 0) throw new Error("That file has no rows to import.");

      const response = await fetch("/api/tracker/items/import/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed.rows }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not read that file");

      const resolved = data as ResolveImportResponse;
      setRows(resolved.rows);
      setSummary(resolved.summary);
      setPayloads(new Map(parsed.rows.map((row) => [row.line, row])));
      setDecisions(
        Object.fromEntries(resolved.rows.map((row) => [row.line, defaultDecision(row)]))
      );
      setFileName(file.name);
      setStage("review");
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "Could not read that file"
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const importable = rows.filter((row) => decisions[row.line]?.action !== "IGNORE");

  async function commit() {
    setBusy(true);
    setError("");
    try {
      const body: { allPrivate: boolean; decisions: ImportDecision[] } = {
        allPrivate,
        decisions: rows.flatMap((row) => {
          const decision = decisions[row.line];
          const payload = payloads.get(row.line);
          if (!decision || !payload || decision.action === "IGNORE") return [];
          return [
            {
              line: row.line,
              action: decision.action,
              slug: decision.slug,
              onExisting: decision.onExisting,
              row: payload,
            },
          ];
        }),
      };
      const response = await fetch("/api/tracker/items/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Import failed");
      setResult(data as CommitImportResponse);
      setStage("result");
      await onImported((data as CommitImportResponse).summary);
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} label="Import keycaps from CSV" wide={stage === "review"}>
      <div className="border-b border-gray-100 px-5 py-5 dark:border-white/10 sm:px-7">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          Bulk add
        </p>
        <h2 className="mt-1 text-lg font-semibold text-gray-950 dark:text-white">
          Import keycaps from a spreadsheet
        </h2>
        {stage === "review" && fileName && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {fileName} · {rows.length} row{rows.length === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {stage === "start" && (
        <div className="px-5 py-6 sm:px-7">
          <ol className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#f7f1e5] text-xs font-bold text-[#80632f] dark:bg-[#2b251b] dark:text-[#dfc284]">
                1
              </span>
              <span>
                Download the template. <strong>Only the set name is required</strong> — leave
                anything you don&apos;t track blank.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#f7f1e5] text-xs font-bold text-[#80632f] dark:bg-[#2b251b] dark:text-[#dfc284]">
                2
              </span>
              <span>Fill in one row per set you own, in Excel or Google Sheets.</span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#f7f1e5] text-xs font-bold text-[#80632f] dark:bg-[#2b251b] dark:text-[#dfc284]">
                3
              </span>
              <span>
                Upload it. You&apos;ll review every row and confirm before anything is added.
              </span>
            </li>
          </ol>

          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={downloadTemplate} className={secondaryButtonClass}>
              Download template
            </button>
            <FieldBlock label="">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className={primaryButtonClass}
              >
                {busy ? "Reading…" : "Upload CSV"}
              </button>
            </FieldBlock>
          </div>

          {error && (
            <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {stage === "review" && summary && (
        <>
          <div className="border-b border-gray-100 px-5 py-4 dark:border-white/10 sm:px-7">
            <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                {summary.matched} matched
              </span>
              {summary.needsReview > 0 && (
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  {summary.needsReview} need review
                </span>
              )}
              {summary.alreadyOwned > 0 && (
                <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                  {summary.alreadyOwned} already owned
                </span>
              )}
              {summary.invalid > 0 && (
                <span className="rounded-full bg-red-100 px-2.5 py-1 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                  {summary.invalid} need fixing
                </span>
              )}
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={allPrivate}
                onChange={(event) => setAllPrivate(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Keep all imported sets private (they are added to your public display by default;
              purchase prices always stay hidden)
            </label>
          </div>

          <div className="max-h-[52vh] overflow-y-auto px-5 py-4 sm:px-7">
            <div className="space-y-2">
              {rows.map((row) => {
                const decision = decisions[row.line] ?? defaultDecision(row);
                const meta = STATUS_META[row.status];
                const ignored = decision.action === "IGNORE";
                const options = [
                  ...(row.match ? [row.match] : []),
                  ...row.candidates,
                  ...(decision.picked ? [decision.picked] : []),
                ].filter(
                  (option, index, all) =>
                    all.findIndex((other) => other.slug === option.slug) === index
                );

                return (
                  <div
                    key={row.line}
                    className={`rounded-xl border p-3 transition ${
                      ignored
                        ? "border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-white/[0.03]"
                        : "border-gray-200 dark:border-gray-700"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                          {row.name || <span className="italic text-gray-400">(no name)</span>}
                        </p>
                        <p className="text-[10px] text-gray-400">Row {row.line}</p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.tone}`}
                      >
                        {meta.label}
                      </span>
                    </div>

                    {row.errors.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {row.errors.map((message) => (
                          <li key={message} className="text-[11px] text-red-600 dark:text-red-400">
                            • {message}
                          </li>
                        ))}
                      </ul>
                    )}

                    {row.status !== "INVALID" && (
                      <div className="mt-2 space-y-2">
                        {/* Which set this row becomes */}
                        <div className="flex flex-wrap items-center gap-2">
                          {options.length > 0 && (
                            <select
                              value={decision.action === "LINK" ? decision.slug ?? "" : ""}
                              onChange={(event) =>
                                setDecision(row.line, {
                                  action: "LINK",
                                  slug: event.target.value,
                                })
                              }
                              className="max-w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                            >
                              <option value="" disabled>
                                Choose a set…
                              </option>
                              {options.map((option) => (
                                <option key={option.slug} value={option.slug}>
                                  {option.name}
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setSearchingLine(searchingLine === row.line ? null : row.line)
                            }
                            className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:border-[#c9ab72] dark:border-gray-700 dark:text-gray-300"
                          >
                            {options.length > 0 ? "Pick another set" : "Pick a set"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDecision(row.line, { action: "CUSTOM" })}
                            aria-pressed={decision.action === "CUSTOM"}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                              decision.action === "CUSTOM"
                                ? "border-[#9a7a42] bg-[#9a7a42] text-white"
                                : "border-gray-200 text-gray-600 hover:border-[#c9ab72] dark:border-gray-700 dark:text-gray-300"
                            }`}
                          >
                            Add as custom
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              // Re-including restores what the row would have
                              // done by default (custom for an unmatched name,
                              // link for a matched one) rather than forcing LINK.
                              setDecisions((current) => ({
                                ...current,
                                [row.line]: ignored
                                  ? { ...defaultDecision(row), ...(decision.picked ? { action: "LINK", slug: decision.slug, picked: decision.picked } : {}) }
                                  : { ...current[row.line], action: "IGNORE" },
                              }))
                            }
                            className="rounded-full px-2 py-1 text-[11px] font-semibold text-gray-500 hover:text-red-600"
                          >
                            {ignored ? "Include" : "Ignore"}
                          </button>
                        </div>

                        {searchingLine === row.line && (
                          <SetSearchPicker
                            onCancel={() => setSearchingLine(null)}
                            onPick={(set) => {
                              setDecision(row.line, {
                                action: "LINK",
                                slug: set.slug,
                                picked: set,
                              });
                              setSearchingLine(null);
                            }}
                          />
                        )}

                        {/* Already-owned rows choose append vs replace. Only a
                            set with existing purchases makes the choice real. */}
                        {row.status === "ALREADY_IN_COLLECTION" &&
                          !ignored &&
                          (row.existingPurchaseCount ?? 0) > 0 && (
                          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-indigo-50/60 px-2.5 py-2 text-[11px] dark:bg-indigo-950/20">
                            <span className="text-gray-600 dark:text-gray-300">
                              You already own this ({row.existingPurchaseCount ?? 0} purchase
                              {row.existingPurchaseCount === 1 ? "" : "s"}):
                            </span>
                            {(
                              [
                                ["APPEND", "Add as new purchase"],
                                ["REPLACE", "Replace purchases"],
                              ] as const
                            ).map(([value, label]) => (
                              <label key={value} className="flex items-center gap-1.5">
                                <input
                                  type="radio"
                                  name={`existing-${row.line}`}
                                  checked={(decision.onExisting ?? "APPEND") === value}
                                  onChange={() =>
                                    setDecision(row.line, { onExisting: value })
                                  }
                                />
                                <span
                                  className={
                                    value === "REPLACE"
                                      ? "text-red-600 dark:text-red-400"
                                      : "text-gray-700 dark:text-gray-200"
                                  }
                                >
                                  {label}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-4 dark:border-white/10 sm:px-7">
            {error ? (
              <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
            ) : (
              <span className="text-[11px] text-gray-400">
                Nothing is added until you confirm.
              </span>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={secondaryButtonClass}>
                Cancel
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={busy || importable.length === 0}
                className={primaryButtonClass}
              >
                {busy ? "Importing…" : `Import ${importable.length} set${importable.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {stage === "result" && result && (
        <>
          <div className="max-h-[52vh] overflow-y-auto px-5 py-5 sm:px-7">
            <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                {result.summary.added} added
              </span>
              {result.summary.appended > 0 && (
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-600 dark:bg-white/10 dark:text-gray-300">
                  {result.summary.appended} purchase added
                </span>
              )}
              {result.summary.replaced > 0 && (
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-600 dark:bg-white/10 dark:text-gray-300">
                  {result.summary.replaced} replaced
                </span>
              )}
              {result.summary.ignored > 0 && (
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-500 dark:bg-white/10 dark:text-gray-400">
                  {result.summary.ignored} skipped
                </span>
              )}
              {result.summary.failed > 0 && (
                <span className="rounded-full bg-red-100 px-2.5 py-1 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                  {result.summary.failed} failed
                </span>
              )}
            </div>

            {result.results.some((row) => !row.ok) && (
              <div className="mt-4">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                  These rows could not be imported
                </p>
                <ul className="mt-2 space-y-1">
                  {result.results
                    .filter((row) => !row.ok)
                    .map((row) => (
                      <li key={row.line} className="text-[11px] text-red-600 dark:text-red-400">
                        Row {row.line} · {row.name} — {row.error}
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex justify-end border-t border-gray-100 px-5 py-4 dark:border-white/10 sm:px-7">
            <button type="button" onClick={onClose} className={primaryButtonClass}>
              Done
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
