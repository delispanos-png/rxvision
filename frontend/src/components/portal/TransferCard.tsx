"use client";

// Έγκριση μεταφοράς σε άλλο φαρμακείο — το αίτημα το κάνει το ΝΕΟ φαρμακείο, εγκρίνει ο ΠΕΛΑΤΗΣ.
// Δείχνουμε ΡΗΤΑ τι θα μεταφερθεί ΚΑΙ ότι το τρέχον φαρμακείο θα ενημερωθεί (με την αιτιολογία)
// — ο πελάτης πρέπει να ξέρει τι συναινεί πριν πατήσει «Έγκριση».
import { useEffect, useState } from "react";
import { Building2, Check, X } from "lucide-react";
import { patientApi } from "@/lib/patientClient";
import { toast } from "@/components/portal/Toaster";
import { useT } from "@/store/prefStore";

export type Transfer = { id: string; pharmacy_name: string; tenant_id: string; reason_label?: string; note?: string | null };

export function TransferCard({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [items, setItems] = useState<Transfer[]>([]);
  const [busy, setBusy] = useState("");

  useEffect(() => { patientApi<{ items: Transfer[] }>("/patient/transfers").then((d) => setItems(d.items)).catch(() => {}); }, []);

  async function decide(tf: Transfer, accept: boolean) {
    setBusy(tf.id);
    try {
      await patientApi("/patient/transfers/decide", { method: "POST", body: JSON.stringify({ transfer_id: tf.id, accept }) });
      setItems((xs) => xs.filter((x) => x.id !== tf.id));
      toast(accept ? t(`Το ${tf.pharmacy_name} σε εξυπηρετεί πλέον!`, `${tf.pharmacy_name} now serves you!`) : t("Το αίτημα απορρίφθηκε.", "The request was declined."), accept ? "success" : "info");
      if (accept) onDone();
    } catch { toast(t("Κάτι πήγε στραβά — δοκίμασε ξανά.", "Something went wrong — try again."), "error"); } finally { setBusy(""); }
  }

  if (items.length === 0) return null;
  return (
    <div className="mb-5 space-y-3">
      {items.map((tf) => (
        <div key={tf.id} className="rounded-2xl border border-brand-200 bg-brand-50/60 p-4">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600"><Building2 className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{t("Αίτημα αλλαγής φαρμακείου", "Pharmacy change request")}</div>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                {t("Το", "")} <b>{tf.pharmacy_name}</b> {t("ζητά να γίνει το φαρμακείο που σε εξυπηρετεί.", "is requesting to become your serving pharmacy.")}
              </p>
              {tf.reason_label && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("Αιτιολογία:", "Reason:")} <b>{tf.reason_label}</b>{tf.note ? ` — «${tf.note}»` : ""}</p>
              )}
              <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                <li>• {t("Μεταφέρονται:", "Transferred:")} <b>{t("πρόγραμμα λήψης, μετρήσεις υγείας, στοιχεία επικοινωνίας", "medication schedule, health measurements, contact details")}</b>.</li>
                <li>• {t("Οι", "Your")} <b>{t("εκτελέσεις σου παραμένουν", "executions stay with you")}</b> — {t("θα τις βλέπεις όλες, με ένδειξη σε ποιο φαρμακείο έγιναν.", "you'll see them all, marked with the pharmacy where they were done.")}</li>
                <li>• {t("Το", "Your")} <b>{t("τρέχον φαρμακείο σου θα ενημερωθεί", "current pharmacy will be notified")}</b> {t("ότι άλλαξες, με την παραπάνω αιτιολογία.", "that you switched, with the reason above.")}</li>
              </ul>
              <div className="mt-3 flex gap-2">
                <button onClick={() => decide(tf, true)} disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
                  <Check className="h-4 w-4" /> {t("Έγκριση", "Approve")}
                </button>
                <button onClick={() => decide(tf, false)} disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3.5 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60">
                  <X className="h-4 w-4" /> {t("Απόρριψη", "Reject")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
