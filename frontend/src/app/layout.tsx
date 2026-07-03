import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";

// Self-hosted at build time (no runtime request to Google Fonts → no user-IP leak + tighter CSP).
const inter = Inter({ subsets: ["latin", "greek"], display: "swap", variable: "--font-inter" });
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { CookieConsent } from "@/components/legal/CookieConsent";

export const metadata: Metadata = {
  metadataBase: new URL("https://app.rxvision.gr"),
  title: { default: "RxVision", template: "%s — RxVision" },
  description: "Στατιστική ανάλυση εκτελέσεων συνταγών φαρμακείου",
  applicationName: "RxVision",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "RxVision", statusBarStyle: "default" },
  icons: { icon: "/favicon.ico", apple: "/icons/apple-touch-icon.png" },
  openGraph: {
    type: "website",
    siteName: "RxVision",
    title: "RxVision",
    description: "Στατιστική ανάλυση εκτελέσεων συνταγών φαρμακείου",
    locale: "el_GR",
    images: [{ url: "/icons/apple-touch-icon.png" }],
  },
  twitter: { card: "summary", title: "RxVision", description: "Στατιστική ανάλυση εκτελέσεων συνταγών φαρμακείου" },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="el" className={inter.variable}>
      <body className="bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <ServiceWorkerRegister />
        <Providers>{children}</Providers>
        <CookieConsent />
      </body>
    </html>
  );
}
