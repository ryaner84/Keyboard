import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getCountdownLabel, formatDateRange } from "@/lib/utils";
import type { GroupBuyWithKits } from "@/types";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Timeline — GMK Group Buys",
  description: "Upcoming and active GMK keycap group buys laid out on a timeline.",
};

async function getTimelineSets(): Promise<GroupBuyWithKits[]> {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return (await prisma.groupBuy.findMany({
      where: {
        status: { in: ["INTEREST_CHECK", "ACTIVE_GB", "SHIPPING"] },
        OR: [{ gbStart: { gte: start } }, { gbEnd: { gte: now } }],
      },
      include: { kits: { select: { id: true, name: true, type: true } } },
      orderBy: [{ gbStart: "asc" }],
      take: 100,
    })) as GroupBuyWithKits[];
  } catch {
    return [];
  }
}

function monthKey(d: Date | null): string {
  if (!d) return "Dates TBD";
  return new Date(d).toLocaleDateString("en-SG", { month: "long", year: "numeric" });
}

export default async function TimelinePage() {
  const sets = await getTimelineSets();

  // Group by the month of gbStart (fallback gbEnd).
  const groups = new Map<string, GroupBuyWithKits[]>();
  for (const s of sets) {
    const key = monthKey(s.gbStart ?? s.gbEnd);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Group Buy Timeline</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Active and upcoming GMK group buys, laid out by month.
        </p>
      </div>

      {sets.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">🗓️</p>
          <p>No scheduled group buys right now.</p>
        </div>
      ) : (
        <div className="space-y-10">
          {Array.from(groups.entries()).map(([month, monthSets]) => (
            <div key={month}>
              {/* Month marker */}
              <div className="flex items-center gap-3 mb-4">
                <span className="text-sm font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                  {month}
                </span>
                <span className="text-xs text-gray-400">{monthSets.length} set{monthSets.length > 1 ? "s" : ""}</span>
                <div className="flex-1 h-px bg-gray-100 dark:bg-gray-800" />
              </div>

              {/* Timeline items */}
              <div className="relative pl-6 border-l-2 border-gray-100 dark:border-gray-800 space-y-4">
                {monthSets.map((set) => {
                  const countdown = getCountdownLabel(set.status, set.gbStart, set.gbEnd);
                  return (
                    <div key={set.id} className="relative">
                      {/* Dot */}
                      <span className="absolute -left-[31px] top-4 w-3 h-3 rounded-full bg-indigo-500 border-2 border-white dark:border-gray-950" />
                      <Link
                        href={`/sets/${set.slug}`}
                        className="flex items-center gap-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-3 hover:border-indigo-200 dark:hover:border-indigo-600 hover:shadow-sm transition-all"
                      >
                        <div className="relative w-20 h-14 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 flex-shrink-0">
                          {set.imageUrl ? (
                            <Image src={set.imageUrl} alt={set.name} fill className="object-cover" unoptimized />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-xl opacity-30">⌨</div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <StatusBadge status={set.status} size="sm" />
                            {countdown && (
                              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{countdown}</span>
                            )}
                          </div>
                          <h3 className="font-semibold text-gray-900 dark:text-white truncate">{set.name}</h3>
                          <p className="text-xs text-gray-400">
                            by {set.designer} · {formatDateRange(set.gbStart, set.gbEnd)}
                          </p>
                        </div>
                        <svg className="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </Link>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
