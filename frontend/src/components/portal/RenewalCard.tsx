"use client";

import { useState } from "react";
import { Check, X, CalendarDays } from "lucide-react";
import { patientApi } from "@/lib/patientClient";

type Intent = { decision?: string | null; visit_date?: string | null; reason?: string | null } | null;
type Doctor = { name?: string | null; specialty?: string | null; phone?: string | null } | null;
export type Renewal = { key?: string | null; medicine?: string | null; doctor?: Doctor; available: number; since?: string | null; intent?: Intent };

const dt = (s?: string | null) => (s ? new Date(s).toLocaleDateString("el-GR") : "");

export function RenewalCard({ r, onDone }: { r: Renewal; onDone: () => void }) {
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
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-slate-800">{r.medicine || "Φάρμακο"}</div>
          {r.key ? <div className="font-mono text-xs text-slate-500">Συνταγή {r.key}</div> : null}
          {r.since ? <div className="text-xs text-slate-500">Διαθέσιμη από {dt(r.since)}</div> : null}
          {r.doctor?.name ? (
            <div className="mt-0.5 text-xs text-slate-500">
              Ιατρός: <span className="font-medium text-slate-700">{r.doctor.name}</span>
              {r.doctor.specialty ? ` · ${r.doctor.specialty}` : ""}
              {r.doctor.phone ? <> · <a href={`tel:${r.doctor.phone}`} className="font-medium text-brand-600 hover:underline">📞 {r.doctor.phone}</a></> : ""}
            </div>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white">Ανεκτέλεστη</span>
      </div>

      {intent?.decision === "take" && <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700">✅ Θα το παραλάβω{intent.visit_date ? ` στις ${dt(intent.visit_date)}` : ""}.</div>}
      {intent?.decision === "skip" && <div className="mt-2 rounded-lg bg-rose-50 px-3 py-1.5 text-sm text-rose-700">✖ Δεν θα το παραλάβω{intent.reason ? `: ${intent.reason}` : ""}.</div>}

      {mode === null ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => setMode("take")} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"><Check className="h-4 w-4" /> {intent?.decision === "take" ? "Αλλαγή ημερομηνίας" : "Θα το πάρω"}</button>
          <button onClick={() => setMode("skip")} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"><X className="h-4 w-4" /> Δεν θα το πάρω</button>
        </div>
      ) : mode === "take" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-600"><CalendarDays className="h-4 w-4" /> Πότε θα περάσεις;</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          <button onClick={() => submit("take")} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Καταχώρηση</button>
          <button onClick={() => setMode(null)} className="text-sm text-slate-400">Άκυρο</button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Λόγος (προαιρετικό)" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          <button onClick={() => submit("skip")} disabled={busy} className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Καταχώρηση</button>
          <button onClick={() => setMode(null)} className="text-sm text-slate-400">Άκυρο</button>
        </div>
      )}
    </div>
  );
}
