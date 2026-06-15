import { Suspense } from "react";
import type { Metadata } from "next";
import { KeyboardPastContent } from "@/components/keyboards/KeyboardPastContent";

export const metadata: Metadata = {
  title: "Past Keyboard Group Buys — Shipping & Delivered — GMK Tracker",
  description: "Keyboard group buys that have shipped or been delivered. Track development updates and vendor announcements.",
};

export default function PastKeyboardsPage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-12 animate-pulse"><div className="h-8 bg-gray-200 rounded w-64 mb-6" /></div>}>
      <KeyboardPastContent />
    </Suspense>
  );
}
