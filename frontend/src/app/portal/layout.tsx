import type { Metadata } from "next";
import { PoweredBy } from "@/components/brand/PoweredBy";
import { ThemeInit } from "@/components/layout/ThemeInit";

export const metadata: Metadata = {
  title: "RxVision — Πύλη Πελατών",
  description: "Δες τις συνταγές σου, ρώτησε για διαθεσιμότητα, κλείσε ραντεβού στο φαρμακείο σου.",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-900 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-slate-100">
      <ThemeInit />
      <div className="flex-1">{children}</div>
      <PoweredBy />
    </div>
  );
}
