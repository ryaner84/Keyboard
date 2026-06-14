import { Suspense } from "react";
import type { Metadata } from "next";
import KeyboardsContent from "./KeyboardsContent";

export const metadata: Metadata = {
  title: "Keyboard Group Buys — GMK Tracker",
  description:
    "Browse keyboard group buys. Track development updates, specs, and GB timelines for custom keyboards.",
};

export default function KeyboardsPage() {
  return (
    <Suspense fallback={
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="h-8 bg-gray-200 rounded animate-pulse w-64 mb-6" />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="aspect-video bg-gray-100 animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-gray-100 rounded animate-pulse w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    }>
      <KeyboardsContent />
    </Suspense>
  );
}
