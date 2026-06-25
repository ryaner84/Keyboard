import { Suspense } from "react";
import type { Metadata } from "next";
import KeyboardCollectionContent from "../KeyboardCollectionContent";

export const metadata: Metadata = {
  title: "Keyboard Catalog — All Group Buys — GMK Tracker",
  description: "Every keyboard group buy ever tracked: active, upcoming, shipped, and delivered.",
};

export default function CatalogPage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-12 animate-pulse"><div className="h-8 bg-gray-200 rounded w-64 mb-6" /></div>}>
      <KeyboardCollectionContent
        sectionTitle="Keyboard Catalog"
        sectionDescription="Every keyboard ever tracked — from interest checks to delivered boards. The complete reference."
      />
    </Suspense>
  );
}
