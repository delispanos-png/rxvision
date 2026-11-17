"use client";

/* RxVision Κύπρος: μία εκτέλεση ΓεΣΥ (όπως η λεπτομέρεια συνταγής στην Ελλάδα). Γραμμές με
   ποσότητες, δοσολογία, παρτίδες και ποσά. Από κάτω οι φάσεις της ίδιας συνταγής που έγιναν εδώ
   και η κατάστασή της (ίδιος ορισμός με τις «Ανοιχτές συνταγές»). */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { fmtDate, fmtDateTime, fmtEur } from "@/lib/formatters";
import { STATUS_STYLE, ageOf, type ChainStatus } from "@/lib/cy";
import { useT } from "@/store/prefStore";

type Amounts = { hio: number; copay: number; pc2: number; beneficiary: number; total: number };
type Detail = {
  dispensing_id: string; prescription_id: string; kind: string; dispensed_at: string; effective_date: string | null;
  patient: { ref: string | null; full_name: string | null; dob: string | null; gender: string | null };
  doctor: { id: string | null; name: string | null; phones: string[] } | null; user: string | null;
  instance: number; instances: number; totals: Amounts; versions: number; corrected_at: string | null;
  lines: { description: string; barcode: string | null; code: string | null; package: string | null; qty_presc: number; qty_disp: number;
    covered: boolean; amounts: Amounts; days_covered: number | null; lots: string[]; doctor_instructions: string | null;
    dosage: { raw_amount: string | null; raw_frequency: string | null; timing: string | null; duration_days: number | null; route: string | null } }[];
  phases: { dispensing_id: string; dispensed_at: string; instance: number; total: number }[];
  chain: { status: ChainStatus | "closed"; next_due: string; days_to_due: number; remaining: number; value_at_stake_cents: number } | null;
};

