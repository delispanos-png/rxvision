"use client";

/** Παθήσεις ICD-10 — ομαδοποιημένες σε ΚΕΦΑΛΑΙΑ, με αναλυτική καρτέλα ανά πάθηση.
 *  Ο κωδικός «E11.9» δεν λέει τίποτα σε κανέναν· το «Ενδοκρινικά & μεταβολικά» λέει πού
 *  πηγαίνει ο τζίρος. Τα βοηθητικά components είναι σε ΕΠΙΠΕΔΟ ΑΡΧΕΙΟΥ (component μέσα σε
 *  render ξαναγεννιέται σε κάθε πάτημα και χάνεται το focus). */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Sparkles, Users, Receipt, TrendingUp, X, BookOpen } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { PanelCard } from "@/components/ui/Card";
import { useT } from "@/store/prefStore";

type Chapter = { key: string; short: string; name: string; range: string };
type Row = {
  _id: string; title?: string | null; description?: string | null; chapter: Chapter;
  rx: number; patients: number; value: number; claimed: number; profit: number;
};
type Med = { name?: string; atc?: string; times: number; value: number };
type Detail = {
  code: string; title?: string | null; description?: string | null; chapter: Chapter;
  rx: number; patients: number; value: number; claimed: number; profit: number;
  prev: { rx: number }; trend_pct: number | null; medicines: Med[];
};
type Note = {
  ok: boolean; cached?: boolean; error?: string;
  what?: string; pharmacy?: string; watch?: string[]; talk?: string[];
};

