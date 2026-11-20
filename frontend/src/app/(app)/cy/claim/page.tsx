"use client";

/* RxVision Κύπρος — Μηνιαία απαίτηση προς τον ΟΑΥ. Τι περιμένεις να πληρωθείς ανά μήνα (ποσό ΟΑΥ),
   ανά είδος, και η λίστα εκτελέσεων του μήνα για συμφωνία με την εκκαθάριση — χωρίς στοιχεία πελατών.
   Backend: services/cy/insights.py::hio_claim. */

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { downloadCsv } from "@/lib/csv";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Month = { month: string; dispensings: number; prescriptions: number; total: number; hio: number; copay: number;
  pc2: number; beneficiary: number; resent: number };
type Disp = { dispensing_id: string; prescription_id: string; date: string; kind: string; phase: string;
  total: number; hio: number; copay: number; pc2: number; resent: boolean };
type Resp = { month: string; current_month: string; months: Month[]; selected: Month | null; by_kind: Month[];
  dispensings: Disp[]; partial: boolean };

const MONTHS = ["Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος", "Ιούλιος", "Αύγουστος",
  "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος"];
const mname = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const eur2 = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export default function CyClaimPage() {
  const t = useT();
  const [month, setMonth] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["cy", "claim", month], queryFn: () => api<Resp>(`/cy/claim${month ? `?month=${month}` : ""}`) });
  const d = q.data;
  const s = d?.selected;
  const cols: Column<Disp>[] = [
    { key: "date", header: t("Ημ/νία", "Date"), render: (r) => dmy(r.date), sortValue: (r) => r.date },
    { key: "dispensing_id", header: t("Εκτέλεση", "Dispensing"), render: (r) => (
      <Link href={`/cy/dispensings/${encodeURIComponent(r.dispensing_id)}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{r.dispensing_id}</Link>) },
    { key: "prescription_id", header: t("Συνταγή", "Prescription"), render: (r) => <span className="text-xs">{r.prescription_id} · {r.phase}</span> },
    { key: "kind", header: t("Είδος", "Type"), render: (r) => r.kind === "consumable" ? t("Αναλώσιμο", "Consumable") : t("Φάρμακο", "Medicine") },
    { key: "total", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.total) },
    { key: "hio", header: "ΟΑΥ", align: "right", render: (r) => <b>{fmtEur(r.hio)}</b> },
    { key: "copay", header: t("Συμμετοχή", "Copay"), align: "right", render: (r) => fmtEur(r.copay) },
    { key: "pc2", header: "PC2", align: "right", render: (r) => r.pc2 ? fmtEur(r.pc2) : "—" },
    { key: "resent", header: "", render: (r) => r.resent ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800" title={t("Η εκτέλεση ξαναστάλθηκε με αλλαγές — έλεγξέ τη στην εκκαθάριση.", "Resent with changes — check it against the settlement.")}>{t("ξαναστάλθηκε", "resent")}</span> : null },
  ];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Μηνιαία απαίτηση ΟΑΥ", "Monthly HIO claim")}</h1>
          <p className="text-sm text-slate-500">{t("Πόσα περιμένεις να πληρωθείς από τον ΟΑΥ κάθε μήνα, από τις εκτελέσεις ΓεΣΥ σου — για να ελέγξεις την εκκαθάριση.",
            "What you expect to be paid by the HIO each month, from your GHS dispensings — to check the settlement.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={d?.month ?? ""} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900">
            {(d?.months ?? []).map((m) => <option key={m.month} value={m.month}>{mname(m.month)}</option>)}
          </select>
          {d && d.dispensings.length > 0 && (
            <button onClick={() => downloadCsv(`apaitisi-oay-${d.month}`, [
              { key: "date", header: t("Ημ/νία", "Date") }, { key: "dispensing_id", header: t("Εκτέλεση", "Dispensing") },
              { key: "prescription_id", header: t("Συνταγή", "Prescription") }, { key: "phase", header: t("Φάση", "Step") },
              { key: "kind", header: t("Είδος", "Type") }, { key: "total_eur", header: t("Αξία €", "Value €") },
              { key: "hio_eur", header: "ΟΑΥ €" }, { key: "copay_eur", header: t("Συμμετοχή €", "Copay €") },
              { key: "pc2_eur", header: "PC2 €" }, { key: "resent_txt", header: t("Ξαναστάλθηκε", "Resent") }],
              d.dispensings.map((r) => ({ ...r, date: dmy(r.date), total_eur: eur2(r.total), hio_eur: eur2(r.hio), copay_eur: eur2(r.copay),
                pc2_eur: eur2(r.pc2), resent_txt: r.resent ? t("ναι", "yes") : "" })))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
          )}
        </div>
      </header>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {d && !s && <p className="text-sm text-slate-500">{t("Δεν υπάρχουν εκτελέσεις αυτόν τον μήνα.", "No dispensings this month.")}</p>}
      {d && s && (
        <>
          {d.partial && <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-950/30 dark:text-sky-200">{t("Ο τρέχων μήνας δεν έχει τελειώσει — τα ποσά μεγαλώνουν όσο έρχονται εκτελέσεις.", "The current month is not over — amounts grow as dispensings arrive.")}</p>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[[t("Ποσό ΟΑΥ (απαίτηση)", "HIO amount (claim)"), fmtEur(s.hio), "text-emerald-700 dark:text-emerald-400"],
              [t("Αξία εκτελέσεων", "Dispensing value"), fmtEur(s.total), ""],
              [t("Συμμετοχή πελατών", "Customer copay"), fmtEur(s.copay), ""],
              ["PC2", fmtEur(s.pc2), ""],
              [t("Εκτελέσεις / συνταγές", "Dispensings / prescriptions"), `${fmtNum(s.dispensings)} / ${fmtNum(s.prescriptions)}`, ""]].map(([l, v, c]) => (
              <div key={l} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="text-xs font-medium text-slate-500">{l}</div><div className={`mt-1 text-xl font-bold ${c}`}>{v}</div>
              </div>))}
          </div>
          {s.resent > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{t(`${s.resent} εκτελέσεις ξαναστάλθηκαν με αλλαγές αυτόν τον μήνα. Αν η εκκαθάριση διαφέρει, ξεκίνα από αυτές.`, `${s.resent} dispensings were resent with changes this month. If the settlement differs, start with these.`)}</p>}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 xl:col-span-1">
              <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Ανά είδος", "By type")}</h2>
              <table className="w-full text-sm"><tbody>
                {d.by_kind.map((k) => (
                  <tr key={k.month} className="border-b border-slate-50 dark:border-slate-800">
                    <td className="px-4 py-2">{k.month === "consumable" ? t("Αναλώσιμα", "Consumables") : t("Φάρμακα", "Medicines")}</td>
                    <td className="px-4 py-2 text-right text-xs text-slate-500">{fmtNum(k.dispensings)}</td>
                    <td className="px-4 py-2 text-right font-semibold">{fmtEur(k.hio)}</td>
                  </tr>))}
              </tbody></table>
            </section>
            <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 xl:col-span-2">
              <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">{t("Τελευταίοι 12 μήνες", "Last 12 months")}</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase text-slate-400"><tr>
                  <th className="px-4 py-2">{t("Μήνας", "Month")}</th><th className="px-4 py-2 text-right">{t("Εκτελέσεις", "Dispensings")}</th>
                  <th className="px-4 py-2 text-right">{t("Αξία", "Value")}</th><th className="px-4 py-2 text-right">ΟΑΥ</th>
                  <th className="px-4 py-2 text-right">{t("Συμμετοχή", "Copay")}</th></tr></thead>
                <tbody>
                  {d.months.map((m) => (
                    <tr key={m.month} onClick={() => setMonth(m.month)} className={`cursor-pointer border-t border-slate-50 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50 ${m.month === d.month ? "bg-brand-50/60 dark:bg-brand-950/20" : ""}`}>
                      <td className="px-4 py-2">{mname(m.month)}{m.month === d.current_month && <span className="ml-1 text-xs text-slate-400">({t("τρέχων", "current")})</span>}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(m.dispensings)}</td>
                      <td className="px-4 py-2 text-right">{fmtEur(m.total)}</td>
                      <td className="px-4 py-2 text-right font-semibold">{fmtEur(m.hio)}</td>
                      <td className="px-4 py-2 text-right">{fmtEur(m.copay)}</td>
                    </tr>))}
                </tbody>
              </table>
            </section>
          </div>
          <div className="rx-card p-2">
            <DataTable pageSize={30} columns={cols} rows={d.dispensings} rowKey={(r) => r.dispensing_id} empty={t("Καμία εκτέλεση.", "No dispensings.")} />
          </div>
        </>
      )}
    </div>
  );
}
