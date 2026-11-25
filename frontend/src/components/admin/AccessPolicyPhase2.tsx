"use client";

/* Πολιτική πρόσβασης — ΦΑΣΗ 2 στο adminpanel: διακόπτης «μέτρηση / επιβολή», όρια, ποιος ΘΑ έπαιρνε (ή πήρε)
   429, και το αρχείο εξαγωγών (ποιος, τι, πόσες γραμμές, SHA-256). */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { Download, Gauge, ShieldAlert, SlidersHorizontal } from "lucide-react";

export type AccessSettings = {
  mode: "observe" | "enforce"; per_min: number; per_hour: number; list_per_min: number; detail_per_min: number;
  exports_per_day: number; export_max_rows: number; strikes_to_lock: number; strike_window_min: number;
};
export type OverRow = { day: string; kind: string; user: string; tenant?: string | null; over: Record<string, number>; max_per_min: number };
export type ExportRow = { at: string; kind: string; user: string; tenant?: string | null; format?: string; screen?: string;
  rows?: number; rows_requested?: number; status?: string; over_limit?: boolean; sha256?: string | null };

const FIELDS: { key: keyof AccessSettings; label: string; hint: string }[] = [
  { key: "per_min", label: "Αιτήματα / λεπτό", hint: "οδηγία: 25" },
  { key: "per_hour", label: "Αιτήματα / ώρα", hint: "οδηγία: 300" },
  { key: "list_per_min", label: "Σελίδες λίστας / λεπτό", hint: "οδηγία: 4" },
  { key: "detail_per_min", label: "Λεπτομέρειες / λεπτό", hint: "οδηγία: 15" },
  { key: "exports_per_day", label: "Εξαγωγές / ημέρα", hint: "οδηγία: 3" },
  { key: "export_max_rows", label: "Μέγιστες γραμμές εξαγωγής", hint: "οδηγία: 2.000" },
  { key: "strikes_to_lock", label: "Strikes για κλείδωμα", hint: "οδηγία: 2" },
  { key: "strike_window_min", label: "Παράθυρο strikes (λεπτά)", hint: "οδηγία: 10" },
];
const RULE: Record<string, string> = {
  per_min: "αιτήματα/λεπτό", per_hour: "αιτήματα/ώρα", list_per_min: "λίστες/λεπτό", detail_per_min: "λεπτομέρειες/λεπτό",
};
const KIND: Record<string, string> = { tenant: "Εφαρμογή φαρμακείου", patient: "Πύλη πελάτη", admin: "Adminpanel" };
const dt = (s?: string | null) => (s ? new Date(s).toLocaleString("el-GR",
  { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Athens" }) : "—");

export function AccessPolicyPhase2({ settings, over, exports }: { settings?: AccessSettings; over: OverRow[]; exports: ExportRow[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<AccessSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings && !form) setForm(settings); }, [settings, form]);

  async function save(patch: Partial<AccessSettings>) {
    setBusy(true);
    try {
      const v = await adminApi<AccessSettings>("/admin/access-policy/settings", { method: "PUT", body: JSON.stringify(patch) });
      setForm(v);
      await qc.invalidateQueries({ queryKey: ["admin", "access-policy"] });
    } catch {
      await appAlert("Η αποθήκευση απέτυχε.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleMode() {
    if (!form) return;
    const next = form.mode === "enforce" ? "observe" : "enforce";
    const affected = over.length;
    const ok = await appConfirm(next === "enforce"
      ? `Ενεργοποίηση επιβολής: όποιος ξεπερνά τα όρια θα παίρνει «πάρα πολλά αιτήματα» και μετά από ${form.strikes_to_lock} υπερβάσεις μέσα σε ${form.strike_window_min}′ ο λογαριασμός του κλειδώνει 24 ώρες.${affected ? ` Στην περίοδο που βλέπεις, ${affected} φορές χρήστες ΘΑ είχαν μπλοκαριστεί.` : " Στην περίοδο που βλέπεις κανένας χρήστης δεν θα είχε μπλοκαριστεί."}`
      : "Επιστροφή σε μέτρηση: κανένας χρήστης δεν θα μπλοκάρεται για ρυθμό ή εξαγωγές (οι AI browsers μένουν μπλοκαρισμένοι).",
    { title: next === "enforce" ? "Επιβολή ορίων" : "Μόνο μέτρηση", confirmText: next === "enforce" ? "Ενεργοποίηση" : "Επιστροφή", danger: next === "enforce" });
    if (ok) await save({ mode: next });
  }

  return (
    <>
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"><SlidersHorizontal className="h-4 w-4" /> Όρια ρυθμού & εξαγωγών</h2>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          {!form ? <div className="text-sm text-slate-400">Φόρτωση…</div> : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold ring-1 ${form.mode === "enforce" ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
                  {form.mode === "enforce" ? <ShieldAlert className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
                  {form.mode === "enforce" ? "ΕΠΙΒΟΛΗ — οι υπερβάσεις μπλοκάρονται" : "ΜΕΤΡΗΣΗ — καταγράφεται ποιος θα μπλοκαριζόταν, κανείς δεν μπλοκάρεται"}
                </span>
                <button disabled={busy} onClick={toggleMode}
                  className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50">
                  {form.mode === "enforce" ? "Επιστροφή σε μέτρηση" : "Ενεργοποίηση επιβολής…"}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                {FIELDS.map((f) => (
                  <label key={f.key} className="text-xs text-slate-500">
                    {f.label}
                    <input type="number" min={1} value={form[f.key] as number}
                      onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none" />
                    <span className="text-[10px] text-slate-400">{f.hint}</span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex justify-end">
                <button disabled={busy} onClick={() => { const { mode: _m, ...rest } = form; void _m; void save(rest); }}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Αποθήκευση ορίων</button>
              </div>
            </>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-700">Ποιος ξεπέρασε (ή θα ξεπερνούσε) τα όρια</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Χρήστης</th>
                <th className="px-3 py-2.5 text-left font-semibold">Φαρμακείο</th>
                <th className="px-3 py-2.5 text-left font-semibold">Ημέρα</th>
                <th className="px-3 py-2.5 text-left font-semibold">Όρια (φορές)</th>
                <th className="px-3 py-2.5 text-right font-semibold">Μέγιστο/λεπτό</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!over.length && <tr><td colSpan={5} className="p-6 text-center text-emerald-700">Κανείς — με τα σημερινά όρια κανένας χρήστης δεν θα μπλοκαριζόταν.</td></tr>}
              {over.map((o, i) => (
                <tr key={i}>
                  <td className="px-4 py-2"><div className="font-medium text-slate-800">{o.user}</div><div className="text-[11px] text-slate-400">{KIND[o.kind] ?? o.kind}</div></td>
                  <td className="px-3 py-2 text-slate-600">{o.tenant || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{o.day.split("-").reverse().join("/")}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{Object.entries(o.over).map(([k, v]) => `${RULE[k] ?? k}: ${v}`).join(" · ")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{o.max_per_min}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"><Download className="h-4 w-4" /> Εξαγωγές (Excel / CSV / PDF)</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Πότε</th>
                <th className="px-3 py-2.5 text-left font-semibold">Χρήστης / φαρμακείο</th>
                <th className="px-3 py-2.5 text-left font-semibold">Οθόνη</th>
                <th className="px-3 py-2.5 text-left font-semibold">Τύπος</th>
                <th className="px-3 py-2.5 text-right font-semibold">Γραμμές</th>
                <th className="px-3 py-2.5 text-left font-semibold">Αποτέλεσμα</th>
                <th className="px-3 py-2.5 text-left font-semibold">SHA-256</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!exports.length && <tr><td colSpan={7} className="p-6 text-center text-slate-400">Καμία εξαγωγή σε αυτό το διάστημα.</td></tr>}
              {exports.map((e, i) => (
                <tr key={i} className={e.status === "denied" ? "bg-rose-50/40" : e.over_limit ? "bg-amber-50/40" : ""}>
                  <td className="px-4 py-2 text-slate-600">{dt(e.at)}</td>
                  <td className="px-3 py-2 text-slate-700">{e.user}<div className="text-[11px] text-slate-400">{KIND[e.kind] ?? e.kind}{e.tenant ? ` · ${e.tenant}` : ""}</div></td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-xs text-slate-500" title={e.screen}>{e.screen || "—"}</td>
                  <td className="px-3 py-2 text-xs font-semibold uppercase text-slate-600">{e.format}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{(e.rows ?? 0).toLocaleString("el-GR")}{e.rows_requested && e.rows_requested > (e.rows ?? 0) ? <span className="text-[11px] text-slate-400"> / {e.rows_requested.toLocaleString("el-GR")}</span> : null}</td>
                  <td className="px-3 py-2 text-xs">{e.status === "denied" ? <span className="font-semibold text-rose-700">αρνήθηκε (όριο)</span> : e.over_limit ? <span className="text-amber-700">πάνω από το όριο (μέτρηση)</span> : <span className="text-slate-500">επιτράπηκε</span>}</td>
                  <td className="px-3 py-2 font-mono text-[10px] text-slate-400" title={e.sha256 ?? ""}>{e.sha256 ? `${e.sha256.slice(0, 12)}…` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
