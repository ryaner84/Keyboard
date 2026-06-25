import { Suspense } from "react";
import type { Metadata } from "next";
import ShowcaseContent from "@/components/showcase/ShowcaseContent";

export const metadata: Metadata = {
  title: "Keyboard Showcase — Browse Community Builds — GMK Tracker",
  description:
    "A browse-only gallery of custom mechanical keyboards from the community. Search and admire other people's builds — no tracking, no prices, just the boards.",
};

export default function ShowcasePage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl animate-pulse px-4 py-12">
          <div className="mb-6 h-40 rounded-2xl bg-gray-200 dark:bg-gray-800" />
          <div className="h-8 w-64 rounded bg-gray-200 dark:bg-gray-800" />
        </div>
      }
    >
      <ShowcaseContent />
    </Suspense>
  );
}
