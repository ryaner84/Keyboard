"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "@/context/LocationContext";
import { DISPLAY_CURRENCIES } from "@/data/countries";
import { useCurrency } from "@/hooks/useCurrency";
import { useTrackedSets } from "@/hooks/useTrackedSets";
import { normalizeImageUrl } from "@/lib/utils";
import { collectionSharePath } from "@/lib/collection-share";
import { convertCurrency, formatCurrency } from "@/lib/currency-utils";
import type {
  CollectionCatalogItem,
  CollectionItemDetails,
  CollectionProfile,
  CollectionUnit,
  GroupBuyWithPricing,
} from "@/types";

type CollectionTab = "collection" | "tracking" | "public";

const EMPTY_DETAILS: CollectionItemDetails = {
  isTracking: true,
  inCollection: false,
  isPublic: false,
  acquiredAt: null,
  condition: null,
  purchasePrice: null,
  purchaseCurrency: null,
  showPurchasePrice: false,
  switches: null,
  keycaps: null,
  buildDetails: null,
  notes: null,
  displayOrder: 0,
  color: null,
  quantity: 1,
  customImageUrl: null,
  units: null,
};

const EMPTY_UNIT: CollectionUnit = {
  acquiredAt: null,
  purchasePrice: null,
  purchaseCurrency: null,
  color: null,
  condition: null,
  switches: null,
  keycaps: null,
  buildDetails: null,
  notes: null,
  imageUrl: null,
};

const CONDITION_LABELS: Record<string, string> = {
  UNBUILT: "New / unbuilt",
  EXCELLENT: "Built · excellent",
  GOOD: "Good",
  FAIR: "Fair",
  PROJECT: "Project board",
};

interface SpendingMonth {
  key: string;
  label: string;
  shortLabel: string;
  amount: number;
  purchases: number;
}

interface CollectionSpending {
  total: number;
  averagePerUnit: number;
  pricedEntries: number;
  pricedUnits: number;
  missingPriceCount: number;
  missingDateCount: number;
  unconvertedCount: number;
  months: SpendingMonth[];
  activeMonths: number;
}

function calculateCollectionSpending(
  items: CollectionCatalogItem[],
  targetCurrency: string,
  rates: Record<string, number>
): CollectionSpending {
  // Every collection item counts toward the ledger — keyboards AND keycap
  // sets. This used to filter productType === "KEYBOARD", which silently
  // dropped keycap purchases (e.g. a set bought in JPY) from Total spent.
  const valuedItems = items;
  const now = new Date();
  const months: SpendingMonth[] = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - index), 1)
    );
    return {
      key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
      label: date.toLocaleDateString("en-SG", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
      shortLabel: date.toLocaleDateString("en-SG", {
        month: "short",
        timeZone: "UTC",
      }),
      amount: 0,
      purchases: 0,
    };
  });
  const monthByKey = new Map(months.map((month) => [month.key, month]));

  let total = 0;
  let pricedEntries = 0;
  let pricedUnits = 0;
  let missingPriceCount = 0;
  let missingDateCount = 0;
  let unconvertedCount = 0;

  for (const item of valuedItems) {
    for (const build of assembleBuilds(item.collection)) {
      const price = build.purchasePrice;
      const sourceCurrency = build.purchaseCurrency || targetCurrency;
      if (price == null) {
        missingPriceCount++;
        continue;
      }

      const canConvert =
        sourceCurrency === targetCurrency ||
        (Number.isFinite(rates[sourceCurrency]) &&
          Number.isFinite(rates[targetCurrency]));
      if (!canConvert) {
        unconvertedCount++;
        continue;
      }

      const convertedPrice =
        sourceCurrency === targetCurrency
          ? price
          : convertCurrency(price, sourceCurrency, targetCurrency, rates);
      total += convertedPrice;
      pricedEntries++;
      pricedUnits++;

      if (!build.acquiredAt) {
        missingDateCount++;
        continue;
      }
      const acquiredAt = new Date(build.acquiredAt);
      if (Number.isNaN(acquiredAt.getTime())) {
        missingDateCount++;
        continue;
      }
      const key = `${acquiredAt.getUTCFullYear()}-${String(
        acquiredAt.getUTCMonth() + 1
      ).padStart(2, "0")}`;
      const month = monthByKey.get(key);
      if (month) {
        month.amount += convertedPrice;
        month.purchases++;
      }
    }
  }

  return {
    total,
    averagePerUnit: pricedUnits > 0 ? total / pricedUnits : 0,
    pricedEntries,
    pricedUnits,
    missingPriceCount,
    missingDateCount,
    unconvertedCount,
    months,
    activeMonths: months.filter((month) => month.amount > 0).length,
  };
}

// Expand a collection record into per-build rows. Build 1 lives on the record's
// top-level fields; builds 2..N come from the `units` array. Always returns
// exactly `quantity` builds, padding with blanks if details are missing.
function assembleBuilds(c: CollectionItemDetails): CollectionUnit[] {
  const qty = Math.max(1, c.quantity || 1);
  const first: CollectionUnit = {
    acquiredAt: c.acquiredAt,
    purchasePrice: c.purchasePrice,
    purchaseCurrency: c.purchaseCurrency,
    color: c.color,
    condition: c.condition,
    switches: c.switches,
    keycaps: c.keycaps,
    buildDetails: c.buildDetails,
    notes: c.notes,
    imageUrl: c.customImageUrl,
  };
  const extra = Array.isArray(c.units)
    ? c.units.map((unit) => ({
        ...unit,
        // Records saved before per-build pricing used one shared purchase
        // record. Carry it into legacy extra builds until the owner edits them.
        acquiredAt:
          unit.acquiredAt === undefined ? c.acquiredAt : unit.acquiredAt,
        purchasePrice:
          unit.purchasePrice === undefined
            ? c.purchasePrice
            : unit.purchasePrice,
        purchaseCurrency:
          unit.purchaseCurrency === undefined
            ? c.purchaseCurrency
            : unit.purchaseCurrency,
      }))
    : [];
  const builds = [first, ...extra].slice(0, qty);
  while (builds.length < qty) builds.push({ ...EMPTY_UNIT });
  return builds;
}

