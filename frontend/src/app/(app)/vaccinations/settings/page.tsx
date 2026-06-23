"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";

type Band = { age_group: string; opens_at: string; closes_at?: string | null };
type Campaign = {
  name: string; season: string; period_start: string; period_end: string;
  rollout: Band[]; priority_icd: string[];
};

const AGE_BANDS = ["75+", "65-74", "50-64", "35-49", "18-34", "0-17"];
const toDate = (s?: string) => (s ? new Date(s).toISOString().slice(0, 10) : "");

export default function VaccinationSettingsPage() {
  const t = useT();
  const camp = useQuery({ queryKey: ["vacc-campaign-settings"], queryFn: () => api<Campaign>("/vaccinations/campaign") });

  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [rollout, setRollout] = useState<Record<string, { from: string; to: string }>>({});
  const [icd, setIcd] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const c = camp.data;
    if (!c) return;
    setName(c.name); setStart(toDate(c.period_start)); setEnd(toDate(c.period_end));
    const r: Record<string, { from: string; to: string }> = {};
    (c.rollout || []).forEach((b) => { r[b.age_group] = { from: toDate(b.opens_at), to: toDate(b.closes_at || undefined) }; });
    setRollout(r);
    setIcd((c.priority_icd || []).join(", "));
  }, [camp.data]);

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api("/vaccinations/campaign", {
        method: "PUT",
        body: JSON.stringify({
          name,
          period_start: start ? new Date(start).toISOString() : undefined,
          period_end: end ? new Date(end).toISOString() : undefined,
          rollout: AGE_BANDS.filter((a) => rollout[a]?.from).map((a) => ({
            age_group: a,
            opens_at: new Date(rollout[a].from).toISOString(),
            closes_at: rollout[a].to ? new Date(rollout[a].to).toISOString() : null,
          })),
          priority_icd: icd.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setSaved(true);
    } catch { setErr(t("Αποτυχία αποθήκευσης.", "Save failed.")); }
    finally { setBusy(false); }
  };

  return (
    <QueryState isLoading={camp.isLoading} isError={camp.isError} onRetry={() => camp.refetch()}>
      <div className="max-w-2xl space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Στοιχεία campaign", "Campaign details")}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-xs font-medium text-slate-500 sm:col-span-2">{t("Όνομα", "Name")}
              <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            </label>
            <label className="block text-xs font-medium text-slate-500">{t("Έναρξη περιόδου", "Period start")}
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            </label>
            <label className="block text-xs font-medium text-slate-500">{t("Λήξη περιόδου", "Period end")}
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Άνοιγμα ανά ηλικιακή ομάδα", "Rollout by age group")}</h3>
          <p className="mb-3 text-xs text-slate-500">{t("Οι μεγαλύτερες ηλικίες ανοίγουν πρώτες. Ορίστε πότε «ανοίγει» κάθε ομάδα.", "Older ages open first. Set when each band opens.")}</p>
          <div className="space-y-2">
            <div className="flex items-center gap-3 pl-16 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              <span className="w-[8.5rem]">{t("Από", "From")}</span>
              <span className="w-[8.5rem]">{t("Έως", "To")}</span>
            </div>
            {AGE_BANDS.map((a) => (
              <div key={a} className="flex items-center gap-3">
                <span className="w-16 text-sm font-semibold text-slate-700 dark:text-slate-200">{a}</span>
                <input type="date" value={rollout[a]?.from || ""}
                  onChange={(e) => setRollout((r) => ({ ...r, [a]: { from: e.target.value, to: r[a]?.to || "" } }))}
                  className="w-[8.5rem] rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
                <input type="date" value={rollout[a]?.to || ""}
                  onChange={(e) => setRollout((r) => ({ ...r, [a]: { from: r[a]?.from || "", to: e.target.value } }))}
                  className="w-[8.5rem] rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Κατηγορίες υψηλής προτεραιότητας (ICD-10)", "High-priority ICD-10 categories")}</h3>
          <p className="mb-3 text-xs text-slate-500">{t("Μοτίβα κωδικών (regex prefix) που δίνουν προτεραιότητα. Π.χ. ^J = αναπνευστικά, ^E1[0-4] = διαβήτης, ^I = καρδιαγγειακά, ^N18 = χρόνια νεφρική.", "Code patterns (regex prefix) granting priority. e.g. ^J = respiratory, ^E1[0-4] = diabetes, ^I = cardiovascular, ^N18 = chronic kidney.")}</p>
          <input value={icd} onChange={(e) => setIcd(e.target.value)} placeholder="^J, ^E1[0-4], ^I, ^N18"
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-800" />
        </section>

        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 font-semibold text-white hover:bg-sky-700 disabled:opacity-50">
            <Save className="h-4 w-4" /> {busy ? t("Αποθήκευση…", "Saving…") : t("Αποθήκευση", "Save")}
          </button>
          {saved && <span className="text-sm font-medium text-emerald-600">{t("Αποθηκεύτηκε ✓", "Saved ✓")}</span>}
          {err && <span className="text-sm text-rose-600">{err}</span>}
        </div>
      </div>
    </QueryState>
  );
}
