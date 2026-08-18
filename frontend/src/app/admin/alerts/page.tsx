"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Smartphone, Plus, Trash2, Save, Send, Loader2, Check } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Res = { phones: string[] };

export default function OwnerAlertsPage() {
  const { data } = useQuery({ queryKey: ["admin", "alert-recipients"], queryFn: () => adminApi<Res>("/admin/alert-recipients"), retry: false });
  const [phones, setPhones] = useState<string[]>([""]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (data) setPhones(data.phones.length ? data.phones : [""]); }, [data]);

  const setAt = (i: number, v: string) => setPhones((p) => p.map((x, k) => (k === i ? v : x)));
  const add = () => setPhones((p) => [...p, ""]);
  const remove = (i: number) => setPhones((p) => (p.length > 1 ? p.filter((_, k) => k !== i) : [""]));

  async function save() {
    setBusy(true); setNotice(null); setSaved(false);
    try {
      const clean = phones.map((p) => p.trim()).filter(Boolean);
      const r = await adminApi<Res>("/admin/alert-recipients", { method: "PUT", body: JSON.stringify({ phones: clean }) });
      setPhones(r.phones.length ? r.phones : [""]);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch {
      setNotice("Σφάλμα αποθήκευσης.");
    } finally { setBusy(false); }
  }

  async function test() {
    setTesting(true); setNotice(null);
    try {
      await adminApi("/admin/alert-recipients/test", { method: "POST" });
      setNotice("✅ Στάλθηκε δοκιμαστικό SMS στα καταχωρημένα κινητά.");
    } catch {
      setNotice("Σφάλμα αποστολής δοκιμαστικού.");
    } finally { setTesting(false); }
  }

  return (
    <div className="w-full max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg"><Smartphone className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">SMS ιδιοκτήτη</h1>
          <p className="text-sm text-slate-500">Ειδοποιήσεις στο κινητό για κρίσιμα γεγονότα της πλατφόρμας.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
          Θα λαμβάνεις SMS όταν:
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-[13px]">
            <li>🆕 <b>Νέα εγγραφή</b> πελάτη (δοκιμαστική ή πληρωμένη) — με στοιχεία & τύπο συνδρομής.</li>
            <li>✅ <b>Ξεκίνησε ο συγχρονισμός ΗΔΥΚΑ</b> ενός φαρμακείου (πρώτα δεδομένα).</li>
            <li>⚠️ <b>Πρόβλημα ΗΔΥΚΑ</b> (λάθος κωδικός ή σφάλμα ρύθμισης).</li>
          </ul>
        </div>

        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Κινητά παραληπτών</label>
        <div className="space-y-2">
          {phones.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={p} onChange={(e) => setAt(i, e.target.value)} placeholder="π.χ. 6955212032"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
              <button onClick={() => remove(i)} title="Αφαίρεση" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <button onClick={add} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300">
          <Plus className="h-3.5 w-3.5" /> Προσθήκη τηλεφώνου
        </button>

        {notice && <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200">{notice}</div>}

        <div className="mt-4 flex items-center justify-between gap-3">
          <button onClick={test} disabled={testing} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Δοκιμαστικό SMS
          </button>
          <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-5 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} {saved ? "Αποθηκεύτηκε" : "Αποθήκευση"}
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-400">Τα SMS στέλνονται από τον κεντρικό λογαριασμό Apifon (χωρίς χρέωση φαρμακείου). Χαμηλός όγκος.</p>
    </div>
  );
}
