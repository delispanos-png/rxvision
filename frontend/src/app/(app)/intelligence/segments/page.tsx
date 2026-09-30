"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur } from "@/lib/formatters";

type Seg = { key: string; label: string; en: string; patients: number; value: number };

export default function SegmentsPage() {
  const t = useT();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["pi-segments"], queryFn: () => api<{ segments: Seg[] }>("/patient-intelligence/segments") });
  if (isLoading) return <div className="p-8 text-slate-400">{t("Ανάλυση κατηγοριών…", "Analyzing segments…")}</div>;
  const max = Math.max(1,...(data?.segments ?? []).map((s) => s.patients));

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">{t("Ασθενείς στους οποίους δόθηκε φάρμακο της κατηγορίας (όλο το ιστορικό που κρατάμε). Αξία = τα φάρμακα της κατηγορίας, όχι ολόκληρες οι συνταγές. Κλικ για καμπάνια σε αυτούς ακριβώς τους ασθενείς.", "Patients dispensed a medicine of the category (all history we keep). Value = the category’s medicines, not whole prescriptions. Click to run a campaign to exactly these patients.")}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.segments ?? []).map((s) => (
          <button key={s.key} type="button" onClick={() => router.push(`/communications?segment=therapy&value=${s.key}`)}
            className="rx-card p-5 text-left transition hover:border-brand-300 hover:shadow-md">
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
            <div className="mt-1 text-xs text-slate-400">{t("ασθενείς · αξία φαρμάκων κατηγορίας", "patients · category medicines value")}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
