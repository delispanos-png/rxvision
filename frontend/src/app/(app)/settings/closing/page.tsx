"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanBarcode, ListChecks, LayoutPanelLeft, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

export default function ClosingSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["reimb-settings"], queryFn: () => api<{ closing_mode: string; list_open: boolean }>("/reimbursement/settings") });
  const mode = data?.closing_mode ?? "classic";
  const listOpen = data?.list_open ?? false;
  const save = useMutation({
    mutationFn: (body: { closing_mode?: string; list_open?: boolean }) => api("/reimbursement/settings", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reimb-settings"] }),
  });

  const opts: { id: string; icon: typeof ScanBarcode; title: string; desc: string }[] = [
    { id: "classic", icon: ScanBarcode, title: t("Κλασικός", "Classic"),
      desc: t("Σκανάρεις μέρα-μέρα όλες τις συνταγές σε μία οθόνη, με προαιρετικό φίλτρο «μόνο όσες χρειάζονται έλεγχο».",
              "Scan all prescriptions day-by-day in one screen, with an optional «only those needing a check» filter.") },
    { id: "guided", icon: ListChecks, title: t("Καθοδηγούμενος (2 στάδια)", "Guided (2 stages)"),
      desc: t("Λιτή, καθοδηγούμενη ροή: Στάδιο 1 αριθμητικός (σκανάρεις όλες) → Στάδιο 2 ποιοτικός (οδηγός μία-συνταγή-τη-φορά μόνο για όσες χρειάζονται οπτικό έλεγχο).",
              "Lean guided flow: Stage 1 numeric (scan all) → Stage 2 qualitative (one-Rx-at-a-time wizard only for those needing a visual check).") },
    { id: "express", icon: LayoutPanelLeft, title: t("Όλα σε ένα βήμα (express)", "All-in-one (express)"),
      desc: t("Μία οθόνη: σκανάρεις και ΤΑΥΤΟΧΡΟΝΑ βλέπεις αριστερά τα κουπόνια και δεξιά τι πρέπει να ελέγξεις/καταθέσεις — χωρίς pop-up. Γρήγορο για έμπειρους.",
              "One screen: scan and at the same time see the coupons on the left and what to check/submit on the right — no pop-ups. Fast for power users.") },
  ];

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{t("Έλεγχος Barcode — Τρόπος κλεισίματος", "Barcode check — closing mode")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("Πώς θα γίνεται ο έλεγχος των συνταγών πριν την υποβολή στα ταμεία. Ισχύει για όλο το φαρμακείο.", "How prescriptions are checked before submission. Applies to the whole pharmacy.")}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {opts.map((o) => {
            const active = mode === o.id;
            return (
              <button key={o.id} onClick={() => { if (!active) save.mutate({ closing_mode: o.id }); }}
                className={`relative rounded-2xl border-2 p-4 text-left transition-colors ${active ? "border-emerald-500 bg-emerald-50/50 dark:border-emerald-600 dark:bg-emerald-950/20" : "border-slate-200 hover:border-slate-300 dark:border-slate-700"}`}>
                {active && <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-emerald-600 text-white"><Check className="h-3.5 w-3.5" /></span>}
                <o.icon className={`h-6 w-6 ${active ? "text-emerald-600" : "text-slate-400"}`} />
                <div className="mt-2 font-semibold text-slate-900 dark:text-slate-100">{o.title}</div>
                <p className="mt-1 text-xs text-slate-500">{o.desc}</p>
              </button>
            );
          })}
        </div>
        {/* προτίμηση: λίστα συνταγών ανοιχτή/κλειστή από προεπιλογή (κλασικός) */}
        <label className="mt-4 flex cursor-pointer items-center gap-2 border-t border-slate-100 pt-4 text-sm dark:border-slate-800">
          <button type="button" role="switch" aria-checked={listOpen} onClick={() => save.mutate({ list_open: !listOpen })}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${listOpen ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${listOpen ? "translate-x-4" : "translate-x-0.5"}`} />
          </button>
          <span className="text-slate-600 dark:text-slate-300">{t("Η λίστα συνταγών ημέρας να ξεκινά ανοιχτή (κλασικός τρόπος)", "Day prescriptions list starts expanded (classic mode)")}</span>
        </label>
        {save.isPending && <p className="mt-2 text-xs text-slate-400">{t("Αποθήκευση…", "Saving…")}</p>}
      </div>
    </div>
  );
}
