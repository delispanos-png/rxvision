"use client";

/* «Αυτός ο πελάτης σου χρωστά κουτί.»

   ΠΟΥ ΜΠΑΙΝΕΙ: στην καρτέλα πελάτη (Εικόνα Πελάτη) και στην καρτέλα στοιχείων επικοινωνίας που
   ανοίγει ο φαρμακοποιός στο ταμείο. ΓΙΑΤΙ: κανείς δεν ανοίγει τη λίστα δανεικών όταν έχει τον
   πελάτη μπροστά του — η πληροφορία πρέπει να τον βρει εκεί που ήδη κοιτάζει, αλλιώς το χρέος
   θυμάται μόνο όποιος το έδωσε.

   ΔΕΝ χτυπάει το API αν το πρόσθετο είναι κλειστό (θα γύριζε 403 σε κάθε άνοιγμα καρτέλας). */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { HandCoins } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useAddonState } from "@/components/layout/AddonSection";
import { useT } from "@/store/prefStore";

type Item = { name?: string; gtin?: string; lot?: string };
type Loan = { _id: string; items?: Item[]; created_at?: string };

const daysAgo = (s?: string) => (s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : 0);

export function AdvanceLoanNotice({ patientId, compact = false }: { patientId?: string | null; compact?: boolean }) {
  const t = useT();
  const on = useAddonState("advance_dispensing").state === "on";
  const q = useQuery({
    queryKey: ["adv", "for-patient", patientId],
    queryFn: () => api<{ items: Loan[]; count: number }>(`/advance-dispensings/for-patient?ref=${encodeURIComponent(patientId!)}`),
    enabled: on && !!patientId,
    retry: false,
    staleTime: 60_000,
  });

  const loans = q.data?.items || [];
  if (!loans.length) return null;

  const names = loans.flatMap((l) => (l.items || []).map((i) => i.name || i.gtin || i.lot)).filter(Boolean);
  const oldest = Math.max(...loans.map((l) => daysAgo(l.created_at)));

  if (compact) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
        <HandCoins className="h-3 w-3" />
        {t(`Χρωστά ${loans.length} δανεικό${loans.length > 1 ? "ά" : ""}`, `Owes ${loans.length} loan${loans.length > 1 ? "s" : ""}`)}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm dark:border-amber-900/50 dark:bg-amber-950/25">
      <HandCoins className="h-4 w-4 shrink-0 text-amber-600" />
      <span className="font-semibold text-amber-900 dark:text-amber-200">
        {t("Εκκρεμεί προχορήγηση (δανεικό)", "Open advance dispensing")}
      </span>
      <span className="text-amber-800/80 dark:text-amber-200/70">
        {names.slice(0, 4).join(", ")}{names.length > 4 ? "…" : ""}
        {oldest > 0 ? ` · ${t(`εδώ και ${oldest} ημέρες`, `${oldest} days ago`)}` : ""}
      </span>
      <Link href="/patients/advance"
        className="ml-auto rounded-lg border border-amber-400 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:text-amber-200">
        {t("Διαχείριση", "Manage")}
      </Link>
    </div>
  );
}
