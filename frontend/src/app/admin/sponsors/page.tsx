"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Handshake, Pencil, Plus, Receipt, Trash2, X } from "lucide-react";

import { ApiError, adminApi, adminDownload } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";

/** Χορηγοί ειδικών προσφορών (π.χ. φαρμακαποθήκη που πληρώνει τη συνδρομή των μελών της).
 *  Χρεώνονται ανά ενεργοποίηση, μόνο αφού η ΗΔΥΚΑ επιβεβαιώσει το ΑΦΜ του φαρμακείου. */

type Sponsor = {
  _id?: string; name: string; afm: string; doy: string; address: string; city: string; postal_code: string;
  email: string; phone: string; contact: string; country: "GR" | "CY"; active: boolean; notes: string;
  activations?: number; billed?: number; open?: number; offers?: number;
};
type Charge = {
  _id: string; promotion_name?: string; afm: string; pharmacy_name?: string; at: string; period_until?: string;
  net: number; vat: number; gross: number; pct?: number;
  invoice?: { id: string; settled: boolean; status?: string; issued: boolean; number: string } | null;
};

const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";
const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const dmy = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("el-GR") : "—");

const ERRORS: Record<string, string> = {
  name_required: "Δώστε επωνυμία.", afm_invalid: "Το ΑΦΜ δεν είναι έγκυρο.", afm_taken: "Υπάρχει ήδη χορηγός με αυτό το ΑΦΜ.",
  email_invalid: "Το email δεν είναι έγκυρο.",
};

const blank = (): Sponsor => ({ name: "", afm: "", doy: "", address: "", city: "", postal_code: "", email: "",
  phone: "", contact: "", country: "GR", active: true, notes: "" });

function Editor({ initial, onClose, onSaved }: { initial: Sponsor; onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<Sponsor>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Sponsor>) => setS((x) => ({ ...x, ...patch }));

  const lookup = async () => {
    // ΑΑΔΕ: συμπλήρωση επωνυμίας/ΔΟΥ/διεύθυνσης από το ΑΦΜ (ίδια υπηρεσία με την εγγραφή)
    try {
      const a = await adminApi<{ ok: boolean; name?: string; title?: string; doy?: string; address?: string; postal_code?: string; city?: string }>(`/onboarding/aade/${s.afm.trim()}`);
      if (a.ok) set({ name: s.name || a.title || a.name || "", doy: a.doy || s.doy, address: a.address || s.address, postal_code: a.postal_code || s.postal_code, city: a.city || s.city });
      else await appAlert("Η ΑΑΔΕ δεν βρήκε στοιχεία για αυτό το ΑΦΜ.", { title: "ΑΑΔΕ" });
    } catch { await appAlert("Η ΑΑΔΕ δεν απαντά αυτή τη στιγμή. Συμπληρώστε τα στοιχεία με το χέρι.", { title: "ΑΑΔΕ" }); }
  };

  const save = async () => {
    setBusy(true); setError("");
    try {
      await adminApi(s._id ? `/admin/sponsors/${s._id}` : "/admin/sponsors", { method: s._id ? "PUT" : "POST", body: JSON.stringify(s) });
      onSaved();
    } catch (e) {
      const code = e instanceof ApiError ? ((e.problem as { detail?: { error?: string } })?.detail?.error ?? "") : "";
      setError(ERRORS[code] || "Δεν αποθηκεύτηκε. Ελέγξτε τα πεδία.");
    }
    setBusy(false);
  };

  return (
    <div className="space-y-4 rounded-xl border border-indigo-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-900">{s._id ? "Επεξεργασία χορηγού" : "Νέος χορηγός"}</h2>
        <button type="button" onClick={onClose} aria-label="Κλείσιμο" className="rounded p-1 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-sm text-slate-600">ΑΦΜ
          <span className="flex gap-2"><input value={s.afm} onChange={(e) => set({ afm: e.target.value })} className={inp} />
            <button type="button" onClick={lookup} disabled={!/^\d{9}$/.test(s.afm.trim())} className="shrink-0 rounded-lg border border-slate-300 px-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40">ΑΑΔΕ</button></span></label>
        <label className="text-sm text-slate-600 md:col-span-2">Επωνυμία (όπως στο παραστατικό)
          <input value={s.name} onChange={(e) => set({ name: e.target.value })} className={inp} /></label>
        <label className="text-sm text-slate-600">ΔΟΥ<input value={s.doy} onChange={(e) => set({ doy: e.target.value })} className={inp} /></label>
        <label className="text-sm text-slate-600">Διεύθυνση<input value={s.address} onChange={(e) => set({ address: e.target.value })} className={inp} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm text-slate-600">Τ.Κ.<input value={s.postal_code} onChange={(e) => set({ postal_code: e.target.value })} className={inp} /></label>
          <label className="text-sm text-slate-600">Πόλη<input value={s.city} onChange={(e) => set({ city: e.target.value })} className={inp} /></label>
        </div>
        <label className="text-sm text-slate-600">Email λογιστηρίου (εκεί πάει το παραστατικό)<input value={s.email} onChange={(e) => set({ email: e.target.value })} className={inp} /></label>
        <label className="text-sm text-slate-600">Τηλέφωνο<input value={s.phone} onChange={(e) => set({ phone: e.target.value })} className={inp} /></label>
        <label className="text-sm text-slate-600">Υπεύθυνος επικοινωνίας<input value={s.contact} onChange={(e) => set({ contact: e.target.value })} className={inp} /></label>
        <label className="text-sm text-slate-600 md:col-span-3">Σημειώσεις (συμφωνία, όροι πληρωμής)
          <textarea value={s.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} className={inp} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3">
        <label className="inline-flex items-center gap-1.5 text-sm text-slate-700"><input type="checkbox" checked={s.active} onChange={(e) => set({ active: e.target.checked })} className="h-4 w-4 rounded border-slate-300" /> Ενεργός</label>
        {error && <span className="text-sm text-rose-600">{error}</span>}
        <button type="button" onClick={save} disabled={busy} className="ml-auto rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">Αποθήκευση</button>
      </div>
    </div>
  );
}

