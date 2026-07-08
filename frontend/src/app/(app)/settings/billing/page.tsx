"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { useT } from "@/store/prefStore";

type Subscription = {
  plan: string;
  status: string;
  price: number; // cents / month
  renews_at: string;
  modules: string[];
};

type Usage = {
  items: { metric: string; label: string; used: number; limit: number }[];
};

type Receipt = {
  id: string; kind: string; kind_label?: { el: string; en: string }; description?: string;
  amount_cents: number; status: string; method?: string | null; provider?: string | null; created_at: string | null;
};

export default function BillingSettingsPage() {
  const t = useT();
  const subscription = useQuery({
    queryKey: queryKeys.subscription(),
    queryFn: () => api<Subscription>(`/subscription`),
  });
  const usage = useQuery({
    queryKey: queryKeys.subscriptionUsage(),
    queryFn: () => api<Usage>(`/subscription/usage`),
  });
  const receipts = useQuery({
    queryKey: ["subscription", "receipts"],
    queryFn: () => api<{ items: Receipt[] }>(`/subscription/receipts`),
    retry: false,
  });

  const s = subscription.data;
  const KIND_ICON: Record<string, string> = { subscription: "🔄", upgrade: "⬆️", addon: "✨", topup: "💬" };
  const STCLS: Record<string, string> = { paid: "bg-emerald-100 text-emerald-700", pending: "bg-amber-100 text-amber-700", failed: "bg-rose-100 text-rose-700" };

  return (
    <ModuleGuard module="settings">
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label={t("Πλάνο", "Plan")} help={t("Το πλάνο συνδρομής του φαρμακείου.", "The pharmacy's subscription plan.")} value={s?.plan ?? "—"} />
        <KpiCard label={t("Κατάσταση", "Status")} help={t("Κατάσταση συνδρομής (active/trial κ.λπ.).", "Subscription status.")} value={s?.status ?? "—"} />
        <KpiCard label={t("Μηνιαία χρέωση", "Monthly charge")} help={t("Μηνιαία χρέωση συνδρομής.", "Monthly subscription charge.")} value={s ? fmtEur(s.price) : "—"} />
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("Χρήση", "Usage")}</h2>
        {usage.isLoading ? (
          <div className="text-slate-400">{t("Φόρτωση δεδομένων…", "Loading data…")}</div>
        ) : (
          <div className="space-y-3">
            {(usage.data?.items ?? []).map((u) => {
              const pct = u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 0;
              return (
                <div key={u.metric}>
                  <div className="mb-1 flex justify-between text-sm text-slate-600">
                    <span>{u.label}</span>
                    <span>
                      {fmtNum(u.used)} / {fmtNum(u.limit)}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Παραστατικά αγορών (ό,τι χρεώθηκε μέσω RxVision) ── */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("Παραστατικά αγορών", "Purchase receipts")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2">{t("Ημ/νία", "Date")}</th>
              <th>{t("Τύπος", "Type")}</th>
              <th>{t("Περιγραφή", "Description")}</th>
              <th className="text-right">{t("Ποσό", "Amount")}</th>
              <th className="text-right">{t("Κατάσταση", "Status")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-50">
              {(receipts.data?.items ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap py-2 text-slate-500">{r.created_at ? new Date(r.created_at).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"}</td>
                  <td className="text-slate-700">{KIND_ICON[r.kind] ?? "•"} {r.kind_label ? t(r.kind_label.el, r.kind_label.en) : r.kind}</td>
                  <td className="text-slate-500">{r.description}{r.provider ? <span className="ml-1 text-xs text-slate-400">· {r.provider}</span> : ""}</td>
                  <td className="text-right font-medium text-slate-800">{fmtEur(r.amount_cents)}</td>
                  <td className="text-right"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STCLS[r.status] ?? "bg-slate-100 text-slate-600"}`}>{r.status === "paid" ? t("Πληρώθηκε", "Paid") : r.status === "pending" ? t("Εκκρεμεί", "Pending") : t("Απέτυχε", "Failed")}</span></td>
                </tr>
              ))}
              {!receipts.data?.items?.length && <tr><td colSpan={5} className="py-6 text-center text-slate-400">{receipts.isLoading ? t("Φόρτωση…", "Loading…") : t("Δεν υπάρχουν παραστατικά ακόμη.", "No receipts yet.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold text-slate-700">{t("Αλλαγή πλάνου", "Change plan")}</h2>
        <p className="mb-3 text-sm text-slate-500">{t("Δες τα διαθέσιμα πακέτα, αναβάθμισε (κάρτα ή τραπεζική κατάθεση) ή προγραμμάτισε υποβάθμιση.", "See available packages, upgrade (card or bank transfer) or schedule a downgrade.")}</p>
        <Link href="/settings/modules" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          {t("Διαχείριση πλάνου →", "Manage plan →")}
        </Link>
      </div>
    </ModuleGuard>
  );
}
