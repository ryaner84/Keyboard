"use client";

import Link from "next/link";
import { useLocation } from "@/context/LocationContext";
import { usePathname } from "next/navigation";
import { CurrencySelector } from "./CurrencySelector";
import { ThemeToggle } from "./ThemeToggle";
import { FeedbackButton } from "./FeedbackButton";
import { HeaderSearch } from "./HeaderSearch";
import { TrackerAccountButton } from "./TrackerAccountButton";

// Segmented pill that groups keycap GBs and keyboard GBs as one nav category.
function GBSegment({ pathname }: { pathname: string }) {
  const onKeycaps = pathname === "/browse";
  const onKeyboards = pathname === "/keyboards";
  const active = onKeycaps || onKeyboards;

  return (
    <div
      className={`flex items-stretch rounded-lg border text-sm font-medium transition-colors overflow-hidden ${
        active
          ? "border-indigo-200 dark:border-indigo-700"
          : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      {/* "GBs" eyebrow — visually labels the pair as Group Buys on wide screens */}
      <span className="hidden xl:flex items-center pl-2.5 pr-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 select-none border-r border-gray-200 dark:border-gray-700">
        GBs
      </span>
      <Link
        href="/browse"
        className={`flex items-center gap-1.5 px-3 py-1.5 border-r transition-colors ${
          onKeycaps
            ? "bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-700"
            : "text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800 border-gray-200 dark:border-gray-700"
        }`}
      >
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <rect x="3" y="8" width="18" height="10" rx="1.5" />
          <rect x="6" y="11" width="2" height="2" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="10" y="11" width="2" height="2" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="14" y="11" width="2" height="2" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="8" y="14" width="6" height="1.5" rx="0.5" fill="currentColor" stroke="none" />
        </svg>
        Keycaps
      </Link>
      <Link
        href="/keyboards"
        className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
          onKeyboards
            ? "bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
            : "text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800"
        }`}
      >
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <line x1="6" y1="10" x2="6.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="10" y1="10" x2="10.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="14" y1="10" x2="14.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="18" y1="10" x2="18.01" y2="10" strokeWidth={2.5} strokeLinecap="round" />
          <line x1="8" y1="14" x2="16" y2="14" strokeWidth={2.5} strokeLinecap="round" />
        </svg>
        Keyboards
      </Link>
    </div>
  );
}

export function Header() {
  const { country, setShowModal } = useLocation();
  const pathname = usePathname();

  const navLinks = [
    { href: "/released", label: "Bargain" },
    { href: "/timeline", label: "Timeline" },
    { href: "/collection", label: "My Collection" },
  ];

  return (
    <header className="sticky top-0 z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border-b border-gray-100 dark:border-gray-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14 gap-2">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-sm">⌨</span>
            </div>
            <span className="font-bold text-gray-900 dark:text-white text-base tracking-tight hidden sm:block">
              GMK Tracker
            </span>
          </Link>

          {/* Nav */}
          <nav className="hidden sm:flex items-center gap-1 mr-auto ml-4">
            <GBSegment pathname={pathname} />
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  pathname === link.href
                    ? "bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
                    : "text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Controls: search · feedback · location · currency · theme */}
          <div className="flex items-center gap-2">
            <HeaderSearch />
            <FeedbackButton />

            {/* Shipping location */}
            <button
              onClick={() => setShowModal(true)}
              title="Shipping location"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-500 transition-colors text-sm"
            >
              <span className="text-base">{country?.flag ?? "🌐"}</span>
              <span className="text-gray-700 dark:text-gray-200 font-medium hidden md:inline">
                {country?.code ?? "Select"}
              </span>
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            <CurrencySelector />
            <ThemeToggle />
            <TrackerAccountButton />
          </div>
        </div>
      </div>
    </header>
  );
}
