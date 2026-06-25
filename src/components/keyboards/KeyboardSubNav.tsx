"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/keyboards/active",   label: "Active",   sub: "GB Open + Extra Drop" },
  { href: "/keyboards/upcoming", label: "Upcoming", sub: "Interest Checks" },
  { href: "/keyboards/past",     label: "Catalog",  sub: "All keyboards" },
];

export function KeyboardSubNav() {
  const pathname = usePathname();

  return (
    <div className="border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-950 sticky top-0 z-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.map(({ href, label, sub }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex flex-col items-start shrink-0 px-4 py-3 border-b-2 text-sm font-semibold transition-colors ${
                  active
                    ? "border-violet-600 text-violet-700 dark:text-violet-400"
                    : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:border-gray-300"
                }`}
              >
                {label}
                <span className={`text-[10px] font-normal mt-0.5 ${active ? "text-violet-500" : "text-gray-400"}`}>
                  {sub}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
