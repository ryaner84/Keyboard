import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateRange } from "@/lib/utils";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GMK Tracker — Group Buy Price Locator",
  description:
    "Find GMK keycap group buys and new releases. Compare prices from vendors worldwide in your local currency, including shipping.",
};

async function getFeaturedSets() {
  try {
    return await prisma.groupBuy.findMany({
      where: { featured: true },
      include: { kits: { select: { id: true, name: true, type: true } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    });
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

export default async function HomePage() {
  const [featured, stats] = await Promise.all([getFeaturedSets(), getStats()]);

  return (
    <div>
      {/* Hero */}
      <section className="bg-white border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="text-center max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-indigo-50 text-indigo-700 rounded-full text-sm font-medium mb-6">
              <span className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
              {stats.activeGBs} Active Group Buys
            </div>
            <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900 tracking-tight mb-4">
              Find the best price for{" "}
              <span className="text-indigo-600">GMK keycaps</span>{" "}
              near you
            </h1>
            <p className="text-lg text-gray-500 mb-8">
              Compare prices from all regional vendors in your local currency — kit cost,
              shipping included. Like Skyscanner, but for keyboards.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/browse"
                className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-colors shadow-sm"
              >
                Browse Group Buys
              </Link>
              <Link
                href="/browse?status=IN_STOCK"
                className="px-6 py-3 bg-white text-gray-700 rounded-xl font-semibold border border-gray-200 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
              >
                In-Stock Now →
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
                <p className="text-3xl font-bold text-gray-900">{s.value}</p>
                <p className="text-sm text-gray-500">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Featured sets */}
      {featured.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-gray-900">Featured Sets</h2>
            <Link href="/browse" className="text-sm text-indigo-600 hover:text-indigo-700 font-medium">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {featured.map((set) => (
              <Link
                key={set.id}
                href={`/sets/${set.slug}`}
                className="group bg-white rounded-2xl border border-gray-100 overflow-hidden hover:border-indigo-200 hover:shadow-md transition-all duration-200"
              >
                <div className="relative aspect-video bg-gray-50 overflow-hidden">
                  {set.imageUrl ? (
                    <Image
                      src={set.imageUrl}
                      alt={set.name}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                      unoptimized
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-indigo-50 to-purple-50">
                      <span className="text-5xl opacity-30">⌨</span>
                    </div>
                  )}
                  <div className="absolute top-3 left-3">
                    <StatusBadge status={set.status} size="sm" />
                  </div>
                </div>
                <div className="p-4">
                  <h3 className="font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors">
                    {set.name}
                  </h3>
                  {set.subtitle && (
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{set.subtitle}</p>
                  )}
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-gray-400">by {set.designer}</span>
                    <span className="text-xs text-gray-400">
                      {formatDateRange(set.gbStart, set.gbEnd)}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* How it works */}
      <section className="bg-white border-t border-gray-100 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-xl font-bold text-gray-900 mb-8 text-center">How it works</h2>
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
                <h3 className="font-semibold text-gray-900 mb-1">{step.title}</h3>
                <p className="text-sm text-gray-500">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
