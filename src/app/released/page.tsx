import { Suspense } from "react";
import ReleasedContent from "./ReleasedContent";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bargain — GMK Tracker",
  description:
    "Bargain hunt: GMK keycap sets and keyboards that finished their group buy — see which ones you can still buy in stock, from which vendors, at the best price to your country.",
};

export default function ReleasedPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="h-36 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse mb-6" />
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden">
                <div className="aspect-video bg-gray-100 dark:bg-gray-800 animate-pulse" />
                <div className="p-4 space-y-2">
                  <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-3/4" />
                  <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      }
    >
      <ReleasedContent />
    </Suspense>
  );
}
