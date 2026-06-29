"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanBarcode, ListChecks, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

export default function ClosingSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["reimb-settings"], queryFn: () => api<{ closing_mode: string }>("/reimbursement/settings") });
  const mode = data?.closing_mode ?? "classic";
  const save = useMutation({
    mutationFn: (m: string) => api("/reimbursement/settings", { method: "POST", body: JSON.stringify({ closing_mode: m }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reimb-settings"] }),
  });

  const opts: { id: string; icon: typeof ScanBarcode; title: string; desc: string }[] = [
    { id: "classic", icon: ScanBarcode, title: t("Κλασικός", "Classic"),
      desc: t("Σκανάρεις μέρα-μέρα όλες τις συνταγές σε μία οθόνη, με προαιρετικό φίλτρο «μόνο όσες χρειάζονται έλεγχο».",
              "Scan all prescriptions day-by-day in one screen, with an optional «only those needing a check» filter.") },
    { id: "guided", icon: ListChecks, title: t("Καθοδηγούμενος (2 στάδια)", "Guided (2 stages)"),
      desc: t("Λιτή, καθοδηγούμενη ροή: Στάδιο 1 αριθμητικός (σκανάρεις όλες) → Στάδιο 2 ποιοτικός (οδηγός μία-συνταγή-τη-φορά μόνο για όσες χρειάζονται οπτικό έλεγχο).",
              "Lean guided flow: Stage 1 numeric (scan all) → Stage 2 qualitative (one-Rx-at-a-time wizard only for those needing a visual check).") },
  ];

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{t("Έλεγχος Barcode — Τρόπος κλεισίματος", "Barcode check — closing mode")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("Πώς θα γίνεται ο έλεγχος των συνταγών πριν την υποβολή στα ταμεία. Ισχύει για όλο το φαρμακείο.", "How prescriptions are checked before submission. Applies to the whole pharmacy.")}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {opts.map((o) => {
            const active = mode === o.id;
            return (
              <button key={o.id} onClick={() => { if (!active) save.mutate(o.id); }}
                className={`relative rounded-2xl border-2 p-4 text-left transition-colors ${active ? "border-emerald-500 bg-emerald-50/50 dark:border-emerald-600 dark:bg-emerald-950/20" : "border-slate-200 hover:border-slate-300 dark:border-slate-700"}`}>
                {active && <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-emerald-600 text-white"><Check className="h-3.5 w-3.5" /></span>}
                <o.icon className={`h-6 w-6 ${active ? "text-emerald-600" : "text-slate-400"}`} />
                <div className="mt-2 font-semibold text-slate-900 dark:text-slate-100">{o.title}</div>
                <p className="mt-1 text-xs text-slate-500">{o.desc}</p>
              </button>
            );
          })}
        </div>
        {save.isPending && <p className="mt-2 text-xs text-slate-400">{t("Αποθήκευση…", "Saving…")}</p>}
      </div>
    </div>
  );
}
