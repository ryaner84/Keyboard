import type { GBStatus } from "@/types";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function formatDate(date: Date | string | null): string {
  if (!date) return "TBD";
  return new Date(date).toLocaleDateString("en-SG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateRange(
  start: Date | string | null,
  end: Date | string | null
): string {
  if (!start && !end) return "Dates TBD";
  if (start && !end) return `From ${formatDate(start)}`;
  if (!start && end) return `Until ${formatDate(end)}`;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export const STATUS_LABELS: Record<GBStatus, string> = {
  INTEREST_CHECK: "Interest Check",
  ACTIVE_GB: "Active GB",
  SHIPPING: "Shipping",
  DELIVERED: "Delivered",
  IN_STOCK: "In Stock",
  CANCELLED: "Cancelled",
};

export const STATUS_COLORS: Record<GBStatus, string> = {
  INTEREST_CHECK: "bg-slate-100 text-slate-700 border-slate-200",
  ACTIVE_GB: "bg-green-100 text-green-800 border-green-200",
  SHIPPING: "bg-blue-100 text-blue-800 border-blue-200",
  DELIVERED: "bg-purple-100 text-purple-800 border-purple-200",
  IN_STOCK: "bg-amber-100 text-amber-800 border-amber-200",
  CANCELLED: "bg-red-100 text-red-800 border-red-200",
};

export const STATUS_DOT_COLORS: Record<GBStatus, string> = {
  INTEREST_CHECK: "bg-slate-400",
  ACTIVE_GB: "bg-green-500",
  SHIPPING: "bg-blue-500",
  DELIVERED: "bg-purple-500",
  IN_STOCK: "bg-amber-500",
  CANCELLED: "bg-red-500",
};
