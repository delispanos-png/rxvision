"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Syringe, Lock } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appConfirm } from "@/store/dialogStore";
import { Modal } from "@/components/ui/Modal";
import { Tooltip } from "@/components/ui/Tooltip";

type Group = { atc: string; label: string; count: number; examples: string[] };
type Product = { eof_code: string; name: string; atc: string; barcode: string };
type Program = {
  _id: string; name: string; atc_prefixes: string[]; eof_codes: string[];
  doses_required: number | null; dose_interval_days: number | null;
  repeat_years: number | null; repeat_months: number | null; repeat_from: "first" | "last";
  sex: string | null; min_age: number | null; max_age: number | null;
  lookback_years: number | null; notify_before_days: number | null;
  active: boolean; notes: string;
};

/** Το πρόχειρο της φόρμας: τα υποχρεωτικά πεδία έχουν πάντα τιμή, τα προαιρετικά μπορεί να είναι κενά. */
type Draft = {
  _id?: string; name: string; atc_prefixes: string[]; eof_codes: string[];
  doses_required: number; dose_interval_days: number | null; repeat_years: number | null;
  repeat_months: number | null; repeat_from: "first" | "last"; sex: string | null;
  min_age: number | null; max_age: number | null;
  lookback_years: number; notify_before_days: number; active: boolean; notes: string;
};

const EMPTY: Draft = {
  name: "", atc_prefixes: [], eof_codes: [],
  doses_required: 1, dose_interval_days: null,
  repeat_years: null, repeat_months: null, repeat_from: "last", sex: null,
  min_age: null, max_age: null,
  lookback_years: 5, notify_before_days: 30, active: true, notes: "",
};

/** Αποθηκευμένο πρόγραμμα → πρόχειρο φόρμας (τα null των υποχρεωτικών παίρνουν default). */
const toDraft = (p: Program): Draft => ({
  ...EMPTY,
  ...p,
  atc_prefixes: p.atc_prefixes ?? [],
  eof_codes: p.eof_codes ?? [],
  doses_required: p.doses_required ?? EMPTY.doses_required,
  // Τα προγράμματα που φτιάχτηκαν όταν υπήρχαν μόνο έτη εμφανίζονται σε μήνες — χωρίς να
  // πειραχτεί η βάση. Ό,τι αποθηκευτεί από δω και πέρα γράφεται σε μήνες.
  repeat_months: p.repeat_months ?? (p.repeat_years ? p.repeat_years * 12 : null),
  repeat_from: p.repeat_from ?? "first",
  lookback_years: p.lookback_years ?? EMPTY.lookback_years,
  notify_before_days: p.notify_before_days ?? EMPTY.notify_before_days,
  notes: p.notes ?? "",
});