function dateInputValue(value: Date | string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function BuildSummary({
  build,
  index,
  selected = false,
  onSelect,
}: {
  build: CollectionUnit;
  index: number;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const specs = [
    build.acquiredAt
      ? `Acquired ${new Date(build.acquiredAt).getFullYear()}`
      : null,
    build.purchasePrice != null
      ? `${build.purchaseCurrency || "USD"} ${build.purchasePrice.toLocaleString()}`
      : null,
    build.color,
    build.condition ? CONDITION_LABELS[build.condition] || build.condition : null,
    build.switches,
    build.keycaps,
  ].filter(Boolean) as string[];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full gap-3 rounded-xl border p-2.5 text-left transition ${
        selected
          ? "border-[#c9ab72] bg-[#faf6ed] shadow-[0_0_0_2px_rgba(201,171,114,0.12)] dark:border-[#80632f] dark:bg-[#2a241a]"
          : "border-transparent bg-gray-50 hover:border-gray-200 hover:bg-white dark:bg-white/[0.04] dark:hover:border-gray-700 dark:hover:bg-white/[0.07]"
      }`}
    >
      {build.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={build.imageUrl}
          alt={`Build ${index + 1}`}
          className="h-12 w-12 shrink-0 rounded-lg bg-gray-100 object-contain dark:bg-gray-800"
        />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gray-200 text-base text-gray-400 dark:bg-gray-800">
          ⌨
        </div>
      )}
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-gray-900 dark:text-white">
          Build {index + 1}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-gray-500 dark:text-gray-400">
          {specs.join(" · ") || "No details yet"}
        </p>
        {build.buildDetails && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-gray-400 dark:text-gray-500">
            {build.buildDetails}
          </p>
        )}
      </div>
      {selected && (
        <span className="ml-auto mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#9a7a42] text-white">
          <CheckIcon />
        </span>
      )}
    </button>
  );
}

// Downscale an uploaded image client-side to keep stored data URLs small.
const MAX_IMAGE_DIM = 1024;
const IMAGE_QUALITY = 0.82;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

type KeyboardPrediction = {
  bbox: [number, number, number, number];
  class: string;
  score: number;
};

type KeyboardDetector = {
  detect(
    input: HTMLImageElement,
    maxNumBoxes?: number,
    minScore?: number
  ): Promise<KeyboardPrediction[]>;
};

let keyboardDetectorPromise: Promise<KeyboardDetector> | null = null;

async function getKeyboardDetector(): Promise<KeyboardDetector> {
  if (!keyboardDetectorPromise) {
    keyboardDetectorPromise = (async () => {
      const [tf, cocoSsd] = await Promise.all([
        import("@tensorflow/tfjs"),
        import("@tensorflow-models/coco-ssd"),
      ]);
      await tf.ready();
      return cocoSsd.load({ base: "lite_mobilenet_v2" });
    })();
  }
  return keyboardDetectorPromise;
}

async function validateKeyboardPhoto(dataUrl: string): Promise<void> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new window.Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Could not inspect that image."));
    element.src = dataUrl;
  });

  let predictions: KeyboardPrediction[];
  try {
    const detector = await getKeyboardDetector();
    predictions = await detector.detect(image, 20, 0.2);
  } catch {
    keyboardDetectorPromise = null;
    throw new Error("The keyboard photo check is unavailable. Please try again.");
  }

  const imageArea = Math.max(1, image.naturalWidth * image.naturalHeight);
  const keyboardDetected = predictions.some((prediction) => {
    const [, , width, height] = prediction.bbox;
    const coverage = (width * height) / imageArea;
    return (
      prediction.class.toLowerCase() === "keyboard" &&
      prediction.score >= 0.2 &&
      coverage >= 0.02
    );
  });

  if (!keyboardDetected) {
    throw new Error(
      "We could not detect a keyboard in this photo. Use a clear image showing most of the board."
    );
  }
}

async function fileToResizedDataUrl(file: File): Promise<string> {
  const readDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new window.Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not read image"));
    el.src = readDataUrl;
  });
  let width = img.width;
  let height = img.height;
  if (Math.max(width, height) > MAX_IMAGE_DIM) {
    const scale = MAX_IMAGE_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return readDataUrl;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
}

function PhotoUploadField({
  value,
  fallback,
  onChange,
  onError,
}: {
  value: string | null;
  fallback: string | null;
  onChange: (value: string | null) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const preview = value || fallback;
  const hasCustom = !!value;

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onError("Please choose an image file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      onError("That file is too large. Choose a photo under 12 MB.");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      if (dataUrl.length > 2_000_000) {
        onError("That photo is too large even after resizing — try a smaller one.");
      } else {
        await validateKeyboardPhoto(dataUrl);
        onChange(dataUrl);
      }
    } catch (uploadError) {
      onError(
        uploadError instanceof Error
          ? uploadError.message
          : "Could not process that image."
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-20 w-24 shrink-0 overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-800">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Keyboard preview" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-2xl text-gray-300 dark:text-gray-600">
            ⌨
          </div>
        )}
      </div>
      <div className="min-w-0">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => handleFile(event.target.files?.[0])}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="rounded-full border border-gray-300 px-3.5 py-1.5 text-xs font-semibold text-gray-700 hover:border-gray-500 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
          >
            {busy ? "Checking photo…" : hasCustom ? "Replace photo" : "Upload your photo"}
          </button>
          {hasCustom && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-red-600"
            >
              Remove
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-gray-400">
          {hasCustom
            ? "Using your verified keyboard photo."
            : "Optional. A private on-device check confirms a keyboard is visible."}
        </p>
      </div>
    </div>
  );
}

type PurchaseCurrencyOption = {
  code: string;
  symbol: string;
  name: string;
};

function CurrencyCombobox({
  value,
  options,
  onChange,
}: {
  value: string;
  options: PurchaseCurrencyOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const active =
    options.find((option) => option.code === value) ??
    options[0] ?? {
      code: value || "USD",
      symbol: value || "$",
      name: "Selected currency",
    };
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      `${option.code} ${option.name} ${option.symbol}`
        .toLowerCase()
        .includes(normalizedQuery)
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlightedIndex(0);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  function selectCurrency(option: PurchaseCurrencyOption) {
    onChange(option.code);
    setOpen(false);
    setQuery("");
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setQuery("");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) =>
        Math.min(current + 1, Math.max(filteredOptions.length - 1, 0))
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter" && filteredOptions[highlightedIndex]) {
      event.preventDefault();
      selectCurrency(filteredOptions[highlightedIndex]);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls="collection-currency-options"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`${inputClass} flex min-h-[42px] items-center justify-between gap-2 text-left`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg bg-[#f4ecdc] px-1.5 text-xs font-bold text-[#80632f] dark:bg-[#362d1e] dark:text-[#dfc284]">
            {active.symbol}
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-bold leading-4 text-gray-950 dark:text-white">
              {active.code}
            </span>
            <span
              title={active.name}
              className="block truncate text-[10px] leading-3 text-gray-500 dark:text-gray-400"
            >
              {active.name}
            </span>
          </span>
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-full min-w-[260px] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-[#15181c] sm:left-auto sm:right-0 sm:w-80">
          <div className="border-b border-gray-100 p-2 dark:border-gray-700">
            <div className="relative">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-4.35-4.35m1.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlightedIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search USD, dollar, SGD..."
                aria-label="Search currencies"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-9 pr-3 text-sm text-gray-950 outline-none placeholder:text-gray-400 focus:border-[#9a7a42] focus:ring-2 focus:ring-[#9a7a42]/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </div>
          </div>

          <div
            id="collection-currency-options"
            role="listbox"
            className="max-h-64 overflow-y-auto p-1.5"
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option, index) => {
                const selected = option.code === active.code;
                const highlighted = index === highlightedIndex;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={option.code}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => selectCurrency(option)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      highlighted
                        ? "bg-[#f7f1e5] dark:bg-[#2b251b]"
                        : "hover:bg-gray-50 dark:hover:bg-gray-800"
                    }`}
                  >
                    <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 px-1.5 text-xs font-bold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                      {option.symbol}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-gray-950 dark:text-white">
                        {option.code}
                      </span>
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                        {option.name}
                      </span>
                    </span>
                    {selected && (
                      <svg
                        className="h-4 w-4 shrink-0 text-[#9a7a42]"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2.5}
                          d="M5 12l4 4 10-10"
                        />
                      </svg>
                    )}
                  </button>
                );
              })
            ) : (
              <p className="px-3 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
                No matching currency. Try a code such as USD or SGD.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BuildFields({
  build,
  fallbackImage,
  purchaseCurrencies,
  onChange,
  onError,
}: {
  build: CollectionUnit;
  fallbackImage: string | null;
  purchaseCurrencies: PurchaseCurrencyOption[];
  onChange: (patch: Partial<CollectionUnit>) => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#ddcfb4] bg-[#faf7f0] p-4 dark:border-[#4a3e29] dark:bg-[#211d16]">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#80632f] dark:text-[#d5b779]">
          Purchase record
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_190px]">
          <Field label="Acquired">
            <input
              type="date"
              value={dateInputValue(build.acquiredAt)}
              onChange={(event) =>
                onChange({ acquiredAt: event.target.value || null })
              }
              className={inputClass}
            />
          </Field>
          <Field label="Purchase price">
            <input
              type="number"
              min="0"
              step="0.01"
              value={build.purchasePrice ?? ""}
              onChange={(event) =>
                onChange({
                  purchasePrice:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                  purchaseCurrency:
                    build.purchaseCurrency ||
                    purchaseCurrencies[0]?.code ||
                    "USD",
                })
              }
              placeholder="Optional"
              className={inputClass}
            />
          </Field>
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-200">
              Currency
            </span>
            <CurrencyCombobox
              value={build.purchaseCurrency || purchaseCurrencies[0]?.code || "USD"}
              options={purchaseCurrencies}
              onChange={(purchaseCurrency) => onChange({ purchaseCurrency })}
            />
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-gray-500 dark:text-gray-400">
          Each build has its own purchase amount and date. These private values
          power your total and monthly trend.
        </p>
      </div>

      <Field label="Photo">
        <PhotoUploadField
          value={build.imageUrl}
          fallback={fallbackImage}
          onChange={(imageUrl) => onChange({ imageUrl })}
          onError={onError}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Color / variant">
          <input
            value={build.color || ""}
            onChange={(event) => onChange({ color: event.target.value })}
            placeholder="e.g. E-White, Black, Navy"
            className={inputClass}
          />
        </Field>
        <Field label="Condition">
          <select
            value={build.condition || ""}
            onChange={(event) => onChange({ condition: event.target.value || null })}
            className={inputClass}
          >
            <option value="">Not specified</option>
            {Object.entries(CONDITION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Switches">
          <input
            value={build.switches || ""}
            onChange={(event) => onChange({ switches: event.target.value })}
            placeholder="e.g. Cherry MX Blacks, lubed"
            className={inputClass}
          />
        </Field>
        <Field label="Keycaps">
          <input
            value={build.keycaps || ""}
            onChange={(event) => onChange({ keycaps: event.target.value })}
            placeholder="e.g. GMK Ishtar"
            className={inputClass}
          />
        </Field>
      </div>
      <Field label="Build specification">
        <textarea
          value={build.buildDetails || ""}
          onChange={(event) => onChange({ buildDetails: event.target.value })}
          placeholder="Plate, mounting configuration, stabilizers, foam, artisan details…"
          rows={3}
          className={inputClass}
        />
      </Field>
      <Field label="Private notes">
        <textarea
          value={build.notes || ""}
          onChange={(event) => onChange({ notes: event.target.value })}
          placeholder="Maintenance notes, serial number, provenance, or memories. Never shown publicly."
          rows={3}
          className={inputClass}
        />
      </Field>
    </div>
  );
}

export default function CollectionContent() {
  const searchParams = useSearchParams();
  const { countryCode, currency } = useLocation();
  const { rates, loading: ratesLoading } = useCurrency(currency);
  const {
    tracked,
    hydrated,
    authenticated,
    email,
    alertsEnabled,
    toggle,
    openSavePrompt,
  } = useTrackedSets();
  const [items, setItems] = useState<CollectionCatalogItem[]>([]);
  const [profile, setProfile] = useState<CollectionProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<CollectionTab>("collection");
  const [editingItem, setEditingItem] = useState<CollectionCatalogItem | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const findQuery = searchParams.get("find")?.trim().slice(0, 120) || "";
  const findQueryHandled = useRef(false);

  const legacySharedSlugs = useMemo(
    () => searchParams.get("sets")?.split(",").map((slug) => slug.trim()).filter(Boolean).slice(0, 100) ?? [],
    [searchParams]
  );
  const isLegacySharedView = legacySharedSlugs.length > 0;
  const slugKey = (isLegacySharedView ? legacySharedSlugs : tracked).join(",");

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      try {
        if (authenticated && !isLegacySharedView) {
          const response = await fetch("/api/tracker", {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("Collection request failed");
          const payload = await response.json();
          setItems(payload.data ?? []);
          setProfile(payload.user ?? null);
          return;
        }

        const slugs = isLegacySharedView ? legacySharedSlugs : tracked;
        if (slugs.length === 0) {
          setItems([]);
          setProfile(null);
          return;
        }
        const query = slugs.map((slug) => `slug=${encodeURIComponent(slug)}`).join("&");
        const response = await fetch(`/api/group-buys?${query}&limit=100`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Catalog request failed");
        const payload = await response.json();
        const order = new Map(slugs.map((slug, index) => [slug, index]));
        const catalog: CollectionCatalogItem[] = (payload.data ?? [])
          .map((item: GroupBuyWithPricing) => ({
            ...item,
            collection: { ...EMPTY_DETAILS },
          }))
          .sort(
            (a: CollectionCatalogItem, b: CollectionCatalogItem) =>
              (order.get(a.slug) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(b.slug) ?? Number.MAX_SAFE_INTEGER)
          );
        setItems(catalog);
        setProfile(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setNotice("The collection could not be loaded. Please refresh and try again.");
      } finally {
        setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [
    authenticated,
    hydrated,
    isLegacySharedView,
    legacySharedSlugs,
    slugKey,
    tracked,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (
      !hydrated ||
      !authenticated ||
      !findQuery ||
      findQueryHandled.current
    ) {
      return;
    }
    findQueryHandled.current = true;
    setCatalogPickerOpen(true);
  }, [authenticated, findQuery, hydrated]);

  const owned = useMemo(
    () =>
      items
        .filter((item) => item.collection.inCollection)
        .sort(
          (a, b) =>
            a.collection.displayOrder - b.collection.displayOrder ||
            a.name.localeCompare(b.name)
        ),
    [items]
  );
  const watching = useMemo(
    () => items.filter((item) => item.collection.isTracking),
    [items]
  );
  const publicItems = useMemo(
    () => owned.filter((item) => item.collection.isPublic),
    [owned]
  );
  const spending = useMemo(
    () => calculateCollectionSpending(owned, currency, rates),
    [currency, owned, rates]
  );
  const firstKeyboardMissingSpend = useMemo(
    () =>
      owned.find((item) =>
        assembleBuilds(item.collection).some(
          (build) => build.purchasePrice == null || !build.acquiredAt
        )
      ) ?? null,
    [owned]
  );

  const visibleItems =
    tab === "collection" ? owned : tab === "tracking" ? watching : publicItems;

  async function updateItem(
    item: CollectionCatalogItem,
    changes: Partial<CollectionItemDetails>
  ) {
    const response = await fetch(`/api/tracker/items/${encodeURIComponent(item.slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not update collection");
    setItems((current) =>
      current.map((candidate) =>
        candidate.slug === item.slug
          ? { ...candidate, collection: payload.collection }
          : candidate
      )
    );
    return payload.collection as CollectionItemDetails;
  }

  async function addToCollection(item: CollectionCatalogItem) {
    if (!authenticated) {
      openSavePrompt();
      return;
    }
    try {
      const details = await updateItem(item, {
        inCollection: true,
        isPublic: false,
      });
      setEditingItem({ ...item, collection: details });
      setTab("collection");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add this item");
    }
  }

  async function shareCollection() {
    if (!authenticated) {
      openSavePrompt();
      return;
    }
    if (owned.length === 0) {
      setNotice("Add a tracked item to your collection before creating a public display.");
      setTab(watching.length > 0 ? "tracking" : "collection");
      return;
    }
    setSharePickerOpen(true);
  }

  async function publishCollection(selectedSlugs: Set<string>) {
    try {
      const changedItems = owned.filter(
        (item) => item.collection.isPublic !== selectedSlugs.has(item.slug)
      );
      await Promise.all(
        changedItems.map((item) =>
          updateItem(item, { isPublic: selectedSlugs.has(item.slug) })
        )
      );

      const response = await fetch("/api/tracker", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionPublished: true,
          ensureCollectionSlug: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.user?.collectionSlug) {
        throw new Error(payload.error || "Could not publish the collection");
      }
      setProfile((current) =>
        current
          ? {
              ...current,
              ...payload.user,
            }
          : payload.user
      );
      const url = `${window.location.origin}${collectionSharePath(
        payload.user.collectionSlug,
        Date.now().toString(36)
      )}`;
      await navigator.clipboard.writeText(url);
      setSharePickerOpen(false);
      setTab("public");
      setNotice(
        `Fresh share link copied. Paste this new link into Discord or chat to load the latest collection poster. ${selectedSlugs.size} selected piece${
          selectedSlugs.size === 1 ? " is" : "s are"
        } visible publicly.`
      );
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Could not share the collection"
      );
    }
  }

  if (isLegacySharedView) {
    return (
      <LegacySharedCollection
        items={items}
        loading={loading}
        countryCode={countryCode}
      />
    );
  }

  const title = profile?.collectionTitle || "My keyboard collection";
  const owner = profile?.displayName || (authenticated ? "Private collector" : "Your collection");
  const authMessage = searchParams.get("auth");
  const alertMessage = searchParams.get("alerts");

  return (
    <main className="min-h-screen bg-[#f5f4f0] pb-16 dark:bg-[#090b0d]">
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
        {(authMessage === "verified" || alertMessage === "off") && (
          <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
            {authMessage === "verified"
              ? "Email verified. Your collection is now synced on this device."
              : "Collection email alerts are now off."}
          </div>
        )}
        {authMessage === "expired" && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            That sign-in link expired or was already used. Request a new code from the account button.
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="fixed bottom-5 left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 rounded-xl bg-gray-950 px-4 py-3 text-center text-sm font-medium text-white shadow-2xl dark:bg-white dark:text-gray-950"
          >
            {notice}
          </div>
        )}

        <section className="relative overflow-hidden rounded-[2rem] bg-[#111417] text-white shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
          <div className="absolute inset-0 opacity-70 [background:radial-gradient(circle_at_85%_15%,rgba(196,166,107,0.24),transparent_28%),radial-gradient(circle_at_8%_95%,rgba(79,70,229,0.18),transparent_30%)]" />
          <div className="relative grid min-h-[290px] gap-8 px-6 py-8 sm:px-9 sm:py-10 lg:grid-cols-[1fr_auto] lg:items-end lg:px-12">
            <div className="max-w-3xl">
              <div className="mb-8 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.26em] text-[#c9ab72]">
                <span className="h-px w-8 bg-[#c9ab72]" />
                Personal archive
              </div>
              <p className="text-sm text-white/55">{owner}</p>
              <h1 className="mt-2 max-w-2xl font-serif text-4xl leading-tight tracking-tight sm:text-5xl lg:text-6xl">
                {title}
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-6 text-white/60 sm:text-base">
                {profile?.collectionBio ||
                  "A considered record of boards collected, built, and enjoyed over time."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 lg:justify-end">
              {authenticated ? (
                <>
                  <button
                    onClick={() => setCatalogPickerOpen(true)}
                    className="rounded-full border border-white/20 bg-white px-4 py-2.5 text-sm font-semibold text-gray-950 hover:bg-[#f1e6cf]"
                  >
                    + Add a piece
                  </button>
                  <button
                    onClick={() => setEditingProfile(true)}
                    className="rounded-full border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-medium text-white backdrop-blur hover:bg-white/10"
                  >
                    Edit profile
                  </button>
                  <button
                    onClick={shareCollection}
                    className="rounded-full bg-[#c9ab72] px-5 py-2.5 text-sm font-semibold text-[#17130d] hover:bg-[#dbc18e]"
                  >
                    {publicItems.length > 0 ? "Manage & share" : "Choose & share"}
                  </button>
                </>
              ) : (
                <button
                  onClick={openSavePrompt}
                  className="rounded-full bg-[#c9ab72] px-5 py-2.5 text-sm font-semibold text-[#17130d] hover:bg-[#dbc18e]"
                >
                  Sign in to build your collection
                </button>
              )}
            </div>
          </div>

          <div className="relative grid grid-cols-3 border-t border-white/10 bg-black/15">
            <HeroStat value={owned.length} label="In collection" />
            <HeroStat value={watching.length} label="Tracking" border />
            <HeroStat value={publicItems.length} label="On display" border />
          </div>
        </section>

        {authenticated && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/5 bg-white/70 px-4 py-3 text-xs text-gray-500 backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-gray-400">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Synced to {profile?.email || email}
              </span>
              <span>Email alerts {profile?.alertsEnabled ?? alertsEnabled ? "on" : "off"}</span>
            </div>
            <span>
              {profile?.collectionPublished
                ? `${publicItems.length} piece${
                    publicItems.length === 1 ? "" : "s"
                  } visible on your public page`
                : "Public page not published"}
            </span>
          </div>
        )}

        {authenticated && owned.length > 0 && (
          <CollectionSpendingPanel
            spending={spending}
            currency={currency}
            loading={ratesLoading}
            onAddDetails={
              firstKeyboardMissingSpend
                ? () => setEditingItem(firstKeyboardMissingSpend)
                : undefined
            }
          />
        )}

        <section className="mt-10">
          <div className="flex flex-col gap-5 border-b border-black/10 pb-4 dark:border-white/10 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
                Collection cabinet
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">
                {tab === "collection"
                  ? "Owned pieces"
                  : tab === "tracking"
                    ? "Watching and considering"
                    : "Public display"}
              </h2>
            </div>
            <div className="flex rounded-full bg-black/5 p-1 dark:bg-white/10">
              <CollectionTabButton
                active={tab === "collection"}
                onClick={() => setTab("collection")}
                label="Collection"
                count={owned.length}
              />
              <CollectionTabButton
                active={tab === "tracking"}
                onClick={() => setTab("tracking")}
                label="Tracking"
                count={watching.length}
              />
              <CollectionTabButton
                active={tab === "public"}
                onClick={() => setTab("public")}
                label="Public"
                count={publicItems.length}
              />
            </div>
          </div>

          {authenticated && tab === "collection" && owned.length > 0 && (
            <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-[#ddcfb4] bg-[#faf7f0] px-5 py-4 dark:border-[#4a3e29] dark:bg-[#211d16] sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eadfc8] text-[#80632f] dark:bg-[#3a3020] dark:text-[#d7ba83]">
                  <EyeIcon />
                </span>
                <div>
                  <p className="text-sm font-semibold text-gray-950 dark:text-white">
                    {publicItems.length > 0
                      ? `${publicItems.length} piece${
                          publicItems.length === 1 ? "" : "s"
                        } selected for your public display`
                      : "Your owned pieces are private"}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-400">
                    Choose exactly which owned items visitors may see. Tracking and
                    private pieces are never included.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSharePickerOpen(true)}
                className="shrink-0 rounded-full bg-gray-950 px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#9a7a42] dark:bg-white dark:text-gray-950 dark:hover:bg-[#c9ab72]"
              >
                Choose display items
              </button>
            </div>
          )}

          {!hydrated || loading ? (
            <CollectionGridSkeleton />
          ) : visibleItems.length === 0 ? (
            <EmptyCollectionState
              tab={tab}
              authenticated={authenticated}
              hasTrackedItems={watching.length > 0}
              onSignIn={openSavePrompt}
              onShowTracking={() => setTab("tracking")}
            />
          ) : (
            <div className="mt-6 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {visibleItems.map((item) => (
                <CollectionCard
                  key={item.id}
                  item={item}
                  tab={tab}
                  countryCode={countryCode}
                  editable={authenticated}
                  onEdit={() => setEditingItem(item)}
                  onTogglePublic={async () => {
                    try {
                      await updateItem(item, {
                        isPublic: !item.collection.isPublic,
                      });
                      setNotice(
                        item.collection.isPublic
                          ? "Piece removed from your public display."
                          : "Piece added to your public display."
                      );
                    } catch (error) {
                      setNotice(
                        error instanceof Error
                          ? error.message
                          : "Could not update public visibility"
                      );
                    }
                  }}
                  onAdd={() => addToCollection(item)}
                  onRemove={() => {
                    toggle(item.slug);
                    setItems((current) => current.filter((candidate) => candidate.slug !== item.slug));
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {editingItem && (
        <CollectionItemEditor
          item={editingItem}
          defaultCurrency={currency}
          onClose={() => setEditingItem(null)}
          onSave={async (changes) => {
            try {
              await updateItem(editingItem, changes);
              setEditingItem(null);
              setNotice("Collection details saved.");
            } catch (error) {
              throw new Error(error instanceof Error ? error.message : "Could not save details");
            }
          }}
          onMoveToTracking={async () => {
            try {
              await updateItem(editingItem, { inCollection: false });
              setEditingItem(null);
              setTab("tracking");
              setNotice("Item removed from your collection. Tracking remains on.");
            } catch (error) {
              setNotice(error instanceof Error ? error.message : "Could not move this item");
            }
          }}
        />
      )}

      {editingProfile && profile && (
        <CollectionProfileEditor
          profile={profile}
          publicCount={publicItems.length}
          onClose={() => setEditingProfile(false)}
          onSave={async (changes) => {
            const response = await fetch("/api/tracker", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(changes),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "Could not save profile");
            setProfile((current) => (current ? { ...current, ...payload.user } : payload.user));
            setEditingProfile(false);
            setNotice("Collection profile saved.");
          }}
        />
      )}

      {sharePickerOpen && (
        <ShareCollectionPicker
          items={owned}
          profile={profile}
          onClose={() => setSharePickerOpen(false)}
          onPublish={publishCollection}
        />
      )}

      {catalogPickerOpen && (
        <CollectionCatalogPicker
          initialQuery={findQuery}
          existingItems={
            new Map(items.map((item) => [item.slug, item.collection]))
          }
          onClose={() => setCatalogPickerOpen(false)}
          onAdd={async (result, mode) => {
            const response = await fetch("/api/tracker/items", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ slug: result.slug }),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || "Could not save this catalog item");
            }
            if (mode === "collection") {
              const patchResponse = await fetch(
                `/api/tracker/items/${encodeURIComponent(result.slug)}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    inCollection: true,
                    isPublic: false,
                  }),
                }
              );
              const patchPayload = await patchResponse.json();
              if (!patchResponse.ok) {
                throw new Error(patchPayload.error || "Could not add to collection");
              }
            }

            const refreshed = await fetch("/api/tracker", { cache: "no-store" });
            const refreshedPayload = await refreshed.json();
            if (!refreshed.ok) throw new Error("Could not refresh collection");
            setItems(refreshedPayload.data ?? []);
            setProfile(refreshedPayload.user ?? profile);
            setTab(mode === "collection" ? "collection" : "tracking");
            setNotice(
              mode === "collection"
                ? `${result.name} added to your collection.`
                : `${result.name} added to tracking.`
            );
          }}
        />
      )}
    </main>
  );
}

