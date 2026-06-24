"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Droplet, Scale, HeartPulse, Plus, Trash2, type LucideIcon } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";

type M = { _id?: string; kind: string; systolic?: number; diastolic?: number; value?: number; at: string; note?: string };
type Data = { latest: Record<string, M>; history: Record<string, M[]> };

const dmy = (s?: string) => (s ? new Date(s).toLocaleDateString("el-GR") : "—");
const bpStatus = (s?: number, d?: number) => (!s || !d ? "neutral" : s >= 140 || d >= 90 ? "high" : s >= 130 || d >= 85 ? "warn" : "ok");
const glStatus = (v?: number) => (!v ? "neutral" : v >= 126 ? "high" : v >= 100 ? "warn" : "ok");
const bmiStatus = (b?: number) => (!b ? "neutral" : b >= 30 ? "high" : b >= 25 || b < 18.5 ? "warn" : "ok");
const STC: Record<string, string> = { ok: "text-emerald-700 bg-emerald-50", warn: "text-amber-700 bg-amber-50", high: "text-rose-700 bg-rose-50", neutral: "text-slate-600 bg-slate-50" };

function Tile({ icon: Icon, label, value, sub, status, onClick }: { icon: LucideIcon; label: string; value: string; sub: string; status: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} disabled={!onClick} className={`rounded-xl border border-slate-200 p-3 text-left dark:border-slate-700 ${onClick ? "hover:border-brand-300" : "cursor-default"}`}>
      <div className="flex items-center gap-1.5 text-xs text-slate-500"><Icon className="h-4 w-4" />{label}</div>
      <div className={`mt-1 inline-flex items-baseline rounded px-1.5 text-lg font-bold ${STC[status]}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>
    </button>
  );
}

export function MeasurementsCard({ patientId }: { patientId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["patient-measurements", patientId], queryFn: () => api<Data>(`/patients/${encodeURIComponent(patientId)}/measurements`) });
  const { data: contact } = useQuery({ queryKey: ["patient-contact", patientId], queryFn: () => api<{ height_cm?: number | null }>(`/patients/${encodeURIComponent(patientId)}/contact`), retry: false });
  const heightCm = contact?.height_cm || undefined;
  const [h, setH] = useState("");
  const saveH = useMutation({
    mutationFn: () => api(`/patients/${encodeURIComponent(patientId)}/height`, { method: "PATCH", body: JSON.stringify({ height_cm: h ? Number(h) : null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["patient-contact", patientId] }); setH(""); },
  });
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("bp");
  const [sys, setSys] = useState(""); const [dia, setDia] = useState(""); const [val, setVal] = useState("");
  const [at, setAt] = useState(new Date().toISOString().slice(0, 10));
  const [hist, setHist] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api(`/patients/${encodeURIComponent(patientId)}/measurements`, { method: "POST", body: JSON.stringify(kind === "bp" ? { kind, systolic: +sys, diastolic: +dia, at } : { kind, value: +val, at }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["patient-measurements", patientId] }); setOpen(false); setSys(""); setDia(""); setVal(""); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/patients/${encodeURIComponent(patientId)}/measurements/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["patient-measurements", patientId] }),
  });

  const bp = data?.latest.bp; const gl = data?.latest.glucose; const wt = data?.latest.weight;
  const bmi = heightCm && wt?.value ? wt.value / ((heightCm / 100) ** 2) : undefined;
  const canSave = kind === "bp" ? !!sys && !!dia : !!val;
  const inp = "rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800";

  return (
    <PanelCard title={t("Μετρήσεις & σωματομετρικά", "Measurements")} action={
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700"><Plus className="h-3.5 w-3.5" />{t("Νέα μέτρηση", "Add")}</button>
    }>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile icon={HeartPulse} label={t("Πίεση", "Blood pressure")} value={bp ? `${bp.systolic}/${bp.diastolic}` : "—"} sub={bp ? dmy(bp.at) : t("καμία μέτρηση", "no data")} status={bpStatus(bp?.systolic, bp?.diastolic)} onClick={() => setHist(hist === "bp" ? null : "bp")} />
        <Tile icon={Droplet} label={t("Ζάχαρο", "Glucose")} value={gl ? `${gl.value}` : "—"} sub={gl ? `mg/dL · ${dmy(gl.at)}` : t("καμία μέτρηση", "no data")} status={glStatus(gl?.value)} onClick={() => setHist(hist === "glucose" ? null : "glucose")} />
        <Tile icon={Scale} label={t("Βάρος", "Weight")} value={wt ? `${wt.value}` : "—"} sub={wt ? `kg · ${dmy(wt.at)}` : t("καμία μέτρηση", "no data")} status="neutral" onClick={() => setHist(hist === "weight" ? null : "weight")} />
        <Tile icon={Activity} label={t("ΔΜΣ (BMI)", "BMI")} value={bmi ? bmi.toFixed(1) : "—"} sub={heightCm ? `${t("ύψος", "height")} ${heightCm}cm` : t("όρισε ύψος →", "set height →")} status={bmiStatus(bmi)} />
      </div>

      {/* ύψος — σταθερό σωματομετρικό (για BMI) */}
      <div className="mt-2 flex items-center gap-2 text-sm">
        <span className="text-xs text-slate-500">{t("Ύψος (cm)", "Height (cm)")}:</span>
        <input type="number" value={h} onChange={(e) => setH(e.target.value)} placeholder={heightCm ? String(heightCm) : "175"}
          className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800" />
        <button onClick={() => saveH.mutate()} disabled={saveH.isPending || !h} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700">{t("Αποθήκευση", "Save")}</button>
      </div>

      {open && (
        <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">{t("Τύπος", "Type")}<select value={kind} onChange={(e) => setKind(e.target.value)} className={`mt-0.5 block ${inp}`}><option value="bp">{t("Πίεση", "BP")}</option><option value="glucose">{t("Ζάχαρο", "Glucose")}</option><option value="weight">{t("Βάρος", "Weight")}</option></select></label>
            {kind === "bp" ? (
              <>
                <label className="text-xs text-slate-500">{t("Συστολική", "Systolic")}<input type="number" value={sys} onChange={(e) => setSys(e.target.value)} className={`mt-0.5 block w-20 ${inp}`} /></label>
                <span className="pb-2 text-slate-400">/</span>
                <label className="text-xs text-slate-500">{t("Διαστολική", "Diastolic")}<input type="number" value={dia} onChange={(e) => setDia(e.target.value)} className={`mt-0.5 block w-20 ${inp}`} /></label>
              </>
            ) : (
              <label className="text-xs text-slate-500">{kind === "glucose" ? "mg/dL" : "kg"}<input type="number" step="0.1" value={val} onChange={(e) => setVal(e.target.value)} className={`mt-0.5 block w-24 ${inp}`} /></label>
            )}
            <label className="text-xs text-slate-500">{t("Ημ/νία", "Date")}<input type="date" value={at} onChange={(e) => setAt(e.target.value)} className={`mt-0.5 block ${inp}`} /></label>
            <button onClick={() => add.mutate()} disabled={add.isPending || !canSave} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{t("Καταχώρηση", "Save")}</button>
          </div>
        </div>
      )}

      {hist && data?.history[hist]?.length ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold text-slate-500">{t("Ιστορικό", "History")} · {hist === "bp" ? t("Πίεση", "BP") : hist === "glucose" ? t("Ζάχαρο", "Glucose") : t("Βάρος", "Weight")} ({t("τελευταίες 10", "last 10")})</div>
          <div className="space-y-1">
            {data.history[hist].map((m, i) => (
              <div key={m._id ?? i} className="flex items-center justify-between rounded-lg border border-slate-100 px-2.5 py-1.5 text-sm dark:border-slate-800">
                <span className="font-medium text-slate-700 dark:text-slate-200">{m.kind === "bp" ? `${m.systolic}/${m.diastolic}` : m.value}{m.kind === "glucose" ? " mg/dL" : m.kind === "weight" ? " kg" : ""}</span>
                <span className="flex items-center gap-2 text-xs text-slate-400">{dmy(m.at)}<button onClick={() => m._id && del.mutate(m._id)} className="text-rose-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button></span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </PanelCard>
  );
}
