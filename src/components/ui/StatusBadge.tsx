import { STATUS_COLORS, STATUS_LABELS, STATUS_DOT_COLORS } from "@/lib/utils";
import type { GBStatus } from "@/types";

interface StatusBadgeProps {
  status: GBStatus;
  size?: "sm" | "md";
}

export function StatusBadge({ status, size = "md" }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 border rounded-full font-medium ${STATUS_COLORS[status]} ${
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT_COLORS[status]}`} />
      {STATUS_LABELS[status]}
    </span>
  );
}