function CollectionSpendingPanel({
  spending,
  currency,
  loading,
  onAddDetails,
}: {
  spending: CollectionSpending;
  currency: string;
  loading: boolean;
  onAddDetails?: () => void;
}) {
  const maxMonth = Math.max(...spending.months.map((month) => month.amount), 1);
  const hasSpend = spending.pricedEntries > 0;
  const completionMessage =
    spending.missingPriceCount > 0
      ? `${spending.missingPriceCount} build${
          spending.missingPriceCount === 1 ? "" : "s"
        } missing a purchase price`
      : spending.missingDateCount > 0
        ? `${spending.missingDateCount} priced purchase${
            spending.missingDateCount === 1 ? "" : "s"
          } missing an acquisition date`
        : null;

  return (
    <section
      data-testid="collection-spending"
      className="mt-6 overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_18px_60px_rgba(29,25,18,0.06)] dark:border-white/10 dark:bg-[#111417]"
    >
      <div className="grid lg:grid-cols-[0.82fr_1.18fr]">
        <div className="border-b border-black/[0.07] p-5 dark:border-white/10 sm:p-7 lg:border-b-0 lg:border-r">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
                <SpendIcon />
                Collection spend
              </div>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-gray-950 dark:text-white">
                Your keyboard investment
              </h2>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1.5 text-[10px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-300">
              <PrivateIcon />
              Private
            </span>
          </div>

          <div className="mt-7">
            <p className="text-xs font-medium text-gray-400">Recorded total</p>
            {loading ? (
              <div className="mt-2 h-12 w-48 animate-pulse rounded-lg bg-gray-100 dark:bg-white/10" />
            ) : (
              <p className="mt-1 font-serif text-4xl tracking-tight text-gray-950 dark:text-white sm:text-5xl">
                {formatCurrency(spending.total, currency)}
              </p>
            )}
            <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">
              Sum of each build’s recorded purchase price, converted to {currency}.
            </p>
          </div>

          <dl className="mt-7 grid grid-cols-3 gap-3 border-t border-gray-100 pt-5 dark:border-white/10">
            <SpendStat
              label="Units valued"
              value={loading ? "—" : String(spending.pricedUnits)}
            />
            <SpendStat
              label="Average"
              value={
                loading || !hasSpend
                  ? "—"
                  : formatCurrency(spending.averagePerUnit, currency)
              }
            />
            <SpendStat
              label="Active months"
              value={loading ? "—" : String(spending.activeMonths)}
            />
          </dl>

          {(completionMessage || spending.unconvertedCount > 0 || !hasSpend) && (
            <div className="mt-5 rounded-xl bg-[#f7f3ea] px-4 py-3 dark:bg-[#211d16]">
              <p className="text-xs font-semibold text-[#725729] dark:text-[#d5b779]">
                {!hasSpend ? "Start your private spend history" : "Complete your ledger"}
              </p>
              <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-400">
                {!hasSpend
                  ? "Add a purchase price and acquisition date from any item’s Edit details panel."
                  : completionMessage ||
                    `${spending.unconvertedCount} purchase could not be converted yet.`}
              </p>
              {onAddDetails && (
                <button
                  type="button"
                  onClick={onAddDetails}
                  className="mt-3 text-xs font-semibold text-[#80632f] underline decoration-[#c9ab72]/60 underline-offset-4 hover:text-gray-950 dark:text-[#d5b779] dark:hover:text-white"
                >
                  Add missing purchase details
                </button>
              )}
            </div>
          )}
        </div>

        <div className="p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                Monthly trend
              </p>
              <h3 className="mt-1 text-lg font-semibold text-gray-950 dark:text-white">
                Purchases over the last 12 months
              </h3>
            </div>
            <p className="text-xs text-gray-400">
              Based on acquisition date · {currency}
            </p>
          </div>

          <div className="mt-7 overflow-x-auto pb-1">
            <div className="grid min-w-[610px] grid-cols-12 gap-2" role="img" aria-label="Monthly keyboard spending over the last twelve months">
              {spending.months.map((month) => {
                const height =
                  month.amount > 0
                    ? Math.max(10, Math.round((month.amount / maxMonth) * 100))
                    : 3;
                return (
                  <div key={month.key} className="flex min-w-0 flex-col items-center">
                    <div className="flex h-36 w-full items-end justify-center rounded-lg bg-gray-50 px-1.5 pt-3 dark:bg-white/[0.035]">
                      <div
                        title={`${month.label}: ${formatCurrency(
                          month.amount,
                          currency
                        )}`}
                        aria-label={`${month.label}: ${formatCurrency(
                          month.amount,
                          currency
                        )}`}
                        className={`w-full rounded-t-md transition-[height] ${
                          month.amount > 0
                            ? "bg-gradient-to-t from-[#8b6d38] to-[#d8bd87]"
                            : "bg-gray-200 dark:bg-white/10"
                        }`}
                        style={{ height: `${height}%` }}
                      />
                    </div>
                    <span className="mt-2 text-[9px] font-semibold uppercase tracking-wide text-gray-400">
                      {month.shortLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4 text-xs text-gray-500 dark:border-white/10 dark:text-gray-400">
            <span>
              {spending.activeMonths > 0
                ? `${spending.activeMonths} month${
                    spending.activeMonths === 1 ? "" : "s"
                  } with recorded purchases`
                : "Add acquisition dates to populate the trend"}
            </span>
            {spending.missingDateCount > 0 && (
              <span>
                {spending.missingDateCount} priced purchase
                {spending.missingDateCount === 1 ? "" : "s"} not charted
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SpendStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] font-semibold uppercase tracking-[0.13em] text-gray-400">
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm font-semibold text-gray-900 dark:text-white">
        {value}
      </dd>
    </div>
  );
}

function HeroStat({
  value,
  label,
  border = false,
}: {
  value: number;
  label: string;
  border?: boolean;
}) {
  return (
    <div className={`px-5 py-5 text-center sm:px-8 ${border ? "border-l border-white/10" : ""}`}>
      <strong className="block font-serif text-2xl font-normal sm:text-3xl">{value}</strong>
      <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">
        {label}
      </span>
    </div>
  );
}

function SpendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 7.5h16v11H4zM7 7.5V5.8C7 4.8 7.8 4 8.8 4h6.4c1 0 1.8.8 1.8 1.8v1.7M8 13h8m-4-2v4"
      />
    </svg>
  );
}

function PrivateIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 10V8a5 5 0 0 1 10 0v2m-11 0h12v10H6z"
      />
    </svg>
  );
}

function CollectionTabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-2 text-xs font-semibold transition sm:px-4 ${
        active
          ? "bg-white text-gray-950 shadow-sm dark:bg-gray-800 dark:text-white"
          : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
      }`}
    >
      {label} <span className="ml-1 opacity-55">{count}</span>
    </button>
  );
}

function CollectionCard({
  item,
  tab,
  countryCode,
  editable,
  onEdit,
  onTogglePublic,
  onAdd,
  onRemove,
}: {
  item: CollectionCatalogItem;
  tab: CollectionTab;
  countryCode: string;
  editable: boolean;
  onEdit: () => void;
  onTogglePublic: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const owned = item.collection.inCollection;
  const builds = assembleBuilds(item.collection);
  const multiBuild = builds.length > 1;
  const [activeBuildIndex, setActiveBuildIndex] = useState(0);
  const visibleBuildIndex = Math.min(activeBuildIndex, builds.length - 1);
  const activeBuild = builds[visibleBuildIndex];
  const catalogImageUrl = normalizeImageUrl(item.imageUrl);
  const imageUrl = multiBuild
    ? activeBuild?.imageUrl ||
      (visibleBuildIndex === 0 ? catalogImageUrl : null)
    : item.collection.customImageUrl || catalogImageUrl;
  // Owner-uploaded photos come in arbitrary aspect ratios — show the WHOLE
  // photo in proportion (object-contain against the card's muted backdrop)
  // instead of cropping it. Catalog renders are pre-framed, so cover is right.
  const isUserPhoto = multiBuild
    ? Boolean(activeBuild?.imageUrl)
    : Boolean(item.collection.customImageUrl);
  const details = [
    item.collection.color && { label: "Color", value: item.collection.color },
    item.collection.switches && { label: "Switches", value: item.collection.switches },
    item.collection.keycaps && { label: "Keycaps", value: item.collection.keycaps },
  ].filter(Boolean) as Array<{ label: string; value: string }>;
  const summaryColor = multiBuild ? activeBuild?.color : item.collection.color;
  const summaryCondition = multiBuild
    ? activeBuild?.condition
    : item.collection.condition;
  const summaryAcquiredAt = multiBuild
    ? activeBuild?.acquiredAt
    : item.collection.acquiredAt;
  const acquiredYear = summaryAcquiredAt
    ? new Date(summaryAcquiredAt).getFullYear()
    : null;

  return (
    <article className="group overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_10px_35px_rgba(25,22,16,0.05)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_50px_rgba(25,22,16,0.10)] dark:border-white/10 dark:bg-[#111417]">
      <div className="relative aspect-[4/3] overflow-hidden bg-[#e9e7e1] dark:bg-gray-900">
        <Link
          href={`/sets/${item.slug}?country=${countryCode}`}
          aria-label={`View ${item.name}`}
          className="absolute inset-0 block"
        >
          {imageUrl ? (
            // Plain img (not next/image) so owner-uploaded data: URLs render.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={
                multiBuild
                  ? `${item.name}, Build ${visibleBuildIndex + 1}`
                  : item.name
              }
              className={`absolute inset-0 h-full w-full transition duration-500 group-hover:scale-[1.025] ${
                isUserPhoto ? "object-contain" : "object-cover"
              }`}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-5xl text-gray-300 dark:text-gray-700">
              ⌨
            </div>
          )}
        </Link>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-4">
            <span className="rounded-full bg-black/65 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur">
              {item.productType === "KEYBOARD" ? "Keyboard" : "Keycap set"}
            </span>
            {owned && (
              <span
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider backdrop-blur ${
                  item.collection.isPublic
                    ? "bg-emerald-500/90 text-white"
                    : "bg-white/85 text-gray-800"
                }`}
              >
                {item.collection.isPublic ? "On display" : "Private"}
              </span>
            )}
        </div>

        {multiBuild && (
          <>
            <button
              type="button"
              onClick={() =>
                setActiveBuildIndex(
                  (visibleBuildIndex - 1 + builds.length) % builds.length
                )
              }
              aria-label="Show previous build photo"
              className="absolute left-3 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-black/55 text-white shadow-lg backdrop-blur transition hover:scale-105 hover:bg-black/75"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={() =>
                setActiveBuildIndex((visibleBuildIndex + 1) % builds.length)
              }
              aria-label="Show next build photo"
              className="absolute right-3 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-black/55 text-white shadow-lg backdrop-blur transition hover:scale-105 hover:bg-black/75"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow-lg backdrop-blur">
              <span>
                Build {visibleBuildIndex + 1} of {builds.length}
              </span>
              <span className="flex gap-1">
                {builds.map((_, index) => (
                  <span
                    key={index}
                    className={`h-1.5 rounded-full transition-all ${
                      index === visibleBuildIndex
                        ? "w-4 bg-white"
                        : "w-1.5 bg-white/45"
                    }`}
                  />
                ))}
              </span>
            </div>
          </>
        )}
        </div>

      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9a7a42] dark:text-[#c9ab72]">
              {item.vendorName || item.designer || "Independent design"}
            </p>
            <Link href={`/sets/${item.slug}?country=${countryCode}`}>
              <h3 className="mt-1 truncate text-lg font-semibold tracking-tight text-gray-950 hover:text-indigo-600 dark:text-white">
                {item.name}
              </h3>
            </Link>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {[
                summaryColor || null,
                summaryCondition
                  ? CONDITION_LABELS[summaryCondition] || summaryCondition
                  : null,
                acquiredYear ? `Acquired ${acquiredYear}` : null,
                !owned && item.status ? String(item.status).replaceAll("_", " ") : null,
              ]
                .filter(Boolean)
                .join(" · ") || (owned ? "Collection details not added yet" : "Saved for later")}
            </p>
          </div>
          {owned && editable && (
            <button
              onClick={onEdit}
              title="Edit collection details"
              className="shrink-0 rounded-full border border-gray-200 p-2 text-gray-500 hover:border-gray-400 hover:text-gray-900 dark:border-gray-700 dark:hover:border-gray-500 dark:hover:text-white"
            >
              <EditIcon />
            </button>
          )}
        </div>

        {owned && !multiBuild && details.length > 0 && (
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 dark:border-white/10">
            {details.map((detail) => (
              <div key={detail.label} className="min-w-0">
                <dt className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">
                  {detail.label}
                </dt>
                <dd className="mt-1 truncate text-xs font-medium text-gray-700 dark:text-gray-200">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {owned && !multiBuild && item.collection.buildDetails && (
          <p className="mt-4 line-clamp-2 border-t border-gray-100 pt-4 text-xs leading-5 text-gray-500 dark:border-white/10 dark:text-gray-400">
            {item.collection.buildDetails}
          </p>
        )}

        {owned && multiBuild && (
          <div className="mt-4 space-y-3 border-t border-gray-100 pt-4 dark:border-white/10">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9a7a42] dark:text-[#c9ab72]">
              {builds.length} builds
            </p>
            {builds.map((build, index) => (
              <BuildSummary
                key={index}
                build={build}
                index={index}
                selected={index === visibleBuildIndex}
                onSelect={() => setActiveBuildIndex(index)}
              />
            ))}
          </div>
        )}

        {owned && editable && (
          <div className="mt-4 grid grid-cols-[1fr_auto] gap-2 border-t border-gray-100 pt-4 dark:border-white/10">
            <button
              onClick={onTogglePublic}
              aria-pressed={item.collection.isPublic}
              className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                item.collection.isPublic
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                  : "border-gray-200 bg-gray-50 text-gray-700 hover:border-[#c9ab72] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  item.collection.isPublic
                    ? "bg-emerald-100 dark:bg-emerald-900"
                    : "bg-white dark:bg-gray-800"
                }`}
              >
                <EyeIcon />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold">
                  {item.collection.isPublic ? "Displayed publicly" : "Display publicly"}
                </span>
                <span className="block truncate text-[10px] opacity-65">
                  {item.collection.isPublic
                    ? "Included when you share"
                    : "Private until selected"}
                </span>
              </span>
              <span
                className={`ml-auto h-2.5 w-2.5 shrink-0 rounded-full border ${
                  item.collection.isPublic
                    ? "border-emerald-600 bg-emerald-500"
                    : "border-gray-400 bg-transparent"
                }`}
              />
            </button>
            <button
              onClick={onEdit}
              className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 hover:border-gray-400 hover:text-gray-950 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white"
            >
              Edit details
            </button>
          </div>
        )}

        {!owned && (
          <div className="mt-4 flex gap-2 border-t border-gray-100 pt-4 dark:border-white/10">
            <button
              onClick={onAdd}
              className="flex-1 rounded-full bg-gray-950 px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#9a7a42] dark:bg-white dark:text-gray-950 dark:hover:bg-[#c9ab72]"
            >
              Add to collection
            </button>
            {editable && tab === "tracking" && (
              <button
                onClick={onRemove}
                title="Stop tracking"
                className="rounded-full border border-gray-200 px-3 text-xs text-gray-500 hover:border-red-200 hover:text-red-600 dark:border-gray-700"
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function EmptyCollectionState({
  tab,
  authenticated,
  hasTrackedItems,
  onSignIn,
  onShowTracking,
}: {
  tab: CollectionTab;
  authenticated: boolean;
  hasTrackedItems: boolean;
  onSignIn: () => void;
  onShowTracking: () => void;
}) {
  const copy =
    tab === "collection"
      ? "Promote a tracked board into your collection, then document its build, condition, and story."
      : tab === "tracking"
        ? "Bookmark keyboards or keycap sets while browsing to keep them here for later."
        : "Public display is intentionally empty until you choose which owned pieces visitors may see.";

  return (
    <div className="mt-6 rounded-2xl border border-dashed border-black/15 bg-white/55 px-6 py-16 text-center dark:border-white/15 dark:bg-white/[0.03]">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#e9e2d3] text-2xl text-[#8b6d38] dark:bg-[#2b261d] dark:text-[#c9ab72]">
        ⌨
      </div>
      <h3 className="mt-5 text-lg font-semibold text-gray-950 dark:text-white">
        {tab === "collection"
          ? "Your display case is ready"
          : tab === "tracking"
            ? "Nothing on the watchlist"
            : "Nothing is publicly displayed"}
      </h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-gray-500 dark:text-gray-400">
        {copy}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {tab === "collection" && hasTrackedItems && (
          <button
            onClick={onShowTracking}
            className="rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-950"
          >
            View tracked items
          </button>
        )}
        {!authenticated && (
          <button
            onClick={onSignIn}
            className="rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-gray-950"
          >
            Sign in to save details
          </button>
        )}
        <Link
          href="/keyboards"
          className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-700 hover:border-gray-500 dark:border-gray-700 dark:text-gray-200"
        >
          Browse keyboards
        </Link>
      </div>
    </div>
  );
}

function CollectionItemEditor({
  item,
  defaultCurrency,
  onClose,
  onSave,
  onMoveToTracking,
}: {
  item: CollectionCatalogItem;
  defaultCurrency: string;
  onClose: () => void;
  onSave: (changes: Partial<CollectionItemDetails>) => Promise<void>;
  onMoveToTracking: () => Promise<void>;
}) {
  const catalogImage = normalizeImageUrl(item.imageUrl);
  const [form, setForm] = useState({
    quantity: item.collection.quantity ?? 1,
    showPurchasePrice: item.collection.showPurchasePrice,
    isPublic: item.collection.isPublic,
  });
  const [builds, setBuilds] = useState<CollectionUnit[]>(() =>
    assembleBuilds(item.collection)
  );
  const [activeBuild, setActiveBuild] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const purchaseCurrencies = useMemo(() => {
    const options = [...DISPLAY_CURRENCIES];
    const savedCurrencies = new Set(
      builds
        .map((build) => build.purchaseCurrency?.trim().toUpperCase())
        .filter((value): value is string => Boolean(value))
    );
    for (const savedCurrency of Array.from(savedCurrencies)) {
      if (!options.some((option) => option.code === savedCurrency)) {
        options.push({
          code: savedCurrency,
          symbol: savedCurrency,
          name: "Previously saved currency",
        });
      }
    }
    return options.sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
  }, [builds, defaultCurrency]);

  useModalBodyLock();

  function setQuantity(next: number) {
    const qty = Math.max(1, Math.min(99, next));
    setForm((f) => ({ ...f, quantity: qty }));
    setBuilds((prev) => {
      const arr = prev.slice(0, qty);
      while (arr.length < qty) {
        arr.push({
          ...EMPTY_UNIT,
          purchaseCurrency: defaultCurrency || "USD",
        });
      }
      return arr;
    });
    setActiveBuild((a) => Math.min(a, qty - 1));
  }

  function updateBuild(index: number, patch: Partial<CollectionUnit>) {
    setBuilds((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const qty = form.quantity;
      const trimmed = builds.slice(0, qty);
      const first = trimmed[0] || { ...EMPTY_UNIT };
      const extra = trimmed.slice(1);
      await onSave({
        inCollection: true,
        quantity: qty,
        showPurchasePrice: form.showPurchasePrice,
        isPublic: form.isPublic,
        // Build 1 lives on the top-level fields.
        acquiredAt: first.acquiredAt || null,
        purchasePrice: first.purchasePrice,
        purchaseCurrency: first.purchaseCurrency || null,
        color: first.color || null,
        condition: first.condition || null,
        switches: first.switches || null,
        keycaps: first.keycaps || null,
        buildDetails: first.buildDetails || null,
        notes: first.notes || null,
        customImageUrl: first.imageUrl || null,
        // Builds 2..N.
        units: extra,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save details");
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} label={`Edit ${item.name}`}>
      <div className="border-b border-gray-100 px-5 py-5 dark:border-gray-800 sm:px-7">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          Collection record
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">
          {item.name}
        </h2>
        <p className="mt-1 text-sm text-gray-500">Add the details that make this build yours.</p>
      </div>

      <div className="max-h-[68vh] space-y-6 overflow-y-auto px-5 py-6 dark:text-white sm:px-7">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(240px,0.8fr)]">
          <div className="rounded-xl bg-gray-50 px-4 py-3 dark:bg-white/[0.04]">
            <p className="text-xs font-semibold text-gray-900 dark:text-white">
              One record per physical build
            </p>
            <p className="mt-1 text-[11px] leading-4 text-gray-500 dark:text-gray-400">
              Use the Build tabs below to record a different date, price, currency,
              photo, and specification for every unit.
            </p>
          </div>
          <Field label="Units owned">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQuantity(form.quantity - 1)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 text-lg font-medium text-gray-600 hover:border-gray-400 hover:text-gray-950 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white"
              >
                −
              </button>
              <span className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-center text-sm font-semibold text-gray-950 dark:border-gray-700 dark:bg-gray-950 dark:text-white">
                {form.quantity}
              </span>
              <button
                type="button"
                onClick={() => setQuantity(form.quantity + 1)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 text-lg font-medium text-gray-600 hover:border-gray-400 hover:text-gray-950 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white"
              >
                +
              </button>
            </div>
          </Field>
        </div>

        <CheckRow
          checked={form.showPurchasePrice}
          onChange={(checked) => setForm({ ...form, showPurchasePrice: checked })}
          title="Show build purchase prices publicly"
          description="Off by default. Every build amount remains private unless both this and public display are enabled."
        />

        {/* Per-build details. With multiple units each build keeps its own
            photo, color, switches, keycaps and condition. */}
        <div className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
          {form.quantity > 1 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {builds.map((_, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => setActiveBuild(index)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                    activeBuild === index
                      ? "bg-gray-950 text-white dark:bg-white dark:text-gray-950"
                      : "border border-gray-200 text-gray-500 hover:text-gray-900 dark:border-gray-700 dark:text-gray-400 dark:hover:text-white"
                  }`}
                >
                  Build {index + 1}
                </button>
              ))}
            </div>
          )}
          <BuildFields
            build={builds[activeBuild] || EMPTY_UNIT}
            fallbackImage={activeBuild === 0 ? catalogImage : null}
            purchaseCurrencies={purchaseCurrencies}
            onChange={(patch) => updateBuild(activeBuild, patch)}
            onError={setError}
          />
        </div>

        <div className="rounded-xl border border-[#ddcfb4] bg-[#faf7f0] p-4 dark:border-[#4a3e29] dark:bg-[#211d16]">
          <CheckRow
            checked={form.isPublic}
            onChange={(checked) => setForm({ ...form, isPublic: checked })}
            title="Display this piece publicly"
            description="Only owned items with this enabled appear at your shared collection URL."
          />
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-gray-100 px-5 py-4 dark:border-gray-800 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <button
          onClick={onMoveToTracking}
          disabled={busy}
          className="text-sm font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
        >
          Remove from collection
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy} className={primaryButtonClass}>
            {busy ? "Saving…" : "Save details"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ShareCollectionPicker({
  items,
  profile,
  onClose,
  onPublish,
}: {
  items: CollectionCatalogItem[];
  profile: CollectionProfile | null;
  onClose: () => void;
  onPublish: (selectedSlugs: Set<string>) => Promise<void>;
}) {
  const [selected, setSelected] = useState(
    () => new Set(items.filter((item) => item.collection.isPublic).map((item) => item.slug))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useModalBodyLock();

  const toggle = (slug: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  return (
    <ModalShell onClose={onClose} label="Choose public collection items">
      <div className="border-b border-gray-100 px-5 py-5 dark:border-gray-800 sm:px-7">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          Public display
        </p>
        <h2 className="mt-1 pr-10 text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">
          Choose what visitors can see
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-gray-500 dark:text-gray-400">
          Select owned pieces for {profile?.collectionTitle || "your collection page"}.
          Unselected pieces and everything you are only tracking stay private.
        </p>
        <div className="mt-4 rounded-xl border border-[#ddcfb4] bg-[#faf7f0] px-4 py-3 text-xs leading-5 text-[#6f572d] dark:border-[#4a3e29] dark:bg-[#211d16] dark:text-[#d7ba83]">
          After publishing, the share link is copied automatically. Pasting it into
          Discord or chat will show a landscape collection poster with your selected
          pieces.
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-800 sm:px-7">
        <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
          {selected.size} of {items.length} selected
        </p>
        <div className="flex gap-3 text-xs font-semibold">
          <button
            onClick={() => setSelected(new Set(items.map((item) => item.slug)))}
            className="text-[#8b6d38] hover:text-[#5f471f] dark:text-[#d0b278]"
          >
            Select all
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="max-h-[56vh] space-y-3 overflow-y-auto px-5 py-5 sm:px-7">
        {items.map((item) => {
          const imageUrl = normalizeImageUrl(item.imageUrl);
          const checked = selected.has(item.slug);
          return (
            <button
              key={item.slug}
              onClick={() => toggle(item.slug)}
              aria-pressed={checked}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                checked
                  ? "border-[#c9ab72] bg-[#faf7f0] ring-1 ring-[#c9ab72]/30 dark:border-[#8f7443] dark:bg-[#211d16]"
                  : "border-gray-200 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
              }`}
            >
              <span className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-800">
                {imageUrl ? (
                  <Image
                    src={imageUrl}
                    alt=""
                    fill
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-xl text-gray-300">
                    ⌨
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-gray-950 dark:text-white">
                  {item.name}
                </span>
                <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                  {item.vendorName || item.designer || "Independent design"}
                </span>
              </span>
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                  checked
                    ? "border-[#9a7a42] bg-[#9a7a42] text-white"
                    : "border-gray-300 text-transparent dark:border-gray-600"
                }`}
              >
                <CheckIcon />
              </span>
            </button>
          );
        })}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="flex flex-col gap-3 border-t border-gray-100 px-5 py-4 dark:border-gray-800 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">
          Only selected pieces appear on the public page and preview poster.
        </p>
        <div className="flex shrink-0 gap-2">
          <button onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button
            disabled={busy || selected.size === 0}
            onClick={async () => {
              if (selected.size === 0) return;
              setBusy(true);
              setError("");
              try {
                await onPublish(selected);
              } catch (publishError) {
                setError(
                  publishError instanceof Error
                    ? publishError.message
                    : "Could not publish collection"
                );
                setBusy(false);
              }
            }}
            className={primaryButtonClass}
          >
            {busy
              ? "Publishing…"
              : `Publish & copy link (${selected.size})`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

interface CatalogPickerResult {
  slug: string;
  name: string;
  designer: string | null;
  status: string;
  imageUrl: string | null;
  productType: string;
}

function CollectionCatalogPicker({
  initialQuery,
  existingItems,
  onClose,
  onAdd,
}: {
  initialQuery?: string;
  existingItems: Map<string, CollectionItemDetails>;
  onClose: () => void;
  onAdd: (
    result: CatalogPickerResult,
    mode: "collection" | "tracking"
  ) => Promise<void>;
}) {
  const [query, setQuery] = useState(initialQuery || "");
  const [results, setResults] = useState<CatalogPickerResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState("");

  useModalBodyLock();

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearching(true);
      setError("");
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(search)}&limit=24`,
          { signal: controller.signal }
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Search unavailable");
        setResults(payload.results ?? []);
      } catch (searchError) {
        if (searchError instanceof DOMException && searchError.name === "AbortError") return;
        setError(searchError instanceof Error ? searchError.message : "Search unavailable");
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  async function add(result: CatalogPickerResult, mode: "collection" | "tracking") {
    setAdding(`${result.slug}:${mode}`);
    setError("");
    try {
      await onAdd(result, mode);
      setResults((current) =>
        current.map((candidate) =>
          candidate.slug === result.slug ? { ...candidate } : candidate
        )
      );
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Could not add item");
    } finally {
      setAdding(null);
    }
  }

  return (
    <ModalShell onClose={onClose} label="Search and add to collection">
      <div className="border-b border-gray-100 px-5 py-5 dark:border-gray-800 sm:px-7">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          Add a piece
        </p>
        <h2 className="mt-1 pr-10 text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">
          Search the keyboard catalog
        </h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Add something you own directly to your collection, or save it under
          Tracking for later.
        </p>
        <p className="mt-2 text-xs leading-5 text-[#80632f] dark:text-[#d0b278]">
          For keyboard families with multiple versions, select the exact edition
          shown in the result name before choosing “I own this.”
        </p>
        <label className="relative mt-5 block">
          <span className="sr-only">Search catalog</span>
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
            <SearchSmallIcon />
          </span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search board, keycap set, designer, or vendor"
            className="w-full rounded-xl border border-gray-200 bg-gray-50 py-3 pl-10 pr-4 text-sm text-gray-950 outline-none focus:border-[#9a7a42] focus:bg-white focus:ring-2 focus:ring-[#9a7a42]/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
          />
        </label>
      </div>

      <div className="max-h-[58vh] overflow-y-auto px-5 py-5 sm:px-7">
        {query.trim().length < 2 ? (
          <div className="py-12 text-center">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Search by the name you remember
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Results include images and product type so you can identify the right item.
            </p>
          </div>
        ) : searching && results.length === 0 ? (
          <p className="py-12 text-center text-sm text-gray-400">Searching catalog…</p>
        ) : results.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              No catalog matches
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Try a shorter product name or the designer.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {results.map((result) => {
              const imageUrl = normalizeImageUrl(result.imageUrl);
              const existing = existingItems.get(result.slug);
              const alreadyOwned = existing?.inCollection === true;
              const alreadyTracking = existing?.isTracking === true;
              return (
                <article
                  key={result.slug}
                  className="flex flex-col gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700 sm:flex-row sm:items-center"
                >
                  <span className="relative h-20 w-full shrink-0 overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-800 sm:w-28">
                    {imageUrl ? (
                      <Image
                        src={imageUrl}
                        alt=""
                        fill
                        unoptimized
                        className="object-cover"
                      />
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center text-2xl text-gray-300">
                        ⌨
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-gray-950 dark:text-white">
                      {result.name}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                      {result.productType === "KEYBOARD" ? "Keyboard" : "Keycap set"}
                      {result.designer ? ` · ${result.designer}` : ""}
                    </span>
                  </span>
                  {alreadyOwned && alreadyTracking ? (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      Owned + tracking
                    </span>
                  ) : (
                    <span className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-col">
                      {!alreadyOwned && (
                      <button
                        disabled={adding !== null}
                        onClick={() => add(result, "collection")}
                        className="rounded-lg bg-gray-950 px-3 py-2 text-xs font-semibold text-white hover:bg-[#9a7a42] disabled:opacity-50 dark:bg-white dark:text-gray-950"
                      >
                        {adding === `${result.slug}:collection`
                          ? "Adding…"
                          : "I own this"}
                      </button>
                      )}
                      {!alreadyTracking && (
                      <button
                        disabled={adding !== null}
                        onClick={() => add(result, "tracking")}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300"
                      >
                        {adding === `${result.slug}:tracking`
                          ? "Saving…"
                          : "Track later"}
                      </button>
                      )}
                      {alreadyTracking && !alreadyOwned && (
                        <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-xs font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          Tracking
                        </span>
                      )}
                    </span>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </ModalShell>
  );
}

function CollectionProfileEditor({
  profile,
  publicCount,
  onClose,
  onSave,
}: {
  profile: CollectionProfile;
  publicCount: number;
  onClose: () => void;
  onSave: (changes: Partial<CollectionProfile>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    displayName: profile.displayName || "",
    collectionTitle: profile.collectionTitle || "",
    collectionBio: profile.collectionBio || "",
    collectionPublished: profile.collectionPublished,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useModalBodyLock();

  return (
    <ModalShell onClose={onClose} label="Edit collection profile" narrow>
      <div className="border-b border-gray-100 px-5 py-5 dark:border-gray-800 sm:px-7">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7a42] dark:text-[#c9ab72]">
          Display card
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">
          Collection profile
        </h2>
      </div>
      <div className="space-y-5 px-5 py-6 sm:px-7">
        <Field label="Collector name">
          <input
            value={form.displayName}
            onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            placeholder="Name or collector handle"
            className={inputClass}
          />
        </Field>
        <Field label="Collection title">
          <input
            value={form.collectionTitle}
            onChange={(event) => setForm({ ...form, collectionTitle: event.target.value })}
            placeholder="e.g. Ryan's 60% Archive"
            className={inputClass}
          />
        </Field>
        <Field label="About this collection">
          <textarea
            value={form.collectionBio}
            onChange={(event) => setForm({ ...form, collectionBio: event.target.value })}
            placeholder="What guides your collection?"
            rows={4}
            className={inputClass}
          />
        </Field>
        <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
          <CheckRow
            checked={form.collectionPublished}
            onChange={(checked) => setForm({ ...form, collectionPublished: checked })}
            title="Public collection page"
            description={`${publicCount} selected piece${publicCount === 1 ? "" : "s"} will be visible. Tracking and private items remain hidden.`}
          />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-800 sm:px-7">
        <button onClick={onClose} className={secondaryButtonClass}>
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSave(form);
            } catch (saveError) {
              setError(saveError instanceof Error ? saveError.message : "Could not save profile");
              setBusy(false);
            }
          }}
          className={primaryButtonClass}
        >
          {busy ? "Saving…" : "Save profile"}
        </button>
      </div>
    </ModalShell>
  );
}

function LegacySharedCollection({
  items,
  loading,
  countryCode,
}: {
  items: CollectionCatalogItem[];
  loading: boolean;
  countryCode: string;
}) {
  return (
    <main className="min-h-screen bg-[#f5f4f0] py-10 dark:bg-[#090b0d]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          This is a legacy watchlist link. New collection links show only pieces the collector explicitly makes public.
        </div>
        <div className="mt-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a7a42]">Shared archive</p>
          <h1 className="mt-2 font-serif text-4xl text-gray-950 dark:text-white">Collector watchlist</h1>
        </div>
        {loading ? (
          <CollectionGridSkeleton />
        ) : (
          <div className="mt-8 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <CollectionCard
                key={item.id}
                item={item}
                tab="tracking"
                countryCode={countryCode}
                editable={false}
                onEdit={() => {}}
                onTogglePublic={() => {}}
                onAdd={() => {}}
                onRemove={() => {}}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function ModalShell({
  children,
  onClose,
  label,
  narrow = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
  narrow?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <button
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`relative w-full overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-[#111417] ${
          narrow ? "max-w-xl" : "max-w-2xl"
        }`}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 rounded-full bg-gray-100 p-2 text-gray-500 hover:text-gray-900 dark:bg-gray-800 dark:text-gray-300 dark:hover:text-white"
        >
          <CloseIcon />
        </button>
        {children}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-200">
        {label}
      </span>
      {children}
    </label>
  );
}

function CheckRow({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-gray-400">
          {description}
        </span>
      </span>
      <span
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${
          checked ? "bg-[#9a7a42]" : "bg-gray-300 dark:bg-gray-700"
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="sr-only"
        />
        <span
          className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${
            checked ? "left-6" : "left-1"
          }`}
        />
      </span>
    </label>
  );
}

function CollectionGridSkeleton() {
  return (
    <div className="mt-6 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {[1, 2, 3].map((item) => (
        <div key={item} className="overflow-hidden rounded-2xl bg-white dark:bg-[#111417]">
          <div className="aspect-[4/3] animate-pulse bg-gray-200 dark:bg-gray-800" />
          <div className="space-y-3 p-5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
            <div className="h-5 w-2/3 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

function useModalBodyLock() {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);
}

function EditIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"
      />
      <circle cx="12" cy="12" r="2.5" strokeWidth={1.8} />
    </svg>
  );
}

function SearchSmallIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="11" cy="11" r="7" strokeWidth={1.8} />
      <path strokeLinecap="round" strokeWidth={1.8} d="M16.5 16.5L21 21" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12l4 4 10-10" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

const inputClass =
  "w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-[#9a7a42] focus:ring-2 focus:ring-[#9a7a42]/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white";
const primaryButtonClass =
  "rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#9a7a42] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-950 dark:hover:bg-[#c9ab72]";
const secondaryButtonClass =
  "rounded-full border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 hover:border-gray-400 hover:text-gray-950 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white";
