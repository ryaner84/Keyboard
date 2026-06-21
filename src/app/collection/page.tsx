import { Suspense } from "react";
import type { Metadata } from "next";
import CollectionContent from "./CollectionContent";

export const metadata: Metadata = {
  title: "My Collection",
  description: "Curate, document, and share your mechanical keyboard collection.",
};

export default function CollectionPage() {
  return (
    <Suspense fallback={<CollectionPageSkeleton />}>
      <CollectionContent />
    </Suspense>
  );
}

function CollectionPageSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="h-64 animate-pulse rounded-[2rem] bg-gray-900" />
      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <div key={item} className="overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900">
            <div className="aspect-[4/3] animate-pulse bg-gray-100 dark:bg-gray-800" />
            <div className="space-y-3 p-5">
              <div className="h-5 w-2/3 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
