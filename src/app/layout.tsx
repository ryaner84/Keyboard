import type { Metadata } from "next";
import "./globals.css";
import { LocationProvider } from "@/context/LocationContext";
import { LocationSelector } from "@/components/home/LocationSelector";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

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
    <html lang="en">
      <body className="bg-gray-50 min-h-screen flex flex-col">
        <LocationProvider>
          <LocationSelector />
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </LocationProvider>
      </body>
    </html>
  );
}
