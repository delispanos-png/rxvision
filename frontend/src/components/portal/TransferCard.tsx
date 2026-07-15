"use client";

// Έγκριση μεταφοράς σε άλλο φαρμακείο — το αίτημα το κάνει το ΝΕΟ φαρμακείο, εγκρίνει ο ΠΕΛΑΤΗΣ.
// Δείχνουμε ΡΗΤΑ τι θα μεταφερθεί ΚΑΙ ότι το τρέχον φαρμακείο θα ενημερωθεί (με την αιτιολογία)
// — ο πελάτης πρέπει να ξέρει τι συναινεί πριν πατήσει «Έγκριση».
import { useEffect, useState } from "react";
import { Building2, Check, X } from "lucide-react";
import { patientApi } from "@/lib/patientClient";
import { toast } from "@/components/portal/Toaster";

export type Transfer = { id: string; pharmacy_name: string; tenant_id: string; reason_label?: string; note?: string | null };

export function TransferCard({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<Transfer[]>([]);
  const [busy, setBusy] = useState("");

  useEffect(() => { patientApi<{ items: Transfer[] }>("/patient/transfers").then((d) => setItems(d.items)).catch(() => {}); }, []);

  async function decide(t: Transfer, accept: boolean) {
    setBusy(t.id);
    try {
      await patientApi("/patient/transfers/decide", { method: "POST", body: JSON.stringify({ transfer_id: t.id, accept }) });
      setItems((xs) => xs.filter((x) => x.id !== t.id));
      toast(accept ? `Το ${t.pharmacy_name} σε εξυπηρετεί πλέον!` : "Το αίτημα απορρίφθηκε.", accept ? "success" : "info");
      if (accept) onDone();
    } catch { toast("Κάτι πήγε στραβά — δοκίμασε ξανά.", "error"); } finally { setBusy(""); }
  }

  if (items.length === 0) return null;
  return (
    <div className="mb-5 space-y-3">
      {items.map((t) => (
        <div key={t.id} className="rounded-2xl border border-brand-200 bg-brand-50/60 p-4">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600"><Building2 className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-slate-900">Αίτημα αλλαγής φαρμακείου</div>
              <p className="mt-0.5 text-sm text-slate-600">
                Το <b>{t.pharmacy_name}</b> ζητά να γίνει το φαρμακείο που σε εξυπηρετεί.
              </p>
              {t.reason_label && (
                <p className="mt-1 text-xs text-slate-500">Αιτιολογία: <b>{t.reason_label}</b>{t.note ? ` — «${t.note}»` : ""}</p>
              )}
              <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">
                <li>• Μεταφέρονται: <b>πρόγραμμα λήψης, μετρήσεις υγείας, στοιχεία επικοινωνίας</b>.</li>
                <li>• Οι <b>εκτελέσεις σου παραμένουν</b> — θα τις βλέπεις όλες, με ένδειξη σε ποιο φαρμακείο έγιναν.</li>
                <li>• Το <b>τρέχον φαρμακείο σου θα ενημερωθεί</b> ότι άλλαξες, με την παραπάνω αιτιολογία.</li>
              </ul>
              <div className="mt-3 flex gap-2">
                <button onClick={() => decide(t, true)} disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
                  <Check className="h-4 w-4" /> Έγκριση
                </button>
                <button onClick={() => decide(t, false)} disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                  <X className="h-4 w-4" /> Απόρριψη
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
