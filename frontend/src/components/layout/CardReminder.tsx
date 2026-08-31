"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { CreditCard } from "lucide-react";
import { useT } from "@/store/prefStore";

type Status = { card_on_file?: boolean; complimentary?: boolean; viva_configured?: boolean; revolut_configured?: boolean };

/**
 * Διακριτική ένδειξη στο Topbar: όσο ο φαρμακοποιός ΔΕΝ έχει καταχωρήσει κάρτα, εμφανίζεται pill
 * «Χωρίς κάρτα» → κλικ = Ρυθμίσεις → Χρεώσεις (καταχώρηση κάρτας). Κρύβεται σε δωρεάν πελάτες ή
 * όταν δεν υπάρχει διαθέσιμος πάροχος πληρωμών.
 */
export function CardReminder() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["billing-status", "card-reminder"],
    queryFn: () => api<Status>("/billing/status"),
    retry: false, refetchInterval: 300_000,
  });
  if (!data || data.card_on_file) return null;
  if (!(data.viva_configured || data.revolut_configured)) return null;
  return (
    <>
      {/* Περιοδική μεγέθυνση (κάθε ~5s) για να «χτυπάει στο μάτι» χωρίς να είναι ενοχλητικό */}
      <style>{"@keyframes cardPulse{0%,72%,100%{transform:scale(1)}80%{transform:scale(1.22)}88%{transform:scale(1.06)}}"}</style>
      <Link href="/settings/billing" title={t("Δεν έχεις κάρτα — πρόσθεσέ την για αυτόματη ανανέωση συνδρομής (τέλος στη χειροκίνητη αγορά) + ξεκλείδωμα επιπλέον δυνατοτήτων. Πάτησε για καταχώρηση.", "No card — add one for automatic subscription renewal (no more manual purchase) + unlock extras. Click to add.")}
        style={{ animation: "cardPulse 5s ease-in-out infinite", transformOrigin: "center" }}
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-400 bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-800 shadow-sm hover:bg-amber-200 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-300">
        <CreditCard className="h-3.5 w-3.5" />
        <span>{t("Χωρίς κάρτα", "No card")}</span>
      </Link>
    </>
  );
}
