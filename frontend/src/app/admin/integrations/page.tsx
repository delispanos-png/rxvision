"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BarChart3 } from "lucide-react";

import { adminApi } from "@/lib/adminClient";

type Clarity = { app?: string; portal?: string; enabled?: boolean };

/** Ενσωματώσεις πλατφόρμας. Σήμερα: Microsoft Clarity για app + πύλη.
 *  Το adminpanel ΔΕΝ παρακολουθείται — ρητή επιλογή ιδιοκτήτη. */
export default function IntegrationsPage() {
  const { data, refetch } = useQuery({
    queryKey: ["admin", "clarity"],
    queryFn: () => adminApi<Clarity>("/admin/analytics/clarity"), retry: false });
  const [form, setForm] = useState<Clarity>({ app: "", portal: "", enabled: true });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (data) setForm({ app: data.app || "", portal: data.portal || "", enabled: data.enabled !== false }); }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(null);
    try {
      await adminApi("/admin/analytics/clarity", { method: "PUT", body: JSON.stringify(form) });
      await refetch();
      setNotice("Αποθηκεύτηκε. Θα ισχύσει στην επόμενη φόρτωση σελίδας.");
    } catch {
      setNotice("Η αποθήκευση απέτυχε.");
    } finally { setBusy(false); }
  }

  const field = "w-full rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800";

  return (
    <div className="w-full space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800 dark:text-slate-100">
          <BarChart3 className="h-5 w-5 text-brand-600" /> Ενσωματώσεις
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Microsoft Clarity — παρακολούθηση συμπεριφοράς σε εφαρμογή φαρμακείου και πύλη πελατών.
        </p>
      </div>

      {/* Ο κίνδυνος ΔΙΠΛΑ στο πεδίο, όχι σε τεκμηρίωση που δεν θα διαβαστεί. */}
      <div className="flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
        <div className="text-sm text-amber-900 dark:text-amber-200">
          <p className="font-semibold">Πριν το ενεργοποιήσεις: βάλε «Masking: Strict» στο Clarity.</p>
          <p className="mt-1 text-amber-800/90 dark:text-amber-300/80">
            Το Clarity καταγράφει <b>ό,τι βλέπει η οθόνη</b>. Και οι δύο επιφάνειες δείχνουν
            ονόματα ασθενών, ΑΜΚΑ και φάρμακα — <b>δεδομένα υγείας</b>. Χωρίς αυστηρό
            μασκάρισμα, αντίγραφά τους φεύγουν στη Microsoft. Η ρύθμιση γίνεται στον πίνακα του
            Clarity (Settings → Masking), <b>όχι από εδώ</b>, και πρέπει να αναφέρεται στην
            πολιτική απορρήτου.
          </p>
        </div>
      </div>

      <form onSubmit={save} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={form.enabled !== false}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Ενεργή παρακολούθηση
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
              app.rxvision.gr <span className="text-slate-400">· εφαρμογή φαρμακείου</span>
            </label>
            <input value={form.app || ""} onChange={(e) => setForm({ ...form, app: e.target.value })}
              placeholder="project id, π.χ. abcd1234ef" className={field} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
              my.rxvision.gr <span className="text-slate-400">· πύλη πελατών</span>
            </label>
            <input value={form.portal || ""} onChange={(e) => setForm({ ...form, portal: e.target.value })}
              placeholder="project id" className={field} />
          </div>
        </div>

        <p className="text-xs text-slate-400">
          Επικόλλησε μόνο το <b>project id</b>. Αν επικολλήσεις ολόκληρο το snippet της Microsoft,
          το id εξάγεται αυτόματα. Άδειο πεδίο = καμία παρακολούθηση σε εκείνη την επιφάνεια.
          Το <b>adminpanel δεν παρακολουθείται</b> ποτέ.
        </p>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy}
            className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            {busy ? "Αποθήκευση…" : "Αποθήκευση"}
          </button>
          {notice && <span className="text-sm text-slate-500">{notice}</span>}
        </div>
      </form>
    </div>
  );
}
