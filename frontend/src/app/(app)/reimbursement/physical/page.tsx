"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ScanBarcode, CheckCircle2, XCircle, RotateCcw, ChevronLeft, ChevronRight,
  X, FileText, Syringe, Pill, ShieldAlert, Ticket, PartyPopper, CalendarDays, ArrowRight, AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtEur } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { appConfirm } from "@/store/dialogStore";

type Item = { barcode: string; claim: number; fund: string; executed_at: string; checked: boolean; day: string };
type DayRow = { date: string; total: number; checked: number };
type Check = { period: string; total: number; checked: number; remaining: number; extra: string[]; by_day: DayRow[]; items: Item[] };
type Coupon = { name: string; barcode: string; quantity: number; category: string; executed: boolean; qr: boolean | null; qr_batch: string | null; qr_expiry: string | null; lot: string | null };
type Detail = { ok: boolean; found: boolean; barcode: string; fund: string; claim: number; n_coupons: number; has_opinion: boolean | null; is_fyk: boolean; has_vaccine: boolean; has_narcotic: boolean; partial: boolean; coupons: Coupon[] };
type ScanRes = { ok: boolean; found: boolean; barcode: string };

function fmtDay(d: string) { try { return new Date(d + "T00:00:00").toLocaleDateString("el-GR", { weekday: "long", day: "numeric", month: "long" }); } catch { return d; } }
function fmtDayShort(d: string) { try { return new Date(d + "T00:00:00").toLocaleDateString("el-GR", { weekday: "short", day: "numeric", month: "short" }); } catch { return d; } }

