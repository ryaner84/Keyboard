import { prisma } from "@/lib/prisma";
import { notHiddenWhere } from "@/lib/showcase";
import { cachedHomeQuery, STATIC_TTL } from "@/lib/home-cache";
import { KeycapVisualizer, type VisualizerSet } from "@/components/visualize/KeycapVisualizer";
import visualizerKeycaps from "@/data/keycap-visualizer/keycaps.json";
import type { KeycapSet } from "@/lib/keycap-visualizer";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Visualize — GMK Tracker",
  description: "Try GMK and DCS keycap sets on popular keyboards, pick a case finish, and compare up to three looks side by side.",
};

// Request-time like the home page: the build never needs a database, and the
// loader below is cached, so the tracker join runs once per TTL.
export const dynamic = "force-dynamic";

// Colors live in src/data/keycap-visualizer/keycaps.json (one entry per set,
// keyed by tracker slug); status and the set page "Compare prices" opens come
// from the tracker row, so a set the tracker hides or marks DEAD drops out here.
const loadVisualizerSets = cachedHomeQuery("visualizer-sets", async () => {
  const entries = visualizerKeycaps.keycaps as KeycapSet[];
  const rows = await prisma.groupBuy.findMany({
    // notHiddenWhere is itself a slug filter, so it goes under AND rather than
    // being spread beside `slug: { in }`, where one would overwrite the other.
    where: { AND: [{ slug: { in: entries.map((e) => e.slug) } }, notHiddenWhere], dataTrustLevel: { not: "DEAD" } },
    select: { slug: true, status: true },
  });
  const status = new Map(rows.map((r) => [r.slug, r.status]));
  return entries.flatMap((e): VisualizerSet[] => (status.has(e.slug) ? [{ ...e, status: status.get(e.slug)! }] : []));
}, STATIC_TTL);

async function getVisualizerSets(): Promise<VisualizerSet[]> {
  try {
    return await loadVisualizerSets();
  } catch {
    // No database (local build, outage): still show the curated colorways.
    return (visualizerKeycaps.keycaps as KeycapSet[]).map((e) => ({ ...e, status: null }));
  }
}

export default async function VisualizePage({ searchParams }: { searchParams: { set?: string } }) {
  const sets = await getVisualizerSets();
  return <KeycapVisualizer sets={sets} initialSlug={searchParams.set} />;
}