function Trend({ pct }: { pct: number | null }) {
  if (pct === null || pct === undefined) return null;
  const up = pct >= 0;
  return (
    <span className={`text-xs font-semibold ${up ? "text-emerald-600" : "text-rose-600"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct)}%
    </span>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Users }) {
  return (
    <div className="rounded-xl border border-slate-200 p-2.5 dark:border-slate-700">
      <div className="flex items-center gap-1.5 text-[10px] uppercase text-slate-400">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="text-base font-bold text-slate-800 dark:text-slate-100">{value}</div>
    </div>
  );
}

export function ConditionsPanel({ query }: { query: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["icd10", "conditions", query],
    queryFn: () => api<{ items: Row[] }>(`/icd10/aggregate?metric=value&limit=150&${query}`),
  });

  const detail = useQuery({
    queryKey: ["icd10", "detail", picked, query],
    queryFn: () => api<Detail>(`/icd10/detail?code=${encodeURIComponent(picked!)}&${query}`),
    enabled: !!picked,
  });

  const note = useQuery({
    queryKey: ["icd10", "note", picked],
    queryFn: () => api<Note>(`/icd10/note?code=${encodeURIComponent(picked!)}`),
    enabled: !!picked, retry: false,
  });

  /** Η παραγωγή καίει όριο AI ΜΟΝΟ την πρώτη φορά πανελλαδικά — μετά τη διαβάζουν όλοι. */
  const gen = useMutation({
    mutationFn: () => api<Note>(`/icd10/note?code=${encodeURIComponent(picked!)}`, { method: "POST" }),
    onSuccess: (r) => qc.setQueryData(["icd10", "note", picked], r),
  });

  const chapters = useMemo(() => {
    const m = new Map<string, { ch: Chapter; rows: Row[]; value: number; rx: number }>();
    for (const r of list.data?.items || []) {
      const k = r.chapter?.key || "—";
      const g = m.get(k) || { ch: r.chapter, rows: [], value: 0, rx: 0 };
      g.rows.push(r); g.value += r.value || 0; g.rx += r.rx || 0;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  }, [list.data]);

  const grand = chapters.reduce((a, c) => a + c.value, 0) || 1;
  const d = detail.data;
  const n = note.data;

  return (
    <PanelCard title={t("Παθήσεις ανά κεφάλαιο", "Conditions by chapter")} bodyClassName="pt-2">
      <p className="mb-3 text-xs text-slate-500">
        {t("Οι διαγνώσεις ομαδοποιημένες στα κεφάλαια του ICD-10. Πάτησε μια πάθηση για την πλήρη εικόνα της.",
           "Diagnoses grouped into ICD-10 chapters. Tap a condition for its full picture.")}
      </p>

      {!chapters.length && (
        <div className="py-8 text-center text-sm text-slate-400">
          {t("Καμία διάγνωση στην περίοδο.", "No diagnoses in this period.")}
        </div>
      )}

      <div className="space-y-2">
        {chapters.map((g) => (
          <div key={g.ch.key} className="rounded-xl border border-slate-200 dark:border-slate-700">
            <button type="button" onClick={() => setOpen({ ...open, [g.ch.key]: !open[g.ch.key] })}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
              <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open[g.ch.key] ? "" : "-rotate-90"}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-slate-800 dark:text-slate-100">{g.ch.short}</span>
                <span className="block truncate text-[11px] text-slate-400">{g.ch.range} · {g.ch.name}</span>
              </span>
              <span className="shrink-0 text-right text-xs text-slate-500">
                {fmtNum(g.rows.length)} {t("παθήσεις", "conditions")} · {fmtNum(g.rx)} {t("συντ.", "rx")}
                <b className="ml-2 text-slate-800 dark:text-slate-100">{fmtEur(g.value)}</b>
                <span className="ml-1 text-slate-400">({Math.round(g.value * 100 / grand)}%)</span>
              </span>
            </button>
            {open[g.ch.key] && (
              <div className="border-t border-slate-200 dark:border-slate-700">
                {g.rows.map((r) => (
                  <button key={r._id} type="button" onClick={() => setPicked(r._id)}
                    className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                    <span className="w-16 shrink-0 font-mono text-xs text-slate-500">{r._id}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">{r.title || "—"}</span>
                    <span className="shrink-0 text-xs text-slate-500">
                      {fmtNum(r.patients)} {t("ασθ.", "pts")} · {fmtNum(r.rx)} {t("συντ.", "rx")}
                      <b className="ml-2 text-slate-800 dark:text-slate-100">{fmtEur(r.value)}</b>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {picked && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-6"
          onClick={() => setPicked(null)}>
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-slate-900 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-slate-400">{picked}</div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{d?.title || "—"}</h3>
                {d?.chapter && (
                  <div className="mt-0.5 text-xs text-slate-500">{d.chapter.name} ({d.chapter.range})</div>
                )}
              </div>
              <button type="button" onClick={() => setPicked(null)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="h-5 w-5" />
              </button>
            </div>

            {detail.isLoading ? <div className="py-6 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : d && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label={t("Ασθενείς", "Patients")} value={fmtNum(d.patients)} icon={Users} />
                  <Stat label={t("Συνταγές", "Prescriptions")} value={fmtNum(d.rx)} icon={Receipt} />
                  <Stat label={t("Αξία", "Value")} value={fmtEur(d.value)} icon={Receipt} />
                  <Stat label={t("Κέρδος", "Profit")} value={fmtEur(d.profit)} icon={TrendingUp} />
                </div>

                <div className="text-sm text-slate-600 dark:text-slate-300">
                  {t("Σε σχέση με την προηγούμενη ίση περίοδο", "Versus the previous equal period")}:{" "}
                  {d.trend_pct === null
                    ? <span className="text-slate-400">{t("δεν υπάρχει σύγκριση", "no comparison")}</span>
                    : <><Trend pct={d.trend_pct} /> <span className="text-slate-400">({t("τότε", "then")}: {fmtNum(d.prev.rx)} {t("συντ.", "rx")})</span></>}
                </div>

                {d.description && (
                  <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500">
                      <BookOpen className="h-3.5 w-3.5" /> {t("Επίσημη περιγραφή ICD-10", "Official ICD-10 description")}
                    </div>
                    <div className="whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{d.description}</div>
                  </div>
                )}

                {d.medicines.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[11px] font-bold uppercase text-slate-500">
                      {t("Τι δίνεις εσύ γι αυτήν", "What you dispense for it")}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {d.medicines.map((m, i) => (
                        <span key={i} className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                          {m.name || "—"}{m.atc ? <span className="ml-1 text-slate-400">{m.atc}</span> : null}
                          <span className="ml-1 text-slate-400">×{m.times}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900 dark:bg-indigo-950/20">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-indigo-700 dark:text-indigo-300">
                      <Sparkles className="h-3.5 w-3.5" /> {t("Τι σημαίνει για το φαρμακείο", "What it means for the pharmacy")}
                    </span>
                    {!n?.ok && (
                      <button type="button" onClick={() => gen.mutate()} disabled={gen.isPending}
                        className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                        {gen.isPending ? t("Ετοιμάζεται…", "Preparing…") : t("Εξήγησέ μου", "Explain it")}
                      </button>
                    )}
                  </div>
                  {n?.ok ? (
                    <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
                      <p>{n.what}</p>
                      <p>{n.pharmacy}</p>
                      {!!n.watch?.length && (
                        <div>
                          <div className="mb-1 text-[11px] font-bold uppercase text-slate-500">{t("Πρόσεχε", "Watch out")}</div>
                          <ul className="list-inside list-disc space-y-0.5">{n.watch.map((x, i) => <li key={i}>{x}</li>)}</ul>
                        </div>
                      )}
                      {!!n.talk?.length && (
                        <div>
                          <div className="mb-1 text-[11px] font-bold uppercase text-slate-500">{t("Στον πάγκο", "At the counter")}</div>
                          <ul className="list-inside list-disc space-y-0.5">{n.talk.map((x, i) => <li key={i}>{x}</li>)}</ul>
                        </div>
                      )}
                      <p className="text-[11px] text-slate-400">
                        {t("Πληροφορία για τον φαρμακοποιό — δεν αποτελεί διάγνωση ούτε υποκαθιστά τον θεράποντα ιατρό.",
                           "Information for the pharmacist — not a diagnosis and no substitute for the treating physician.")}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">
                      {gen.data && !gen.data.ok
                        ? t("Δεν ήταν δυνατή η δημιουργία αυτή τη στιγμή.", "Could not generate right now.")
                        : t("Σύντομη εξήγηση της πάθησης, τι συνήθως συνοδεύει και τι προσέχεις στον πάγκο.",
                            "A short explanation, what usually goes with it and what to watch at the counter.")}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </PanelCard>
  );
}