export default function PhysicalCheckPage() {
  const t = useT();
  const qc = useQueryClient();
  const { period } = useReimbPeriod();
  const inputRef = useRef<HTMLInputElement>(null);
  const [bc, setBc] = useState("");
  const [dayIdx, setDayIdx] = useState(0);
  const [last, setLast] = useState<{ found: boolean; barcode: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const resumed = useRef(false);

  const { data } = useQuery({ queryKey: ["reimb-physical", period], queryFn: () => api<Check>(`/reimbursement/physical?period=${period}`) });
  const byDay = data?.by_day ?? [];

  // resume at the first not-yet-complete day, once
  useEffect(() => {
    if (data && !resumed.current && byDay.length) {
      resumed.current = true;
      const i = byDay.findIndex((d) => d.checked < d.total);
      setDayIdx(i < 0 ? byDay.length - 1 : i);
    }
  }, [data, byDay]);
  useEffect(() => { inputRef.current?.focus(); document.getElementById(`dayrow-${dayIdx}`)?.scrollIntoView({ block: "nearest" }); }, [dayIdx]);

  const scan = useMutation({
    mutationFn: (barcode: string) => api<ScanRes>(`/reimbursement/physical/scan?period=${period}`, { method: "POST", body: JSON.stringify({ barcode }) }),
    onSuccess: (r) => { setLast({ found: r.found, barcode: r.barcode }); qc.invalidateQueries({ queryKey: ["reimb-physical", period] }); },
  });
  const reset = useMutation({
    mutationFn: () => api(`/reimbursement/physical/reset?period=${period}`, { method: "POST" }),
    onSuccess: () => { setLast(null); resumed.current = false; setDayIdx(0); qc.invalidateQueries({ queryKey: ["reimb-physical", period] }); },
  });

  const cur = byDay[dayIdx];
  const dayItems = (data?.items ?? []).filter((i) => i.day === cur?.date).sort((a, b) => (a.checked === b.checked ? b.claim - a.claim : a.checked ? 1 : -1));
  const dayDone = !!cur && cur.checked >= cur.total;
  const monthDone = byDay.length > 0 && byDay.every((d) => d.checked >= d.total);
  const daysComplete = byDay.filter((d) => d.checked >= d.total).length;

  function submit() {
    const v = bc.trim();
    if (!v) return;
    scan.mutate(v);
    setBc("");
    inputRef.current?.focus();
  }
  async function nextDay() {
    if (!dayDone && cur && cur.total - cur.checked > 0 &&
        !(await appConfirm(t(`Λείπουν ${cur.total - cur.checked} συνταγές από αυτή τη μέρα. Να προχωρήσεις; (θα μείνουν εκκρεμείς)`, `${cur.total - cur.checked} prescriptions missing from this day. Proceed anyway?`)))) return;
    setDayIdx((i) => Math.min(i + 1, byDay.length - 1));
  }
  async function openDetail(barcode: string) {
    setDetail({ found: false } as Detail);
    try { const d = await api<Detail>(`/reimbursement/prescription?barcode=${encodeURIComponent(barcode)}`); setDetail(d.found ? d : null); }
    catch { setDetail(null); }
  }

  const cols: Column<Item>[] = [
    { key: "checked", header: "", render: (r) => r.checked ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300" /> },
    { key: "barcode", header: "Barcode", render: (r) => <button onClick={() => openDetail(r.barcode)} className={`font-mono text-xs hover:text-emerald-600 hover:underline ${r.checked ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-200"}`}>{r.barcode}</button> },
    { key: "fund", header: t("Ταμείο", "Fund"), hideOnMobile: true, render: (r) => r.fund },
    { key: "claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => fmtEur(r.claim) },
  ];

  if (monthDone) return (
    <div className="space-y-4 py-10 text-center">
      <PartyPopper className="mx-auto h-12 w-12 text-emerald-500" />
      <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Ο μήνας ολοκληρώθηκε! 🎉", "Month complete! 🎉")}</h2>
      <p className="text-sm text-slate-500">{t(`Όλες οι ${data?.total ?? 0} συνταγές ελέγχθηκαν σε ${byDay.length} ημέρες.`, `All ${data?.total ?? 0} prescriptions checked across ${byDay.length} days.`)}</p>
      {!!data?.extra.length && <p className="text-sm text-rose-600">{t(`Προσοχή: ${data.extra.length} σκαναρίστηκαν εκτός λίστας.`, `Note: ${data.extra.length} scanned not in data.`)}</p>}
      <button onClick={async () => { if (await appConfirm(t("Μηδενισμός ελέγχου;", "Reset check?"), { danger: true })) reset.mutate(); }} className="mx-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-4 w-4" /> {t("Νέος έλεγχος", "New check")}</button>
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* month progress */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" /> {t("Ημέρες ολοκληρωμένες", "Days complete")}: <b className="text-slate-700 dark:text-slate-200">{daysComplete}/{byDay.length}</b></span>
        <button onClick={async () => { if (await appConfirm(t("Μηδενισμός ελέγχου;", "Reset check?"), { danger: true })) reset.mutate(); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-3 w-3" /> {t("Μηδενισμός", "Reset")}</button>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${byDay.length ? (daysComplete / byDay.length) * 100 : 0}%` }} /></div>

      {/* days overview — count + status per day */}
      <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
        {byDay.map((d, i) => {
          const done = d.checked >= d.total;
          const isCur = i === dayIdx;
          return (
            <button id={`dayrow-${i}`} key={d.date} onClick={() => setDayIdx(i)}
              className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-xs last:border-0 dark:border-slate-800 ${isCur ? "bg-emerald-50 ring-1 ring-inset ring-emerald-300 dark:bg-emerald-950/30" : "hover:bg-slate-50 dark:hover:bg-slate-800/50"}`}>
              {done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : isCur ? <ArrowRight className="h-4 w-4 shrink-0 text-emerald-600" /> : <span className="h-4 w-4 shrink-0 rounded-full border-2 border-slate-300" />}
              <span className={`flex-1 capitalize ${isCur ? "font-semibold text-slate-800 dark:text-slate-100" : done ? "text-slate-400 line-through" : "text-slate-600 dark:text-slate-300"}`}>
                {fmtDayShort(d.date)}
                {isCur && <span className="ml-1.5 font-medium text-emerald-600">← {t("τώρα εδώ", "now here")}</span>}
                {done && !isCur && <span className="ml-1.5 text-emerald-500">✓ {t("ολοκληρώθηκε", "done")}</span>}
              </span>
              <span className={`shrink-0 tabular-nums font-medium ${done ? "text-emerald-600" : "text-slate-500 dark:text-slate-400"}`}>{d.checked}/{d.total}</span>
            </button>
          );
        })}
      </div>

      {/* current day card */}
      <div className={`rounded-2xl border-2 p-5 ${dayDone ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
        <div className="flex items-center justify-between">
          <button onClick={() => setDayIdx((i) => Math.max(0, i - 1))} disabled={dayIdx === 0} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800 sm:h-8 sm:w-8"><ChevronLeft className="h-5 w-5" /></button>
          <div className="text-center">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{t("Ημέρα", "Day")} {dayIdx + 1}/{byDay.length}</div>
            <div className="text-lg font-bold capitalize text-slate-900 dark:text-slate-100">{cur ? fmtDay(cur.date) : "—"}</div>
          </div>
          <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800 sm:h-8 sm:w-8"><ChevronRight className="h-5 w-5" /></button>
        </div>

        {/* day progress */}
        <div className="mt-3 flex items-center justify-center gap-2 text-sm">
          <span className={`text-2xl font-extrabold ${dayDone ? "text-emerald-600" : "text-slate-900 dark:text-slate-100"}`}>{cur?.checked ?? 0}</span>
          <span className="text-slate-400">/ {cur?.total ?? 0} {t("συνταγές σκαναρισμένες", "prescriptions scanned")}</span>
        </div>

        {dayDone ? (
          <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="mt-4 w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            ✓ {t("Ολοκληρώθηκε — Επόμενη ημέρα", "Done — Next day")} →
          </button>
        ) : (
          <>
            <p className="mt-3 mb-2 text-center text-xs text-slate-500"><ScanBarcode className="mr-1 inline h-4 w-4 text-emerald-600" /> {t("Σκάναρε τις συνταγές αυτής της ημέρας", "Scan this day's prescriptions")}</p>
            <div className="flex gap-2">
              <input ref={inputRef} autoFocus value={bc} onChange={(e) => setBc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                placeholder={t("Barcode συνταγής…", "Prescription barcode…")} inputMode="numeric"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800" />
              <button onClick={submit} className="rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">{t("Έλεγχος", "Check")}</button>
            </div>
            <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="mt-2 w-full text-center text-xs text-slate-400 hover:text-slate-600">{t("Παράλειψη ημέρας (εκκρεμεί)", "Skip day (leave pending)")} →</button>
          </>
        )}

        {last && (
          <div className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${last.found ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
            {last.found ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            <span className="font-mono">{last.barcode}</span> — {last.found ? t("βρέθηκε ✓", "found ✓") : t("ΔΕΝ υπάρχει στα δεδομένα!", "NOT in our data!")}
          </div>
        )}
      </div>

      {/* this day's prescriptions */}
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Συνταγές ημέρας", "Day's prescriptions")} ({dayItems.length})</h3>
      <DataTable pageSize={50} columns={cols} rows={dayItems} rowKey={(r) => r.barcode} empty={t("Καμία συνταγή.", "No prescriptions.")} />

      {/* extras (scanned but not in data) */}
      {!!data?.extra.length && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/50 dark:bg-rose-950/40">
          <div className="mb-1 text-sm font-semibold text-rose-700 dark:text-rose-300">{t("Σκαναρίστηκαν αλλά ΔΕΝ υπάρχουν στα δεδομένα μας:", "Scanned but NOT in our data:")}</div>
          <div className="flex flex-wrap gap-1.5">{data.extra.map((b) => <span key={b} className="rounded bg-white px-2 py-0.5 font-mono text-xs text-rose-700 dark:bg-slate-900">{b}</span>)}</div>
        </div>
      )}

      {/* advanced detail modal */}
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
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {detail.has_opinion === true && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700"><FileText className="h-3 w-3" /> {t("Απαιτεί γνωμάτευση (συνταγή)", "Requires opinion (prescription)")}</span>}
                  {detail.has_opinion === false && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600"><FileText className="h-3 w-3" /> {t("Χωρίς γνωμάτευση", "No opinion needed")}</span>}
                  {detail.is_fyk && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">ΦΥΚ</span>}
                  {detail.has_vaccine && <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700"><Syringe className="h-3 w-3" /> {t("Εμβόλιο", "Vaccine")}</span>}
                  {detail.has_narcotic && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700"><ShieldAlert className="h-3 w-3" /> {t("Ναρκωτικό", "Narcotic")}</span>}
                  {detail.partial && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{t("Μερική εκτέλεση", "Partial")}</span>}
                </div>
                {detail.coupons.some((c) => c.qr !== null) && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {detail.coupons.filter((c) => c.qr === true).length > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> {detail.coupons.filter((c) => c.qr === true).length} QR {t("αυτόματα", "auto")}</span>}
                    {detail.coupons.filter((c) => c.qr === false).length > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700"><AlertTriangle className="h-3.5 w-3.5" /> {detail.coupons.filter((c) => c.qr === false).length} {t("ταινίες προς έλεγχο", "strips to check")}</span>}
                  </div>
                )}
                <div className="space-y-1.5">
                  {detail.coupons.map((c, i) => {
                    const strip = c.qr === false;
                    return (
                      <div key={i} className={`flex items-start gap-2 rounded-lg border p-2.5 ${
                        c.qr === true ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20"
                          : strip ? "border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30"
                            : "border-slate-200 dark:border-slate-700"}`}>
                        {c.qr === true ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                          : strip ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                            : <Pill className={`mt-0.5 h-4 w-4 shrink-0 ${c.category === "fyk" ? "text-orange-500" : c.category === "vaccine" ? "text-sky-500" : c.category === "narcotic" ? "text-rose-500" : "text-slate-400"}`} />}
                        <div className="min-w-0 flex-1">
                          <div className={`text-xs ${strip ? "font-semibold text-slate-800 dark:text-slate-100" : "font-medium text-slate-700 dark:text-slate-200"}`}>{c.name} {c.quantity > 1 && <span className="text-slate-400">×{c.quantity}</span>}</div>
                          {c.qr === true && (
                            <div className="mt-0.5 text-[11px] font-semibold text-emerald-600">✓ QR — {t("δεν χρειάζεται έλεγχος", "no check needed")}{c.qr_batch ? ` · batch ${c.qr_batch}` : ""}{c.qr_expiry ? ` · ${t("λήξη", "exp")} ${c.qr_expiry}` : ""}</div>
                          )}
                          {strip && (
                            <div className="mt-1">
                              <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700">⚠ {t("Ταινία γνησιότητας — έλεγξέ το", "Authenticity strip — check it")}</div>
                              {c.lot && <div className="mt-0.5 font-mono text-lg font-extrabold tracking-wider text-slate-900 dark:text-slate-100">{c.lot}</div>}
                            </div>
                          )}
                          {c.qr === null && c.barcode && <div className="font-mono text-[10px] text-slate-400">{c.barcode}</div>}
                          {!c.executed && <div className="text-[10px] text-rose-500">{t("ανεκτέλεστο", "unexecuted")}</div>}
                        </div>
                      </div>
                    );
                  })}
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
