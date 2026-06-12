import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { LocationProvider } from "@/context/LocationContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { LocationSelector } from "@/components/home/LocationSelector";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { ShippingLocationTab } from "@/components/layout/ShippingLocationTab";

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
            <LocationSelector />
            <Header />
            <ShippingLocationTab />
            <main className="flex-1">{children}</main>
            <Footer />
          </LocationProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
