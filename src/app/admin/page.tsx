import Link from "next/link";
import { prisma } from "@/lib/prisma";
import ImportButton from "./ImportButton";

async function getStats() {
  const [groupBuys, vendors, vendorKits] = await Promise.all([
    prisma.groupBuy.count(),
    prisma.vendor.count(),
    prisma.vendorKit.count(),
  ]);
  return { groupBuys, vendors, vendorKits };
}

export default async function AdminDashboard() {
  const stats = await getStats();

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[
          { label: "Group Buys", value: stats.groupBuys, href: "/admin/sets" },
          { label: "Vendors", value: stats.vendors, href: "/admin/vendors" },
          { label: "Vendor Listings", value: stats.vendorKits, href: "/admin/sets" },
        ].map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="bg-white rounded-2xl border border-gray-100 p-5 hover:border-indigo-200 transition-colors"
          >
            <p className="text-3xl font-bold text-gray-900">{s.value}</p>
            <p className="text-sm text-gray-500 mt-1">{s.label}</p>
          </Link>
        ))}
      </div>

      <div className="mb-4">
        <ImportButton />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link
          href="/admin/sets/new"
          className="flex items-center gap-3 bg-indigo-600 text-white rounded-2xl p-5 hover:bg-indigo-700 transition-colors"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <div>
            <p className="font-semibold">Add Group Buy</p>
            <p className="text-sm text-indigo-200">Create a new set listing</p>
          </div>
        </Link>

        <Link
          href="/admin/vendors/new"
          className="flex items-center gap-3 bg-white border border-gray-100 rounded-2xl p-5 hover:border-indigo-200 transition-colors"
        >
          <svg className="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          <div>
            <p className="font-semibold text-gray-900">Add Vendor</p>
            <p className="text-sm text-gray-400">Register a new regional vendor</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
