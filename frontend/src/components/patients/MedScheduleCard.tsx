"use client";

// Ο ΦΑΡΜΑΚΟΠΟΙΟΣ ρυθμίζει το πρόγραμμα λήψης του ασθενή (ίδια λογική με την πύλη πελατών):
// ενεργοποίηση υπενθύμισης ανά αγωγή + ώρα λήψης (24ωρο) ή «κάθε X ώρες» + σχέση με γεύμα.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pill, Clock, AlertTriangle, X } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";

type Therapy = { med_key: string; name: string; dosage_text: string | null; per_day: number; days_left: number | null; enabled: boolean; time?: string | null; meal?: string | null; interval_hours?: number | null; plan_summary?: string | null; override?: { by?: string; reason?: string; at?: string; doctor_text?: string } | null };
type Phase = { days: number; qty: number; per_day: number; times: string[] };
type Ovr = { med_key: string; name: string; doctor_text: string | null; kind: "custom" | "composite"; per_day: number; phases: Phase[]; maintenance_qty: number; reason: string };
type Sched = { therapies: Therapy[] };
type Cfg = { med_key: string; time: string; meal: string; mode: "time" | "interval"; interval: number; per_day: number };

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINS = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];

export function MedScheduleCard({ patientId }: { patientId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["patient-med-schedule", patientId], queryFn: () => api<Sched>(`/patients/${encodeURIComponent(patientId)}/med-schedule`) });
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [ovr, setOvr] = useState<Ovr | null>(null);          // ΕΞΑΙΡΕΤΙΚΗ αλλαγή οδηγίας γιατρού
  const [ovrErr, setOvrErr] = useState<string | null>(null);
  const key = ["patient-med-schedule", patientId];

  const reminder = useMutation({
    mutationFn: (b: { med_key: string; enabled: boolean; time?: string | null; meal?: string | null; interval_hours?: number | null }) =>
      api(`/patients/${encodeURIComponent(patientId)}/med-reminder`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  function toggle(th: Therapy) {
    const enabled = !th.enabled;
    reminder.mutate({ med_key: th.med_key, enabled });
    if (enabled) {
      const pd = th.per_day || 1;
      setCfg({ med_key: th.med_key, time: th.time || "08:00", meal: th.meal || "none", mode: th.interval_hours ? "interval" : "time", interval: th.interval_hours || Math.max(1, Math.round(24 / pd)), per_day: pd });
    } else if (cfg?.med_key === th.med_key) setCfg(null);
  }
  function edit(th: Therapy) {
    const pd = th.per_day || 1;
    setCfg({ med_key: th.med_key, time: th.time || "08:00", meal: th.meal || "none", mode: th.interval_hours ? "interval" : "time", interval: th.interval_hours || Math.max(1, Math.round(24 / pd)), per_day: pd });
  }
  const plan = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      api(`/patients/${encodeURIComponent(patientId)}/med-plan`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setOvr(null); setOvrErr(null); },
    onError: () => setOvrErr(t("Δεν αποθηκεύτηκε — έλεγξε την αιτιολόγηση.", "Not saved — check the justification.")),
  });

  function save() {
    if (!cfg) return;
    reminder.mutate({ med_key: cfg.med_key, enabled: true, time: cfg.time || null, meal: cfg.meal, interval_hours: cfg.mode === "interval" ? cfg.interval : 0 });
    setCfg(null);
  }

  const ths = data?.therapies ?? [];
  const TimePicker = ({ label }: { label: string }) => cfg ? (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <div className="flex items-center gap-1.5">
        <select value={cfg.time.split(":")[0]} onChange={(e) => setCfg({ ...cfg, time: `${e.target.value}:${cfg.time.split(":")[1] || "00"}` })} className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">{HOURS.map((h) => <option key={h} value={h}>{h}</option>)}</select>
        <span className="font-bold text-slate-400">:</span>
        <select value={cfg.time.split(":")[1] || "00"} onChange={(e) => setCfg({ ...cfg, time: `${cfg.time.split(":")[0]}:${e.target.value}` })} className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">{MINS.map((m) => <option key={m} value={m}>{m}</option>)}</select>
      </div>
    </div>
  ) : null;

  return (
    <PanelCard title={t("Πρόγραμμα λήψης φαρμάκων", "Medication schedule")}>
      <p className="mb-2 text-xs text-slate-500">{t("Ενεργοποίησε ποιες αγωγές θα υπενθυμίζονται στον ασθενή & όρισε ώρα/συχνότητα. Εμφανίζεται στην πύλη πελατών.", "Enable which therapies remind the patient & set time/frequency. Shown in the customer portal.")}</p>
      {ths.length === 0 && <p className="text-sm text-slate-400">{t("Δεν βρέθηκαν ενεργές αγωγές.", "No active therapies.")}</p>}
      <div className="space-y-2">
        {ths.map((th) => (
          <div key={th.med_key} className={`rounded-xl border p-3 ${th.enabled ? "border-violet-200 dark:border-violet-900" : "border-slate-200 dark:border-slate-700"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{th.name}</div>
                {th.override ? (
                  <>
                    <div className="mt-0.5 text-xs text-slate-400 line-through">{th.override.doctor_text || th.dosage_text}</div>
                    <div className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 dark:border-amber-800 dark:bg-amber-950/30">
                      <div className="flex items-center gap-1 text-[11px] font-bold text-amber-800 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" /> {t("Αλλαγή από φαρμακοποιό", "Changed by pharmacist")}
                      </div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {th.plan_summary || t(`${th.per_day} λήψη/ημέρα`, `${th.per_day}×/day`)}
                      </div>
                      {th.override.reason && <div className="mt-0.5 text-[11px] italic text-amber-800 dark:text-amber-300">«{th.override.reason}»</div>}
                    </div>
                  </>
                ) : th.dosage_text ? <div className="mt-0.5 text-xs text-slate-500">{th.dosage_text}</div> : null}
                {th.enabled && cfg?.med_key !== th.med_key && (
                  <button onClick={() => edit(th)} className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-100 dark:bg-violet-950/40 dark:text-violet-300">
                    <Clock className="h-3 w-3" /> {th.interval_hours ? `κάθε ${th.interval_hours}ω` : (th.time || "—")}{th.meal === "before" ? " · πριν" : th.meal === "after" ? " · μετά" : ""} · {t("αλλαγή", "edit")}
                  </button>
                )}
                {/* ΕΞΑΙΡΕΤΙΚΗ αλλαγή της οδηγίας του γιατρού — ξεχωριστό, διακριτικό, με αιτιολόγηση */}
                {ovr?.med_key !== th.med_key && (
                  <button onClick={() => setOvr({ med_key: th.med_key, name: th.name, doctor_text: th.override?.doctor_text || th.dosage_text,
                      kind: "custom", per_day: th.per_day || 1,
                      phases: [{ days: 2, qty: 1, per_day: 3, times: ["08:00", "14:00", "20:00"] }],
                      maintenance_qty: 1, reason: "" })}
                    className="ml-1 mt-1 inline-flex items-center gap-1 rounded-lg border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" /> {th.override ? t("Αλλαγή/επαναφορά", "Change/revert") : t("Αλλαγή δοσολογίας", "Change dosage")}
                  </button>
                )}
              </div>
              <button onClick={() => toggle(th)} className={`relative h-6 w-11 shrink-0 rounded-full transition ${th.enabled ? "bg-violet-600" : "bg-slate-300 dark:bg-slate-600"}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${th.enabled ? "left-[1.45rem]" : "left-0.5"}`} />
              </button>
            </div>
            {ovr?.med_key === th.med_key && (
              <div className="mt-2 space-y-2 rounded-lg border-2 border-amber-300 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-950/20">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[11px] font-bold text-amber-900 dark:text-amber-300">
                    ⚠️ {t("Αλλαγή οδηγίας γιατρού — μόνο σε εξαιρετικές περιπτώσεις", "Changing the doctor's instruction — exceptional cases only")}
                  </div>
                  <button onClick={() => { setOvr(null); setOvrErr(null); }} className="shrink-0 text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
                </div>
                {ovr.doctor_text && <div className="rounded bg-white px-2 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t("Ο γιατρός έγραψε", "The doctor prescribed")}: <b>{ovr.doctor_text}</b></div>}

                <div className="flex gap-1.5">
                  {([["custom", t("Απλή δοσολογία", "Simple dosage")], ["composite", t("Σύνθετη", "Composite")]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setOvr({ ...ovr, kind: k })}
                      className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${ovr.kind === k ? "border-amber-500 bg-amber-500 text-white" : "border-slate-200 bg-white text-slate-600 dark:border-slate-600 dark:bg-slate-800"}`}>{l}</button>
                  ))}
                </div>

                {ovr.kind === "custom" ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-600 dark:text-slate-300">{t("Λήψεις ανά ημέρα", "Intakes per day")}</span>
                    <select value={ovr.per_day} onChange={(e) => setOvr({ ...ovr, per_day: +e.target.value })}
                      className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
                      {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {ovr.phases.map((ph, i) => {
                      const setPh = (patch: Partial<Phase>) => { const ps = [...ovr.phases]; ps[i] = { ...ph, ...patch }; setOvr({ ...ovr, phases: ps }); };
                      const setTimes = (n: number) => {
                        const def = ["08:00", "14:00", "20:00", "23:00", "11:00", "17:00"];
                        const tms = Array.from({ length: n }, (_, j) => ph.times[j] ?? def[j] ?? "08:00");
                        setPh({ per_day: n, times: tms });
                      };
                      return (
                        <div key={i} className="rounded-lg border border-amber-200 bg-white p-2 dark:border-amber-900 dark:bg-slate-800">
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="shrink-0 font-semibold text-slate-500">{t("Φάση", "Phase")} {i + 1}</span>
                            <input type="number" min={0} step={0.5} value={ph.qty} title={t("ποσότητα ανά λήψη", "amount per intake")}
                              onChange={(e) => setPh({ qty: parseFloat(e.target.value) || 0 })}
                              className="w-12 rounded border border-slate-300 px-1 py-1 text-center dark:border-slate-600 dark:bg-slate-900" />
                            <span className="text-slate-500">×</span>
                            <select value={ph.per_day} onChange={(e) => setTimes(+e.target.value)}
                              className="rounded border border-slate-300 px-1 py-1 dark:border-slate-600 dark:bg-slate-900">
                              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                            </select>
                            <span className="text-slate-500">{t("/ημέρα, για", "/day, for")}</span>
                            <input type="number" min={1} value={ph.days}
                              onChange={(e) => setPh({ days: parseInt(e.target.value) || 1 })}
                              className="w-12 rounded border border-slate-300 px-1 py-1 text-center dark:border-slate-600 dark:bg-slate-900" />
                            <span className="text-slate-500">{t("ημ.", "days")}</span>
                            <button onClick={() => setOvr({ ...ovr, phases: ovr.phases.filter((_, j) => j !== i) })}
                              className="ml-auto shrink-0 text-slate-400 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-slate-500">⏰ {t("ώρες:", "times:")}</span>
                            {Array.from({ length: ph.per_day }, (_, j) => (
                              <input key={j} type="time" value={ph.times[j] ?? "08:00"}
                                onChange={(e) => { const tms = [...ph.times]; tms[j] = e.target.value; setPh({ times: tms }); }}
                                className="rounded border border-slate-300 px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900" />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => setOvr({ ...ovr, phases: [...ovr.phases, { days: 2, qty: 1, per_day: 1, times: ["08:00"] }] })}
                        className="rounded border border-dashed border-slate-300 px-2 py-1 text-[11px] text-slate-600 dark:border-slate-600 dark:text-slate-300">+ {t("φάση", "phase")}</button>
                      <span className="text-[11px] text-slate-600 dark:text-slate-300">{t("μετά μόνιμα", "then permanently")}</span>
                      <input type="number" min={0} step={0.5} value={ovr.maintenance_qty}
                        onChange={(e) => setOvr({ ...ovr, maintenance_qty: parseFloat(e.target.value) || 0 })}
                        className="w-14 rounded border border-slate-300 px-1.5 py-1 text-center text-[11px] dark:border-slate-600 dark:bg-slate-800" />
                      {ovr.maintenance_qty === 0 && <span className="text-[10px] text-amber-700">{t("→ διακοπή", "→ stop")}</span>}
                    </div>
                  </div>
                )}

                <div>
                  <div className="mb-1 text-[11px] font-semibold text-amber-900 dark:text-amber-300">
                    {t("Αιτιολόγηση (υποχρεωτική)", "Justification (required)")} *
                  </div>
                  <textarea value={ovr.reason} onChange={(e) => setOvr({ ...ovr, reason: e.target.value })} rows={2}
                    placeholder={t("π.χ. Κατόπιν συνεννόησης με τον θεράποντα ιατρό, λόγω…", "e.g. In agreement with the treating physician, due to…")}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800" />
                  <p className="mt-1 text-[10px] text-slate-500">{t("Καταγράφεται ποιος έκανε την αλλαγή και πότε. Η αρχική οδηγία του γιατρού δεν σβήνεται.", "Who changed it and when is recorded. The doctor's original instruction is never deleted.")}</p>
                </div>
                {ovrErr && <div className="text-[11px] font-semibold text-rose-600">{ovrErr}</div>}
                <div className="flex flex-wrap justify-end gap-2">
                  {th.override && (
                    <button onClick={() => plan.mutate({ med_key: ovr.med_key, kind: "none" })}
                      className="mr-auto rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-white dark:border-slate-600 dark:text-slate-300">
                      {t("Επαναφορά οδηγίας γιατρού", "Revert to doctor's instruction")}
                    </button>
                  )}
                  <button onClick={() => { setOvr(null); setOvrErr(null); }} className="px-2 py-1 text-[11px] text-slate-400">{t("Άκυρο", "Cancel")}</button>
                  <button disabled={!ovr.reason.trim() || plan.isPending}
                    onClick={() => plan.mutate(ovr.kind === "custom"
                      ? { med_key: ovr.med_key, kind: "custom", per_day: ovr.per_day, reason: ovr.reason }
                      : { med_key: ovr.med_key, kind: "composite", phases: ovr.phases, maintenance_qty: ovr.maintenance_qty, reason: ovr.reason })}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-amber-700 disabled:opacity-40">
                    {t("Αποθήκευση αλλαγής", "Save change")}
                  </button>
                </div>
              </div>
            )}
            {cfg?.med_key === th.med_key && (
              <div className="mt-2 space-y-2 rounded-lg border border-violet-200 bg-violet-50/50 p-2.5 dark:border-violet-900 dark:bg-violet-950/20">
                {cfg.per_day > 1 && (
                  <>
                    <div className="text-[11px] font-medium text-violet-700 dark:text-violet-300">💊 {cfg.per_day} {t("λήψεις/ημέρα", "intakes/day")}</div>
                    <div className="flex gap-1.5">
                      {([["time", t("Συγκεκριμένη ώρα", "Fixed time")], ["interval", t("Κάθε X ώρες", "Every X hours")]] as const).map(([mv, ml]) => (
                        <button key={mv} onClick={() => setCfg({ ...cfg, mode: mv })} className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${cfg.mode === mv ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 bg-white text-slate-600 dark:border-slate-600 dark:bg-slate-800"}`}>{ml}</button>
                      ))}
                    </div>
                  </>
                )}
                {cfg.per_day > 1 && cfg.mode === "interval" && (
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-slate-500">🔁 {t("Κάθε πόσες ώρες;", "Every how many hours?")}</div>
                    <select value={cfg.interval} onChange={(e) => setCfg({ ...cfg, interval: +e.target.value })} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">{[3, 4, 6, 8, 12].map((h) => <option key={h} value={h}>{t("κάθε", "every")} {h}{t("ω", "h")}</option>)}</select>
                  </div>
                )}
                <TimePicker label={`⏰ ${cfg.per_day > 1 && cfg.mode === "interval" ? t("Ώρα 1ης λήψης", "First intake") : t("Ώρα λήψης", "Intake time")} (24h)`} />
                {cfg.per_day > 1 && cfg.mode === "interval" && (
                  <div className="rounded-lg bg-white/70 px-2 py-1 text-[10px] text-slate-500 dark:bg-slate-800/70">{t("Δόσεις", "Doses")}: {Array.from({ length: Math.ceil(24 / cfg.interval) }, (_, i) => { const [h, mn] = cfg.time.split(":").map(Number); const tot = ((h * 60 + mn + i * cfg.interval * 60) % 1440); return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`; }).join(" · ")}</div>
                )}
                <div>
                  <div className="mb-1 text-[11px] font-medium text-slate-500">🍽️ {t("Σε σχέση με το γεύμα", "Relative to meal")}</div>
                  <div className="flex gap-1.5">
                    {([["before", t("Πριν", "Before")], ["after", t("Μετά", "After")], ["none", t("Άσχετο", "N/A")]] as const).map(([v, l]) => (
                      <button key={v} onClick={() => setCfg({ ...cfg, meal: v })} className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${cfg.meal === v ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 bg-white text-slate-600 dark:border-slate-600 dark:bg-slate-800"}`}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setCfg(null)} className="px-2 py-1 text-xs text-slate-400">{t("Άκυρο", "Cancel")}</button>
                  <button onClick={save} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">{t("Αποθήκευση", "Save")}</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </PanelCard>
  );
}
