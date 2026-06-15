"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Repeat, Printer } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { RepeatTree } from "@/components/prescriptions/RepeatTree";
import { useT } from "@/store/prefStore";

type T = (el: string, en: string) => string;

// Stored ΗΔΥΚΑ/CDA per-line detail (money in cents). Persisted at ingestion → no live fetch needed.
type LineDetails = {
  eof_code?: string | null; form?: string | null;
  execution_price?: number | null; retail_price?: number | null; reference_price?: number | null;
  patient_share?: number | null; difference?: number | null; participation_pct?: number | null;
  generic?: boolean | null; substitution_allowed?: boolean | null; lot?: string | null;
  dose?: string | null; frequency?: string | null; duration?: string | null;
  qr?: boolean | null; strip?: string | null;
};
type PrescDetails = {
  issue_date?: string | null; deadline_date?: string | null;
  exemption?: boolean | null; opinion?: boolean | null; fund_surcharge?: boolean | null;
  fund_surcharge_amount?: number | null; patient_share_total?: number | null; fund_share_total?: number | null;
};

type Item = {
  name: string | null; barcode: string | null; substance: string | null; category: string | null;
  atc?: string | null; narcotic?: boolean; high_cost?: boolean;
  quantity: number; retail_price: number; wholesale_price: number; margin: number;
  participation: number | null; patient_share: number; fund_share: number; is_executed: boolean;
  details?: LineDetails | null;
};

