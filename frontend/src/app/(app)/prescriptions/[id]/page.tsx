"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Repeat, Printer, FileText } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { RepeatTree } from "@/components/prescriptions/RepeatTree";

type Item = {
  name: string | null; barcode: string | null; substance: string | null; category: string | null;
  atc?: string | null; narcotic?: boolean; high_cost?: boolean;
  quantity: number; retail_price: number; wholesale_price: number; margin: number;
  participation: number | null; patient_share: number; fund_share: number; is_executed: boolean;
};

const CAT_BADGE: Record<string, { label: string; cls: string }> = {
  narcotic: { label: "Ναρκωτικό", cls: "bg-rose-100 text-rose-700" },
  vaccine: { label: "Εμβόλιο", cls: "bg-sky-100 text-sky-700" },
  allergen: { label: "Αλλεργιογόνο", cls: "bg-amber-100 text-amber-700" },
  fyk: { label: "ΦΥΚ", cls: "bg-violet-100 text-violet-700" },
};
function CategoryBadge({ category }: { category?: string | null }) {
  const b = category ? CAT_BADGE[category] : undefined;
  if (!b) return null;
  return <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>;
}
type Detail = {
  external_id: string; executed_at: string; status: string | null; source: string;
  repeat_current: number; repeat_total: number; next_open_date: string | null;
  amount_total: number; amount_claimed: number; patient_share: number; wholesale_cost: number;
  fund_payable: number; patient_payable: number;
  icd10: string[]; has_unexecuted_substances: boolean;
  doctor: { name: string | null; specialty: string | null } | null;
  fund: { name: string | null; code: string | null } | null;
  patient: { sex: string | null; birth_year: number | null; area: string | null } | null;
  items: Item[];
};

type IdikaLine = {
  name: string; eof_code: string | null; form: string | null; substance: string | null; atc: string | null;
  is_executed: boolean; dose: string | null; frequency: string | null; duration: string | null; lot: string | null;
  execution_price: number | null; retail_price: number | null; reference_price: number | null;
  participation_pct: number | null; patient_share: number | null; difference: number | null;
  substitution_allowed: boolean; generic: boolean;
};
type Idika = {
  details: {
    issue_date: string | null; deadline_date: string | null; fund_surcharge: boolean;
    fund_surcharge_amount: number | null; patient_share_total: number | null; fund_share_total: number | null;
    exemption: boolean; opinion: boolean;
  };
  lines: IdikaLine[];
};

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const eurR = (v: number | null) => (v == null ? "—" : new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format(v));
const dt = (s: string) => new Date(s).toLocaleString("el-GR", { dateStyle: "medium", timeStyle: "short" });
const sexLabel = (s: string | null) => (s === "M" ? "Άνδρας" : s === "F" ? "Γυναίκα" : "—");

