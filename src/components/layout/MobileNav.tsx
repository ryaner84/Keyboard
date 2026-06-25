"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  {
    href: "/browse",
    label: "Keycaps",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-5 h-5">
        <rect x="3" y="8" width="18" height="10" rx="1.5" strokeWidth={1.8} />
        <rect x="6" y="11" width="2" height="2" rx="0.5" fill="currentColor" stroke="none" />
        <rect x="10" y="11" width="2" height="2" rx="0.5" fill="currentColor" stroke="none" />
        <rect x="14" y="11" width="2" height="2" rx="0.5" fill="currentColor" stroke="none" />
        <rect x="8" y="14" width="6" height="1.5" rx="0.5" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    href: "/keyboards",
    label: "Keyboards",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-5 h-5">
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <line x1="6" y1="10" x2="6.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
        <line x1="10" y1="10" x2="10.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
        <line x1="14" y1="10" x2="14.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
        <line x1="18" y1="10" x2="18.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
        <line x1="8" y1="14" x2="16" y2="14" strokeWidth={2.5} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/showcase",
    label: "Showcase",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-5 h-5">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    href: "/released",
    label: "Bargain",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
      </svg>
    ),
  },
  {
    href: "/timeline",
    label: "Timeline",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-5 h-5">
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 3" />
      </svg>
    ),
  },
  {
    href: "/collection",
    label: "Collection",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
      </svg>
    ),
  },
];

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 sm:hidden bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border-t border-gray-200 dark:border-gray-800"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-6 h-14">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href + "/"));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active
                  ? "text-indigo-600 dark:text-indigo-400"
                  : "text-gray-400 dark:text-gray-500 active:text-gray-700 dark:active:text-gray-300"
              }`}
            >
              {item.icon}
              <span className="text-[9.5px] font-medium leading-none truncate w-full text-center px-0.5">
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
