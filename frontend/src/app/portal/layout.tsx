import type { Metadata } from "next";
import { ThemeInit } from "@/components/layout/ThemeInit";

export const metadata: Metadata = {
  title: "RxVision — Πύλη Πελατών",
  description: "Δες τις συνταγές σου, ρώτησε για διαθεσιμότητα, κλείσε ραντεβού στο φαρμακείο σου.",
};

// App-shell ύψους οθόνης (100dvh) που ΔΕΝ σκρολάρει — το περιεχόμενο σκρολάρει μέσα του, ώστε το
// κάτω μενού (κινητό) να μένει ΜΟΝΙΜΑ κολλημένο κάτω και να μη «φεύγει» με το scroll.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-900 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-slate-100">
      <ThemeInit />
      {children}
    </div>
  );
}
