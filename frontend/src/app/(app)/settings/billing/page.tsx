"use client";

import { appAlert } from "@/store/dialogStore";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
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

  const checkout = useMutation({
    mutationFn: (plan: string) =>
      api<{ url: string }>(`/subscription/checkout`, { method: "POST", body: JSON.stringify({ plan }) }),
    onSuccess: (r) => {
      if (r.url && typeof window !== "undefined") window.location.href = r.url;
    },
    onError: (e) => appAlert(e instanceof ApiError ? t(`Σφάλμα (${e.status})`, `Error (${e.status})`) : t("Αποτυχία", "Failed")),
  });

  const s = subscription.data;

  return (
    <ModuleGuard module="settings">
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label={t("Πλάνο", "Plan")} value={s?.plan ?? "—"} />
        <KpiCard label={t("Κατάσταση", "Status")} value={s?.status ?? "—"} />
        <KpiCard label={t("Μηνιαία χρέωση", "Monthly charge")} value={s ? fmtEur(s.price) : "—"} />
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

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("Αναβάθμιση πλάνου", "Upgrade plan")}</h2>
        <div className="flex gap-2">
          {["starter", "pro", "enterprise"].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => checkout.mutate(p)}
              disabled={checkout.isPending || s?.plan === p}
              className="rounded-lg border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-800 hover:bg-brand-100 disabled:opacity-50"
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </ModuleGuard>
  );
}
