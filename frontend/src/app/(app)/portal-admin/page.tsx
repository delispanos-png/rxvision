"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, MessageSquare, CalendarClock, Stethoscope } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Avail = { id?: string; _id?: string; query: string; medicine_name?: string | null; patient_name?: string; patient_phone?: string; status: string; answer?: string | null; created_at: string };
type Appt = { id?: string; _id?: string; service_name: string; kind?: string; note?: string; patient_name?: string; patient_phone?: string; requested_at: string; status: string };
type Service = { id?: string; _id?: string; name: string; kind?: string; description?: string; active?: boolean };

const oid = (x: { id?: string; _id?: string }) => x.id ?? x._id ?? "";
const dtl = (s: string) => new Date(s).toLocaleString("el-GR", { dateStyle: "medium", timeStyle: "short" });

function AvailabilityTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["portal-avail"], queryFn: () => api<{ items: Avail[] }>("/portal/availability") });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation({
    mutationFn: (v: { id: string; answer: string }) => api(`/portal/availability/${v.id}/answer`, { method: "POST", body: JSON.stringify({ answer: v.answer }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portal-avail"] }),
  });
  const items = data?.items ?? [];
  return (
    <div className="space-y-3">
      {items.length === 0 && <p className="text-sm text-slate-400">{t("Καμία ερώτηση διαθεσιμότητας.", "No availability questions.")}</p>}
      {items.map((a) => {
        const id = oid(a);
        return (
          <div key={id} className="rx-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="font-medium text-slate-800 dark:text-slate-200">💊 {a.medicine_name || a.query}</span>
                {(a.patient_name || a.patient_phone) && (
                  <div className="text-xs text-slate-500">{a.patient_name}{a.patient_phone ? ` · ${a.patient_phone}` : ""}</div>
                )}
              </div>
              <span className="shrink-0 text-xs text-slate-400">{dtl(a.created_at)}</span>
            </div>
            {a.answer ? (
              <div className="mt-1 text-sm text-emerald-700">{t("Απάντησες", "Answered")}: {a.answer}</div>
            ) : (
              <div className="mt-2 flex gap-2">
                <input value={answers[id] ?? ""} onChange={(e) => setAnswers({ ...answers, [id]: e.target.value })}
                  placeholder={t("Απάντηση (π.χ. Ναι, διαθέσιμο)", "Answer (e.g. Yes, in stock)")}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" />
                <button onClick={() => answers[id] && answer.mutate({ id, answer: answers[id] })}
                  className="rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700">{t("Στείλε", "Send")}</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AppointmentsTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["portal-appts"], queryFn: () => api<{ items: Appt[] }>("/portal/appointments") });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: string }) => api(`/portal/appointments/${v.id}/status`, { method: "POST", body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portal-appts"] }),
  });
  const items = data?.items ?? [];
  const STATUS_EL: Record<string, string> = {
    requested: t("Σε αναμονή", "Requested"), confirmed: t("Επιβεβαιωμένο", "Confirmed"),
    ready: t("Έτοιμη για παραλαβή", "Ready for pickup"), done: t("Ολοκληρώθηκε", "Done"),
    cancelled: t("Ακυρώθηκε", "Cancelled"),
  };
  return (
    <div className="space-y-3">
      {items.length === 0 && <p className="text-sm text-slate-400">{t("Κανένα ραντεβού.", "No appointments.")}</p>}
      {items.map((a) => {
        const id = oid(a);
        const isPickup = a.kind === "pickup";
        return (
          <div key={id} className="flex flex-wrap items-center justify-between gap-2 rx-card p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800 dark:text-slate-200">{a.service_name}</span>
                {isPickup && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">📦 {t("Παραλαβή", "Pickup")}</span>}
              </div>
              <div className="text-xs text-slate-500">{dtl(a.requested_at)}{(a.patient_name || a.patient_phone) ? ` · ${a.patient_name ?? ""}${a.patient_phone ? " " + a.patient_phone : ""}` : ""}</div>
              {a.note && <div className="mt-0.5 text-xs text-slate-400">💊 {a.note}</div>}
            </div>
            <div className="flex items-center gap-2">
              {isPickup && a.status !== "ready" && (
                <button onClick={() => setStatus.mutate({ id, status: "ready" })}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                  {t("Έτοιμη για παραλαβή", "Mark ready")}
                </button>
              )}
              <select value={a.status} onChange={(e) => setStatus.mutate({ id, status: e.target.value })}
                className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800">
                {["requested", "confirmed", "ready", "done", "cancelled"].map((s) => <option key={s} value={s}>{STATUS_EL[s]}</option>)}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ServicesTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["portal-services"], queryFn: () => api<{ items: Service[] }>("/portal/services") });
  const [name, setName] = useState("");
  const [kind, setKind] = useState("service");
  const create = useMutation({
    mutationFn: () => api("/portal/services", { method: "POST", body: JSON.stringify({ name, kind }) }),
    onSuccess: () => { setName(""); qc.invalidateQueries({ queryKey: ["portal-services"] }); },
  });
  const items = data?.items ?? [];
  return (
    <div className="space-y-3">
      <div className="flex gap-2 rx-card p-4">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Νέα υπηρεσία (π.χ. Αντιγριπικός εμβολιασμός)", "New service")}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800">
          <option value="service">{t("Υπηρεσία", "Service")}</option>
          <option value="vaccination">{t("Εμβολιασμός", "Vaccination")}</option>
        </select>
        <button onClick={() => name.trim() && create.mutate()} className="rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700">{t("Προσθήκη", "Add")}</button>
      </div>
      {items.map((s) => (
        <div key={oid(s)} className="flex items-center justify-between rx-card p-3">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{s.name}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{s.kind === "vaccination" ? t("Εμβολιασμός", "Vaccination") : t("Υπηρεσία", "Service")}</span>
        </div>
      ))}
    </div>
  );
}

export default function PortalAdminPage() {
  const t = useT();
  const [tab, setTab] = useState("availability");
  const TABS: [string, string, typeof MessageSquare][] = [
    ["availability", t("Διαθεσιμότητα", "Availability"), MessageSquare],
    ["appointments", t("Ραντεβού", "Appointments"), CalendarClock],
    ["services", t("Υπηρεσίες", "Services"), Stethoscope],
  ];
  return (
    <ModuleGuard module="patient_portal">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-emerald-500 text-white shadow-lg"><Users className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Πύλη Πελατών", "Customer Portal")}</h1>
          <p className="text-sm text-slate-500">{t("Διαχειρίσου ερωτήσεις διαθεσιμότητας, ραντεβού & υπηρεσίες των πελατών σου.", "Manage your customers' availability questions, appointments & services.")}</p>
        </div>
      </div>
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700">
        {TABS.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2 text-sm ${tab === k ? "border-brand-600 font-semibold text-brand-700 dark:text-brand-400" : "border-transparent text-slate-500"}`}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </nav>
      {tab === "availability" && <AvailabilityTab />}
      {tab === "appointments" && <AppointmentsTab />}
      {tab === "services" && <ServicesTab />}
    </ModuleGuard>
  );
}
