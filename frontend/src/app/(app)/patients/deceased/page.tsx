"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Cross, DownloadCloud, Loader2, Check, Gift, ShoppingBag } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Row = {
  patient_id: string; name: string; amka: string | null; deceased_at: string | null;
  loyalty_points: number; loyalty_cents: number; orders_count: number; orders_cents: number;
  total_cents: number; settled: boolean;
};
type Res = { items: Row[]; totals: { patients: number; with_balance: number; loyalty_cents: number; orders_cents: number; total_cents: number } };
type Job = { status?: string; total?: number; done?: number; deceased_found?: number; age_filled?: number; note?: string };

const eur = (c: number) => `${((c || 0) / 100).toLocaleString("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const ddmmyyyy = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

export default function DeceasedBalancesPage() {
  const t = useT();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ["deceased-balances"], queryFn: () => api<Res>("/patients/deaths/balances") });

  const job = useQuery({
    queryKey: ["death-sweep"],
    queryFn: () => api<Job>("/patients/deaths/sweep"),
    refetchInterval: (query) => (["running", "queued"].includes((query.state.data as Job)?.status || "") ? 4000 : false),
  });
  const running = ["running", "queued"].includes(job.data?.status || "");
  const startSweep = useMutation({
    mutationFn: () => api("/patients/deaths/sweep", { method: "POST" }),
    onSuccess: () => { job.refetch(); },
  });
  const settle = useMutation({
    mutationFn: (v: { id: string; settled: boolean }) => api(`/patients/deaths/${encodeURIComponent(v.id)}/settle`, { method: "POST", body: JSON.stringify({ settled: v.settled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deceased-balances"] }),
  });

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-lg"><Cross className="h-6 w-6" /></span>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Θανόντες", "Deceased")}</h1>
            <p className="text-xs text-slate-500">{t("Όλοι οι θανόντες ασθενείς (με ή χωρίς υπόλοιπο). Τυχόν υπόλοιπο πόντων/ανεξόφλητων για διεκδίκηση ή κλείσιμο.", "All deceased patients (with or without a balance). Any loyalty/unpaid balance can be claimed or written off.")}</p>
          </div>
        </div>

        {/* Έλεγχος θανόντων από ΗΔΥΚΑ */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-700 dark:bg-slate-800/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <DownloadCloud className="mt-0.5 h-5 w-5 text-slate-500" />
              <div>
                <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{t("Έλεγχος θανόντων από ΗΔΥΚΑ", "Check deceased via ΗΔΥΚΑ")}</div>
                <p className="text-xs text-slate-500">{t("Ελέγχει τους ασθενείς στη ΗΔΥΚΑ και μαρκάρει τους θανόντες ως ανενεργούς. Αργά & με ασφάλεια στο παρασκήνιο· τρέχει και αυτόματα κάθε εβδομάδα.", "Checks patients against ΗΔΥΚΑ and marks the deceased inactive. Slow & safe in the background; also runs weekly automatically.")}</p>
              </div>
            </div>
            <button onClick={() => startSweep.mutate()} disabled={running || startSweep.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
              {running || startSweep.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
              {running ? t("Σε εξέλιξη…", "Running…") : t("Έλεγχος τώρα", "Check now")}
            </button>
          </div>
          {job.data && job.data.status !== "idle" && (
            <div className="mt-3">
              {running && (job.data.total || 0) > 0 && (
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <div className="h-full rounded-full bg-slate-600 transition-all" style={{ width: `${Math.min(100, Math.round(((job.data.done || 0) / (job.data.total || 1)) * 100))}%` }} />
                </div>
              )}
              <div className="mt-1.5 text-xs text-slate-500">
                {job.data.status === "running" && t("Έλεγχος", "Checking")}
                {job.data.status === "queued" && t("Σε ουρά…", "Queued…")}
                {job.data.status === "done" && `✓ ${t("Ολοκληρώθηκε", "Completed")}`}
                {job.data.status === "paused" && `⏸ ${t("Παύση — δες τη Διασύνδεση ΗΔΥΚΑ", "Paused — check ΗΔΥΚΑ connection")}`}
                {job.data.status === "error" && `⚠ ${t("Σφάλμα/μη ρυθμισμένη ΗΔΥΚΑ", "Error/ΗΔΥΚΑ not configured")}`}
                {(job.data.total || 0) > 0 && `: ${job.data.done || 0}/${job.data.total}`}
                {` · ${t("θανόντες", "deceased")}: ${job.data.deceased_found || 0}`}
                {(job.data.age_filled || 0) > 0 && ` · ${t("ηλικίες", "ages")}: ${job.data.age_filled}`}
              </div>
            </div>
          )}
        </div>

        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
          {q.data && (
            <>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                <Kpi label={t("Σύνολο θανόντων", "Total deceased")} value={String(q.data.totals.patients)} />
                <Kpi label={t("Με ανοιχτό υπόλοιπο", "With open balance")} value={String(q.data.totals.with_balance)} tint="amber" />
                <Kpi label={t("Πόντοι (αξία)", "Loyalty value")} value={eur(q.data.totals.loyalty_cents)} tint="violet" />
                <Kpi label={t("Ανεξόφλητες παραγγελίες", "Unpaid orders")} value={eur(q.data.totals.orders_cents)} tint="amber" />
                <Kpi label={t("Σύνολο υπολοίπων", "Total balance")} value={eur(q.data.totals.total_cents)} tint="rose" />
              </div>

              {q.data.items.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900">
                  {t("Δεν υπάρχουν θανόντες.", "No deceased patients.")}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-400 dark:bg-slate-800/50">
                      <tr>
                        <th className="px-4 py-2 font-semibold">{t("Θανών", "Deceased")}</th>
                        <th className="px-4 py-2 font-semibold">{t("Ημ/νία", "Date")}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t("Πόντοι", "Loyalty")}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t("Παραγγελίες", "Orders")}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t("Σύνολο", "Total")}</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {q.data.items.map((r) => (
                        <tr key={r.patient_id} className={`hover:bg-slate-50/60 dark:hover:bg-slate-800/40 ${r.settled ? "opacity-50" : ""}`}>
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-slate-800 dark:text-slate-100">{r.name}</div>
                            <div className="text-[11px] text-slate-400">ΑΜΚΑ {r.amka || "—"}</div>
                          </td>
                          <td className="px-4 py-2.5 text-slate-500">{ddmmyyyy(r.deceased_at)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {r.loyalty_cents > 0 ? (
                              <span className="inline-flex items-center gap-1 text-violet-600"><Gift className="h-3.5 w-3.5" />{eur(r.loyalty_cents)}</span>
                            ) : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {r.orders_cents > 0 ? (
                              <span className="inline-flex items-center gap-1 text-amber-600"><ShoppingBag className="h-3.5 w-3.5" />{eur(r.orders_cents)} <span className="text-[11px] text-slate-400">×{r.orders_count}</span></span>
                            ) : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold text-slate-800 dark:text-slate-100">{eur(r.total_cents)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <button onClick={() => settle.mutate({ id: r.patient_id, settled: !r.settled })} disabled={settle.isPending}
                              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold ${r.settled ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700"}`}>
                              <Check className="h-3.5 w-3.5" /> {r.settled ? t("Τακτοποιήθηκε", "Settled") : t("Σήμανε τακτοποιημένο", "Mark settled")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </QueryState>
      </div>
    </ModuleGuard>
  );
}

function Kpi({ label, value, tint = "slate" }: { label: string; value: string; tint?: string }) {
  const c: Record<string, string> = { slate: "text-slate-800 dark:text-slate-100", violet: "text-violet-600", amber: "text-amber-600", rose: "text-rose-600" };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-xl font-extrabold ${c[tint] || c.slate}`}>{value}</div>
    </div>
  );
}
