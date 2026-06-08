"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";

type Med = { name: string | null; barcode: string | null; substance: string | null; atc: string | null; category: string | null; times: number; value: number };
type Icd = { code: string; count: number; title?: string | null };

// ATC level-1 therapeutic classes (WHO) → Greek names
const ATC_L1: Record<string, string> = {
  A: "Πεπτικό σύστημα & μεταβολισμός", B: "Αίμα & αιμοποιητικά όργανα",
  C: "Καρδιαγγειακό σύστημα", D: "Δερματολογικά",
  G: "Ουροποιογεννητικό & ορμόνες φύλου", H: "Ορμονικά σκευάσματα (συστηματικά)",
  J: "Αντιλοιμώδη (συστηματικά)", L: "Αντινεοπλασματικά & ανοσορυθμιστικά",
  M: "Μυοσκελετικό σύστημα", N: "Νευρικό σύστημα", P: "Αντιπαρασιτικά",
  R: "Αναπνευστικό σύστημα", S: "Αισθητήρια όργανα", V: "Διάφορα",
};
type Detail = {
  patient_id: string; full_name: string | null; amka: string | null;
  sex: string | null; age_group: string | null; birth_year: number | null; area: string | null;
  lifecycle: string | null; rx_count: number; value_total: number;
  first_seen: string | null; last_seen: string | null;
  icd10: Icd[]; medicines: Med[];
};

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const sexLabel = (s: string | null) => (s === "M" ? "Άνδρας" : s === "F" ? "Γυναίκα" : "—");
const dte = (s: string | null) => (s ? new Date(s).toLocaleDateString("el-GR") : "—");

export default function PatientDetailPage() {
  const id = decodeURIComponent(useParams<{ id: string }>().id);
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["patient-detail", id],
    queryFn: () => api<Detail>(`/patients/detail/${encodeURIComponent(id)}`),
    retry: false,
  });

  if (isLoading) return <div className="text-slate-400">Φόρτωση…</div>;
  if (!data) return <div className="text-slate-500">Ο ασφαλισμένος δεν βρέθηκε.</div>;
  const d = data;
  const age = d.birth_year ? new Date().getFullYear() - d.birth_year : null;

  return (
    <div className="space-y-5">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
        <ArrowLeft className="h-4 w-4" /> Πίσω
      </button>

      <div>
        <h1 className="text-xl font-bold text-slate-900">{d.full_name || "Ασφαλισμένος"}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {sexLabel(d.sex)}{age ? `, ${age} ετών` : d.age_group ? `, ${d.age_group}` : ""}
          {d.amka ? ` · ΑΜΚΑ ${d.amka}` : ""} · {d.area || "—"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Συνταγές", String(d.rx_count)],
          ["Συνολική αξία", eur(d.value_total)],
          ["Πρώτη εκτέλεση", dte(d.first_seen)],
          ["Τελευταία", dte(d.last_seen)],
        ].map(([l, v]) => (
          <div key={l} className="rx-card p-4">
            <div className="text-xs text-slate-400">{l}</div>
            <div className="mt-1 text-base font-bold text-slate-900">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PanelCard title="Διαγνώσεις (ICD-10)">
          {d.icd10.length === 0 ? <div className="text-sm text-slate-400">—</div> : (
            <div className="flex flex-wrap gap-2">
              {d.icd10.map((x) => (
                <span key={x.code} title={x.title || ""} className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                  <b>{x.code}</b>{x.title ? ` — ${x.title}` : ""} <span className="text-slate-400">×{x.count}</span>
                </span>
              ))}
            </div>
          )}
        </PanelCard>

        <PanelCard title="Θεραπευτικές κατηγορίες (ATC)">
          {(() => {
            const byAtc = new Map<string, number>();
            for (const m of d.medicines) {
              const k = (m.atc || "?").slice(0, 1).toUpperCase();
              byAtc.set(k, (byAtc.get(k) || 0) + m.times);
            }
            const rows = [...byAtc.entries()].sort((a, b) => b[1] - a[1]);
            return rows.length === 0 ? <div className="text-sm text-slate-400">—</div> : (
              <div className="flex flex-wrap gap-2">
                {rows.map(([k, n]) => (
                  <span key={k} className="rounded-lg bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">
                    {ATC_L1[k] || k} <span className="text-violet-400">×{n}</span>
                  </span>
                ))}
              </div>
            );
          })()}
        </PanelCard>
      </div>

      <PanelCard title="Φάρμακα που έχει λάβει">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="py-2">Σκεύασμα</th>
                <th>Δραστική ουσία</th>
                <th className="text-right">Φορές</th>
                <th className="text-right">Αξία</th>
              </tr>
            </thead>
            <tbody>
              {d.medicines.map((m, i) => (
                <tr key={i} className="border-b border-slate-50">
                  <td className="py-2 font-medium text-slate-800">{m.name || "—"}</td>
                  <td className="text-slate-500">{m.substance || "—"}</td>
                  <td className="text-right">{m.times}</td>
                  <td className="text-right">{eur(m.value)}</td>
                </tr>
              ))}
              {d.medicines.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-slate-400">—</td></tr>}
            </tbody>
          </table>
        </div>
      </PanelCard>
    </div>
  );
}
