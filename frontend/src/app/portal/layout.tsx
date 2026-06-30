import type { Metadata } from "next";
import { PoweredBy } from "@/components/brand/PoweredBy";

export const metadata: Metadata = {
  title: "RxVision — Πύλη Πελατών",
  description: "Δες τις συνταγές σου, ρώτησε για διαθεσιμότητα, κλείσε ραντεβού στο φαρμακείο σου.",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col overflow-x-clip bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-900">
      <div className="flex-1">{children}</div>
      <PoweredBy />
    </div>
  );
}
