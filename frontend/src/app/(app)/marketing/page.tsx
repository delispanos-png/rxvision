"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Megaphone, Send, Target, Mail, Clock, RefreshCw, Smartphone, TrendingUp, Ticket, BarChart3 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { appAlert } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Cat = { key: string; label: string; icon: string; offer: string; patients: number; value: number };
type Card = { id: string; icon: string; urgency: string; title: string; why: string; count: number; cta: string; segment: string; value: string | null };
type Campaign = { id: string; channel: string; subject?: string | null; recipients: number; sent: number; created_at: string | null; coupon: string | null; redemptions: number; redeemed_value_cents: number; conversion_pct: number };
type Dash = {
  performance: { days: number; total: { campaigns: number; recipients: number; sent: number; failed: number }; by_channel: Record<string, { campaigns: number; recipients: number; sent: number; failed: number }> };
  categories: Cat[];
  suggestions: Card[];
  campaigns: Campaign[];
  totals: { upcoming: number; winback: number; at_risk: number; push_reach: number };
};

const eur = (c: number) => `${((c || 0) / 100).toLocaleString("el-GR", { maximumFractionDigits: 0 })} €`;
const CHAN: Record<string, string> = { email: "Email", sms: "SMS", viber: "Viber", push: "Push" };

export default function MarketingDashboard() {
  const t = useT();
  const router = useRouter();
  const q = useQuery({ queryKey: ["marketing-dash"], queryFn: () => api<Dash>("/marketing/dashboard"), refetchInterval: 300_000 });
  const go = (segment: string, value: string | null) => router.push(`/communications?segment=${segment}${value ? `&value=${encodeURIComponent(value)}` : ""}`);
  // εξαργύρωση κουπονιού στο ταμείο
  const [rc, setRc] = useState("");
  const [ramt, setRamt] = useState("");
  const redeem = useMutation({
    mutationFn: () => api<{ ok: boolean; error?: string; discount_cents?: number }>("/marketing/coupons/redeem", { method: "POST", body: JSON.stringify({ code: rc.trim().toUpperCase(), amount_cents: ramt ? Math.round(parseFloat(ramt) * 100) : 0 }) }),
    onSuccess: (r) => {
      if (r.ok) { appAlert(t(`✅ Έγκυρο! Έκπτωση: ${eur(r.discount_cents || 0)}`, `✅ Valid! Discount: ${eur(r.discount_cents || 0)}`)); setRc(""); setRamt(""); q.refetch(); }
      else appAlert({ not_found: t("Δεν βρέθηκε κουπόνι.", "Coupon not found."), expired: t("Έληξε.", "Expired."), max_reached: t("Εξαντλήθηκαν οι εξαργυρώσεις.", "Max redemptions reached."), inactive: t("Ανενεργό.", "Inactive.") }[r.error || ""] || t("Μη έγκυρο.", "Invalid."));
    },
    onError: (e: Error) => appAlert(t("Αποτυχία: ", "Failed: ") + e.message),
  });

  return (
    <ModuleGuard module="marketing">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-violet-600 text-white shadow-lg"><Megaphone className="h-6 w-6" /></span>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Στοχευμένη Προώθηση", "Targeted Marketing")}</h1>
            <p className="text-xs text-slate-500">{t("Στείλε τη σωστή προσφορά στους σωστούς ασθενείς — και δες τι αποδίδει.", "Send the right offer to the right patients — and see what works.")}</p>
          </div>
        </div>

        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
          {q.data && (() => {
            const d = q.data;
            const p = d.performance.total;
            return (
              <>
                {/* ── ΑΠΟΔΟΤΙΚΟΤΗΤΑ ── */}
                <section>
                  <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><TrendingUp className="h-4 w-4 text-violet-500" /> {t("Αποδοτικότητα", "Performance")} <span className="text-xs font-normal text-slate-400">· {t("τελ.", "last")} {d.performance.days} {t("ημέρες", "days")}</span></h2>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <Kpi label={t("Καμπάνιες", "Campaigns")} value={String(p.campaigns)} />
                    <Kpi label={t("Παραλήπτες", "Recipients")} value={p.recipients.toLocaleString("el-GR")} />
                    <Kpi label={t("Στάλθηκαν", "Sent")} value={p.sent.toLocaleString("el-GR")} tint="emerald" />
                    <Kpi label={t("Δωρεάν push", "Free push")} value={String(d.totals.push_reach)} tint="sky" sub={t("ενεργά κινητά", "active phones")} />
                  </div>
                  {Object.keys(d.performance.by_channel).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      {Object.entries(d.performance.by_channel).map(([ch, v]) => (
                        <span key={ch} className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-slate-800">{CHAN[ch] || ch}: <b>{v.sent}</b> {t("μηνύματα", "msgs")}</span>
                      ))}
                    </div>
                  )}
                </section>

                {/* ── ΠΡΟΤΑΣΕΙΣ ΕΝΕΡΓΕΙΩΝ ── */}
                <section>
                  <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><Target className="h-4 w-4 text-fuchsia-500" /> {t("Προτάσεις ενεργειών", "Recommended actions")}</h2>
                  {d.suggestions.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 py-8 text-center text-sm text-slate-400 dark:border-slate-700">{t("Δεν υπάρχουν προτάσεις αυτή τη στιγμή.", "No suggestions right now.")}</div>
                  ) : (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {d.suggestions.map((c) => (
                        <div key={c.id} className={`flex items-start justify-between gap-3 rounded-2xl border p-3.5 ${c.urgency === "high" ? "border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100"><span className="text-base">{c.icon}</span> {c.title}</div>
                            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{c.why}</div>
                          </div>
                          <button onClick={() => go(c.segment, c.value)} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"><Send className="h-3.5 w-3.5" /> {c.cta}</button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* ── ΕΞΑΡΓΥΡΩΣΗ ΚΟΥΠΟΝΙΟΥ (ταμείο) ── */}
                <section className="rounded-2xl border border-violet-200 bg-violet-50/40 p-3.5 dark:border-violet-900/40 dark:bg-violet-950/20">
                  <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><Ticket className="h-4 w-4 text-violet-500" /> {t("Εξαργύρωση κουπονιού", "Redeem coupon")} <span className="text-xs font-normal text-slate-400">{t("· στο ταμείο", "· at the counter")}</span></div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input value={rc} onChange={(e) => setRc(e.target.value)} placeholder={t("Κωδικός (π.χ. RX3F9A1C)", "Code (e.g. RX3F9A1C)")} className="w-44 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm uppercase dark:border-slate-600 dark:bg-slate-800" />
                    <input value={ramt} onChange={(e) => setRamt(e.target.value)} type="number" min={0} placeholder={t("ποσό αγοράς €", "purchase € amount")} className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
                    <button onClick={() => rc.trim() && redeem.mutate()} disabled={!rc.trim() || redeem.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{t("Εξαργύρωση", "Redeem")}</button>
                  </div>
                </section>

                {/* ── ΑΠΟΔΟΣΗ ΚΑΜΠΑΝΙΩΝ (ROI) ── */}
                {d.campaigns.length > 0 && (
                  <section>
                    <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><BarChart3 className="h-4 w-4 text-emerald-500" /> {t("Απόδοση καμπανιών", "Campaign performance")}</h2>
                    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
                      <table className="w-full min-w-[620px] text-sm">
                        <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800"><tr>
                          <th className="px-3 py-2">{t("Καμπάνια", "Campaign")}</th><th className="px-3 py-2">{t("Κανάλι", "Channel")}</th><th className="px-3 py-2">{t("Κουπόνι", "Coupon")}</th>
                          <th className="px-3 py-2 text-right">{t("Στάλθηκαν", "Sent")}</th><th className="px-3 py-2 text-right">{t("Εξαργυρώθηκαν", "Redeemed")}</th><th className="px-3 py-2 text-right">{t("Αξία", "Value")}</th><th className="px-3 py-2 text-right">{t("Conversion", "Conversion")}</th>
                        </tr></thead>
                        <tbody>
                          {d.campaigns.map((c) => (
                            <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                              <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{c.subject || <span className="text-slate-400">—</span>}</td>
                              <td className="px-3 py-2 text-xs">{CHAN[c.channel] || c.channel}</td>
                              <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{c.coupon || "—"}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-600">{c.sent}</td>
                              <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800 dark:text-slate-100">{c.coupon ? c.redemptions : "—"}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{c.coupon ? eur(c.redeemed_value_cents) : "—"}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{c.coupon ? <span className={c.conversion_pct >= 5 ? "font-semibold text-emerald-600" : "text-slate-500"}>{c.conversion_pct}%</span> : <span className="text-slate-300">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {/* γρήγορες αφορμές */}
                <section className="grid gap-2.5 sm:grid-cols-3">
                  <Quick icon={<Clock className="h-4 w-4" />} label={t("Επερχόμενες επαναλήψεις", "Upcoming refills")} n={d.totals.upcoming} onClick={() => go("upcoming", "30")} />
                  <Quick icon={<RefreshCw className="h-4 w-4" />} label={t("Ανενεργοί (win-back)", "Inactive (win-back)")} n={d.totals.winback} onClick={() => go("inactive", "180")} />
                  <Quick icon={<Smartphone className="h-4 w-4" />} label={t("Δωρεάν κανάλι push", "Free push channel")} n={d.totals.push_reach} onClick={() => router.push("/communications")} />
                </section>
              </>
            );
          })()}
        </QueryState>
      </div>
    </ModuleGuard>
  );
}

function Kpi({ label, value, sub, tint = "slate" }: { label: string; value: string; sub?: string; tint?: string }) {
  const c: Record<string, string> = { slate: "text-slate-800 dark:text-slate-100", emerald: "text-emerald-600", sky: "text-sky-600" };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-2xl font-extrabold ${c[tint] || c.slate}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Quick({ icon, label, n, onClick }: { icon: React.ReactNode; label: string; n: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left hover:border-violet-300 dark:border-slate-700 dark:bg-slate-900">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-950/40">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-bold text-slate-800 dark:text-slate-100">{n}</span>
        <span className="block truncate text-[11px] text-slate-500">{label}</span>
      </span>
      <Mail className="h-4 w-4 text-slate-300" />
    </button>
  );
}
