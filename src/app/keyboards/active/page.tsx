import { Suspense } from "react";
import type { Metadata } from "next";
import KeyboardCollectionContent from "../KeyboardCollectionContent";

export const metadata: Metadata = {
  title: "Active Keyboard Group Buys — GMK Tracker",
  description: "Keyboard group buys that are open to join right now, plus extra drops with leftover stock available immediately.",
};

export default function ActiveKeyboardsPage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-12 animate-pulse"><div className="h-8 bg-gray-200 rounded w-64 mb-6" /></div>}>
      <KeyboardCollectionContent
        defaultStatuses={["ACTIVE_GB", "IN_STOCK"]}
        sectionTitle="Active Keyboard Group Buys"
      />
    </Suspense>
  );
}