export default function PrescriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["rx-detail", id],
    queryFn: () => api<Detail>(`/prescriptions/detail/${encodeURIComponent(id)}`),
    retry: false,
  });

  const [loadIdika, setLoadIdika] = useState(false);
  const idika = useQuery({
    queryKey: ["rx-idika", id],
    queryFn: () => api<Idika>(`/prescriptions/idika/${encodeURIComponent(id)}`),
    enabled: loadIdika,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return <div className="text-slate-400">Φόρτωση…</div>;
  if (!data) return <div className="text-slate-500">Η συνταγή δεν βρέθηκε.</div>;

  const d = data;
  const age = d.patient?.birth_year ? new Date().getFullYear() - d.patient.birth_year : null;
  const profit = d.amount_total - d.wholesale_cost;
  const recurring = d.repeat_total > 1;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
          <ArrowLeft className="h-4 w-4" /> Πίσω
        </button>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          <Printer className="h-4 w-4" /> Εκτύπωση εκτέλεσης
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">Συνταγή {d.external_id}</h1>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">{d.status || "ΕΚΤΕΛΕΣΜΕΝΗ"}</span>
          {recurring && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">
              <Repeat className="h-3.5 w-3.5" /> Επαναλαμβανόμενη {d.repeat_current}/{d.repeat_total}
            </span>
          )}
        </div>
      </div>

      {/* Πληρωτέο από Ταμείο — the headline number (what the pharmacy collects from the fund) */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-600 px-5 py-4 text-white">
        <div>
          <div className="text-xs uppercase tracking-wide text-brand-100">Πληρωτέο από Ταμείο</div>
          <div className="text-xs text-brand-200">Τι έχει να εισπράξει το φαρμακείο από το ταμείο</div>
        </div>
        <div className="text-3xl font-extrabold">{eur(d.fund_payable)}</div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Σύνολο αξίας", eur(d.amount_total)],
          ["Πληρωτέο από Ασφ/νο", eur(d.patient_payable)],
          ["Χονδρικό κόστος", eur(d.wholesale_cost)],
          ["Μεικτό κέρδος", eur(profit)],
        ].map(([l, v]) => (
          <div key={l} className="rx-card p-4">
            <div className="text-xs text-slate-400">{l}</div>
            <div className="mt-1 text-lg font-bold text-slate-900">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <PanelCard title="Ιατρός">
          <div className="text-sm font-semibold text-slate-800">{d.doctor?.name || "Άγνωστος"}</div>
          <div className="text-xs text-slate-500">{d.doctor?.specialty || "—"}</div>
        </PanelCard>
        <PanelCard title="Ασθενής (ανωνυμοποιημένος)">
          <div className="text-sm text-slate-700">{sexLabel(d.patient?.sex ?? null)}{age ? `, ${age} ετών` : ""}</div>
          <div className="text-xs text-slate-500">{d.patient?.area || "—"} · Ταμείο: {d.fund?.name || "—"}</div>
        </PanelCard>
        <PanelCard title="Συνταγή">
          <div className="text-sm text-slate-700">Εκτέλεση: {dt(d.executed_at)}</div>
          <div className="text-xs text-slate-500">
            {recurring ? `Επανάληψη ${d.repeat_current}/${d.repeat_total}` : "Μία εκτέλεση"}
            {d.next_open_date ? ` · Επόμενη: ${new Date(d.next_open_date).toLocaleDateString("el-GR")}` : ""}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {(d.icd10 || []).map((c) => (
              <span key={c} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{c}</span>
            ))}
          </div>
        </PanelCard>
      </div>

      {/* repeat tree — all executions of this prescription's barcode */}
      <RepeatTree externalId={id} />

      {/* medicines */}
      <PanelCard title="Φάρμακα & θεραπείες">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="py-2">Σκεύασμα</th>
                <th>Δραστική ουσία</th>
                <th className="text-right">Ποσ.</th>
                <th className="text-right">Λιανική</th>
                <th className="text-right">Συμμ.%</th>
                <th className="text-right">Από ασφ/νο</th>
                <th className="text-right">Από ταμείο</th>
                <th className="text-right">Κέρδος</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((it, i) => (
                <tr key={i} className="border-b border-slate-50">
                  <td className="py-2 font-medium text-slate-800">
                    {it.name || "—"}<CategoryBadge category={it.category} />
                    {it.atc && <span className="ml-1.5 text-[10px] text-slate-400">{it.atc}</span>}
                  </td>
                  <td className="text-slate-500">{it.substance || "—"}</td>
                  <td className="text-right">{it.quantity}</td>
                  <td className="text-right">{eur(it.retail_price)}</td>
                  <td className="text-right text-slate-500">{it.participation != null ? `${it.participation}%` : "—"}</td>
                  <td className="text-right text-amber-700">{eur(it.patient_share)}</td>
                  <td className="text-right font-medium text-brand-700">{eur(it.fund_share)}</td>
                  <td className="text-right font-medium text-emerald-700">{eur(it.margin)}</td>
                </tr>
              ))}
              {d.items.length === 0 && (
                <tr><td colSpan={8} className="py-4 text-center text-slate-400">Δεν υπάρχουν γραμμές φαρμάκων.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </PanelCard>

      {/* full portal-style detail, fetched live from ΗΔΙΚΑ on demand */}
      <PanelCard title="Πλήρη στοιχεία ΗΔΙΚΑ">
        {!loadIdika ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-slate-500">Φέρε ζωντανά από την ΗΔΙΚΑ όλες τις λεπτομέρειες της εκτέλεσης (ημερομηνίες, ταινία γνησιότητας, δοσολογία, τιμές αναφοράς, απαλλαγή/γνωμάτευση).</p>
            <button onClick={() => setLoadIdika(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 print:hidden">
              <FileText className="h-4 w-4" /> Φόρτωση από ΗΔΙΚΑ
            </button>
          </div>
        ) : idika.isLoading ? (
          <div className="py-6 text-center text-sm text-slate-400">Άντληση από ΗΔΙΚΑ…</div>
        ) : idika.isError || !idika.data ? (
          <div className="py-4 text-sm text-rose-600">Αποτυχία άντλησης από ΗΔΙΚΑ. <button onClick={() => idika.refetch()} className="underline">Δοκίμασε ξανά</button></div>
        ) : (
          <div className="space-y-5">
            {/* general */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
              <Field label="Ημ/νία έκδοσης" value={idika.data.details.issue_date} />
              <Field label="Προθεσμία εκτέλεσης" value={idika.data.details.deadline_date} />
              <Field label="Επιβάρυνση 1€" value={idika.data.details.fund_surcharge ? "Ναι" : "Όχι"} />
              <Field label="Απαλλαγή συμμετοχής" value={idika.data.details.exemption ? "Ναι" : "Όχι"} />
              <Field label="Γνωμάτευση" value={idika.data.details.opinion ? "Ναι" : "Όχι"} />
              <Field label="Συμμετοχή ασθενή (σύν.)" value={eurR(idika.data.details.patient_share_total)} />
              <Field label="Από ταμείο (σύν.)" value={eurR(idika.data.details.fund_share_total)} />
            </div>
            {/* per-line */}
            <div className="space-y-3">
              {idika.data.lines.map((ln, i) => (
                <div key={i} className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-800">{ln.name}</span>
                    {ln.atc && <span className="text-[10px] text-slate-400">{ln.atc}</span>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${ln.is_executed ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{ln.is_executed ? "Εκτελέστηκε" : "Δεν εκτελέστηκε"}</span>
                    {ln.generic && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700">Γενόσημο</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
                    <Field label="Δραστική" value={ln.substance} />
                    <Field label="Μορφή" value={ln.form} />
                    <Field label="Δοσολογία" value={[ln.dose, ln.frequency && `ανά ${ln.frequency}`, ln.duration && `για ${ln.duration}`].filter(Boolean).join(" · ") || null} />
                    <Field label="Ταινία γνησιότητας" value={ln.lot} />
                    <Field label="Τιμή εκτέλεσης" value={eurR(ln.execution_price)} />
                    <Field label="Τιμή λιανικής" value={eurR(ln.retail_price)} />
                    <Field label="Τιμή αναφοράς" value={eurR(ln.reference_price)} />
                    <Field label="Συμμετοχή %" value={ln.participation_pct != null ? `${ln.participation_pct}%` : null} />
                    <Field label="Διαφορά" value={eurR(ln.difference)} />
                    <Field label="Αντικατάσταση" value={ln.substitution_allowed ? "Επιτρέπεται" : "Όχι"} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </PanelCard>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="font-medium text-slate-800">{value || "—"}</div>
    </div>
  );
}
