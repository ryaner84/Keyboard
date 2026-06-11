import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { UpcomingCarousel } from "@/components/home/UpcomingCarousel";
import { SetCard } from "@/components/browse/SetCard";
import { LocationReminder } from "@/components/home/LocationReminder";
import type { GroupBuyWithKits, GroupBuyWithPricing } from "@/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GMK Tracker — Group Buy Price Locator",
  description:
    "Find GMK keycap group buys and new releases. Compare prices from vendors worldwide in your local currency, including shipping.",
};

// Render at request time so featured sets / stats are always fresh and the
// build never depends on a live database connection.
export const dynamic = "force-dynamic";

// Include base-kit vendor pricing so catalog cards can show cheapest vendors.
const PRICING_INCLUDE = {
  kits: {
    include: {
      vendorKits: {
        include: { vendor: { include: { shippingZones: true } } },
      },
    },
  },
} as const;

async function getFeaturedSets(): Promise<GroupBuyWithPricing[]> {
  try {
    return (await prisma.groupBuy.findMany({
      where: { featured: true },
      include: PRICING_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 6,
    })) as unknown as GroupBuyWithPricing[];
  } catch {
    return [];
  }
}

async function getFinishingSoon(): Promise<GroupBuyWithPricing[]> {
  try {
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return (await prisma.groupBuy.findMany({
      where: { status: "ACTIVE_GB", gbEnd: { gte: now, lte: in7 } },
      include: PRICING_INCLUDE,
      orderBy: { gbEnd: "asc" },
      take: 5,
    })) as unknown as GroupBuyWithPricing[];
  } catch {
    return [];
  }
}

async function getNewGroupBuys(): Promise<GroupBuyWithPricing[]> {
  try {
    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    return (await prisma.groupBuy.findMany({
      where: { status: "ACTIVE_GB", gbStart: { gte: twoWeeksAgo, lte: now } },
      include: PRICING_INCLUDE,
      orderBy: { gbStart: "desc" },
      take: 5,
    })) as unknown as GroupBuyWithPricing[];
  } catch {
    return [];
  }
}

async function getUpcomingSets(): Promise<GroupBuyWithKits[]> {
  try {
    return (await prisma.groupBuy.findMany({
      where: { status: { in: ["ACTIVE_GB", "INTEREST_CHECK"] } },
      include: { kits: { select: { id: true, name: true, type: true } } },
      orderBy: [{ featured: "desc" }, { status: "asc" }, { gbEnd: "asc" }],
      take: 5,
    })) as GroupBuyWithKits[];
  } catch {
    return [];
  }
}

async function getStats() {
  try {
    const [activeGBs, inStock, totalSets] = await Promise.all([
      prisma.groupBuy.count({ where: { status: "ACTIVE_GB" } }),
      prisma.groupBuy.count({ where: { status: "IN_STOCK" } }),
      prisma.groupBuy.count(),
    ]);
    return { activeGBs, inStock, totalSets };
  } catch {
    return { activeGBs: 0, inStock: 0, totalSets: 0 };
  }
}

// Post-GB sets a vendor still stocks with a live price — the aftermarket is
// where real price differences appear (GB pricing is MSRP everywhere), so the
// homepage showcases it with live proof.
const RELEASED_STATUSES = ["SHIPPING", "DELIVERED", "IN_STOCK"] as const;
const AVAILABLE_FILTER = {
  kits: {
    some: {
      type: "BASE" as const,
      vendorKits: { some: { price: { not: null }, inStock: true } },
    },
  },
};

async function getAftermarket(): Promise<{
  highlights: GroupBuyWithPricing[];
  releasedCount: number;
  availableCount: number;
}> {
  try {
    const [highlights, releasedCount, availableCount] = await Promise.all([
      prisma.groupBuy.findMany({
        where: { status: { in: [...RELEASED_STATUSES] }, ...AVAILABLE_FILTER },
        include: PRICING_INCLUDE,
        orderBy: { gbEnd: { sort: "desc", nulls: "last" } },
        take: 3,
      }) as unknown as GroupBuyWithPricing[],
      prisma.groupBuy.count({ where: { status: { in: [...RELEASED_STATUSES] } } }),
      prisma.groupBuy.count({
        where: { status: { in: [...RELEASED_STATUSES] }, ...AVAILABLE_FILTER },
      }),
    ]);
    return { highlights, releasedCount, availableCount };
  } catch {
    return { highlights: [], releasedCount: 0, availableCount: 0 };
  }
}