/** Παράμετροι περιοδικών εμβολιασμών — ζει μέσα στις «Ρυθμίσεις» του κυκλώματος. */
export function VaccineProgramsConfig() {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: progs } = useQuery({
    queryKey: ["vaccine-programs"],
    queryFn: () => api<{ items: Program[] }>("/vaccine-programs"),
  });
  const { data: groups } = useQuery({
    queryKey: ["vaccine-groups"],
    queryFn: () => api<{ items: Group[] }>("/vaccine-programs/catalog/groups"),
  });

  const save = useMutation({
    mutationFn: (p: Draft) =>
      p._id ? api(`/vaccine-programs/${p._id}`, { method: "PUT", body: JSON.stringify(p) })
            : api("/vaccine-programs", { method: "POST", body: JSON.stringify(p) }),
    onSuccess: () => { setEditing(null); setError(null); qc.invalidateQueries({ queryKey: ["vaccine-programs"] }); },
    onError: (e: unknown) => setError((e as { message?: string })?.message || t("Αποτυχία αποθήκευσης.", "Save failed.")),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/vaccine-programs/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vaccine-programs"] }),
  });
  const remove = async (p: Program) => {
    if (await appConfirm(t(`Διαγραφή του προγράμματος «${p.name}»;`, `Delete programme "${p.name}"?`))) del.mutate(p._id);
  };

  const items = progs?.items ?? [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Περιοδικοί εμβολιασμοί — παράμετροι", "Periodic vaccinations — parameters")}</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {t("Ποια μη εποχικά εμβόλια παρακολουθεί το φαρμακείο και κάθε πότε επαναλαμβάνονται.",
               "Which non-seasonal vaccines the pharmacy tracks and how often they repeat.")}
          </p>
        </div>
        <button onClick={() => { setError(null); setEditing({ ...EMPTY }); }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-700">
          <Plus className="h-4 w-4" />{t("Νέο", "New")}
        </button>
      </div>

      {!items.length && (
        <div className="py-6 text-center text-sm text-slate-400">
          <Syringe className="mx-auto mb-2 h-8 w-8 text-slate-300" />
          {t("Ξεκίνα με ένα εμβόλιο — π.χ. έρπης ζωστήρας ή τέτανος.", "Start with one vaccine — e.g. herpes zoster or tetanus.")}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((p) => (
          <div key={p._id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{p.name}</span>
                  {!p.active && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{t("ανενεργό", "inactive")}</span>}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.atc_prefixes?.map((a) => (
                    <span key={a} className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">{a}</span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => { setError(null); setEditing(toDraft(p)); }}
                  className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => remove(p)}
                  className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/30"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500">
              <Row label={t("Δόσεις σειράς", "Doses")} value={String(p.doses_required ?? 1)} />
              <Row label={t("Επανάληψη", "Repeat")} value={(() => {
                const m = p.repeat_months ?? (p.repeat_years ? p.repeat_years * 12 : null);
                if (!m) return t("δεν επαναλαμβάνεται", "none");
                const from = p.repeat_from === "last" ? t("από τελευταία", "from last") : t("από έναρξη", "from start");
                return m % 12 === 0 ? t(`κάθε ${m / 12} έτη · ${from}`, `every ${m / 12}y · ${from}`)
                                    : t(`κάθε ${m} μήνες · ${from}`, `every ${m}m · ${from}`);
              })()} />
              <Row label={t("Ηλικίες", "Ages")} value={p.min_age || p.max_age ? `${p.min_age ?? 0}–${p.max_age ?? "∞"}` : t("όλες", "all")} />
              <Row label={t("Προειδοποίηση", "Notify")} value={`${p.notify_before_days ?? 30} ${t("ημ.", "d")}`} />
            </dl>
          </div>
        ))}
      </div>

      {editing && (
        <Editor value={editing} groups={groups?.items ?? []} error={error} saving={save.isPending}
          onCancel={() => setEditing(null)} onSave={(v) => save.mutate(v)} />
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (<><dt className="truncate">{label}</dt><dd className="text-right font-medium text-slate-700 dark:text-slate-200">{value}</dd></>);
}

function Editor({ value, groups, error, saving, onCancel, onSave }: {
  value: Draft; groups: Group[]; error: string | null; saving: boolean;
  onCancel: () => void; onSave: (v: Draft) => void;
}) {
  const t = useT();
  const [v, setV] = useState(value);
  const set = (patch: Partial<Draft>) => setV({ ...v, ...patch });
  const toggleAtc = (atc: string) =>
    set({ atc_prefixes: v.atc_prefixes.includes(atc) ? v.atc_prefixes.filter((x) => x !== atc) : [...v.atc_prefixes, atc],
          eof_codes: [] });   // αλλαγή ομάδας → οι παλιές επιλογές σκευασμάτων δεν ισχύουν
  const toggleCode = (code: string) =>
    set({ eof_codes: v.eof_codes.includes(code) ? v.eof_codes.filter((x) => x !== code) : [...v.eof_codes, code] });

  // Τα σκευάσματα των επιλεγμένων ομάδων — ο φαρμακοποιός μπορεί να στοχεύσει συγκεκριμένα
  // (π.χ. στον πνευμονιόκοκκο δίνεται άλλο σκεύασμα ανά ηλικία).
  const [prodTerm, setProdTerm] = useState("");
  // Σκευάσματα προς επιλογή: των ομάδων που διάλεξε, ή ΟΛΑ τα εμβόλια όταν ψάχνει ελεύθερα.
  // Δεν περιορίζουμε εμείς τι «ταιριάζει» σε κάθε εμβολιασμό — δεν το γνωρίζουμε.
  const { data: prods } = useQuery({
    queryKey: ["vaccine-products", v.atc_prefixes, prodTerm],
    queryFn: async () => {
      if (prodTerm.trim())
        return (await api<{ items: Product[] }>(`/vaccine-programs/catalog/products?q=${encodeURIComponent(prodTerm.trim())}`)).items;
      const all = await Promise.all(v.atc_prefixes.map((a) =>
        api<{ items: Product[] }>(`/vaccine-programs/catalog/products?atc=${encodeURIComponent(a)}`)));
      return all.flatMap((x) => x.items);
    },
    enabled: v.atc_prefixes.length > 0 || prodTerm.trim().length > 1,
  });

  return (
    <Modal open onClose={onCancel} size="lg"
      title={v._id ? t("Επεξεργασία προγράμματος", "Edit programme") : t("Νέο πρόγραμμα εμβολιασμού", "New vaccination programme")}
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-600">{t("Άκυρο", "Cancel")}</button>
          <button onClick={() => onSave(v)} disabled={saving}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">
            {saving ? t("Αποθήκευση…", "Saving…") : t("Αποθήκευση", "Save")}
          </button>
        </div>
      }>
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">{error}</div>}

        <Field label={t("Όνομα προγράμματος", "Programme name")}>
          <input value={v.name} onChange={(e) => set({ name: e.target.value })}
            placeholder={t("π.χ. Έρπης ζωστήρας", "e.g. Herpes zoster")} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        </Field>

        {/* Σε ΕΠΕΞΕΡΓΑΣΙΑ το εμβόλιο κλειδώνει: αλλαγή του θα άλλαζε αναδρομικά ποιοι ασθενείς
            ανήκουν στο πρόγραμμα και τι σημαίνει το ιστορικό τους. Θέλεις άλλο εμβόλιο → νέο πρόγραμμα. */}
        {v._id ? (
          <Field label={t("Εμβόλιο προγράμματος", "Programme vaccine")}
            hint={t("Το εμβόλιο δεν αλλάζει μετά τη δημιουργία — για άλλο εμβόλιο φτιάξε νέο πρόγραμμα.",
                    "The vaccine cannot change after creation — create a new programme for a different one.")}>
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
              {v.atc_prefixes.length ? v.atc_prefixes.map((a) => {
                const g = groups.find((x) => x.atc === a);
                return (
                  <span key={a} className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-sm font-medium text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-200">
                    <Lock className="h-3 w-3 text-slate-400" />
                    {g?.label ?? a}
                    <span className="text-[11px] text-slate-400">{a}</span>
                  </span>
                );
              }) : <span className="text-sm text-slate-400">{t("Μεμονωμένα σκευάσματα", "Individual products")}</span>}
            </div>
          </Field>
        ) : (
          <Field label={t("Ποια εμβόλια παρακολουθώ", "Which vaccines to watch")}
            hint={t("Επίλεξε ομάδα — περιλαμβάνει όλα τα σκευάσματά της. Δεν αλλάζει μετά τη δημιουργία.",
                    "Pick a group — it includes all its products. Cannot be changed later.")}>
            <div className="grid max-h-56 gap-1.5 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700 sm:grid-cols-2">
              {groups.map((g) => (
                <label key={g.atc} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                  <input type="checkbox" checked={v.atc_prefixes.includes(g.atc)} onChange={() => toggleAtc(g.atc)} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-700 dark:text-slate-200">{g.label}</span>
                    <span className="block truncate text-[11px] text-slate-400">{g.atc} · {g.count} {t("σκευάσματα", "products")}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}

        {(!!prods?.length || !!v.atc_prefixes.length) && (
          <Field label={t("Ποια σκευάσματα δίνεις", "Which products you dispense")}
            hint={t("Εσύ ορίζεις ποια σκευάσματα ανήκουν σε αυτόν τον εμβολιασμό — άφησέ τα ξεμαρκάριστα για όλη την ομάδα. Ψάξε με το εμπορικό όνομα για να βρεις οποιοδήποτε εμβόλιο του καταλόγου.",
                    "You define which products belong to this vaccination — leave unchecked for the whole group. Search by brand name to find any vaccine in the catalogue.")}>
            <input value={prodTerm} onChange={(e) => setProdTerm(e.target.value)}
              placeholder={t("αναζήτηση σκευάσματος (π.χ. PREVENAR)…", "search product (e.g. PREVENAR)…")}
              className="mb-1.5 block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
            <div className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700 sm:grid-cols-2">
              {(prods ?? []).map((pr) => (
                <label key={pr.eof_code} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                  <input type="checkbox" checked={v.eof_codes.includes(pr.eof_code)} onChange={() => toggleCode(pr.eof_code)} />
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{pr.name}</span>
                    <span className="ml-1.5 text-[11px] text-slate-400">{pr.atc}</span>
                  </span>
                </label>
              ))}
            </div>
            {!!v.eof_codes.length && (
              <p className="mt-1 text-xs text-sky-600 dark:text-sky-400">
                {t(`Επιλεγμένα ${v.eof_codes.length} σκευάσματα — μόνο αυτά θα παρακολουθούνται.`,
                   `${v.eof_codes.length} products selected — only these will be tracked.`)}
              </p>
            )}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Δόσεις σειράς", "Doses in series")}
            hint={t("Πόσες ενέσεις ολοκληρώνουν μία σειρά.", "How many shots complete one course.")}>
            <input type="number" min={1} max={6} value={v.doses_required ?? 1}
              onChange={(e) => set({ doses_required: Number(e.target.value) })} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </Field>
          <Field label={t("Μεσοδιάστημα δόσεων (ημέρες)", "Days between doses")}>
            <input type="number" min={1} value={v.dose_interval_days ?? ""}
              onChange={(e) => set({ dose_interval_days: e.target.value ? Number(e.target.value) : null })}
              placeholder={t("π.χ. 60", "e.g. 60")} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Επανάληψη κάθε (μήνες)", "Repeat every (months)")}
            hint={t("Κενό = δεν επαναλαμβάνεται. Σε ΜΗΝΕΣ: 6 για Prolia, 3 για Ajovy, 120 για τέτανο (10 έτη).",
                    "Empty = does not repeat. In MONTHS: 6 for Prolia, 3 for Ajovy, 120 for tetanus.")}>
            <input type="number" min={1} max={600} value={v.repeat_months ?? ""}
              onChange={(e) => set({ repeat_months: e.target.value ? Number(e.target.value) : null })}
              placeholder={t("π.χ. 6", "e.g. 6")} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </Field>
          {/* Η ΠΙΟ ΕΠΙΚΙΝΔΥΝΗ ΡΥΘΜΙΣΗ ΤΗΣ ΣΕΛΙΔΑΣ: με λάθος επιλογή, ασθενής που έκανε δόση χθες
              εμφανίζεται εκπρόθεσμος εδώ και χρόνια. Γι αυτό εξηγείται με παράδειγμα, όχι με όρο. */}
          <Field label={t("Ο επόμενος κύκλος μετράει από", "Next cycle counts from")}
            hint={t("Θεραπεία που επαναλαμβάνεται για πάντα (Prolia) → τελευταία δόση. Αναμνηστική εμβολίου → έναρξη σειράς.",
                    "Recurring therapy → last dose. Vaccine booster → start of series.")}>
            <select value={v.repeat_from} onChange={(e) => set({ repeat_from: e.target.value as "first" | "last" })}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
              <option value="last">{t("την τελευταία δόση (θεραπεία)", "the last dose (therapy)")}</option>
              <option value="first">{t("την έναρξη της σειράς (αναμνηστική)", "the start of the series (booster)")}</option>
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label={t("Φύλο", "Sex")}
            hint={t("Μόνο αν η θεραπεία αφορά ρητά ένα φύλο.", "Only if the therapy targets one sex.")}>
            <select value={v.sex ?? ""} onChange={(e) => set({ sex: e.target.value || null })}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
              <option value="">{t("Όλοι", "All")}</option>
              <option value="F">{t("Γυναίκες", "Women")}</option>
              <option value="M">{t("Άνδρες", "Men")}</option>
            </select>
          </Field>
          <Field label={t("Ελάχιστη ηλικία", "Min age")}>
            <input type="number" min={0} max={120} value={v.min_age ?? ""}
              onChange={(e) => set({ min_age: e.target.value ? Number(e.target.value) : null })} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </Field>
          <Field label={t("Μέγιστη ηλικία", "Max age")}>
            <input type="number" min={0} max={120} value={v.max_age ?? ""}
              onChange={(e) => set({ max_age: e.target.value ? Number(e.target.value) : null })} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </Field>
          <Field label={t("Προειδοποίηση (ημέρες)", "Notify before (days)")}>
            <input type="number" min={0} max={365} value={v.notify_before_days ?? 30}
              onChange={(e) => set({ notify_before_days: Number(e.target.value) })} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </Field>
        </div>

        <Field label={t("Αναδρομική αναζήτηση (έτη)", "Historical lookback (years)")}
          hint={t("Πόσο πίσω θα ψάξει στο ιστορικό συνταγών κατά την πρώτη σάρωση.",
                  "How far back the first sweep looks through prescription history.")}>
          <input type="number" min={1} max={10} value={v.lookback_years ?? 5}
            onChange={(e) => set({ lookback_years: Number(e.target.value) })} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800 sm:w-40" />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.active} onChange={(e) => set({ active: e.target.checked })} />
          <span className="text-slate-700 dark:text-slate-200">{t("Ενεργό πρόγραμμα", "Active programme")}</span>
        </label>

        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/25 dark:text-amber-200">
          <Tooltip label={t("Η πλατφόρμα δεν προτείνει ιατρικά μεσοδιαστήματα.", "The platform does not suggest clinical intervals.")}>
            <span>⚕️ {t("Τα μεσοδιαστήματα τα ορίζεις εσύ, με βάση τις ισχύουσες οδηγίες. Η πλατφόρμα λειτουργεί ως εργαλείο υπενθύμισης και δεν υποκαθιστά ιατρική κρίση.",
                        "You define the intervals per current guidance. The platform is a reminder tool and does not replace clinical judgement.")}</span>
          </Tooltip>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
