"use client";

import { useEffect, useMemo, useState } from "react";
import { DateInput } from "@/components/ui/DateInput";
import { MultiSelect } from "@/components/filters/MultiSelect";
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

// Κατηγορίες υψηλής προτεραιότητας με ΑΝΘΡΩΠΙΝΑ ονόματα (όχι regex). Κάθε κατηγορία αντιστοιχεί σε
// «γυμνά» προθέματα ICD-10 (χωρίς σύμβολα) — το backend τα αγκυρώνει (^prefix). `legacy` = παλιές
// μορφές που αναγνωρίζουμε στην ανάγνωση για να τσεκάρεται σωστά η κατηγορία.
type IcdCat = { value: string; el: string; en: string; prefixes: string[]; legacy?: string[] };
const ICD_CATS: IcdCat[] = [
  { value: "respiratory", el: "Αναπνευστικά (χρόνια)", en: "Chronic respiratory", prefixes: ["J"] },
  { value: "diabetes", el: "Σακχαρώδης διαβήτης", en: "Diabetes mellitus", prefixes: ["E10", "E11", "E12", "E13", "E14"], legacy: ["E1[0-4]"] },
  { value: "cardiovascular", el: "Καρδιαγγειακά", en: "Cardiovascular", prefixes: ["I"] },
  { value: "ckd", el: "Χρόνια νεφρική νόσος", en: "Chronic kidney disease", prefixes: ["N18"] },
  { value: "liver", el: "Χρόνια ηπατική νόσος", en: "Chronic liver disease", prefixes: ["K70", "K71", "K72", "K73", "K74", "K75", "K76", "K77"] },
  { value: "immuno", el: "Ανοσοκαταστολή / HIV", en: "Immunosuppression / HIV", prefixes: ["B20", "B21", "B22", "B23", "B24", "D80", "D81", "D82", "D83", "D84"] },
  { value: "cancer", el: "Κακοήθεια (ογκολογικά)", en: "Malignancy (oncology)", prefixes: ["C"] },
  { value: "neuro", el: "Νευρολογικά / νευρομυϊκά", en: "Neurological / neuromuscular", prefixes: ["G"] },
  { value: "obesity", el: "Παχυσαρκία", en: "Obesity", prefixes: ["E66"] },
  { value: "hemoglobin", el: "Αιμοσφαιρινοπάθειες", en: "Haemoglobinopathies", prefixes: ["D56", "D57", "D58"] },
  { value: "autoimmune", el: "Αυτοάνοσα / ρευματολογικά", en: "Autoimmune / rheumatologic", prefixes: ["M05", "M06", "M32", "M33", "M34", "M35"] },
];

const normTok = (s: string) => s.replace(/^\^+/, "").trim();
const catMatchesTok = (cat: IcdCat, tok: string) =>
  cat.prefixes.some((p) => tok === p || tok.startsWith(p) || p.startsWith(tok)) || (cat.legacy || []).includes(tok);

