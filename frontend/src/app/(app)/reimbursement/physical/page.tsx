"use client";

import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ScanBarcode, CheckCircle2, XCircle, ListChecks, AlertTriangle, RotateCcw,
  X, FileText, Syringe, Pill, ShieldAlert, Ticket,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtNum, fmtEur, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Item = { barcode: string; claim: number; fund: string; executed_at: string; checked: boolean; day: string };
type DayRow = { date: string; total: number; checked: number };
type Check = { period: string; day: string | null; total: number; checked: number; remaining: number; extra: string[]; by_day: DayRow[]; items: Item[] };
type Coupon = { name: string; barcode: string; quantity: number; category: string; requires_opinion: boolean; executed: boolean };
type Detail = { ok: boolean; found: boolean; barcode: string; fund: string; claim: number; n_coupons: number; requires_opinion: boolean; is_fyk: boolean; has_vaccine: boolean; has_narcotic: boolean; partial: boolean; coupons: Coupon[] };
type ScanRes = { ok: boolean; found: boolean; barcode: string; detail: Detail | null };

export default function PhysicalCheckPage() {
  const t = useT();
  const qc = useQueryClient();
  const { period } = useReimbPeriod();
  const inputRef = useRef<HTMLInputElement>(null);
  const [bc, setBc] = useState("");
  const [day, setDay] = useState("");
  const [last, setLast] = useState<{ found: boolean; barcode: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["reimb-physical", period, day], queryFn: () => api<Check>(`/reimbursement/physical?period=${period}${day ? `&day=${day}` : ""}`) });
  const scan = useMutation({
    mutationFn: (barcode: string) => api<ScanRes>(`/reimbursement/physical/scan?period=${period}`, { method: "POST", body: JSON.stringify({ barcode }) }),
    onSuccess: (r) => { setLast({ found: r.found, barcode: r.barcode }); if (r.found && r.detail?.found) setDetail(r.detail); qc.invalidateQueries({ queryKey: ["reimb-physical", period] }); },
  });
  const reset = useMutation({
    mutationFn: () => api(`/reimbursement/physical/reset?period=${period}`, { method: "POST" }),
    onSuccess: () => { setLast(null); qc.invalidateQueries({ queryKey: ["reimb-physical", period] }); },
  });

  function submit() {
    const v = bc.trim();
    if (!v) return;
    scan.mutate(v);
    setBc("");
    inputRef.current?.focus();
  }

  const cols: Column<Item>[] = [
    { key: "checked", header: "", render: (r) => r.checked ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300" /> },
    { key: "barcode", header: "Barcode", render: (r) => <button onClick={() => openDetail(r.barcode)} className={`font-mono text-xs hover:text-emerald-600 hover:underline ${r.checked ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-200"}`}>{r.barcode}</button> },
    { key: "fund", header: t("Ταμείο", "Fund"), hideOnMobile: true, render: (r) => r.fund },
    { key: "executed_at", header: t("Ημ/νία", "Date"), hideOnMobile: true, render: (r) => fmtDate(r.executed_at) },
    { key: "claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => fmtEur(r.claim) },
  ];

  async function openDetail(barcode: string) {
    setDetail({ found: false } as Detail);  // loading sentinel
    try { const d = await api<Detail>(`/reimbursement/prescription?barcode=${encodeURIComponent(barcode)}`); setDetail(d.found ? d : null); }
    catch { setDetail(null); }
  }

  return (
    <div className="space-y-5">
      {/* day selector — per-day reconciliation */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-500">{t("Ημέρα", "Day")}:</span>
        <select value={day} onChange={(e) => setDay(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
          <option value="">{t("Όλος ο μήνας", "Whole month")}</option>
          {(data?.by_day ?? []).map((d) => <option key={d.date} value={d.date}>{d.date} — {d.checked}/{d.total}</option>)}
        </select>
        {day && <span className="text-xs text-slate-400">{t("Φιλτράρισμα στην επιλεγμένη ημέρα", "Filtered to the selected day")}</span>}
      </div>

      {/* scanner */}
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 dark:border-emerald-800 dark:bg-emerald-950/20">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><ScanBarcode className="h-5 w-5 text-emerald-600" /> {t("Σκανάρισμα συνταγών", "Scan prescriptions")}</div>
        <p className="mb-3 mt-1 text-xs text-slate-500">{t("Σκάναρε το barcode κάθε συνταγής — ταυτοποιείται με τη λίστα και ανοίγει τα κουπόνια/πληροφορίες κατάθεσης.", "Scan each prescription barcode — matched against the list, opening its coupons / submission info.")}</p>
        <div className="flex gap-2">
          <input ref={inputRef} autoFocus value={bc} onChange={(e) => setBc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder={t("π.χ. 2604200422266", "e.g. 2604200422266")} inputMode="numeric"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800" />
          <button onClick={submit} className="rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">{t("Έλεγχος", "Check")}</button>
        </div>
        {last && (
          <div className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${last.found ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
            {last.found ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            <span className="font-mono">{last.barcode}</span> — {last.found ? t("βρέθηκε ✓ (δες κουπόνια)", "found ✓ (see coupons)") : t("ΔΕΝ υπάρχει στα δεδομένα μας!", "NOT in our data!")}
          </div>
        )}
      </div>

      {/* counters */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={day ? t("Σύνολο ημέρας", "Day total") : t("Σύνολο μήνα", "Month total")} value={fmtNum(data?.total ?? 0)} icon={ListChecks} accent="indigo" />
        <KpiCard label={t("Ελεγμένες", "Checked")} value={fmtNum(data?.checked ?? 0)} icon={CheckCircle2} accent="green" />
        <KpiCard label={t("Εκκρεμείς (δεν σκαναρίστηκαν)", "Remaining (unscanned)")} value={fmtNum(data?.remaining ?? 0)} icon={AlertTriangle} accent="amber" />
        <KpiCard label={t("Εκτός λίστας (ΗΔΙΚΑ)", "Not in our data")} value={fmtNum(data?.extra.length ?? 0)} icon={XCircle} accent="rose" />
      </div>

      {!!data?.extra.length && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/50 dark:bg-rose-950/40">
          <div className="mb-1 text-sm font-semibold text-rose-700 dark:text-rose-300">{t("Σκαναρίστηκαν αλλά ΔΕΝ υπάρχουν στα δεδομένα μας:", "Scanned but NOT in our data:")}</div>
          <div className="flex flex-wrap gap-1.5">{data.extra.map((b) => <span key={b} className="rounded bg-white px-2 py-0.5 font-mono text-xs text-rose-700 dark:bg-slate-900">{b}</span>)}</div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Εκκρεμείς πρώτα", "Remaining first")} · {fmtNum(data?.total ?? 0)} {t("συνταγές", "Rx")}</h3>
        <button onClick={() => { if (confirm(t("Μηδενισμός ελέγχου;", "Reset check?"))) reset.mutate(); }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-3.5 w-3.5" /> {t("Μηδενισμός", "Reset")}</button>
      </div>
      {isLoading ? <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : (
        <DataTable pageSize={25} columns={cols} rows={data?.items ?? []} rowKey={(r) => r.barcode} empty={t("Καμία εκτέλεση.", "No executions.")} />
      )}

      {/* advanced detail modal — coupons + submission flags */}
      {detail !== null && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setDetail(null)}>
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            {!detail.found && !detail.coupons ? (
              <div className="text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>
            ) : (
              <>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-emerald-600"><Ticket className="h-3.5 w-3.5" /> {t("Κουπόνια συνταγής", "Prescription coupons")}</div>
                    <h3 className="font-mono text-base font-bold text-slate-900 dark:text-slate-100">{detail.barcode}</h3>
                    <p className="text-xs text-slate-500">{detail.fund} · {fmtEur(detail.claim)} · {detail.n_coupons} {t("κουπόνια", "coupons")}</p>
                  </div>
                  <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
                </div>

                {/* submission flags */}
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {detail.requires_opinion && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700"><FileText className="h-3 w-3" /> {t("Απαιτεί γνωμάτευση", "Requires opinion")}</span>}
                  {detail.is_fyk && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">ΦΥΚ</span>}
                  {detail.has_vaccine && <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700"><Syringe className="h-3 w-3" /> {t("Εμβόλιο", "Vaccine")}</span>}
                  {detail.has_narcotic && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700"><ShieldAlert className="h-3 w-3" /> {t("Ναρκωτικό", "Narcotic")}</span>}
                  {detail.partial && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{t("Μερική εκτέλεση", "Partial")}</span>}
                </div>

                {/* coupon list */}
                <div className="space-y-1.5">
                  {detail.coupons.map((c, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700">
                      <Pill className={`mt-0.5 h-4 w-4 shrink-0 ${c.category === "fyk" ? "text-orange-500" : c.category === "vaccine" ? "text-sky-500" : c.category === "narcotic" ? "text-rose-500" : "text-slate-400"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-slate-700 dark:text-slate-200">{c.name} {c.quantity > 1 && <span className="text-slate-400">×{c.quantity}</span>}</div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400">
                          {c.barcode && <span className="font-mono">{c.barcode}</span>}
                          {c.requires_opinion && <span className="text-amber-600">📋 {t("γνωμάτευση", "opinion")}</span>}
                          {!c.executed && <span className="text-rose-500">{t("ανεκτέλεστο", "unexecuted")}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[10px] text-slate-400">{t("Τα κουπόνια που πρέπει να υπάρχουν στη συνταγή για την κατάθεση.", "The coupons that should be on the prescription for submission.")}</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
