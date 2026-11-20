"use client";

/* RxVision Κύπρος — Εκκαθάριση ΟΑΥ. Ο φαρμακοποιός ανεβάζει τα αρχεία που λαμβάνει κάθε μήνα από τον ΟΑΥ
   (PDF «Αμοιβή Φαρμακοποιού», PDF «Κατάσταση πληρωμής», Excel «Πληρωμένες απαιτήσεις» / «Εγκεκριμένο» /
   «Μερικώς εκτελεσμένη»). Βλέπει την αμοιβή του, τις εφημερίες και τις διορθώσεις, και ΣΥΜΦΩΝΙΑ κάθε
   εκτέλεσης με τα δεδομένα του RxVision. Backend: services/cy/settlement.py. Χωρίς στοιχεία πελατών. */

import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileUp, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { ApiError, api, apiUpload } from "@/lib/apiClient";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { appConfirm } from "@/store/dialogStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Month = { month: string; price_cents: number | null; packages: number | null; fee_cents: number | null;
  duty_cents: number | null; corrections_cents: number | null; paid_total_cents: number | null; payment_date: string | null;
  has: { unit: boolean; remittance: boolean; paid: boolean; pending: boolean } };
type RemLine = { date: string; invoice: string; description: string; kind: string; cents: number };
type Diff = { id: string; kind: string; claim_date: string | null; fields: Record<string, { ours: number; hio_file: number }> };
type Miss = { id: string; kind: string; claim_date: string | null; total: number; hio: number; packages: number };
type Pend = { id: string; status: "approved" | "partial"; kind: string; date: string | null; beneficiary: number; hio: number; found: boolean };
type Unseen = { id: string; date: string; hio: number; total: number; packages: number };
type Detail = {
  month: string;
  unit: { invoice_id: string; invoice_date: string | null; price_cents: number; packages: number; fee_cents: number; consistent: boolean } | null;
  remittance: { payment_date: string | null; total_cents: number | null; claims_cents: number; fee_cents: number | null;
    duty_cents: number; corrections: RemLine[]; duty: RemLine[] } | null;
  paid: { count: number; packages: number; hio_cents: number; total_cents: number; vat_cents: number; copay_cents: number;
    pc2_cents: number; packages_match_unit: boolean | null } | null;
  reconcile: { ok: number; diffs: Diff[]; missing: Miss[]; pending: Pend[]; unseen: Unseen[]; unseen_count: number };
  files: { name: string; kind: string; at: string }[];
};
type ImportRes = { imported: { file: string; kind: string; month: string }[]; errors: { file: string; error: string }[] };

const MONTHS = ["Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος", "Ιούλιος", "Αύγουστος",
  "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος"];
const mname = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const dmy = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const eur = (c: number | null | undefined) => (c == null ? "—" : fmtEur(c));

