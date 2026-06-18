"use client";

import { useTracker } from "@/context/TrackerContext";

// Compatibility wrapper for existing bookmark call sites. The source of truth
// now lives in TrackerProvider so every card, table, detail page, and header
// shares the same anonymous-or-signed-in state.
export function useTrackedSets() {
  return useTracker();
}
