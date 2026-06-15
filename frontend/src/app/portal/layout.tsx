import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "RxVision — Πύλη Πελατών",
  description: "Δες τις συνταγές σου, ρώτησε για διαθεσιμότητα, κλείσε ραντεβού στο φαρμακείο σου.",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-900">
      {children}
    </div>
  );
}
