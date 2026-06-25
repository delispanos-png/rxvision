"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Receipt, FileStack, Landmark, Coins } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";

type Day = { date: string; rx: number; executions: number; claim: number; retail: number; patient: number; hundred: number };
type Daily = { period: string; group: string; groups: string[]; days: Day[]; totals: { rx: number; executions: number; claim: number; retail: number; patient: number; hundred: number; days: number } };
type Exec = { external_id: string; executed_at: string; patient_name?: string | null; fund_name?: string | null; fund_general?: string | null; amount_total: number; amount_claimed: number; status?: string | null };

export default function DailyReconciliationPage() {
  const t = useT();
  const { period } = useReimbPeriod();
  const [group, setGroup] = useState("all");
  const { data, isLoading } = useQuery({ queryKey: ["reimb-daily", period, group], queryFn: () => api<Daily>(`/reimbursement/daily?period=${period}&group=${encodeURIComponent(group)}`) });
  const tot = data?.totals;
  const [day, setDay] = useState<string | null>(null);
  const groupLabel = (g: string) => g === "all" ? t("Σύνολο (όλα τα ταμεία)", "Total (all funds)") : g;

  // εκτελέσεις της επιλεγμένης ημέρας (UTC όρια, ίδια με τον ημερήσιο έλεγχο) — εξαιρ. ακυρωμένες
  const nextDay = day ? new Date(new Date(day + "T00:00:00.000Z").getTime() + 864e5).toISOString() : "";
  const execs = useQuery({
    queryKey: ["reimb-daily-execs", day],
    queryFn: () => api<{ items: Exec[] }>(`/prescriptions?date_from=${day}T00:00:00.000Z&date_to=${nextDay}&page_size=300&sort=executed_at&dir=-1`),
    enabled: !!day,
  });
  const items = (execs.data?.items ?? []).filter((e) => e.status !== "cancelled");

  const cols: Column<Day>[] = [
    { key: "date", header: t("Ημέρα", "Day"), render: (r) => <span className="font-medium">{r.date}</span> },
    { key: "rx", header: t("Συνταγές", "Rx"), align: "right", sortValue: (r) => r.rx, render: (r) => fmtNum(r.rx) },
    { key: "executions", header: t("Εκτελέσεις", "Executions"), align: "right", sortValue: (r) => r.executions, render: (r) => <span className="font-medium text-brand-600">{fmtNum(r.executions)}</span> },
    { key: "retail", header: t("Λιανική", "Retail"), align: "right", hideOnMobile: true, sortValue: (r) => r.retail, render: (r) => fmtEur(r.retail) },
    { key: "patient", header: t("Συμμετοχή", "Patient"), align: "right", hideOnMobile: true, sortValue: (r) => r.patient, render: (r) => fmtEur(r.patient) },
    { key: "hundred", header: t("100%", "100%"), align: "right", sortValue: (r) => r.hundred, render: (r) => r.hundred ? <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{fmtNum(r.hundred)}</span> : <span className="text-slate-300">—</span> },
    { key: "claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => <b>{fmtEur(r.claim)}</b> },
  ];

  const execCols: Column<Exec>[] = [
    { key: "executed_at", header: t("Ώρα", "Time"), render: (r) => new Date(r.executed_at).toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" }) },
    { key: "external_id", header: t("Barcode", "Barcode"), render: (r) => <span className="font-mono text-xs">{r.external_id}</span> },
    { key: "patient_name", header: t("Ασθενής", "Patient"), hideOnMobile: true, render: (r) => r.patient_name || "—" },
    { key: "fund_name", header: t("Ταμείο", "Fund"), hideOnMobile: true, render: (r) => r.fund_general || r.fund_name || "—" },
    { key: "amount_total", header: t("Λιανική", "Retail"), align: "right", sortValue: (r) => r.amount_total, render: (r) => fmtEur(r.amount_total) },
    { key: "amount_claimed", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.amount_claimed, render: (r) => <b>{fmtEur(r.amount_claimed)}</b> },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">{t("Πλήθος εκτελέσεων & αιτούμενα ποσά ανά ημέρα και σύνολο μήνα — για αντιπαραβολή με το πρόγραμμα του φαρμακείου. Κάνε κλικ σε μια ημέρα για να δεις τις εκτελέσεις.", "Per-day execution counts & claimed amounts. Click a day to see its executions.")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium text-slate-600 dark:text-slate-300">{t("Υποβολή / Ταμείο:", "Submission / Fund:")}</label>
        <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800">
          {(data?.groups ?? ["all"]).map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
        </select>
        {group !== "all" && <span className="text-xs text-slate-400">{t("Εμφανίζονται μόνο οι υποβαλλόμενες της επιλεγμένης ομάδας (οι 100% εξαιρούνται).", "Only submitted prescriptions of the selected group (100% excluded).")}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <KpiCard label={t("Ημέρες", "Days")} help={t("Πλήθος ημερών με δραστηριότητα στην περίοδο.", "Days with activity in the period.")} value={fmtNum(tot?.days ?? 0)} icon={CalendarDays} accent="indigo" />
        <KpiCard label={t("Συνταγές", "Prescriptions")} help={t("Διακριτές συνταγές (barcodes) — εξαιρ. ακυρωμένων.", "Distinct prescriptions, excluding cancelled.")} value={fmtNum(tot?.rx ?? 0)} icon={Receipt} accent="violet" />
        <KpiCard label={t("Εκτελέσεις", "Executions")} help={t("Πλήθος εκτελέσεων (& μερικών εκτελέσεων) — εξαιρ. ακυρωμένων· συμφωνεί με τη σελίδα «Συνταγές».", "Executions incl. partials, excluding cancelled.")} value={fmtNum(tot?.executions ?? 0)} icon={FileStack} accent="sky" />
        <KpiCard label={t("Συνολική απαίτηση", "Total claim")} help={t("Συνολικό αιτούμενο ποσό προς όλα τα ταμεία.", "Total amount claimed to all funds.")} value={fmtEur(tot?.claim ?? 0)} icon={Landmark} accent="green" />
        <KpiCard label={t("Συμμετοχή ασφ/νων", "Patient share")} help={t("Ποσό που πλήρωσαν οι ασθενείς από την τσέπη.", "Out-of-pocket patient share.")} value={fmtEur(tot?.patient ?? 0)} icon={Coins} accent="amber" />
        <KpiCard label={t("Συνταγές 100%", "100% prescriptions")} help={t("Αμιγώς 100% συμμετοχή — δεν υποβάλλονται, κρατούνται στο φαρμακείο.", "Pure 100% — kept at the pharmacy, not submitted.")} value={fmtNum(tot?.hundred ?? 0)} icon={Receipt} accent="rose" />
      </div>

      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Ανάλυση ανά ημέρα", "Per-day breakdown")}</h3>
      {isLoading ? <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
        <DataTable pageSize={40} columns={cols} rows={data?.days ?? []} rowKey={(r) => r.date} onRowClick={(r) => setDay(r.date)} empty={t("Καμία εκτέλεση τον μήνα.", "No executions this month.")} />
      )}

      <Modal open={!!day} onClose={() => setDay(null)} size="3xl" title={`${t("Εκτελέσεις", "Executions")} · ${day ? fmtDate(day) : ""}`}>
        {execs.isLoading ? <div className="p-6 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
          <>
            <div className="mb-2 text-sm text-slate-500">{items.length} {t("εκτελέσεις", "executions")}</div>
            <div className="overflow-x-auto">
              <DataTable pageSize={50} columns={execCols} rows={items} rowKey={(r) => r.external_id} empty={t("Καμία εκτέλεση.", "No executions.")} />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
