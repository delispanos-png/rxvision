"use client";

import { useState } from "react";
import { Check, X, CalendarDays } from "lucide-react";
import { patientApi } from "@/lib/patientClient";
import { useT } from "@/store/prefStore";

type Intent = { decision?: string | null; visit_date?: string | null; reason?: string | null } | null;
type Doctor = { name?: string | null; specialty?: string | null; phone?: string | null } | null;
export type Renewal = { key?: string | null; medicine?: string | null; doctor?: Doctor; available: number; since?: string | null; intent?: Intent };

const dt = (s?: string | null) => (s ? new Date(s).toLocaleDateString("el-GR") : "");

export function RenewalCard({ r, onDone }: { r: Renewal; onDone: () => void }) {
  const t = useT();
  const intent = r.intent;
  const [mode, setMode] = useState<"take" | "skip" | null>(null);
  const [date, setDate] = useState(intent?.visit_date ? intent.visit_date.slice(0, 10) : "");
  const [reason, setReason] = useState(intent?.reason || "");
  const [busy, setBusy] = useState(false);

  async function submit(decision: "take" | "skip") {
    if (!r.key) return;
    setBusy(true);
    try {
      await patientApi("/patient/renewals/respond", {
        method: "POST",
        body: JSON.stringify({ key: r.key, decision, visit_date: decision === "take" ? (date || null) : null, reason: decision === "skip" ? (reason || null) : null }),
      });
      setMode(null);
      onDone();
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-slate-800 dark:text-slate-100">{r.medicine || t("Φάρμακο", "Medicine")}</div>
          {r.key ? <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{t("Συνταγή", "Prescription")} {r.key}</div> : null}
          {r.since ? <div className="text-xs text-slate-500 dark:text-slate-400">{t("Διαθέσιμη από", "Available since")} {dt(r.since)}</div> : null}
          {r.doctor?.name ? (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {t("Ιατρός:", "Doctor:")} <span className="font-medium text-slate-700 dark:text-slate-200">{r.doctor.name}</span>
              {r.doctor.specialty ? ` · ${r.doctor.specialty}` : ""}
              {r.doctor.phone ? <> · <a href={`tel:${r.doctor.phone}`} className="font-medium text-brand-600 hover:underline">📞 {r.doctor.phone}</a></> : ""}
            </div>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white">{t("Ανεκτέλεστη", "Unexecuted")}</span>
      </div>

      {intent?.decision === "take" && <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700">✅ {t("Θα το παραλάβω", "I'll pick it up")}{intent.visit_date ? t(` στις ${dt(intent.visit_date)}`, ` on ${dt(intent.visit_date)}`) : ""}.</div>}
      {intent?.decision === "skip" && <div className="mt-2 rounded-lg bg-rose-50 px-3 py-1.5 text-sm text-rose-700">✖ {t("Δεν θα το παραλάβω", "I won't pick it up")}{intent.reason ? `: ${intent.reason}` : ""}.</div>}

      {mode === null ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => setMode("take")} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"><Check className="h-4 w-4" /> {intent?.decision === "take" ? t("Αλλαγή ημερομηνίας", "Change date") : t("Θα το πάρω", "I'll take it")}</button>
          <button onClick={() => setMode("skip")} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"><X className="h-4 w-4" /> {t("Δεν θα το πάρω", "I won't take it")}</button>
        </div>
      ) : mode === "take" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300"><CalendarDays className="h-4 w-4" /> {t("Πότε θα περάσεις;", "When will you stop by?")}</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-slate-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
          <button onClick={() => submit("take")} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">{t("Καταχώρηση", "Save")}</button>
          <button onClick={() => setMode(null)} className="text-sm text-slate-400">{t("Άκυρο", "Cancel")}</button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("Λόγος (προαιρετικό)", "Reason (optional)")} className="min-w-0 flex-1 rounded-lg border border-slate-300 dark:border-slate-600 px-2 py-1.5 text-sm" />
          <button onClick={() => submit("skip")} disabled={busy} className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">{t("Καταχώρηση", "Save")}</button>
          <button onClick={() => setMode(null)} className="text-sm text-slate-400">{t("Άκυρο", "Cancel")}</button>
        </div>
      )}
    </div>
  );
}
