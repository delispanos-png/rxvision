"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Plus, Trash2, Save, Send, ShieldAlert } from "lucide-react";
import { api } from "@/lib/apiClient";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";

type Smart = { key: string; icon: string; name: string; why: string; count: number; rules: Rules };
type Cond = { field: string; op: string; value: unknown };
type Rules = { match: "all" | "any"; conditions: Cond[] };
type Field = { label: string; type: string; options?: string[]; clinical?: boolean };
type Saved = { _id: string; name: string; rules: Rules; clinical: boolean; count: number };

const OPS: Record<string, string> = {
  gte: "τουλάχιστον", lte: "το πολύ", gt: "πάνω από", lt: "κάτω από",
  eq: "είναι", ne: "δεν είναι", between: "μεταξύ", contains: "περιέχει", is: "είναι",
};
const inp = "rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800";

export default function AudiencesPage() {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const [rules, setRules] = useState<Rules>({ match: "all", conditions: [] });

  const smart = useQuery({ queryKey: ["comms", "smart"], queryFn: () => api<{ items: Smart[] }>("/communications/audience/smart") });
  const fields = useQuery({ queryKey: ["comms", "fields"], queryFn: () => api<{ fields: Record<string, Field> }>("/communications/audience/fields") });
  const saved = useQuery({ queryKey: ["comms", "audiences"], queryFn: () => api<{ items: Saved[] }>("/communications/audiences") });

  const preview = useQuery({
    queryKey: ["comms", "preview", JSON.stringify(rules)],
    queryFn: () => api<{ ok: boolean; count: number; clinical: boolean; error?: string }>("/communications/audience/preview", { method: "POST", body: JSON.stringify({ rules }) }),
    enabled: rules.conditions.length > 0,
  });

  const save = useMutation({
    mutationFn: (name: string) => api("/communications/audiences", { method: "POST", body: JSON.stringify({ name, rules }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["comms", "audiences"] }); setRules({ match: "all", conditions: [] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/communications/audiences/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comms", "audiences"] }),
  });

  const F = fields.data?.fields ?? {};
  const add = () => setRules((r) => ({ ...r, conditions: [...r.conditions, { field: "days_since_visit", op: "gte", value: 90 }] }));
  const upd = (i: number, patch: Partial<Cond>) => setRules((r) => ({ ...r, conditions: r.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const rm = (i: number) => setRules((r) => ({ ...r, conditions: r.conditions.filter((_, j) => j !== i) }));
  // Το κοινό ταξιδεύει στη φόρμα μηνύματος — εκεί γράφει και στέλνει.
  const use = (rs: Rules, label: string) =>
    router.push(`/communications?audience=${encodeURIComponent(JSON.stringify(rs))}&label=${encodeURIComponent(label)}`);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{t("Σε ποιους θέλεις να μιλήσεις;", "Who do you want to talk to?")}</h2>
        <p className="mt-0.5 text-sm text-slate-500">{t("Διάλεξε έτοιμη ομάδα ή φτιάξε δική σου. Τα πλήθη είναι πραγματικά, αυτή τη στιγμή.", "Pick a ready group or build your own. Counts are live.")}</p>
      </div>

      <QueryState isLoading={smart.isLoading} isError={smart.isError} onRetry={() => smart.refetch()}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(smart.data?.items ?? []).map((s) => (
            <button key={s.key} onClick={() => use(s.rules, s.name)} disabled={!s.count}
              className="group rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-pop disabled:opacity-50 disabled:hover:translate-y-0 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-start gap-2.5">
                <span className="text-xl leading-none" aria-hidden>{s.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{s.name}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-slate-500">{s.why}</div>
                </div>
              </div>
              <div className="mt-3 text-lg font-bold text-brand-600">
                {s.count ? t(`${s.count} άνθρωποι`, `${s.count} people`) : t("κανένας αυτή τη στιγμή", "nobody right now")}
              </div>
            </button>
          ))}
        </div>
      </QueryState>

      {/* ── δικός σου κανόνας ─────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t("Φτιάξε δική σου ομάδα", "Build your own")}</h3>
        <div className="mt-3 space-y-2">
          {rules.conditions.map((c, i) => {
            const f = F[c.field];
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                {i > 0 && (
                  <select value={rules.match} onChange={(e) => setRules((r) => ({ ...r, match: e.target.value as "all" | "any" }))} className={inp + " w-20"}>
                    <option value="all">{t("ΚΑΙ", "AND")}</option>
                    <option value="any">{t("Ή", "OR")}</option>
                  </select>
                )}
                <select value={c.field} onChange={(e) => upd(i, { field: e.target.value, value: "" })} className={inp + " min-w-[220px] flex-1"}>
                  {Object.entries(F).map(([k, v]) => <option key={k} value={k}>{v.label}{v.clinical ? " ⚕️" : ""}</option>)}
                </select>
                <select value={c.op} onChange={(e) => upd(i, { op: e.target.value })} className={inp}>
                  {Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {f?.type === "choice" ? (
                  <select value={String(c.value ?? "")} onChange={(e) => upd(i, { value: e.target.value })} className={inp}>
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f?.type === "bool" ? (
                  <select value={String(c.value)} onChange={(e) => upd(i, { value: e.target.value === "true" })} className={inp}>
                    <option value="true">{t("ναι", "yes")}</option><option value="false">{t("όχι", "no")}</option>
                  </select>
                ) : c.op === "between" ? (
                  <span className="flex items-center gap-1">
                    <input type="number" value={(c.value as number[])?.[0] ?? ""} onChange={(e) => upd(i, { value: [Number(e.target.value), (c.value as number[])?.[1] ?? 0] })} className={inp + " w-20"} />
                    <span className="text-xs text-slate-400">—</span>
                    <input type="number" value={(c.value as number[])?.[1] ?? ""} onChange={(e) => upd(i, { value: [(c.value as number[])?.[0] ?? 0, Number(e.target.value)] })} className={inp + " w-20"} />
                  </span>
                ) : (
                  <input value={String(c.value ?? "")} onChange={(e) => upd(i, { value: f?.type === "number" || f?.type === "money" ? Number(e.target.value) : e.target.value })}
                    className={inp + " w-28"} />
                )}
                <button onClick={() => rm(i)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
              </div>
            );
          })}
          <button onClick={add} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-50 dark:border-slate-700">
            <Plus className="h-4 w-4" />{t("Πρόσθεσε κριτήριο", "Add a condition")}
          </button>
        </div>

        {rules.conditions.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            {preview.data?.ok === false ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700">
                <ShieldAlert className="h-4 w-4" />
                {t("Κλινικό κριτήριο: επιτρέπεται μόνο σε μήνυμα φροντίδας, χωρίς προσφορά.",
                  "Clinical criterion: care messages only, no offer.")}
              </span>
            ) : (
              <span className="text-sm text-slate-600 dark:text-slate-300">
                {preview.isFetching ? t("Μετράω…", "Counting…")
                  : t(`Ταιριάζουν ${preview.data?.count ?? 0} άνθρωποι`, `${preview.data?.count ?? 0} people match`)}
              </span>
            )}
            <span className="ml-auto flex gap-2">
              <button onClick={async () => { const n = await appPrompt(t("Όνομα ομάδας;", "Group name?")); if (n?.trim()) save.mutate(n.trim()); }}
                disabled={!preview.data?.ok}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300">
                <Save className="h-4 w-4" />{t("Αποθήκευσέ την", "Save it")}
              </button>
              <button onClick={() => use(rules, t("Δική μου ομάδα", "My group"))} disabled={!preview.data?.count}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                <Send className="h-4 w-4" />{t("Γράψε τους", "Write to them")}
              </button>
            </span>
          </div>
        )}
      </div>

      {/* ── αποθηκευμένες ─────────────────────────────────────────────────── */}
      {!!saved.data?.items?.length && (
        <div>
          <h3 className="mb-2 text-sm font-bold text-slate-900 dark:text-slate-100">{t("Οι ομάδες σου", "Your groups")}</h3>
          <div className="space-y-2">
            {saved.data.items.map((a) => (
              <div key={a._id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                <Users className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="font-medium text-slate-800 dark:text-slate-100">{a.name}</span>
                {a.clinical && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">{t("φροντίδα", "care")}</span>}
                <span className="text-sm text-slate-500">{t(`${a.count} άνθρωποι`, `${a.count} people`)}</span>
                <span className="ml-auto flex gap-2">
                  <button onClick={() => use(a.rules, a.name)} disabled={!a.count}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300">{t("Γράψε τους", "Write")}</button>
                  <button onClick={async () => { if (await appConfirm(t(`Διαγραφή της ομάδας «${a.name}»;`, `Delete "${a.name}"?`), { danger: true })) del.mutate(a._id); }}
                    className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
