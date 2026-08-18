"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Target, Send, Mail, MessageSquare, Smartphone } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Cat = { key: string; label: string; icon: string; offer: string; patients: number; value: number };
type Res = { items: Cat[]; catalog: { key: string; label: string; icon: string; offer: string }[] };

const eur = (c: number) => `${((c || 0) / 100).toLocaleString("el-GR", { maximumFractionDigits: 0 })} €`;

export default function TherapyCategoriesPage() {
  const t = useT();
  const router = useRouter();
  const q = useQuery({ queryKey: ["marketing-cats"], queryFn: () => api<Res>("/marketing/categories") });
  const go = (key: string, channel?: string) => router.push(`/communications?segment=therapy&value=${key}${channel ? `&channel=${channel}` : ""}`);

  return (
    <ModuleGuard module="marketing">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-violet-600 text-white shadow-lg"><Target className="h-6 w-6" /></span>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Θεραπευτικές κατηγορίες", "Therapeutic categories")}</h1>
            <p className="text-xs text-slate-500">{t("Δες πόσοι πελάτες σου ανήκουν σε κάθε κατηγορία — και στόχευσέ τους με 1 κλικ.", "See how many customers fall in each category — and target them in 1 click.")}</p>
          </div>
        </div>

        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
          {q.data && (() => {
            const cats = [...q.data.items].sort((a, b) => b.patients - a.patients);
            const totalPatients = cats.reduce((s, c) => s + c.patients, 0);
            const totalValue = cats.reduce((s, c) => s + c.value, 0);
            return (
              <>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  <Kpi label={t("Κατηγορίες με ασθενείς", "Categories with patients")} value={String(cats.filter((c) => c.patients > 0).length)} />
                  <Kpi label={t("Σύνολο (με επικάλυψη)", "Total (with overlap)")} value={totalPatients.toLocaleString("el-GR")} />
                  <Kpi label={t("Αξία εκτελέσεων", "Executions value")} value={eur(totalValue)} tint="emerald" />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {cats.map((c) => (
                    <div key={c.key} className={`rounded-2xl border p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 ${c.patients > 0 ? "border-slate-200 bg-white" : "border-dashed border-slate-200 bg-slate-50/50 opacity-70"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          <span className="text-2xl">{c.icon}</span>
                          <div>
                            <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{c.label}</div>
                            <div className="text-[11px] text-slate-400">{c.offer}</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{c.patients}</div>
                          <div className="text-[11px] text-slate-400">{t("ασθενείς", "patients")}</div>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-xs text-slate-500">{t("αξία", "value")}: <b className="text-emerald-600">{eur(c.value)}</b></span>
                        {c.patients > 0 && (
                          <div className="flex items-center gap-1">
                            <button onClick={() => go(c.key, "push")} title={t("Push (δωρεάν)", "Push (free)")} className="grid h-8 w-8 place-items-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-100"><Smartphone className="h-4 w-4" /></button>
                            <button onClick={() => go(c.key, "email")} title="Email" className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><Mail className="h-4 w-4" /></button>
                            <button onClick={() => go(c.key, "sms")} title="SMS" className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><MessageSquare className="h-4 w-4" /></button>
                            <button onClick={() => go(c.key)} className="ml-1 inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"><Send className="h-3.5 w-3.5" /> {t("Στόχευσε", "Target")}</button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </QueryState>
      </div>
    </ModuleGuard>
  );
}

function Kpi({ label, value, tint = "slate" }: { label: string; value: string; tint?: string }) {
  const c: Record<string, string> = { slate: "text-slate-800 dark:text-slate-100", emerald: "text-emerald-600" };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-xl font-extrabold ${c[tint] || c.slate}`}>{value}</div>
    </div>
  );
}