const catBadge = (t: T): Record<string, { label: string; cls: string }> => ({
  narcotic: { label: t("Ναρκωτικό", "Narcotic"), cls: "bg-rose-100 text-rose-700" },
  vaccine: { label: t("Εμβόλιο", "Vaccine"), cls: "bg-sky-100 text-sky-700" },
  allergen: { label: t("Αλλεργιογόνο", "Allergen"), cls: "bg-amber-100 text-amber-700" },
  fyk: { label: "ΦΥΚ", cls: "bg-violet-100 text-violet-700" },
});
function CategoryBadge({ category }: { category?: string | null }) {
  const t = useT();
  const b = category ? catBadge(t)[category] : undefined;
  if (!b) return null;
  return <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>;
}
type Detail = {
  external_id: string; executed_at: string; status: string | null; source: string;
  repeat_current: number; repeat_total: number; repeat_root: string | null; next_open_date: string | null;
  amount_total: number; amount_claimed: number; patient_share: number; wholesale_cost: number;
  fund_payable: number; patient_payable: number;
  icd10: string[]; has_unexecuted_substances: boolean;
  doctor: { name: string | null; specialty: string | null } | null;
  fund: { name: string | null; code: string | null } | null;
  patient: { sex: string | null; birth_year: number | null; area: string | null; full_name: string | null; amka: string | null } | null;
  details?: PrescDetails | null;
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
const sexLabel = (s: string | null, t: T) => (s === "M" ? t("Άνδρας", "Male") : s === "F" ? t("Γυναίκα", "Female") : "—");
const yesNo = (v: boolean | null | undefined, t: T) => (v == null ? null : v ? t("Ναι", "Yes") : t("Όχι", "No"));
const hasStoredHdyka = (d: Detail) =>
  !!(d.details && Object.keys(d.details).length) || d.items.some((i) => i.details && Object.keys(i.details).length);

export default function PrescriptionDetailPage() {
  const t = useT();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["rx-detail", id],
    queryFn: () => api<Detail>(`/prescriptions/detail/${encodeURIComponent(id)}`),
    retry: false,
  });

  const idika = useQuery({
    queryKey: ["rx-idika", id],
    queryFn: () => api<Idika>(`/prescriptions/idika/${encodeURIComponent(id)}`),
    // Auto-fetch live ONLY when the details aren't stored yet (pre re-download). Once stored,
    // the section renders from the DB with no ΗΔΥΚΑ call.
    enabled: !!data && !hasStoredHdyka(data),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return <div className="text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;
  if (!data) return <div className="text-slate-500">{t("Η συνταγή δεν βρέθηκε.", "Prescription not found.")}</div>;

  const d = data;
  const age = d.patient?.birth_year ? new Date().getFullYear() - d.patient.birth_year : null;
  const profit = d.amount_total - d.wholesale_cost;
  // This is a repeat of an earlier prescription when its repeat_root points to a DIFFERENT
  // barcode (the chain's first ℞). The stored repeat_current/repeat_total are unreliable until
  // the full ΗΔΙΚΑ chain is synced, so we no longer print a fake "N/N".
  const recurring = !!d.repeat_root && d.repeat_root !== d.external_id.split(":")[0];
  // A partial execution's amount_total covers only what was dispensed in THIS visit, while
  // wholesale_cost is the whole prescription's cost (incl. not-yet-dispensed lines) → the
  // per-execution gross profit is meaningless. Suppress it (a negative profit is the same tell)
  // until the per-execution dispensing detail arrives from ΗΔΙΚΑ.
  const marginReliable = d.status !== "partial" && profit >= 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t("Πίσω", "Back")}
        </button>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          <Printer className="h-4 w-4" /> {t("Εκτύπωση εκτέλεσης", "Print execution")}
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">{t("Συνταγή", "Prescription")} {d.external_id}</h1>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">{d.status || t("ΕΚΤΕΛΕΣΜΕΝΗ", "EXECUTED")}</span>
          {recurring && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">
              <Repeat className="h-3.5 w-3.5" /> {t("Επανάληψη συνταγής", "Repeat prescription")}
            </span>
          )}
        </div>
      </div>

      {/* Πληρωτέο από Ταμείο — the headline number (what the pharmacy collects from the fund) */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-600 px-5 py-4 text-white">
        <div>
          <div className="text-xs uppercase tracking-wide text-brand-100">{t("Πληρωτέο από Ταμείο", "Payable by Fund")}</div>
          <div className="text-xs text-brand-200">{t("Τι έχει να εισπράξει το φαρμακείο από το ταμείο", "What the pharmacy collects from the fund")}</div>
        </div>
        <div className="text-3xl font-extrabold">{eur(d.fund_payable)}</div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          [t("Σύνολο αξίας", "Total value"), eur(d.amount_total)],
          [t("Πληρωτέο από Ασφ/νο", "Payable by patient"), eur(d.patient_payable)],
          [t("Χονδρικό κόστος", "Wholesale cost"), marginReliable ? eur(d.wholesale_cost) : "—"],
          [t("Μεικτό κέρδος", "Gross profit"), marginReliable ? eur(profit) : "—"],
        ].map(([l, v]) => (
          <div key={l} className="rx-card p-4">
            <div className="text-xs text-slate-400">{l}</div>
            <div className="mt-1 text-lg font-bold text-slate-900">{v}</div>
          </div>
        ))}
      </div>
      {!marginReliable && (
        <div className="-mt-2 text-xs text-slate-400">
          {t("Το χονδρικό κόστος & το μεικτό κέρδος αφορούν όλη τη συνταγή, όχι τη μερική εκτέλεση — θα υπολογιστούν ανά εκτέλεση μετά τον πλήρη συγχρονισμό με το ΗΔΙΚΑ.",
             "Wholesale cost & gross profit cover the whole prescription, not this partial execution — they will be computed per-execution after the full ΗΔΙΚΑ sync.")}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <PanelCard title={t("Ιατρός", "Doctor")}>
          <div className="text-sm font-semibold text-slate-800">{d.doctor?.name || t("Άγνωστος", "Unknown")}</div>
          <div className="text-xs text-slate-500">{d.doctor?.specialty || "—"}</div>
        </PanelCard>
        <PanelCard title={t("Ασθενής", "Patient")}>
          <div className="text-sm font-semibold text-slate-800">{d.patient?.full_name || t("—", "—")}</div>
          <div className="text-xs text-slate-500">{sexLabel(d.patient?.sex ?? null, t)}{age ? t(`, ${age} ετών`, `, ${age} years old`) : ""}{d.patient?.amka ? ` · ΑΜΚΑ ${d.patient.amka}` : ""}</div>
          <div className="text-xs text-slate-500">{d.patient?.area || "—"} · {t("Ταμείο", "Fund")}: {d.fund?.name || "—"}</div>
        </PanelCard>
        <PanelCard title={t("Συνταγή", "Prescription")}>
          <div className="text-sm text-slate-700">{t("Εκτέλεση", "Execution")}: {dt(d.executed_at)}</div>
          <div className="text-xs text-slate-500">
            {recurring ? t("Επανάληψη συνταγής", "Repeat prescription") : t("Μία εκτέλεση", "Single execution")}
            {d.next_open_date ? t(` · Επόμενη: ${new Date(d.next_open_date).toLocaleDateString("el-GR")}`, ` · Next: ${new Date(d.next_open_date).toLocaleDateString("el-GR")}`) : ""}
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
      <PanelCard title={t("Φάρμακα & θεραπείες", "Medicines & treatments")}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="py-2">{t("Σκεύασμα", "Product")}</th>
                <th>{t("Δραστική ουσία", "Active substance")}</th>
                <th className="text-right">{t("Ποσ.", "Qty")}</th>
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
                </tr>
              ))}
              {d.items.length === 0 && (
                <tr><td colSpan={3} className="py-4 text-center text-slate-400">{t("Δεν υπάρχουν γραμμές φαρμάκων.", "No medicine lines.")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </PanelCard>

      {/* Full ΗΔΥΚΑ details — ALWAYS shown, from the stored data (no button). Falls back to a live
          fetch only while a prescription's details aren't stored yet (i.e. before the re-download). */}
      <PanelCard title={t("Πλήρη στοιχεία ΗΔΥΚΑ", "Full ΗΔΥΚΑ details")}>
        {hasStoredHdyka(d) ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
              <Field label={t("Ημ/νία έκδοσης", "Issue date")} value={d.details?.issue_date} />
              <Field label={t("Προθεσμία εκτέλεσης", "Execution deadline")} value={d.details?.deadline_date} />
              <Field label={t("Επιβάρυνση 1€", "€1 surcharge")} value={yesNo(d.details?.fund_surcharge, t)} />
              <Field label={t("Απαλλαγή συμμετοχής", "Co-payment exemption")} value={yesNo(d.details?.exemption, t)} />
              <Field label={t("Γνωμάτευση", "Opinion")} value={yesNo(d.details?.opinion, t)} />
              <Field label={t("Συμμετοχή ασθενή (σύν.)", "Patient share (total)")} value={d.details?.patient_share_total != null ? eur(d.details.patient_share_total) : null} />
              <Field label={t("Από ταμείο (σύν.)", "From fund (total)")} value={d.details?.fund_share_total != null ? eur(d.details.fund_share_total) : null} />
            </div>
            <div className="space-y-3">
              {d.items.map((it, i) => {
                const ln = it.details || {};
                return (
                  <div key={i} className={`rounded-xl border p-4 ${it.is_executed ? "border-slate-200" : "border-slate-300 bg-slate-100 dark:bg-slate-800/60"}`}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${it.is_executed ? "text-slate-800" : "text-slate-500"}`}>{it.name}</span>
                      {it.atc && <span className="text-[10px] text-slate-400">{it.atc}</span>}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${it.is_executed ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{it.is_executed ? t("Εκτελέστηκε", "Executed") : t("Δεν εκτελέστηκε", "Not executed")}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
                      <Field label={t("Δραστική", "Active substance")} value={it.substance} />
                      <Field label={t("Μορφή", "Form")} value={ln.form} />
                      <Field label={t("Ποσότητα", "Quantity")} value={String(it.quantity)} />
                      <Field label={t("Δοσολογία", "Dosage")} value={[ln.dose, ln.frequency && t(`ανά ${ln.frequency}`, `every ${ln.frequency}`), ln.duration && t(`για ${ln.duration}`, `for ${ln.duration}`)].filter(Boolean).join(" · ") || null} />
                      <Field label={t("Ταινία γνησιότητας", "Authenticity strip")} value={ln.strip || ln.lot} />
                      <Field label={t("Τιμή εκτέλεσης", "Execution price")} value={ln.execution_price != null ? eur(ln.execution_price) : null} />
                      <Field label={t("Τιμή λιανικής", "Retail price")} value={ln.retail_price != null ? eur(ln.retail_price) : null} />
                      <Field label={t("Τιμή αναφοράς", "Reference price")} value={ln.reference_price != null ? eur(ln.reference_price) : null} />
                      <Field label={t("Συμμετοχή %", "Co-payment %")} value={ln.participation_pct != null ? `${ln.participation_pct}%` : null} />
                      <Field label={t("Διαφορά", "Difference")} value={ln.difference != null ? eur(ln.difference) : null} />
                      <Field label={t("Τύπος κουπονιού", "Coupon type")} value={ln.qr ? "QR" : ln.strip ? t("Ταινία", "Strip") : null} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : idika.isLoading ? (
          <div className="py-6 text-center text-sm text-slate-400">{t("Άντληση από ΗΔΥΚΑ…", "Fetching from ΗΔΥΚΑ…")}</div>
        ) : idika.isError || !idika.data ? (
          <div className="py-4 text-sm text-rose-600">{t("Αποτυχία άντλησης από ΗΔΥΚΑ.", "Failed to fetch from ΗΔΥΚΑ.")} <button onClick={() => idika.refetch()} className="underline">{t("Δοκίμασε ξανά", "Try again")}</button></div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
              <Field label={t("Ημ/νία έκδοσης", "Issue date")} value={idika.data.details.issue_date} />
              <Field label={t("Προθεσμία εκτέλεσης", "Execution deadline")} value={idika.data.details.deadline_date} />
              <Field label={t("Επιβάρυνση 1€", "€1 surcharge")} value={yesNo(idika.data.details.fund_surcharge, t)} />
              <Field label={t("Απαλλαγή συμμετοχής", "Co-payment exemption")} value={yesNo(idika.data.details.exemption, t)} />
              <Field label={t("Γνωμάτευση", "Opinion")} value={yesNo(idika.data.details.opinion, t)} />
              <Field label={t("Συμμετοχή ασθενή (σύν.)", "Patient share (total)")} value={eurR(idika.data.details.patient_share_total)} />
              <Field label={t("Από ταμείο (σύν.)", "From fund (total)")} value={eurR(idika.data.details.fund_share_total)} />
            </div>
            <div className="space-y-3">
              {idika.data.lines.map((ln, i) => (
                <div key={i} className={`rounded-xl border p-4 ${ln.is_executed ? "border-slate-200" : "border-slate-300 bg-slate-100 dark:bg-slate-800/60"}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`font-semibold ${ln.is_executed ? "text-slate-800" : "text-slate-500"}`}>{ln.name}</span>
                    {ln.atc && <span className="text-[10px] text-slate-400">{ln.atc}</span>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${ln.is_executed ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{ln.is_executed ? t("Εκτελέστηκε", "Executed") : t("Δεν εκτελέστηκε", "Not executed")}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
                    <Field label={t("Δραστική", "Active substance")} value={ln.substance} />
                    <Field label={t("Μορφή", "Form")} value={ln.form} />
                    <Field label={t("Δοσολογία", "Dosage")} value={[ln.dose, ln.frequency && t(`ανά ${ln.frequency}`, `every ${ln.frequency}`), ln.duration && t(`για ${ln.duration}`, `for ${ln.duration}`)].filter(Boolean).join(" · ") || null} />
                    <Field label={t("Ταινία γνησιότητας", "Authenticity strip")} value={ln.lot} />
                    <Field label={t("Τιμή εκτέλεσης", "Execution price")} value={eurR(ln.execution_price)} />
                    <Field label={t("Τιμή λιανικής", "Retail price")} value={eurR(ln.retail_price)} />
                    <Field label={t("Τιμή αναφοράς", "Reference price")} value={eurR(ln.reference_price)} />
                    <Field label={t("Συμμετοχή %", "Co-payment %")} value={ln.participation_pct != null ? `${ln.participation_pct}%` : null} />
                    <Field label={t("Διαφορά", "Difference")} value={eurR(ln.difference)} />
                    <Field label={t("Αντικατάσταση", "Substitution")} value={ln.substitution_allowed ? t("Επιτρέπεται", "Allowed") : t("Όχι", "No")} />
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
