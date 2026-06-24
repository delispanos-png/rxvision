"use client";

import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";

type Seg = { key: string; label: string; en: string; patients: number; value: number };

export default function SegmentsPage() {
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: ["pi-segments"], queryFn: () => api<{ segments: Seg[] }>("/patient-intelligence/segments") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Ανάλυση κατηγοριών…", "Analyzing segments…")}</div>;
  const max = Math.max(1,...(data?.segments ?? []).map((s) => s.patients));

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">{t("Δυναμικά θεραπευτικά segments βάσει ATC. Κλικ για στόχευση (σύντομα custom segments).", "Dynamic therapeutic segments by ATC. (Custom segments coming soon.)")}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.segments ?? []).map((s) => (
          <div key={s.key} className="rx-card p-5">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950"><Layers className="h-4 w-4" /></span>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t(s.label, s.en)}</h3>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-slate-900 dark:text-slate-100">{fmtNum(s.patients)}</span>
              <span className="text-sm font-semibold text-emerald-600">{fmtEur(s.value)}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${(s.patients / max) * 100}%` }} />
            </div>
            <div className="mt-1 text-xs text-slate-400">{t("ασθενείς · αξία περιόδου", "patients · period value")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
