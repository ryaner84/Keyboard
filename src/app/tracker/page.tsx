import { Suspense } from "react";
import TrackerContent from "./TrackerContent";

export default function TrackerPage() {
  return (
    <Suspense fallback={
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="h-8 bg-gray-200 rounded animate-pulse w-48 mb-6" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1,2,3].map(i => (
            <div key={i} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="aspect-video bg-gray-100 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    }>
      <TrackerContent />
    </Suspense>
  );
}
