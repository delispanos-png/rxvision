"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Syringe } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appConfirm } from "@/store/dialogStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PanelCard } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Tooltip } from "@/components/ui/Tooltip";

type Group = { atc: string; label: string; count: number; examples: string[] };
type Program = {
  _id: string; name: string; atc_prefixes: string[]; eof_codes: string[];
  doses_required: number | null; dose_interval_days: number | null;
  repeat_years: number | null; min_age: number | null; max_age: number | null;
  lookback_years: number | null; notify_before_days: number | null;
  active: boolean; notes: string;
};

/** Το πρόχειρο της φόρμας: τα υποχρεωτικά πεδία έχουν πάντα τιμή, τα προαιρετικά μπορεί να είναι κενά. */
type Draft = {
  _id?: string; name: string; atc_prefixes: string[]; eof_codes: string[];
  doses_required: number; dose_interval_days: number | null; repeat_years: number | null;
  min_age: number | null; max_age: number | null;
  lookback_years: number; notify_before_days: number; active: boolean; notes: string;
};

const EMPTY: Draft = {
  name: "", atc_prefixes: [], eof_codes: [],
  doses_required: 1, dose_interval_days: null,
  repeat_years: null, min_age: null, max_age: null,
  lookback_years: 5, notify_before_days: 30, active: true, notes: "",
};

/** Αποθηκευμένο πρόγραμμα → πρόχειρο φόρμας (τα null των υποχρεωτικών παίρνουν default). */
const toDraft = (p: Program): Draft => ({
  ...EMPTY,
  ...p,
  atc_prefixes: p.atc_prefixes ?? [],
  eof_codes: p.eof_codes ?? [],
  doses_required: p.doses_required ?? EMPTY.doses_required,
  lookback_years: p.lookback_years ?? EMPTY.lookback_years,
  notify_before_days: p.notify_before_days ?? EMPTY.notify_before_days,
  notes: p.notes ?? "",
});

export default function VaccineProgramsPage() {
  return (
    <ModuleGuard module="vaccination_programs">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
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
    if (await appConfirm(t(`Διαγραφή του προγράμματος «${p.name}»;`, `Delete programme "${p.name}"?`)))
      del.mutate(p._id);
  };

  const items = progs?.items ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-slate-500">
          {t("Όρισε ποια μη εποχικά εμβόλια παρακολουθεί το φαρμακείο σου. Το σύστημα εντοπίζει πότε τα έκανε κάθε πελάτης και σε ειδοποιεί όταν πλησιάζει η επανάληψη.",
             "Define which non-seasonal vaccines your pharmacy tracks. The system finds when each customer had them and alerts you when a booster is due.")}
        </p>
        <button onClick={() => { setError(null); setEditing({ ...EMPTY }); }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-700">
          <Plus className="h-4 w-4" />{t("Νέο πρόγραμμα", "New programme")}
        </button>
      </div>

      {!items.length && (
        <PanelCard title={t("Κανένα πρόγραμμα ακόμη", "No programmes yet")}>
          <div className="py-6 text-center text-sm text-slate-500">
            <Syringe className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            {t("Ξεκίνα με ένα εμβόλιο — π.χ. έρπης ζωστήρας ή τέτανος.",
               "Start with one vaccine — e.g. herpes zoster or tetanus.")}
          </div>
        </PanelCard>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((p) => (
          <div key={p._id} className="rx-card p-4">
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
                  {!!p.eof_codes?.length && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      +{p.eof_codes.length} {t("σκευάσματα", "products")}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => { setError(null); setEditing(toDraft(p)); }}
                  className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700">
                  <Pencil className="h-4 w-4" />
                </button>
                <button onClick={() => remove(p)}
                  className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/30">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500">
              <Row label={t("Δόσεις σειράς", "Doses in series")} value={String(p.doses_required ?? 1)} />
              <Row label={t("Επανάληψη", "Booster")}
                value={p.repeat_years ? t(`κάθε ${p.repeat_years} έτη`, `every ${p.repeat_years}y`) : t("δεν επαναλαμβάνεται", "none")} />
              <Row label={t("Ηλικίες", "Ages")}
                value={p.min_age || p.max_age ? `${p.min_age ?? 0}–${p.max_age ?? "∞"}` : t("όλες", "all")} />
              <Row label={t("Αναδρομή", "Lookback")} value={`${p.lookback_years ?? 5} ${t("έτη", "y")}`} />
            </dl>
          </div>
        ))}
      </div>

      {editing && (
        <Editor value={editing} groups={groups?.items ?? []} error={error} saving={save.isPending}
          onCancel={() => setEditing(null)} onSave={(v) => save.mutate(v)} />
      )}
    </div>
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
    set({ atc_prefixes: v.atc_prefixes.includes(atc) ? v.atc_prefixes.filter((x) => x !== atc) : [...v.atc_prefixes, atc] });

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

        <Field label={t("Ποια εμβόλια παρακολουθώ", "Which vaccines to watch")}
          hint={t("Επίλεξε ομάδα — περιλαμβάνει όλα τα σκευάσματά της.", "Pick a group — it includes all its products.")}>
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

        <Field label={t("Αναμνηστική κάθε (έτη)", "Booster every (years)")}
          hint={t("Άφησέ το κενό αν το εμβόλιο ΔΕΝ επαναλαμβάνεται. Διαφορετικό από τις δόσεις σειράς.",
                  "Leave empty if the vaccine does NOT repeat. Different from the dose series.")}>
          <input type="number" min={1} max={50} value={v.repeat_years ?? ""}
            onChange={(e) => set({ repeat_years: e.target.value ? Number(e.target.value) : null })}
            placeholder={t("π.χ. 10 για τέτανο", "e.g. 10 for tetanus")} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
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
