export type DataTrustLevel = "TRUSTED" | "CAUTION" | "STALE" | "DEAD";

export interface DataTrustFields {
  sourceType?: string | null;
  sourceUrl?: string | null;
  sourceLastCheckedAt?: Date | string | null;
  sourceLastActivityAt?: Date | string | null;
  dataTrustLevel?: string | null;
  dataTrustReason?: string | null;
}

const LABELS: Record<DataTrustLevel, string> = {
  TRUSTED: "Source verified",
  CAUTION: "Needs review",
  STALE: "Stale source",
  DEAD: "Dead thread",
};

const DESCRIPTIONS: Record<DataTrustLevel, string> = {
  TRUSTED: "This listing has a recent source or live vendor data.",
  CAUTION: "This listing is usable, but one or more source details are incomplete.",
  STALE: "This listing came from a source that has not shown recent activity.",
  DEAD: "This Geekhack thread appears inactive and may not represent a live group buy.",
};

export function normalizeTrustLevel(level?: string | null): DataTrustLevel {
  if (level === "CAUTION" || level === "STALE" || level === "DEAD") return level;
  return "TRUSTED";
}

export function getDataTrustMeta(item: DataTrustFields) {
  const level = normalizeTrustLevel(item.dataTrustLevel);
  return {
    level,
    label: LABELS[level],
    description: item.dataTrustReason || DESCRIPTIONS[level],
    isLowTrust: level !== "TRUSTED",
    isDead: level === "DEAD",
  };
}

export function formatTrustDate(date?: Date | string | null): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