function Charges({ sponsor }: { sponsor: Sponsor }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "sponsors", sponsor._id, "charges"],
    queryFn: () => adminApi<{ items: Charge[] }>(`/admin/sponsors/${sponsor._id}/charges`) });
  const rows = q.data?.items ?? [];

  const settle = async (c: Charge, settled: boolean) => {
    if (!c.invoice) return;
    await adminApi(`/admin/invoices/${c.invoice.id}/settle`, { method: "POST", body: JSON.stringify({ settled }) });
    q.refetch();
    qc.invalidateQueries({ queryKey: ["admin", "sponsors"] });
  };

  if (q.isLoading) return <p className="text-sm text-slate-500">Φόρτωση…</p>;
  if (!rows.length) return <p className="text-sm text-slate-500">Καμία χρέωση ακόμη. Ο χορηγός χρεώνεται όταν ένα φαρμακείο της λίστας του συνδέσει ΗΔΥΚΑ και επιβεβαιωθεί το ΑΦΜ του.</p>;
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button type="button" onClick={() => adminDownload(`/admin/sponsors/${sponsor._id}/report`, `${sponsor.name || "sponsor"}-ενεργοποιήσεις.csv`).catch(() => appAlert("Δεν κατέβηκε η αναφορά.", { title: "Αναφορά" }))}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> Αναφορά για τον χορηγό (CSV)</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th className="py-1">Ενεργοποίηση</th><th>Φαρμακείο</th><th>ΑΦΜ</th><th>Προσφορά</th><th>Ποσό (με ΦΠΑ)</th><th>Παραστατικό</th><th>Εξόφληση</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((c) => (
              <tr key={c._id}>
                <td className="py-1.5">{dmy(c.at)}</td>
                <td>{c.pharmacy_name || "—"}</td>
                <td className="font-mono">{c.afm}</td>
                <td>{c.promotion_name || "—"}{c.pct && c.pct < 100 ? ` (${c.pct}%)` : ""}</td>
                <td>{eur(c.gross)}</td>
                <td>{c.invoice ? (c.invoice.issued ? "Εκδόθηκε" : "Σε αναμονή SoftOne") : <span className="text-amber-700">Δεν δημιουργήθηκε</span>}</td>
                <td>{c.invoice && (c.invoice.settled
                  ? <button type="button" onClick={() => settle(c, false)} className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 hover:underline" title="Αναίρεση">Εξοφλήθηκε</button>
                  : <button type="button" onClick={() => settle(c, true)} className="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-50">Σημείωσε εξόφληση</button>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function SponsorsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "sponsors"], queryFn: () => adminApi<{ items: Sponsor[] }>("/admin/sponsors") });
  const [editing, setEditing] = useState<Sponsor | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "sponsors"] });
  const items = q.data?.items ?? [];

  const remove = async (s: Sponsor) => {
    const used = (s.offers ?? 0) > 0 || (s.activations ?? 0) > 0;
    if (!(await appConfirm(used ? `Ο «${s.name}» έχει προσφορές ή χρεώσεις, οπότε θα απενεργοποιηθεί αντί να διαγραφεί, για να μείνει το ιστορικό.` : `Διαγραφή του «${s.name}»;`,
      { title: used ? "Απενεργοποίηση" : "Διαγραφή", danger: true, confirmText: used ? "Απενεργοποίηση" : "Διαγραφή" }))) return;
    await adminApi(`/admin/sponsors/${s._id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900"><Handshake className="h-5 w-5 text-indigo-600" /> Χορηγοί</h1>
          <p className="text-sm text-slate-500">Τρίτοι (π.χ. φαρμακαποθήκη) που πληρώνουν τη συνδρομή των μελών τους μέσα από μια ειδική προσφορά. Χρεώνονται ένα παραστατικό ανά φαρμακείο, μόνο αφού η ΗΔΥΚΑ επιβεβαιώσει το ΑΦΜ του. Δεν βλέπουν ποτέ δεδομένα χρήσης.</p>
        </div>
        {!editing && <button type="button" onClick={() => setEditing(blank())} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><Plus className="h-4 w-4" /> Νέος χορηγός</button>}
      </div>

      {editing && <Editor key={editing._id || "new"} initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}

      {q.isLoading && <p className="text-sm text-slate-500">Φόρτωση…</p>}
      {!q.isLoading && items.length === 0 && !editing && <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">Δεν υπάρχει κανένας χορηγός ακόμη.</p>}
      <div className="space-y-2">
        {items.map((s) => (
          <div key={s._id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">{s.name}</span>
                  {!s.active && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">Ανενεργός</span>}
                  <span className="font-mono text-xs text-slate-500">ΑΦΜ {s.afm}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">{s.offers ?? 0} προσφορές · {s.activations ?? 0} ενεργοποιήσεις · χρεώθηκαν {eur(s.billed)} · <b className={(s.open ?? 0) > 0 ? "text-amber-700" : "text-emerald-700"}>ανοιχτό {eur(s.open)}</b></p>
                {s.email && <p className="text-xs text-slate-500">{s.email}{s.contact ? ` · ${s.contact}` : ""}</p>}
              </div>
              <button type="button" onClick={() => setOpen(open === s._id ? null : s._id!)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Receipt className="h-3.5 w-3.5" /> Χρεώσεις</button>
              <button type="button" onClick={() => setEditing(s)} aria-label="Επεξεργασία" className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50"><Pencil className="h-4 w-4" /></button>
              <button type="button" onClick={() => remove(s)} aria-label="Διαγραφή" className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
            </div>
            {open === s._id && <div className="mt-3 border-t border-slate-100 pt-3"><Charges sponsor={s} /></div>}
          </div>
        ))}
      </div>
    </div>
  );
}