export default async function HomePage() {
  const [featured, stats, upcoming, finishingSoon, newGBs, aftermarket] = await Promise.all([
    getFeaturedSets(),
    getStats(),
    getUpcomingSets(),
    getFinishingSoon(),
    getNewGroupBuys(),
    getAftermarket(),
  ]);

  return (
    <div>
      {/* Upcoming GB carousel */}
      {upcoming.length > 0 && <UpcomingCarousel sets={upcoming} />}

      {/* Hero */}
      <section className="bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="text-center max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium mb-6">
              <span className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
              {stats.activeGBs} Active Group Buys
            </div>
            <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900 dark:text-white tracking-tight mb-4">
              Find the cheapest{" "}
              <span className="text-indigo-600 dark:text-indigo-400">GMK keycaps</span>{" "}
              shipped to you
            </h1>
            <p className="text-lg text-gray-500 dark:text-gray-400 mb-6">
              We compare every regional vendor and show you the lowest total price —
              kit cost <strong>plus shipping to your country</strong>, in your currency.
              Like Skyscanner, but for keycaps.
            </p>

            {/* Shipping-location reminder / confirmation */}
            <div className="mb-8 flex justify-center">
              <LocationReminder />
            </div>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/browse"
                className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-colors shadow-sm"
              >
                Browse Group Buys
              </Link>
              <Link
                href="/released?availability=available"
                className="px-6 py-3 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded-xl font-semibold border border-gray-200 dark:border-gray-700 hover:border-emerald-400 hover:text-emerald-600 transition-colors"
              >
                Released &amp; In Stock →
              </Link>
            </div>
          </div>

          {/* Stats */}
          <div className="mt-12 grid grid-cols-3 gap-4 max-w-lg mx-auto">
            {[
              { label: "Active GBs", value: stats.activeGBs },
              { label: "In Stock", value: stats.inStock },
              { label: "Sets Tracked", value: stats.totalSets },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-3xl font-bold text-gray-900 dark:text-white">{s.value}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Aftermarket: the real price-comparison play ─────────────────────
          During a group buy every vendor charges the same MSRP. AFTER release
          the spread opens up — leftover stock, regional sales, FX swings — so
          this is the service's sharpest value. Sell it hard, with live proof. */}
      <section className="relative overflow-hidden bg-gradient-to-br from-emerald-700 via-teal-700 to-cyan-800">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              "radial-gradient(circle at 85% 15%, white 0%, transparent 40%), radial-gradient(circle at 5% 95%, white 0%, transparent 35%)",
          }}
        />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
          <div className="grid lg:grid-cols-[1fr_auto] gap-8 items-center mb-8">
            <div>
              <p className="inline-flex items-center gap-2 px-3 py-1 bg-white/15 text-emerald-50 rounded-full text-xs font-semibold uppercase tracking-wide mb-4">
                <span className="w-1.5 h-1.5 bg-emerald-300 rounded-full" />
                The aftermarket advantage
              </p>
              <h2 className="text-2xl sm:text-3xl font-extrabold text-white leading-tight max-w-2xl">
                Group buy prices are the same everywhere.
                <span className="text-emerald-200"> Released sets aren&apos;t.</span>
              </h2>
              <p className="mt-3 text-emerald-50/90 text-sm sm:text-base max-w-2xl">
                During a group buy every vendor charges MSRP — there&apos;s nothing to
                compare. The real differences appear <strong>after release</strong>:
                leftover stock, regional sales, and currency swings can put the same
                set at very different prices across vendors. We track who still
                stocks every released GMK set and rank the true cost to your door.
              </p>
            </div>

            <div className="flex lg:flex-col gap-3">
              <div className="bg-white/15 backdrop-blur-sm rounded-xl px-5 py-3 text-center">
                <p className="text-2xl font-bold text-white leading-tight">{aftermarket.releasedCount}</p>
                <p className="text-[11px] text-emerald-100 uppercase tracking-wide">released sets</p>
              </div>
              <div className="bg-white/15 backdrop-blur-sm rounded-xl px-5 py-3 text-center">
                <p className="text-2xl font-bold text-white leading-tight">{aftermarket.availableCount}</p>
                <p className="text-[11px] text-emerald-100 uppercase tracking-wide">buyable right now</p>
              </div>
            </div>
          </div>

          {/* Live proof: released sets you can buy today, with real vendor prices */}
          {aftermarket.highlights.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-8">
              {aftermarket.highlights.map((set) => (
                <SetCard key={set.id} set={set} />
              ))}
            </div>
          )}

          <div className="flex justify-center">
            <Link
              href="/released?availability=available"
              className="px-7 py-3 bg-white text-emerald-700 rounded-xl font-semibold hover:bg-emerald-50 transition-colors shadow-sm"
            >
              Explore released sets →
            </Link>
          </div>
        </div>
      </section>

      {/* Finishing Soon */}
      {finishingSoon.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <span className="text-red-500">⏳</span> Finishing Soon
              <span className="px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 text-xs font-semibold border border-red-100 dark:border-red-900">
                ≤ 7 days left
              </span>
            </h2>
            <Link href="/browse?finishing=7" className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-700 font-medium">
              View all →
            </Link>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Group buys ending within the next 7 days — last chance to order.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {finishingSoon.map((set) => (
              <SetCard key={set.id} set={set} />
            ))}
          </div>
        </section>
      )}

      {/* New Group Buys */}
      {newGBs.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <span className="text-green-500">✨</span> New Group Buys
            </h2>
            <Link href="/browse?new=14" className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-700 font-medium">
              View all →
            </Link>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Just launched in the last 2 weeks.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {newGBs.map((set) => (
              <SetCard key={set.id} set={set} />
            ))}
          </div>
        </section>
      )}

      {/* Featured sets */}
      {featured.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Featured Sets</h2>
            <Link href="/browse" className="text-sm text-indigo-600 hover:text-indigo-700 font-medium">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {featured.map((set) => (
              <SetCard key={set.id} set={set} />
            ))}
          </div>
        </section>
      )}

      {/* How it works */}
      <section className="bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-8 text-center">How it works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              {
                icon: "🌏",
                title: "Pick your location",
                desc: "Select your country to see prices and shipping in your local currency.",
              },
              {
                icon: "🔍",
                title: "Browse group buys",
                desc: "Search and filter active GBs, interest checks, and in-stock sets.",
              },
              {
                icon: "💰",
                title: "Compare prices",
                desc: "See all vendors ranked by total cost — kit + shipping to you.",
              },
            ].map((step) => (
              <div key={step.title} className="text-center px-4">
                <div className="text-4xl mb-3">{step.icon}</div>
                <h3 className="font-semibold text-gray-900 dark:text-white mb-1">{step.title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
