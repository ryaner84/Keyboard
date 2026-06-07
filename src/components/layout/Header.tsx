"use client";

import Link from "next/link";
import { useLocation } from "@/context/LocationContext";
import { usePathname } from "next/navigation";

export function Header() {
  const { country, setShowModal } = useLocation();
  const pathname = usePathname();

  const navLinks = [
    { href: "/browse", label: "Browse" },
    { href: "/tracker", label: "My Tracker" },
  ];

  return (
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-sm border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-sm">⌨</span>
            </div>
            <span className="font-bold text-gray-900 text-base tracking-tight">GMK Tracker</span>
          </Link>

          {/* Nav */}
          <nav className="hidden sm:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  pathname === link.href
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Location pill */}
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 transition-colors text-sm"
          >
            <span className="text-base">{country?.flag ?? "🌐"}</span>
            <span className="text-gray-700 font-medium">{country?.code ?? "Select"}</span>
            <span className="text-gray-400 text-xs">{country?.currency}</span>
            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
