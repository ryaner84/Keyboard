"use client";

import Link from "next/link";
import { useLocation } from "@/context/LocationContext";
import { usePathname } from "next/navigation";
import { CurrencySelector } from "./CurrencySelector";
import { ThemeToggle } from "./ThemeToggle";
import { FeedbackButton } from "./FeedbackButton";
import { HeaderSearch } from "./HeaderSearch";

export function Header() {
  const { country, setShowModal } = useLocation();
  const pathname = usePathname();

  const navLinks = [
    { href: "/browse", label: "Group Buys" },
    { href: "/released", label: "Released" },
    { href: "/timeline", label: "Timeline" },
    { href: "/tracker", label: "My Tracker" },
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
            {/* Global set search */}
            <HeaderSearch />

            {/* Feedback */}
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

            {/* Display currency */}
            <CurrencySelector />

            {/* Dark / light */}
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
