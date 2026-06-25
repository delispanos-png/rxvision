"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Plus, Trash2, Copy, Calendar, AlertTriangle, Moon, Sun, Upload, CheckCircle2, XCircle } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";

type Interval = { start: string; end: string };
type Day = { day: number; status: string; intervals: Interval[] };
type Sched = { timezone: string; week: Day[] };
type Duty = { _id: string; date: string; start: string; end: string; overnight: boolean; kind: string; note?: string | null };
type Exc = { _id: string; date: string; type: string; label?: string | null; note?: string | null };
type Status = { isOpen: boolean; isOnDuty: boolean; isOvernightDuty: boolean; closingSoon: boolean; statusText: string; nextOpening?: string | null; nextClosing?: string | null };

const DAYS = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο", "Κυριακή"];
const STATUS_OPTS = [["closed", "Κλειστό"], ["continuous", "Συνεχές"], ["split", "Σπαστό"], ["custom", "Προσαρμοσμένο"]] as const;
const EXC_TYPES = [["holiday", "Αργία"], ["local_holiday", "Τοπική αργία"], ["vacation", "Διακοπές"], ["inventory", "Απογραφή"], ["renovation", "Ανακαίνιση"], ["emergency_close", "Έκτακτο κλείσιμο"], ["custom", "Έκτακτη αλλαγή ωραρίου"]] as const;

function defaultsFor(status: string, cur: Interval[]): Interval[] {
  if (status === "closed") return [];
  if (status === "continuous") return cur.length ? cur : [{ start: "08:00", end: "21:00" }];
  if (status === "split") return cur.length >= 2 ? cur : [{ start: "08:00", end: "14:00" }, { start: "17:00", end: "21:00" }];
  return cur.length ? cur : [{ start: "08:00", end: "14:00" }];
}
const TEMPLATES: { name: string; week: Day[] }[] = [
  { name: "Συνεχές (Δευ-Παρ 08-21)", week: [...Array(5)].map((_, i) => ({ day: i, status: "continuous", intervals: [{ start: "08:00", end: "21:00" }] })).concat([{ day: 5, status: "continuous", intervals: [{ start: "08:00", end: "14:00" }] }, { day: 6, status: "closed", intervals: [] }]) },
  { name: "Σπαστό (Δευ-Παρ 08-14 & 17-21)", week: [...Array(5)].map((_, i) => ({ day: i, status: "split", intervals: [{ start: "08:00", end: "14:00" }, { start: "17:00", end: "21:00" }] })).concat([{ day: 5, status: "continuous", intervals: [{ start: "08:00", end: "14:00" }] }, { day: 6, status: "closed", intervals: [] }]) },
  { name: "Μικτό (Δευ/Τετ/Σαβ μισή)", week: [0, 1, 2, 3, 4, 5, 6].map((i) => ([0, 2, 5].includes(i) ? { day: i, status: "continuous", intervals: [{ start: "08:00", end: "14:00" }] } : i === 6 ? { day: i, status: "closed", intervals: [] } : { day: i, status: "split", intervals: [{ start: "08:00", end: "14:00" }, { start: "17:00", end: "21:00" }] })) },
];

