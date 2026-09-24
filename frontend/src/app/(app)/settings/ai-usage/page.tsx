"use client";

/** Χρήση AI — μηνιαία αναφορά για το ΦΑΡΜΑΚΕΙΟ.
 *  Υπάρχει για έναν λόγο: όταν ρωτήσει «πόσες ερωτήσεις έκανα;», να το βλέπει μόνος του.
 *  Δεν δείχνουμε ποτέ το δικό μας κόστος — μόνο ερωτήσεις και αξία με τις τιμές μας. */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, BookOpen, MessageSquare, Wallet } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Day = { date: string; questions: number; cached: number; llm: number; value_cents: number };
type Report = {
  month: string; questions: number; from_knowledge_base: number; new_questions: number;
  value_cents: number; included_budget_cents: number; budget_period: string;
  remaining_cents: number | null; over_budget: boolean; days: Day[];
};

const eur = (c: number) =>
  new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);

function months(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 12; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

function Card({ icon: Icon, label, value, sub, tint }: {
  icon: typeof Sparkles; label: string; value: string; sub?: string; tint: string;
}) {
  return (
    <div className="rx-card flex items-center gap-3 p-4">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tint}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs text-slate-500">{label}</div>
        <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
        {sub && <div className="truncate text-[11px] text-slate-400">{sub}</div>}
      </div>
    </div>
  );
}

export default function AiUsagePage() {
  const t = useT();
  const [month, setMonth] = useState(months()[0]);
  const { data, isLoading } = useQuery({
    queryKey: ["ai-usage", month],
    queryFn: () => api<Report>(`/subscription/ai-usage?month=${month}`),
  });
  const d = data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {t("Χρήση AI", "AI usage")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("Τι ρώτησες, πότε, και πόσο μετρήθηκε — για να μη χρειάζεται να ρωτάς εμάς.",
               "What you asked, when, and how it counted — so you never have to ask us.")}
          </p>
        </div>
        <select value={month} onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:bg-slate-800">
          {months().map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {isLoading ? <div className="text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card icon={MessageSquare} label={t("Ερωτήσεις", "Questions")}
              value={String(d.questions)} tint="bg-indigo-100 text-indigo-700" />
            <Card icon={BookOpen} label={t("Από τη βάση γνώσεων", "From knowledge base")}
              value={String(d.from_knowledge_base)}
              sub={t("απαντήθηκαν άμεσα — χωρίς χρέωση", "answered instantly — not charged")}
              tint="bg-emerald-100 text-emerald-700" />
            <Card icon={Sparkles} label={t("Νέες ερωτήσεις", "New questions")}
              value={String(d.new_questions)} tint="bg-violet-100 text-violet-700" />
            <Card icon={Wallet} label={t("Αξία μήνα", "Month value")}
              value={eur(d.value_cents)}
              sub={d.included_budget_cents
                ? t(`από ${eur(d.included_budget_cents)} που περιλαμβάνει το πακέτο σου`,
                    `of ${eur(d.included_budget_cents)} included in your plan`)
                : undefined}
              tint={d.over_budget ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"} />
          </div>

          {d.included_budget_cents > 0 && (
            <div className="rx-card p-4">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-300">
                  {t("Περιλαμβάνεται στο πακέτο σου", "Included in your plan")}
                </span>
                <span className="font-semibold text-slate-800 dark:text-slate-100">
                  {eur(d.value_cents)} / {eur(d.included_budget_cents)}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div className={`h-full ${d.over_budget ? "bg-rose-500" : "bg-emerald-500"}`}
                  style={{ width: `${Math.min(100, (d.value_cents / d.included_budget_cents) * 100)}%` }} />
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                {d.over_budget
                  ? t("Έχεις ξεπεράσει το περιλαμβανόμενο όριο του μήνα.",
                      "You have exceeded this month included allowance.")
                  : t(`Απομένουν ${eur(d.remaining_cents || 0)} αυτόν τον μήνα.`,
                      `${eur(d.remaining_cents || 0)} remaining this month.`)}
              </div>
            </div>
          )}

          <div className="rx-card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              {t("Ανά ημέρα", "By day")}
            </h2>
            {!d.days.length ? (
              <p className="text-sm text-slate-400">{t("Καμία ερώτηση αυτόν τον μήνα.", "No questions this month.")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400 dark:border-slate-700">
                      <th className="py-1.5">{t("Ημέρα", "Day")}</th>
                      <th className="py-1.5 text-right">{t("Ερωτήσεις", "Questions")}</th>
                      <th className="py-1.5 text-right">{t("Από βάση γνώσεων", "From KB")}</th>
                      <th className="py-1.5 text-right">{t("Νέες", "New")}</th>
                      <th className="py-1.5 text-right">{t("Αξία", "Value")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.days.map((r) => (
                      <tr key={r.date} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                        <td className="py-1.5">{r.date}</td>
                        <td className="py-1.5 text-right font-medium">{r.questions}</td>
                        <td className="py-1.5 text-right text-emerald-700">{r.cached}</td>
                        <td className="py-1.5 text-right">{r.llm}</td>
                        <td className="py-1.5 text-right">{eur(r.value_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-xs text-slate-400">
            {t("Οι ερωτήσεις που απαντήθηκαν από τη βάση γνώσεων δεν χρεώνονται: η απάντηση υπήρχε ήδη έτοιμη.",
               "Questions answered from the knowledge base are not charged: the answer already existed.")}
          </p>
        </>
      )}
    </div>
  );
}
