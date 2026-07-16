import { formatTrustDate, getDataTrustMeta, type DataTrustFields } from "@/lib/data-trust";

const BADGE_CLASS = {
  TRUSTED: "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
  CAUTION: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  STALE: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
  DEAD: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
} as const;

export function DataTrustBadge({
  item,
  compact = false,
}: {
  item: DataTrustFields;
  compact?: boolean;
}) {
  const meta = getDataTrustMeta(item);
  if (!meta.isLowTrust) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${BADGE_CLASS[meta.level]}`}
      title={meta.description}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {compact ? meta.label.replace(" source", "") : meta.label}
    </span>
  );
}

export function DataTrustNotice({ item }: { item: DataTrustFields }) {
  const meta = getDataTrustMeta(item);
  if (!meta.isLowTrust) return null;

  const checked = formatTrustDate(item.sourceLastCheckedAt);
  const activity = formatTrustDate(item.sourceLastActivityAt);

  return (
    <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${BADGE_CLASS[meta.level]}`}>
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        <DataTrustBadge item={item} />
        {item.sourceType === "GEEKHACK" && <span>Geekhack source confidence</span>}
      </div>
      <p className="mt-1 leading-relaxed">{meta.description}</p>
      {(activity || checked || item.sourceUrl) && (
        <p className="mt-2 text-xs opacity-80">
          {activity && <>Last thread activity: {activity}. </>}
          {checked && <>Last checked: {checked}. </>}
          {item.sourceUrl && (
            <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
              Open source
            </a>
          )}
        </p>
      )}
    </div>
  );
}
