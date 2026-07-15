"use client";

// Κύκλωμα «Μεταφορά πελάτη σε εμάς» (Ασφαλισμένοι → Μεταφορά πελάτη).
// Δύο ΞΕΧΩΡΙΣΤΑ πράγματα: (1) η φόρμα αιτήματος, (2) η λίστα με πελάτες που άλλαξαν φαρμακείο.
import { ArrowRightLeft } from "lucide-react";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { TransferRequestCard, TransferNoticesCard } from "@/components/patients/TransferCard";

export default function PatientTransfersPage() {
  const t = useT();
  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-5 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-500 text-white shadow-lg">
          <ArrowRightLeft className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t("Μεταφορά πελάτη σε εμάς", "Transfer a customer to us")}
          </h1>
          <p className="text-sm text-slate-500">
            {t("Ζήτα να αναλάβεις έναν πελάτη — εγκρίνει ο ίδιος από την πύλη του. Εδώ βλέπεις και ποιοι δικοί σου πελάτες άλλαξαν φαρμακείο.",
              "Request to take over a customer — they approve it in their portal.")}
          </p>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <TransferRequestCard />
        <TransferNoticesCard />
      </div>
    </ModuleGuard>
  );
}
