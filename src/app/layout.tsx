import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { LocationProvider } from "@/context/LocationContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { LocationSelector } from "@/components/home/LocationSelector";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MobileNav } from "@/components/layout/MobileNav";
import { ShippingLocationTab } from "@/components/layout/ShippingLocationTab";
import { SuggestProductTab } from "@/components/layout/SuggestProductTab";
import { TrackerProvider } from "@/context/TrackerContext";

export const metadata: Metadata = {
  title: {
    default: "GMK Tracker — Group Buy Price Locator",
    template: "%s | GMK Tracker",
  },
  description:
    "Find the best price for GMK keycap group buys and new releases from vendors worldwide. See prices in your local currency with shipping included.",
  openGraph: {
    siteName: "GMK Tracker",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-screen flex flex-col">
        <ThemeProvider>
          <LocationProvider>
            <TrackerProvider>
              <LocationSelector />
              <Header />
              {/* Right-edge ribbons, stacked: shipping location + suggest product */}
              <div className="fixed right-0 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-1.5 items-end">
                <ShippingLocationTab />
                <SuggestProductTab />
              </div>
              <main className="flex-1 pb-14 sm:pb-0">{children}</main>
              <div className="hidden sm:block"><Footer /></div>
              <MobileNav />
            </TrackerProvider>
          </LocationProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
