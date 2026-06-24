"use client";

import { useQuery } from "@tanstack/react-query";
import { RotateCcw, Wallet, Users } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";

type WB = {
  buckets: { bucket: number; count: number; lost_revenue: number; recoverable: number }[];
  total_recoverable: number; total_lost: number;
};

export default function WinbackPage() {
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: ["pi-winback"], queryFn: () => api<WB>("/patient-intelligence/winback") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard label={t("Ανενεργοί ασθενείς", "Inactive patients")} help={t("Ασθενείς που σημάνθηκαν ανενεργοί (αποβίωσαν/μετακόμισαν/σταμάτησαν).", "Patients marked inactive.")} value={fmtNum((data?.buckets ?? []).reduce((s, b) => s + b.count, 0))} icon={Users} accent="rose" />
        <KpiCard label={t("Συνολικός χαμένος τζίρος", "Total lost revenue")} help={t("Συνολική αξία χαμένων (μη εκτελεσμένων) επαναλήψεων.", "Total lost turnover from missed refills.")} value={fmtEur(data?.total_lost ?? 0)} icon={Wallet} accent="amber" />
        <KpiCard label={t("Δυνητική ανάκτηση", "Potential recovery")} help={t("Αξία χαμένων/ανοιχτών επαναλήψεων που μπορείς να ανακτήσεις.", "Recoverable value of missed/open refills.")} value={fmtEur(data?.total_recoverable ?? 0)} icon={RotateCcw} accent="green" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(data?.buckets ?? []).map((b) => (
          <div key={b.bucket} className="rx-card p-5">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{b.bucket} {t("ημέρες αδράνειας", "days inactive")}</div>
            <div className="mt-2 text-3xl font-bold text-slate-900 dark:text-slate-100">{fmtNum(b.count)}</div>
            <div className="text-xs text-slate-400">{t("ασθενείς", "patients")}</div>
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">{t("Χαμένος", "Lost")}</span><b className="text-rose-600">{fmtEur(b.lost_revenue)}</b></div>
              <div className="flex justify-between"><span className="text-slate-500">{t("Ανακτήσιμος", "Recoverable")}</span><b className="text-emerald-600">{fmtEur(b.recoverable)}</b></div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400">{t("Η ανάκτηση εκτιμάται ως φθίνον ποσοστό της ιστορικής αξίας ανά διάστημα αδράνειας. Δες τη λίστα Recall για ασθενείς με στοιχεία επικοινωνίας.", "Recovery is estimated as a decaying fraction of historical value per inactivity window. See the Recall list for patients with contact details.")}</p>
    </div>
  );
}