function Kpi({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function Section({ title, count, tone, children }: { title: string; count: number; tone: "ok" | "warn" | "info"; children: React.ReactNode }) {
  const c = tone === "ok" ? "bg-emerald-100 text-emerald-800" : tone === "warn" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800";
  return (
    <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <h2 className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">
        {title}<span className={`rounded-full px-2 py-0.5 text-xs ${c}`}>{fmtNum(count)}</span>
      </h2>
      <div className="p-2">{children}</div>
    </section>
  );
}

export default function CySettlementPage() {
  const t = useT();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportRes | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["cy", "settlement"], queryFn: () => api<{ items: Month[] }>("/cy/settlement") });
  const sel = month ?? list.data?.items[0]?.month ?? null;
  const det = useQuery({ queryKey: ["cy", "settlement", sel], enabled: !!sel,
    queryFn: () => api<Detail>(`/cy/settlement/${sel}`) });
  const d = det.data;

  const KIND: Record<string, string> = {
    unit: t("Αμοιβή φαρμακοποιού (PDF)", "Pharmacist fee (PDF)"), remittance: t("Κατάσταση πληρωμής (PDF)", "Remittance advice (PDF)"),
    paid: t("Πληρωμένες απαιτήσεις (Excel)", "Paid claims (Excel)"), pending: t("Εκκρεμείς απαιτήσεις (Excel)", "Pending claims (Excel)") };
  const ERR: Record<string, string> = {
    unsupported_file: t("δεν είναι PDF ή Excel", "not a PDF or Excel file"), unknown_pdf: t("PDF που δεν είναι αρχείο του ΟΑΥ", "PDF that is not an HIO file"),
    unknown_xlsx: t("Excel που δεν είναι αρχείο του ΟΑΥ", "Excel that is not an HIO file"), no_month: t("δεν βρέθηκε μήνας", "no month found"),
    unreadable: t("δεν διαβάζεται", "unreadable") };

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setErr(null); setResult(null);
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    try {
      const r = await apiUpload<ImportRes>("/cy/settlement/import", fd);
      setResult(r);
      if (r.imported[0]) setMonth(r.imported[0].month);
      await qc.invalidateQueries({ queryKey: ["cy", "settlement"] });
      await qc.invalidateQueries({ queryKey: ["cy", "profit"] });
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 413 ? t("Πολύ μεγάλο αρχείο (έως 10 MB).", "File too large (max 10 MB).")
        : t("Το ανέβασμα απέτυχε. Δοκίμασε ξανά.", "Upload failed. Try again."));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(m: string) {
    if (!(await appConfirm(t(`Να διαγραφούν τα αρχεία εκκαθάρισης του μήνα ${mname(m)}; Οι εκτελέσεις σου δεν επηρεάζονται.`,
      `Delete the settlement files of ${mname(m)}? Your dispensings are not affected.`), { title: t("Διαγραφή μήνα", "Delete month"), danger: true, confirmText: t("Διαγραφή", "Delete") }))) return;
    await api(`/cy/settlement/${m}`, { method: "DELETE" });
    setMonth(null);
    await qc.invalidateQueries({ queryKey: ["cy", "settlement"] });
    await qc.invalidateQueries({ queryKey: ["cy", "profit"] });
  }

  const rc = d?.reconcile;
  const diffCols: Column<Diff>[] = [
    { key: "id", header: t("Εκτέλεση", "Dispensing"), render: (r) => <Link href={`/cy/dispensings/${r.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{r.id}</Link> },
    { key: "claim_date", header: t("Ημ/νία απαίτησης", "Claim date"), render: (r) => dmy(r.claim_date) },
    { key: "fields", header: t("Τι διαφέρει (RxVision → ΟΑΥ)", "What differs (RxVision → HIO)"), render: (r) => (
      <div className="space-y-0.5 text-xs">{Object.entries(r.fields).map(([k, v]) => (
        <div key={k}><b>{k === "packages" ? t("συσκευασίες", "packages") : k === "hio" ? "ΟΑΥ" : k === "copay" ? t("συμμετοχή", "copay") : k === "total" ? t("σύνολο", "total") : k.toUpperCase()}</b>: {k === "packages" ? `${v.ours} → ${v.hio_file}` : `${fmtEur(v.ours)} → ${fmtEur(v.hio_file)}`}</div>))}</div>) },
  ];
  const missCols: Column<Miss>[] = [
    { key: "id", header: t("Εκτέλεση", "Dispensing"), render: (r) => <b>{r.id}</b> },
    { key: "claim_date", header: t("Ημ/νία απαίτησης", "Claim date"), render: (r) => dmy(r.claim_date) },
    { key: "packages", header: t("Συσκευασίες", "Packages"), align: "right", render: (r) => fmtNum(r.packages) },
    { key: "hio", header: "ΟΑΥ", align: "right", render: (r) => fmtEur(r.hio) },
    { key: "total", header: t("Σύνολο", "Total"), align: "right", render: (r) => fmtEur(r.total) },
  ];
  const pendCols: Column<Pend>[] = [
    { key: "id", header: t("Εκτέλεση", "Dispensing"), render: (r) => r.found
      ? <Link href={`/cy/dispensings/${r.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{r.id}</Link>
      : <span>{r.id} <span className="text-xs text-amber-700">({t("λείπει από το RxVision", "missing from RxVision")})</span></span> },
    { key: "status", header: t("Κατάσταση", "Status"), render: (r) => r.status === "partial" ? t("Μερικώς εκτελεσμένη", "Partially dispensed") : t("Εγκρίθηκε", "Approved") },
    { key: "date", header: t("Ημ/νία", "Date"), render: (r) => dmy(r.date) },
    { key: "hio", header: t("Ενδεικτικά ΟΑΥ", "Indicative HIO"), align: "right", render: (r) => fmtEur(r.hio) },
  ];
  const unseenCols: Column<Unseen>[] = [
    { key: "id", header: t("Εκτέλεση", "Dispensing"), render: (r) => <Link href={`/cy/dispensings/${r.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{r.id}</Link> },
    { key: "date", header: t("Ημ/νία", "Date"), render: (r) => dmy(r.date) },
    { key: "packages", header: t("Συσκευασίες", "Packages"), align: "right", render: (r) => fmtNum(r.packages) },
    { key: "hio", header: "ΟΑΥ", align: "right", render: (r) => fmtEur(r.hio) },
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Εκκαθάριση ΟΑΥ", "HIO settlement")}</h1>
        <p className="text-sm text-slate-500">{t("Ανέβασε τα αρχεία που λαμβάνεις κάθε μήνα από τον ΟΑΥ: βλέπεις την αμοιβή σου και ελέγχεις ότι πληρώθηκε κάθε εκτέλεση.",
          "Upload the files you receive each month from the HIO: see your fee and check that every dispensing was paid.")}</p>
      </header>

      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-3">
          <input ref={input} type="file" multiple accept=".pdf,.xlsx" className="hidden" onChange={(e) => upload(e.target.files)} />
          <button onClick={() => input.current?.click()} disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}{t("Ανέβασε αρχεία του μήνα", "Upload the month's files")}
          </button>
          <span className="text-xs text-slate-500">{t("Μπορείς να τα διαλέξεις όλα μαζί. Ξανά-ανέβασμα αντικαθιστά το προηγούμενο.", "You can select them all at once. Uploading again replaces the previous one.")}</span>
        </div>
        <ul className="grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
          <li>• <b>{t("Αμοιβή φαρμακοποιού", "Pharmacist fee")}</b> (PDF): {t("τιμή μονάδας, συσκευασίες, αμοιβή", "unit price, packages, fee")}</li>
          <li>• <b>{t("Κατάσταση πληρωμής", "Remittance advice")}</b> (PDF): {t("εφημερίες, διορθώσεις, σύνολο", "duty nights, corrections, total")}</li>
          <li>• <b>{t("Πληρωμένες απαιτήσεις", "Paid claims")}</b> (Excel): {t("έλεγχος κάθε εκτέλεσης", "check of every dispensing")}</li>
          <li>• <b>{t("Εγκεκριμένο / Μερικώς εκτελεσμένη", "Approved / Partially dispensed")}</b> (Excel): {t("όσα δεν πληρώθηκαν ακόμα", "what is not paid yet")}</li>
        </ul>
        {err && <p className="text-sm text-rose-600">{err}</p>}
        {result && (
          <div className="space-y-1 text-sm">
            {result.imported.map((i) => <p key={i.file} className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="h-4 w-4" />{i.file} — {KIND[i.kind] ?? i.kind} · {mname(i.month)}</p>)}
            {result.errors.map((e) => <p key={e.file} className="flex items-center gap-1.5 text-amber-700"><TriangleAlert className="h-4 w-4" />{e.file} — {ERR[e.error] ?? e.error}</p>)}
          </div>
        )}
        <p className="text-xs text-slate-400">{t("Δεν αποθηκεύονται ονόματα ή ταυτότητες πελατών· μόνο αριθμοί εκτέλεσης και ποσά.", "No customer names or IDs are stored; only dispensing numbers and amounts.")}</p>
      </section>

      {list.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {list.data && list.data.items.length === 0 && (
        <p className="text-sm text-slate-500">{t("Δεν έχεις ανεβάσει ακόμα εκκαθάριση. Μέχρι τότε η Κερδοφορία δεν μπορεί να δείξει την αμοιβή σου.", "No settlement uploaded yet. Until then Profitability cannot show your fee.")}</p>
      )}

      {list.data && list.data.items.length > 0 && (
        <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase text-slate-400"><tr>
              <th className="px-4 py-2">{t("Μήνας", "Month")}</th><th className="px-4 py-2 text-right">{t("Τιμή μονάδας", "Unit price")}</th>
              <th className="px-4 py-2 text-right">{t("Συσκευασίες", "Packages")}</th><th className="px-4 py-2 text-right">{t("Αμοιβή", "Fee")}</th>
              <th className="px-4 py-2 text-right">{t("Εφημερίες", "Duty nights")}</th><th className="px-4 py-2 text-right">{t("Πληρωμή", "Payment")}</th><th /></tr></thead>
            <tbody>
              {list.data.items.map((m) => (
                <tr key={m.month} onClick={() => setMonth(m.month)} className={`cursor-pointer border-t border-slate-50 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50 ${m.month === sel ? "bg-brand-50/60 dark:bg-brand-950/20" : ""}`}>
                  <td className="px-4 py-2 font-medium">{mname(m.month)}</td>
                  <td className="px-4 py-2 text-right">{eur(m.price_cents)}</td>
                  <td className="px-4 py-2 text-right">{m.packages == null ? "—" : fmtNum(m.packages)}</td>
                  <td className="px-4 py-2 text-right font-semibold text-emerald-700 dark:text-emerald-400">{eur(m.fee_cents)}</td>
                  <td className="px-4 py-2 text-right">{eur(m.duty_cents)}</td>
                  <td className="px-4 py-2 text-right">{eur(m.paid_total_cents)}{m.payment_date && <span className="ml-1 text-xs text-slate-400">({dmy(m.payment_date)})</span>}</td>
                  <td className="px-2 py-2 text-right">
                    <button onClick={(e) => { e.stopPropagation(); remove(m.month); }} title={t("Διαγραφή μήνα", "Delete month")} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>))}
            </tbody>
          </table>
        </section>
      )}

      {det.isLoading && sel && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {d && rc && (
        <>
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{mname(d.month)}</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi label={t("Αμοιβή ΟΑΥ", "HIO fee")} tone="text-emerald-700 dark:text-emerald-400" value={eur(d.unit?.fee_cents)}
              sub={d.unit ? `${fmtNum(d.unit.packages)} × ${fmtEur(d.unit.price_cents)}` : t("ανέβασε το PDF αμοιβής", "upload the fee PDF")} />
            <Kpi label={t("Εφημερίες", "Duty nights")} value={d.remittance ? fmtEur(d.remittance.duty_cents) : "—"} />
            <Kpi label={t("Διορθώσεις", "Corrections")} value={d.remittance ? fmtEur(d.remittance.corrections.reduce((s, x) => s + x.cents, 0)) : "—"}
              tone={d.remittance && d.remittance.corrections.some((x) => x.cents < 0) ? "text-rose-600" : ""} />
            <Kpi label={t("Απαιτήσεις φαρμάκων", "Medicine claims")} value={d.remittance ? fmtEur(d.remittance.claims_cents) : d.paid ? fmtEur(d.paid.hio_cents) : "—"}
              sub={t("πληρώνονται στη χονδρική", "paid at wholesale")} />
            <Kpi label={t("Σύνολο πληρωμής", "Total payment")} value={eur(d.remittance?.total_cents)} sub={d.remittance?.payment_date ? dmy(d.remittance.payment_date) : undefined} />
          </div>

          <div className="space-y-1 text-sm">
            {d.unit && (d.unit.consistent
              ? <p className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="h-4 w-4" />{t("Η αμοιβή = τιμή μονάδας × συσκευασίες.", "Fee = unit price × packages.")}</p>
              : <p className="flex items-center gap-1.5 text-amber-700"><TriangleAlert className="h-4 w-4" />{t("Η αμοιβή δεν ισούται με τιμή μονάδας × συσκευασίες — έλεγξέ το με τον ΟΑΥ.", "The fee does not equal unit price × packages — check it with the HIO.")}</p>)}
            {d.paid?.packages_match_unit === true && <p className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="h-4 w-4" />{t(`Οι ${fmtNum(d.paid.packages)} συσκευασίες των πληρωμένων απαιτήσεων είναι αυτές που αμείφθηκαν.`, `The ${fmtNum(d.paid.packages)} packages of the paid claims are the ones paid for.`)}</p>}
            {d.paid?.packages_match_unit === false && <p className="flex items-center gap-1.5 text-amber-700"><TriangleAlert className="h-4 w-4" />{t(`Οι πληρωμένες απαιτήσεις έχουν ${fmtNum(d.paid.packages)} συσκευασίες, η αμοιβή μετρά ${fmtNum(d.unit?.packages ?? 0)}.`, `Paid claims have ${fmtNum(d.paid.packages)} packages, the fee counts ${fmtNum(d.unit?.packages ?? 0)}.`)}</p>}
            {!d.paid && <p className="text-xs text-slate-500">{t("Ανέβασε και το Excel «Πληρωμένες απαιτήσεις» για τον έλεγχο κάθε εκτέλεσης.", "Also upload the «Paid claims» Excel to check every dispensing.")}</p>}
          </div>

          {d.paid && (
            <Section title={t("Ταιριάζουν ακριβώς με το RxVision", "Match RxVision exactly")} count={rc.ok} tone="ok">
              <p className="px-2 py-1 text-xs text-slate-500">{t("Ίδιες συσκευασίες, ποσό ΟΑΥ, συμμετοχή, PC2 και σύνολο.", "Same packages, HIO amount, copay, PC2 and total.")}</p>
            </Section>
          )}
          {rc.diffs.length > 0 && (
            <Section title={t("Πληρώθηκαν διαφορετικά", "Paid differently")} count={rc.diffs.length} tone="warn">
              <DataTable pageSize={15} columns={diffCols} rows={rc.diffs} rowKey={(r) => r.id} />
            </Section>
          )}
          {rc.missing.length > 0 && (
            <Section title={t("Πληρώθηκαν αλλά λείπουν από το RxVision", "Paid but missing from RxVision")} count={rc.missing.length} tone="warn">
              <p className="px-2 py-1 text-xs text-slate-500">{t("Ο ΟΑΥ τις πλήρωσε, αλλά δεν ήρθαν στο RxVision. Ανέβασέ τες από την ", "The HIO paid them but they never reached RxVision. Upload them from ")}
                <Link href="/cy/import" className="underline">{t("Εισαγωγή XML", "XML import")}</Link>.</p>
              <DataTable pageSize={15} columns={missCols} rows={rc.missing} rowKey={(r) => r.id} />
            </Section>
          )}
          {rc.pending.length > 0 && (
            <Section title={t("Δεν πληρώθηκαν ακόμα", "Not paid yet")} count={rc.pending.length} tone="info">
              <DataTable pageSize={15} columns={pendCols} rows={rc.pending} rowKey={(r) => r.id} />
            </Section>
          )}
          {rc.unseen_count > 0 && (
            <Section title={t("Του μήνα, αλλά πουθενά στα αρχεία του ΟΑΥ", "This month, but nowhere in the HIO files")} count={rc.unseen_count} tone="warn">
              <p className="px-2 py-1 text-xs text-slate-500">{t("Εκτελέσεις του μήνα με ποσό ΟΑΥ που δεν είναι ούτε πληρωμένες ούτε σε εκκρεμότητα στα αρχεία που ανέβασες. Ίσως πληρωθούν τον επόμενο μήνα — αν όχι, ρώτησε τον ΟΑΥ.",
                "Dispensings of the month with an HIO amount that are neither paid nor pending in the uploaded files. They may be paid next month — if not, ask the HIO.")}</p>
              <DataTable pageSize={15} columns={unseenCols} rows={rc.unseen} rowKey={(r) => r.id} />
            </Section>
          )}
          {d.remittance && (d.remittance.corrections.length > 0 || d.remittance.duty.length > 0) && (
            <Section title={t("Εφημερίες και διορθώσεις", "Duty nights and corrections")} count={d.remittance.corrections.length + d.remittance.duty.length} tone="info">
              <table className="w-full text-sm"><tbody>
                {[...d.remittance.duty, ...d.remittance.corrections].map((l, i) => (
                  <tr key={i} className="border-b border-slate-50 dark:border-slate-800">
                    <td className="px-2 py-1.5 text-xs text-slate-500">{dmy(l.date)}</td>
                    <td className="px-2 py-1.5">{l.description}</td>
                    <td className={`px-2 py-1.5 text-right font-medium ${l.cents < 0 ? "text-rose-600" : ""}`}>{fmtEur(l.cents)}</td>
                  </tr>))}
              </tbody></table>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
