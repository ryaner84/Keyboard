import { Suspense } from "react";
import type { Metadata } from "next";
import KeyboardCollectionContent from "../KeyboardCollectionContent";

export const metadata: Metadata = {
  title: "Upcoming Keyboards — Interest Checks — GMK Tracker",
  description: "Keyboard designs in the interest check phase. No ordering yet, but track what's coming.",
};

export default function UpcomingKeyboardsPage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-12 animate-pulse"><div className="h-8 bg-gray-200 rounded w-64 mb-6" /></div>}>
      <KeyboardCollectionContent
        defaultStatuses={["INTEREST_CHECK"]}
        sectionTitle="Upcoming Keyboards"
        sectionDescription="Interest checks — designers gauging community interest before launching a GB."
      />
    </Suspense>
  );
}