export default function VaccinationSettingsPage() {
  const t = useT();
  const camp = useQuery({ queryKey: ["vacc-campaign-settings"], queryFn: () => api<Campaign>("/vaccinations/campaign") });

  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [rollout, setRollout] = useState<Record<string, { from: string; to: string }>>({});
  const [selCats, setSelCats] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
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
    // reverse-map αποθηκευμένα προθέματα → επιλεγμένες κατηγορίες· ό,τι δεν καλύπτεται → «προχωρημένο».
    const stored = (c.priority_icd || []).map(normTok).filter(Boolean);
    const sel: string[] = []; const used = new Set<string>();
    for (const cat of ICD_CATS) {
      if (stored.some((tok) => catMatchesTok(cat, tok))) {
        sel.push(cat.value);
        stored.forEach((tok) => { if (catMatchesTok(cat, tok)) used.add(tok); });
      }
    }
    setSelCats(sel);
    setCustom(stored.filter((tok) => !used.has(tok)).join(", "));
  }, [camp.data]);

  const selChips = useMemo(
    () => ICD_CATS.filter((c) => selCats.includes(c.value)),
    [selCats]);

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const catPrefixes = ICD_CATS.filter((c) => selCats.includes(c.value)).flatMap((c) => c.prefixes);
      const customPrefixes = custom.split(",").map((s) => normTok(s)).filter(Boolean);
      const priority_icd = Array.from(new Set([...catPrefixes, ...customPrefixes]));
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
          priority_icd,
        }),
      });
      setSaved(true);
    } catch { setErr(t("Αποτυχία αποθήκευσης.", "Save failed.")); }
    finally { setBusy(false); }
  };

  return (
    <QueryState isLoading={camp.isLoading} isError={camp.isError} onRetry={() => camp.refetch()}>
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Στοιχεία campaign", "Campaign details")}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-xs font-medium text-slate-500 sm:col-span-2">{t("Όνομα", "Name")}
              <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            </label>
            <label className="block text-xs font-medium text-slate-500">{t("Έναρξη περιόδου", "Period start")}
              <DateInput value={start} onChange={(v) => setStart(v)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs font-medium text-slate-500">{t("Λήξη περιόδου", "Period end")}
              <DateInput value={end} onChange={(v) => setEnd(v)} className="mt-1 w-full" />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Άνοιγμα ανά ηλικιακή ομάδα", "Rollout by age group")}</h3>
          <p className="mb-3 text-xs text-slate-500">{t("Οι μεγαλύτερες ηλικίες ανοίγουν πρώτες. Ορίστε πότε «ανοίγει» κάθε ομάδα.", "Older ages open first. Set when each band opens.")}</p>
          <div className="space-y-2">
            <div className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-slate-400 sm:grid-cols-[4rem_1fr_1fr] sm:gap-3">
              <span />
              <span>{t("Από", "From")}</span>
              <span>{t("Έως", "To")}</span>
            </div>
            {AGE_BANDS.map((a) => (
              <div key={a} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2 sm:grid-cols-[4rem_1fr_1fr] sm:gap-3">
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{a}</span>
                <DateInput value={rollout[a]?.from || ""} onChange={(v) => setRollout((r) => ({...r, [a]: { from: v, to: r[a]?.to || "" } }))} className="w-full" />
                <DateInput value={rollout[a]?.to || ""} onChange={(v) => setRollout((r) => ({...r, [a]: { from: r[a]?.from || "", to: v } }))} className="w-full" />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Κατηγορίες υψηλής προτεραιότητας", "High-priority categories")}</h3>
          <p className="mb-3 text-xs text-slate-500">{t("Διάλεξε ποιες χρόνιες παθήσεις δίνουν προτεραιότητα στον εμβολιασμό. Επιλέγεις με ονόματα — τους κωδικούς ICD-10 τους χειριζόμαστε εμείς.", "Pick which chronic conditions grant vaccination priority. Choose by name — we handle the ICD-10 codes for you.")}</p>
          <MultiSelect
            label={t("Παθήσεις προτεραιότητας", "Priority conditions")}
            groups={[{ options: ICD_CATS.map((c) => ({ value: c.value, label: t(c.el, c.en) })) }]}
            selected={selCats}
            onChange={setSelCats}
            allLabel={t("Επίλεξε κατηγορίες…", "Select categories…")}
            selectedLabel={(n) => t(`${n} επιλεγμένες`, `${n} selected`)}
            clearLabel={t("Καθαρισμός", "Clear")}
          />
          {selChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selChips.map((c) => (
                <span key={c.value} className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900">
                  {t(c.el, c.en)}
                  <button onClick={() => setSelCats((s) => s.filter((x) => x !== c.value))} aria-label={t("Αφαίρεση", "Remove")} className="text-sky-400 hover:text-sky-700">×</button>
                </span>
              ))}
            </div>
          )}
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">{t("Προχωρημένο: προσθήκη κωδικών ICD-10", "Advanced: add ICD-10 codes")}</summary>
            <p className="mt-2 text-slate-400">{t("Πρόσθεσε προθέματα κωδικών χωρισμένα με κόμμα (χωρίς σύμβολα). Π.χ. F20, M06.", "Add code prefixes separated by commas (no symbols). e.g. F20, M06.")}</p>
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="F20, M06"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-800" />
          </details>
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