export default function CyDispensingDetailPage() {
  const t = useT();
  const router = useRouter();
  const id = decodeURIComponent(useParams<{ id: string }>().id);
  const q = useQuery({ queryKey: ["cy", "dispensing", id], queryFn: () => api<Detail>(`/cy/dispensings/${encodeURIComponent(id)}`), retry: false });
  if (q.isLoading) return <Loader2 className="h-5 w-5 animate-spin text-slate-400" />;
  const d = q.data;
  if (!d) return <p className="text-sm text-slate-500">{t("Η εκτέλεση δεν βρέθηκε.", "Dispensing not found.")}</p>;
  const age = ageOf(d.patient.dob);

  return (
    <div className="space-y-4">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> {t("Πίσω", "Back")}
      </button>

      <div className="rx-card flex flex-wrap items-start justify-between gap-4 p-5">
        <div>
          <div className="text-xs text-slate-400">{t("Συνταγή", "Prescription")} {d.prescription_id} · {t("εκτέλεση", "dispensing")} {d.dispensing_id}</div>
          <h1 className="mt-1 text-xl font-bold text-slate-900 dark:text-slate-100">
            {d.kind === "drug" ? t("Φάρμακα", "Drugs") : t("Αναλώσιμα", "Consumables")} · {t("φάση", "step")} {d.instance}/{d.instances}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {fmtDateTime(d.dispensed_at)}{d.user ? ` · ${t("από", "by")} ${d.user}` : ""}
            {d.versions > 1 && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">{t("διορθώθηκε", "corrected")} ×{d.versions - 1}</span>}
          </p>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            {d.patient.ref && (
              <Link href={`/cy/patients/${encodeURIComponent(d.patient.ref)}`} className="font-medium text-brand-600 hover:underline">
                👤 {d.patient.full_name || "—"}{age != null ? ` · ${age} ${t("ετών", "yrs")}` : ""}
              </Link>
            )}
            {d.doctor?.id && (
              <Link href={`/cy/doctors/${encodeURIComponent(d.doctor.id)}`} className="font-medium text-brand-600 hover:underline">
                🩺 {d.doctor.name || d.doctor.id}
              </Link>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-slate-500">{t("Σύνολο", "Total")}</dt><dd className="font-semibold">{fmtEur(d.totals.total)}</dd></div>
          <div><dt className="text-xs text-slate-500">{t("ΟΑΥ", "HIO")}</dt><dd className="font-semibold">{fmtEur(d.totals.hio)}</dd></div>
          <div><dt className="text-xs text-slate-500">{t("Πελάτης", "Customer")}</dt><dd className="font-semibold">{fmtEur(d.totals.beneficiary)}</dd></div>
          <div><dt className="text-xs text-slate-500">PC2</dt><dd className="font-semibold">{fmtEur(d.totals.pc2)}</dd></div>
        </dl>
      </div>

      <PanelCard title={t("Γραμμές εκτέλεσης", "Dispensing lines")}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="py-2 pr-3">{t("Σκεύασμα", "Product")}</th><th className="py-2 pr-3 text-center">{t("Δόθηκαν/Συνταγή", "Given/Prescribed")}</th>
                <th className="py-2 pr-3">{t("Δοσολογία", "Dosage")}</th><th className="py-2 pr-3 text-right">{t("ΟΑΥ", "HIO")}</th>
                <th className="py-2 pr-3 text-right">{t("Συμμετοχή", "Co-pay")}</th><th className="py-2 pr-3 text-right">PC2</th><th className="py-2 text-right">{t("Σύνολο", "Total")}</th></tr>
            </thead>
            <tbody>
              {d.lines.map((l, i) => (
                <tr key={i} className={`border-t border-slate-100 align-top dark:border-slate-800 ${l.qty_disp === 0 ? "bg-amber-50/60 dark:bg-amber-900/10" : ""}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{l.description}</div>
                    <div className="text-xs text-slate-400">{[l.package, l.barcode || l.code, l.lots.length ? `${t("παρτίδα", "lot")} ${l.lots.join(", ")}` : null].filter(Boolean).join(" · ")}</div>
                    {l.doctor_instructions && <div className="text-xs italic text-slate-500">{l.doctor_instructions}</div>}
                  </td>
                  <td className="py-2 pr-3 text-center">{l.qty_disp}/{l.qty_presc}{l.qty_disp === 0 && <div className="text-xs text-amber-700">{t("δεν δόθηκε", "not given")}</div>}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600 dark:text-slate-300">
                    {[l.dosage.raw_amount, l.dosage.raw_frequency, l.dosage.timing].filter(Boolean).join(" · ") || "—"}
                    {l.days_covered ? <div className="text-slate-400">{t("καλύπτει", "covers")} {l.days_covered} {t("ημ.", "d")}</div> : null}
                  </td>
                  <td className="py-2 pr-3 text-right">{fmtEur(l.amounts.hio)}</td>
                  <td className="py-2 pr-3 text-right">{fmtEur(l.amounts.copay)}</td>
                  <td className="py-2 pr-3 text-right">{l.amounts.pc2 ? fmtEur(l.amounts.pc2) : "—"}</td>
                  <td className="py-2 text-right font-semibold">{fmtEur(l.amounts.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelCard>

      <PanelCard title={t("Η συνταγή στο φαρμακείο σου", "This prescription at your pharmacy")}>
        {d.chain && d.chain.status !== "closed" ? (
          <p className="mb-3 text-sm">
            <span className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[d.chain.status].cls}`}>{t(STATUS_STYLE[d.chain.status].el, STATUS_STYLE[d.chain.status].en)}</span>
            {t("επόμενη φάση", "next step")} {fmtDate(d.chain.next_due)} · {t("απομένουν", "remaining")} {d.chain.remaining} · {t("αξία", "value")} {fmtEur(d.chain.value_at_stake_cents)}
          </p>
        ) : <p className="mb-3 text-sm text-slate-500">{t("Η συνταγή ολοκληρώθηκε.", "The prescription is complete.")}</p>}
        <ol className="flex flex-wrap gap-2">
          {d.phases.map((p) => (
            <li key={p.dispensing_id}>
              <Link href={`/cy/dispensings/${encodeURIComponent(p.dispensing_id)}`}
                className={`block rounded-lg border px-3 py-1.5 text-xs ${p.dispensing_id === d.dispensing_id ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 hover:border-brand-300 dark:border-slate-700"}`}>
                {p.instance}/{d.instances} · {fmtDate(p.dispensed_at)} · {fmtEur(p.total)}
              </Link>
            </li>
          ))}
        </ol>
      </PanelCard>
    </div>
  );
}
