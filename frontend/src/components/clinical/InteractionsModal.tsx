"use client";

import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { ShieldAlert, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Modal } from "@/components/ui/Modal";

type Interaction = { a: string; b: string; severity: string; mechanism?: string; risk?: string; action?: string; involves_new?: boolean };
type Result = { ok?: boolean; error?: string; interactions?: Interaction[]; checked_drugs?: string[]; note?: string; summary?: string; source?: string; added?: string[] };

const SEV: Record<string, { cls: string; el: string }> = {
  minor: { cls: "bg-emerald-100 text-emerald-700 border-emerald-200", el: "Ήσσονος" },
  moderate: { cls: "bg-amber-100 text-amber-700 border-amber-200", el: "Μέτρια" },
  major: { cls: "bg-orange-100 text-orange-700 border-orange-200", el: "Σοβαρή" },
  contraindicated: { cls: "bg-rose-100 text-rose-700 border-rose-200", el: "Αντένδειξη" },
};

/** Έλεγχος αλληλεπιδράσεων φαρμάκων (PharmaCat AI). Καλεί το endpoint όταν ανοίγει· το backend
 *  κάνει cache platform-wide (ίδιος συνδυασμός = δωρεάν/άμεσο). Στέλνει ΜΟΝΟ ονόματα/δραστικές (όχι PII). */
export function InteractionsModal({ open, onClose, title, endpoint, body }: {
  open: boolean; onClose: () => void; title: string; endpoint: string; body?: object;
}) {
  const t = useT();
  const run = useMutation({
    mutationFn: () => api<Result>(endpoint, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  });
  const { mutate } = run;
  useEffect(() => { if (open) mutate(); }, [open, endpoint, mutate]);
  const r = run.data;

  return (
    <Modal open={open} onClose={onClose} size="lg"
      title={<span className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-orange-500" /> {title}</span>}>
      {run.isPending && (
        <div className="flex items-center gap-2 py-10 text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> {t("Ανάλυση αλληλεπιδράσεων…", "Analyzing interactions…")}</div>
      )}
      {run.isError && (
        <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{t("Ο έλεγχος δεν είναι διαθέσιμος (κλειδωμένο PharmaCat/AI module ή μη ρυθμισμένο κλειδί).", "Check unavailable (locked PharmaCat/AI module or missing key).")}</div>
      )}
      {r && r.ok === false && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {r.error === "trial_exhausted" ? t("Έφτασες το όριο των 30 δοκιμαστικών ερωτήσεων AI. Αναβάθμισε σε πληρωμένο πακέτο.", "You reached the 30 trial AI questions limit. Upgrade to a paid plan.")
            : r.error === "daily_limit" ? t("Έφτασες το ημερήσιο όριο AI ερωτημάτων.", "Daily AI limit reached.")
            : r.error === "patient_not_found" ? t("Δεν βρέθηκε ασθενής.", "Patient not found.")
            : r.error === "not_configured" ? t("Το AI δεν είναι ρυθμισμένο (κλειδί στο admin).", "AI not configured (set key in admin).")
            : t("Δεν ήταν δυνατός ο έλεγχος.", "Could not run the check.")}
        </div>
      )}
      {r && r.ok !== false && (
        <div className="space-y-3">
          {!!r.checked_drugs?.length && (
            <div className="text-xs text-slate-500">{t("Ελέγχθηκαν", "Checked")}: <span className="text-slate-600 dark:text-slate-300">{r.checked_drugs.join(" · ")}</span></div>
          )}
          {!!r.added?.length && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300">
              {t("Νέο σκεύασμα προς έλεγχο", "New medicine to check")}: <b>{r.added.join(" · ")}</b>
            </div>
          )}
          {r.summary && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200">{r.summary}</p>}
          {r.interactions?.length ? (
            <div className="space-y-2">{[...r.interactions].sort((a, b) => Number(!!b.involves_new) - Number(!!a.involves_new)).map((x, i) => {
              const sv = SEV[x.severity] ?? SEV.moderate;
              return (
                <div key={i} className={`rounded-lg border p-3 text-sm ${sv.cls} ${x.involves_new ? "ring-2 ring-indigo-400" : ""}`}>
                  <div className="flex items-center justify-between font-semibold">
                    <span className="flex items-center gap-1.5">{x.involves_new && <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{t("ΝΕΟ", "NEW")}</span>}{x.a} ↔ {x.b}</span>
                    <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px]">{sv.el}</span>
                  </div>
                  {x.mechanism && <div className="mt-1 opacity-90"><b>{t("Μηχανισμός", "Mechanism")}:</b> {x.mechanism}</div>}
                  {x.risk && <div className="opacity-90"><b>{t("Κίνδυνος", "Risk")}:</b> {x.risk}</div>}
                  {x.action && <div className="opacity-90"><b>{t("Ενέργεια", "Action")}:</b> {x.action}</div>}
                </div>
              );
            })}</div>
          ) : (
            <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              ✓ {r.note === "no_regimen_for_new"
                ? t("Ο ασθενής δεν έχει ενεργή αγωγή — δεν υπάρχει με τι να ελεγχθεί το νέο σκεύασμα.", "The patient has no active regimen — nothing to check the new medicine against.")
                : r.note === "no_drugs" || r.note === "no_active"
                ? t("Δεν βρέθηκαν φάρμακα/ενεργή αγωγή για έλεγχο.", "No medicines / active therapy to check.")
                : r.added?.length
                ? t("Δεν εντοπίστηκαν αλληλεπιδράσεις του νέου σκευάσματος με την ενεργή αγωγή.", "No interactions found between the new medicine and the active regimen.")
                : t("Δεν εντοπίστηκαν σημαντικές αλληλεπιδράσεις.", "No significant interactions found.")}
            </div>
          )}
          <p className="text-[11px] text-slate-400">{t("Υποβοήθηση κλινικής απόφασης — δεν υποκαθιστά την κρίση του φαρμακοποιού/ιατρού.", "Clinical decision support — not a substitute for professional judgment.")}</p>
        </div>
      )}
    </Modal>
  );
}
