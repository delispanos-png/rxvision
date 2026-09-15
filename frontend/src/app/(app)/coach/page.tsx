"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Compass, Check, BellOff, ArrowRight, Trophy, Flame, TrendingUp } from "lucide-react";
import { api } from "@/lib/apiClient";
import { appConfirm } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Tone = "soft" | "firm" | "hard";
type Item = {
  key: string; signal: string; name: string | null; title: string; body: string; action: string;
  tone: Tone; streak: number; relapses: number; money_cents: number | null; href: string | null;
};
type Win = { key: string; count: number; text: string };
type Today = {
  day: string; greeting: string; items: Item[]; hidden: number; wins: Win[];
  closing: string; clean_streak: number; at_risk_cents: number;
};
type Hist = { day: string; misses: number; wins: number };

const eur = (c: number) => `${((c || 0) / 100).toLocaleString("el-GR", { maximumFractionDigits: 0 })} €`;

// Ο τόνος δεν είναι διακόσμηση — είναι η πληροφορία. Κόκκινο = το λέμε πολλές μέρες.
const TONE: Record<Tone, { bar: string; chip: string; label: [string, string] }> = {
  soft: { bar: "bg-sky-400", chip: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300", label: ["Το πρόσεξα", "Noticed"] },
  firm: { bar: "bg-amber-500", chip: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300", label: ["Επιμένει", "Recurring"] },
  hard: { bar: "bg-rose-600", chip: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300", label: ["Επαναλαμβάνεται", "Repeated"] },
};

export default function CoachPage() {
  const t = useT();
  const q = useQuery({ queryKey: ["coach-today"], queryFn: () => api<Today>("/coach/today"), refetchInterval: 600_000 });
  const h = useQuery({ queryKey: ["coach-history"], queryFn: () => api<{ items: Hist[] }>("/coach/history?days=21") });

  const mark = useMutation({
    mutationFn: (v: { key: string; action: string }) =>
      api(`/coach/findings/${encodeURIComponent(v.key)}/mark`, { method: "POST", body: JSON.stringify({ action: v.action }) }),
    onSuccess: () => { q.refetch(); h.refetch(); },
  });

  async function dismiss(it: Item) {
    if (await appConfirm(t(`Να μη σου το ξαναπώ για «${it.title}»; Θα σωπάσω για έναν μήνα.`,
      `Stop mentioning "${it.title}"? I'll stay quiet for a month.`))) mark.mutate({ key: it.key, action: "dismiss" });
  }

  const hist = h.data?.items ?? [];
  const trend = useMemo(() => {
    if (hist.length < 6) return null;
    const half = Math.floor(hist.length / 2);
    const avg = (a: Hist[]) => a.reduce((s, x) => s + x.misses, 0) / (a.length || 1);
    const before = avg(hist.slice(0, half)), after = avg(hist.slice(half));
    return { before, after, better: after < before - 0.4, worse: after > before + 0.4 };
  }, [hist]);
  const maxMiss = Math.max(1, ...hist.map((x) => x.misses));

  return (
    <ModuleGuard module="daily_coach">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-600 text-white shadow-lg"><Compass className="h-6 w-6" /></span>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Ο Σύμβουλός σου", "Your Advisor")}</h1>
            <p className="text-xs text-slate-500">{t("Τι έπρεπε να είχες προσέξει σήμερα — και τι έκανες σωστά.", "What deserved your attention today — and what you got right.")}</p>
          </div>
        </div>

        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
          {q.data && (
            <>
              {/* Η καλημέρα — ο σύμβουλος μιλάει πρώτος */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <p className="text-base leading-relaxed text-slate-800 dark:text-slate-200">{q.data.greeting}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  {q.data.clean_streak > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <Flame className="h-3.5 w-3.5" />{t(`${q.data.clean_streak} καθαρές μέρες σερί`, `${q.data.clean_streak}-day clean streak`)}
                    </span>
                  )}
                  {q.data.at_risk_cents > 0 && (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {t(`Σε εκκρεμότητα: ${eur(q.data.at_risk_cents)}`, `At stake: ${eur(q.data.at_risk_cents)}`)}
                    </span>
                  )}
                </div>
              </div>

              {/* Τι ξέφυγε */}
              <div className="space-y-3">
                {q.data.items.map((it) => {
                  const tn = TONE[it.tone];
                  return (
                    <div key={it.key} className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
                      <span className={`absolute inset-y-0 left-0 w-1.5 ${tn.bar}`} />
                      <div className="p-4 pl-6">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{it.title}</h3>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tn.chip}`}>{t(tn.label[0], tn.label[1])}</span>
                          {it.streak > 1 && (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {t(`${it.streak}η μέρα`, `day ${it.streak}`)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{it.body}</p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {it.href && (
                            <Link href={it.href} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
                              {it.action}<ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                          )}
                          <button onClick={() => mark.mutate({ key: it.key, action: "done" })}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                            <Check className="h-3.5 w-3.5" />{t("Το έκανα", "Done")}
                          </button>
                          <button onClick={() => dismiss(it)}
                            className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                            <BellOff className="h-3.5 w-3.5" />{t("Δεν με αφορά", "Not relevant")}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {q.data.hidden > 0 && (
                  <p className="px-1 text-xs text-slate-500">
                    {t(`Υπάρχουν κι άλλα ${q.data.hidden}, αλλά δεν σου τα λέω σήμερα — κλείσε πρώτα αυτά.`,
                      `${q.data.hidden} more found, but not today — clear these first.`)}
                  </p>
                )}
              </div>

              {/* Τι πήγε καλά — το μισό της δουλειάς */}
              {q.data.wins.length > 0 && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-emerald-800 dark:text-emerald-300">
                    <Trophy className="h-4 w-4" />{t("Αυτά τα πήγες σωστά", "What you got right")}
                  </h2>
                  <ul className="mt-3 space-y-2.5">
                    {q.data.wins.map((w) => (
                      <li key={w.key} className="text-sm leading-relaxed text-emerald-900 dark:text-emerald-200">✅ {w.text}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Το κλείσιμο */}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm italic text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                {q.data.closing}
              </div>

              {/* Η γραμμή αυτοβελτίωσης */}
              {hist.length >= 3 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-200">
                    <TrendingUp className="h-4 w-4" />{t("Πώς πας", "How you're doing")}
                  </h2>
                  <div className="mt-4 flex h-20 items-end gap-1">
                    {hist.map((d) => (
                      <div key={d.day} className="group relative flex-1" title={`${d.day}: ${d.misses}`}>
                        <div className={`w-full rounded-t ${d.misses === 0 ? "bg-emerald-400" : d.misses <= 3 ? "bg-sky-400" : "bg-amber-400"}`}
                          style={{ height: `${Math.max(6, (d.misses / maxMiss) * 76)}px` }} />
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {trend?.better
                      ? t("Πριν από δύο εβδομάδες σου έλεγα περισσότερα απ' όσα σου λέω τώρα. Κάτι αλλάζει στον τρόπο που δουλεύεις — συνέχισε.",
                        "Two weeks ago I had more to tell you than I do now. Something is changing in how you work — keep going.")
                      : trend?.worse
                        ? t("Τις τελευταίες μέρες μου ξεφεύγουν περισσότερα από πριν. Δεν σε κατηγορώ — ίσως έχεις περισσότερη δουλειά. Αλλά να το ξέρεις.",
                          "More has been slipping lately than before. Not blaming you — maybe you're busier. But you should know.")
                        : t("Σταθερή πορεία. Κάθε πράσινη στήλη είναι μια μέρα που δεν ξέφυγε τίποτα.",
                          "Steady. Every green bar is a day when nothing slipped.")}
                  </p>
                </div>
              )}
            </>
          )}
        </QueryState>
      </div>
    </ModuleGuard>
  );
}