export default function AvailabilityPage() {
  const t = useT();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["pa", "status"], queryFn: () => api<Status>("/pharmacy-availability/status"), refetchInterval: 60000, retry: false });
  const sched = useQuery({ queryKey: ["pa", "schedule"], queryFn: () => api<Sched>("/pharmacy-availability/schedule"), retry: false });
  const duties = useQuery({ queryKey: ["pa", "duties"], queryFn: () => api<{ items: Duty[] }>("/pharmacy-availability/duties"), retry: false });
  const excs = useQuery({ queryKey: ["pa", "exceptions"], queryFn: () => api<{ items: Exc[] }>("/pharmacy-availability/exceptions"), retry: false });

  const [week, setWeek] = useState<Day[]>([]);
  const [errs, setErrs] = useState<string[]>([]);
  useEffect(() => { if (sched.data) setWeek(sched.data.week.map((d) => ({ ...d, intervals: d.intervals.map((i) => ({ ...i })) }))); }, [sched.data]);

  const setDayStatus = (day: number, st: string) => setWeek((w) => w.map((d) => d.day === day ? { ...d, status: st, intervals: defaultsFor(st, d.intervals) } : d));
  const setIv = (day: number, idx: number, k: "start" | "end", v: string) => setWeek((w) => w.map((d) => d.day === day ? { ...d, intervals: d.intervals.map((iv, i) => i === idx ? { ...iv, [k]: v } : iv) } : d));
  const addIv = (day: number) => setWeek((w) => w.map((d) => d.day === day ? { ...d, intervals: [...d.intervals, { start: "17:00", end: "21:00" }] } : d));
  const delIv = (day: number, idx: number) => setWeek((w) => w.map((d) => d.day === day ? { ...d, intervals: d.intervals.filter((_, i) => i !== idx) } : d));
  const copyToAll = (day: number) => setWeek((w) => { const src = w.find((d) => d.day === day)!; return w.map((d) => d.day >= 0 && d.day <= 4 ? { ...d, status: src.status, intervals: src.intervals.map((i) => ({ ...i })) } : d); });

  const saveSched = useMutation({
    mutationFn: () => api<{ ok: boolean; errors?: string[] }>("/pharmacy-availability/schedule", { method: "PUT", body: JSON.stringify({ week }) }),
    onSuccess: (r) => { if (r.ok) { setErrs([]); qc.invalidateQueries({ queryKey: ["pa"] }); } else setErrs(r.errors || []); },
    onError: () => setErrs([t("Αποτυχία αποθήκευσης.", "Save failed.")]),
  });

  // duty form
  const [d, setD] = useState({ date: "", start: "08:00", end: "08:00", kind: "duty", note: "" });
  const [dErr, setDErr] = useState<string[]>([]);
  const addDuty = useMutation({
    mutationFn: () => api<{ ok: boolean; errors?: string[] }>("/pharmacy-availability/duties", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: (r) => { if (r.ok) { setDErr([]); setD({ date: "", start: "08:00", end: "08:00", kind: "duty", note: "" }); qc.invalidateQueries({ queryKey: ["pa"] }); } else setDErr(r.errors || []); },
  });
  const delDuty = useMutation({ mutationFn: (id: string) => api("/pharmacy-availability/duties/delete", { method: "POST", body: JSON.stringify({ id }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["pa"] }) });

  // exception form
  const [e, setE] = useState({ date: "", type: "holiday", label: "", note: "" });
  const [eErr, setEErr] = useState<string[]>([]);
  const addExc = useMutation({
    mutationFn: () => api<{ ok: boolean; errors?: string[] }>("/pharmacy-availability/exceptions", { method: "POST", body: JSON.stringify(e) }),
    onSuccess: (r) => { if (r.ok) { setEErr([]); setE({ date: "", type: "holiday", label: "", note: "" }); qc.invalidateQueries({ queryKey: ["pa"] }); } else setEErr(r.errors || []); },
  });
  const delExc = useMutation({ mutationFn: (id: string) => api("/pharmacy-availability/exceptions/delete", { method: "POST", body: JSON.stringify({ id }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["pa"] }) });

  // import
  const [impText, setImpText] = useState("");
  const [preview, setPreview] = useState<{ preview: Duty[]; errors: string[]; count: number; saved?: number } | null>(null);
  const doImport = useMutation({
    mutationFn: (commit: boolean) => api<{ preview: Duty[]; errors: string[]; count: number; saved: number }>("/pharmacy-availability/import", { method: "POST", body: JSON.stringify({ text: impText, commit }) }),
    onSuccess: (r, commit) => { setPreview(r); if (commit) { setImpText(""); qc.invalidateQueries({ queryKey: ["pa"] }); } },
  });

  const s = status.data;
  const statusColor = s?.isOnDuty ? (s.isOvernightDuty ? "bg-indigo-600" : "bg-violet-600") : s?.isOpen ? (s.closingSoon ? "bg-amber-500" : "bg-emerald-600") : "bg-slate-500";

  return (
    <div className="space-y-5">
      {/* LIVE STATUS */}
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-4 text-white ${statusColor}`}>
        <div className="flex items-center gap-3">
          {s?.isOvernightDuty ? <Moon className="h-6 w-6" /> : s?.isOpen ? <Sun className="h-6 w-6" /> : <Clock className="h-6 w-6" />}
          <div>
            <div className="text-xs uppercase tracking-wide opacity-80">{t("Κατάσταση φαρμακείου τώρα", "Pharmacy status now")}</div>
            <div className="text-lg font-extrabold">{s?.statusText || "…"}</div>
          </div>
        </div>
        <div className="text-right text-xs opacity-90">
          {s?.isOnDuty && <div className="rounded-full bg-white/20 px-2 py-0.5 font-semibold">{s.isOvernightDuty ? t("Διανυκτέρευση", "Overnight duty") : t("Εφημερία", "On duty")}</div>}
        </div>
      </div>

      {/* WEEKLY SCHEDULE */}
      <PanelCard title={t("Εβδομαδιαίο ωράριο", "Weekly schedule")}>
        <div className="mb-3 flex flex-wrap gap-2">
          {TEMPLATES.map((tp) => (
            <button key={tp.name} onClick={() => setWeek(tp.week.map((dd) => ({ ...dd, intervals: dd.intervals.map((i) => ({ ...i })) })))} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">📋 {tp.name}</button>
          ))}
        </div>
        <div className="space-y-2">
          {week.map((day) => (
            <div key={day.day} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-sm font-semibold text-slate-700 dark:text-slate-200">{DAYS[day.day]}</span>
                <select value={day.status} onChange={(ev) => setDayStatus(day.day, ev.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800">
                  {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {day.status !== "closed" && day.intervals.map((iv, idx) => (
                  <span key={idx} className="inline-flex items-center gap-1">
                    <input type="time" value={iv.start} onChange={(ev) => setIv(day.day, idx, "start", ev.target.value)} className="rounded border border-slate-300 px-1.5 py-1 text-sm dark:border-slate-600 dark:bg-slate-800" />
                    <span className="text-slate-400">–</span>
                    <input type="time" value={iv.end} onChange={(ev) => setIv(day.day, idx, "end", ev.target.value)} className="rounded border border-slate-300 px-1.5 py-1 text-sm dark:border-slate-600 dark:bg-slate-800" />
                    <button onClick={() => delIv(day.day, idx)} className="text-slate-300 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
                  </span>
                ))}
                {day.status !== "closed" && <button onClick={() => addIv(day.day)} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-600"><Plus className="h-3 w-3" /> {t("διάστημα", "interval")}</button>}
                {day.day <= 4 && <button onClick={() => copyToAll(day.day)} title={t("Αντιγραφή σε Δευτέρα-Παρασκευή", "Copy to Mon-Fri")} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"><Copy className="h-3 w-3" /> {t("σε Δευ-Παρ", "to Mon-Fri")}</button>}
              </div>
            </div>
          ))}
        </div>
        {errs.length > 0 && <div className="mt-3 space-y-1 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{errs.map((x, i) => <div key={i}>⚠ {x}</div>)}</div>}
        <button onClick={() => saveSched.mutate()} disabled={saveSched.isPending} className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saveSched.isPending ? t("Αποθήκευση…", "Saving…") : t("Αποθήκευση ωραρίου", "Save schedule")}</button>
      </PanelCard>

      {/* DUTIES */}
      <PanelCard title={t("Εφημερίες & διανυκτερεύσεις", "On-duty & overnight")}>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div><label className="mb-1 block text-xs text-slate-500">{t("Ημερομηνία", "Date")}</label><input type="date" value={d.date} onChange={(ev) => setD({ ...d, date: ev.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></div>
          <div><label className="mb-1 block text-xs text-slate-500">{t("Έναρξη", "Start")}</label><input type="time" value={d.start} onChange={(ev) => setD({ ...d, start: ev.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></div>
          <div><label className="mb-1 block text-xs text-slate-500">{t("Λήξη", "End")}</label><input type="time" value={d.end} onChange={(ev) => setD({ ...d, end: ev.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></div>
          <div><label className="mb-1 block text-xs text-slate-500">{t("Τύπος", "Type")}</label><select value={d.kind} onChange={(ev) => setD({ ...d, kind: ev.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"><option value="duty">{t("Απλή εφημερία", "Duty")}</option><option value="overnight">{t("Διανυκτέρευση", "Overnight")}</option></select></div>
          <div className="flex-1 min-w-[120px]"><label className="mb-1 block text-xs text-slate-500">{t("Σημείωση", "Note")}</label><input value={d.note} onChange={(ev) => setD({ ...d, note: ev.target.value })} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></div>
          <button onClick={() => addDuty.mutate()} disabled={!d.date || addDuty.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Plus className="h-4 w-4" /> {t("Προσθήκη", "Add")}</button>
        </div>
        {dErr.length > 0 && <div className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{dErr.map((x, i) => <div key={i}>⚠ {x}</div>)}</div>}
        <div className="space-y-1.5">
          {(duties.data?.items ?? []).map((du) => (
            <div key={du._id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
              <span className="inline-flex items-center gap-2">
                {du.kind === "overnight" ? <Moon className="h-4 w-4 text-indigo-500" /> : <Clock className="h-4 w-4 text-violet-500" />}
                <b>{du.date.split("-").reverse().join("/")}</b> · {du.start}–{du.end}{du.overnight && <span className="text-xs text-indigo-500"> {t("(επόμενη μέρα)", "(next day)")}</span>}
                {du.note && <span className="text-xs text-slate-400">· {du.note}</span>}
              </span>
              <button onClick={() => delDuty.mutate(du._id)} className="text-slate-300 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          {(duties.data?.items ?? []).length === 0 && <div className="py-3 text-center text-sm text-slate-400">{t("Καμία εφημερία.", "No duties.")}</div>}
        </div>

        {/* bulk import */}
        <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-600">
          <div className="mb-1 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200"><Upload className="h-4 w-4 text-brand-600" /> {t("Μαζική εισαγωγή εφημεριών", "Bulk import duties")}</div>
          <p className="mb-2 text-xs text-slate-400">{t("Επικόλλησε κείμενο/CSV/Excel (π.χ. «10/01/2027 08:00 - 08:00 διανυκτέρευση»). Γίνεται preview πριν την αποθήκευση.", "Paste text/CSV/Excel. Preview before saving.")}</p>
          <textarea value={impText} onChange={(ev) => { setImpText(ev.target.value); setPreview(null); }} rows={3} placeholder={"10/01/2027 08:00 - 08:00 διανυκτέρευση\n15/02/2027 14:00 21:00"} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800" />
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => doImport.mutate(false)} disabled={!impText.trim() || doImport.isPending} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300">{t("Προεπισκόπηση", "Preview")}</button>
            {preview && preview.count > 0 && <button onClick={() => doImport.mutate(true)} disabled={doImport.isPending} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{t(`Αποθήκευση ${preview.count}`, `Save ${preview.count}`)}</button>}
          </div>
          {preview && (
            <div className="mt-2 space-y-1 text-xs">
              {preview.saved ? <div className="font-semibold text-emerald-600">✓ {t(`Αποθηκεύτηκαν ${preview.saved}`, `Saved ${preview.saved}`)}</div> : null}
              {preview.preview.map((p, i) => <div key={i} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 dark:bg-slate-800"><CheckCircle2 className="h-3 w-3 text-emerald-500" /> {p.date.split("-").reverse().join("/")} {p.start}–{p.end} {p.kind === "overnight" ? "🌙" : ""}</div>)}
              {preview.errors.map((er, i) => <div key={i} className="text-rose-600"><XCircle className="mr-1 inline h-3 w-3" />{er}</div>)}
            </div>
          )}
        </div>
      </PanelCard>

      {/* EXCEPTIONS */}
      <PanelCard title={t("Εξαιρέσεις & ειδικές ημέρες", "Exceptions & special days")}>
        <p className="mb-2 text-xs text-slate-400">{t("Υπερισχύουν του εβδομαδιαίου ωραρίου για τη συγκεκριμένη ημερομηνία.", "Override the weekly schedule for that date.")}</p>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div><label className="mb-1 block text-xs text-slate-500">{t("Ημερομηνία", "Date")}</label><input type="date" value={e.date} onChange={(ev) => setE({ ...e, date: ev.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></div>
          <div><label className="mb-1 block text-xs text-slate-500">{t("Τύπος", "Type")}</label><select value={e.type} onChange={(ev) => setE({ ...e, type: ev.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">{EXC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="flex-1 min-w-[120px]"><label className="mb-1 block text-xs text-slate-500">{t("Περιγραφή", "Label")}</label><input value={e.label} onChange={(ev) => setE({ ...e, label: ev.target.value })} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" /></div>
          <button onClick={() => addExc.mutate()} disabled={!e.date || addExc.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"><Plus className="h-4 w-4" /> {t("Προσθήκη", "Add")}</button>
        </div>
        {eErr.length > 0 && <div className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{eErr.map((x, i) => <div key={i}>⚠ {x}</div>)}</div>}
        <div className="space-y-1.5">
          {(excs.data?.items ?? []).map((ex) => (
            <div key={ex._id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
              <span className="inline-flex items-center gap-2"><Calendar className="h-4 w-4 text-amber-500" /> <b>{ex.date.split("-").reverse().join("/")}</b> · {EXC_TYPES.find(([v]) => v === ex.type)?.[1] || ex.type}{ex.label && <span className="text-xs text-slate-400">· {ex.label}</span>}</span>
              <button onClick={() => delExc.mutate(ex._id)} className="text-slate-300 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          {(excs.data?.items ?? []).length === 0 && <div className="py-3 text-center text-sm text-slate-400">{t("Καμία εξαίρεση.", "No exceptions.")}</div>}
        </div>
      </PanelCard>

      <p className="flex items-center gap-1.5 text-xs text-slate-400"><AlertTriangle className="h-3.5 w-3.5" /> {t("Όλες οι ώρες σε τοπική ώρα Ελλάδας (Europe/Athens). Οι εξαιρέσεις υπερισχύουν του εβδομαδιαίου ωραρίου.", "All times in Greek local time. Exceptions override the weekly schedule.")}</p>
    </div>
  );
}
