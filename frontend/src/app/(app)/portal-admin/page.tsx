"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QRCodeCanvas } from "qrcode.react";
import { Users, MessageSquare, CalendarClock, Stethoscope, FileText, ZoomIn, Trash2, Heart, Copy, Printer } from "lucide-react";
import { api, apiBlob } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtDateTime } from "@/lib/formatters";

type Avail = { id?: string; _id?: string; query: string; medicine_name?: string | null; patient_name?: string; patient_phone?: string; status: string; answer?: string | null; created_at: string };
type Appt = { id?: string; _id?: string; service_name: string; kind?: string; note?: string; patient_name?: string; patient_phone?: string; requested_at: string; status: string };
type Slot = { day: number; start: string; end: string };
type DateRange = { start_date: string; end_date: string; start: string; end: string };
type Availability = { mode: string; slots: Slot[]; date_ranges?: DateRange[] };
type Service = { id?: string; _id?: string; name: string; kind?: string; description?: string; active?: boolean; duration_min?: number; availability?: Availability };
const DAYS = ["Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ", "Κυρ"];
const dmy = (iso: string) => { const [y, m, d] = iso.split("-"); return d && m ? `${d}/${m}${y ? "/" + y.slice(2) : ""}` : iso; };
const rangeLabel = (r: DateRange) => (r.start_date === r.end_date ? dmy(r.start_date) : `${dmy(r.start_date)}–${dmy(r.end_date)}`) + ` ${r.start}–${r.end}`;
const isoToDmy = (iso: string) => { const [y, m, d] = (iso || "").split("-"); return d ? `${d}/${m}/${y}` : ""; };
const dmyToIso = (s: string) => {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return "";
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? "" : iso;
};

/** Locale-independent date field — always shows ηη/μμ/εεεε, stores ISO (yyyy-mm-dd). */
function DateField({ value, onChange, className }: { value: string; onChange: (iso: string) => void; className?: string }) {
  const [text, setText] = useState(isoToDmy(value));
  useEffect(() => { setText(isoToDmy(value)); }, [value]);
  function handle(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    setText(out);
    const iso = dmyToIso(out);
    if (iso) onChange(iso);
  }
  return <input value={text} onChange={(e) => handle(e.target.value)} placeholder="ηη/μμ/εεεε" inputMode="numeric" maxLength={10} className={className} />;
}
const slotsSummary = (av?: Availability) => {
  if (!av || av.mode !== "custom") return "Όλο το ωράριο του φαρμακείου";
  const parts = [
    ...(av.slots ?? []).map((s) => `${DAYS[s.day]} ${s.start}–${s.end}`),
    ...(av.date_ranges ?? []).map((r) => `📅 ${rangeLabel(r)}`),
  ];
  return parts.length ? parts.join(" · ") : "Όλο το ωράριο του φαρμακείου";
};
type Cda = { available?: boolean; found?: boolean; doctor?: string | null; medicines?: string[]; issue_date?: string | null; deadline_date?: string | null; intangible?: boolean; exec_count?: number | null };
type RxReq = { id?: string; _id?: string; kind: string; barcode?: string | null; note?: string | null; status: string; created_at: string; patient_name?: string; patient_phone?: string; image_id?: string | null; cda?: Cda | null; reply?: string | null; available_date?: string | null };

const oid = (x: { id?: string; _id?: string }) => x.id ?? x._id ?? "";
const dtl = (s: string) => fmtDateTime(s);
const RX_STATUS: Record<string, string> = { new: "Νέα", in_progress: "Σε εξέλιξη", answered: "Απαντήθηκε", done: "Ολοκληρώθηκε", rejected: "Απορρίφθηκε" };
const rxStatusCls = (s: string) => ["answered", "done"].includes(s) ? "bg-emerald-100 text-emerald-700" : s === "rejected" ? "bg-rose-100 text-rose-700" : s === "in_progress" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700";

type PortalCustomers = { registered: number; total: number; to_invite: number; adoption_pct: number; contactable: number; registered_list: { name: string; since?: string | null; last_seen?: string | null }[]; tenant_id?: string; pharmacy_name?: string | null; register_url?: string };

function Kpi({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint: string }) {
  return (
    <div className="rx-card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tint}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function PortalCustomersTab() {
  const t = useT();
  const { data: d } = useQuery({ queryKey: ["portal-customers"], queryFn: () => api<PortalCustomers>("/portal/portal-customers") });
  const [copied, setCopied] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);
  const url = d?.register_url || "https://my.rxvision.gr/portal/register";
  const phName = d?.pharmacy_name || t("το φαρμακείο μας", "our pharmacy");

  function printQR() {
    const canvas = qrRef.current?.querySelector("canvas");
    const dataUrl = canvas?.toDataURL("image/png");
    if (!dataUrl) return;
    const w = window.open("", "_blank", "width=460,height=640");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR ${phName}</title></head>
      <body style="margin:0;font-family:system-ui,sans-serif;text-align:center;padding:36px 24px;color:#0f172a">
        <div style="font-size:14px;letter-spacing:.08em;color:#6366f1;font-weight:700">RxVision · ΠΥΛΗ ΠΕΛΑΤΩΝ</div>
        <h1 style="font-size:24px;margin:8px 0 2px">${phName}</h1>
        <p style="font-size:16px;color:#334155;margin:0 0 18px">Σκάναρε &amp; κάνε εγγραφή — δες τις συνταγές σου &amp; κλείσε ραντεβού!</p>
        <img src="${dataUrl}" style="width:320px;height:320px"/>
        <p style="font-size:13px;color:#64748b;margin-top:18px">Εγγραφή με το ΑΜΚΑ σου · μόλις 1 λεπτό</p>
      </body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label={t("Εγγεγραμμένοι στην πύλη", "Registered")} value={d ? String(d.registered) : "—"} tint="text-emerald-600" />
        <Kpi label={t("Σύνολο πελατών", "Total patients")} value={d ? String(d.total) : "—"} tint="text-slate-800 dark:text-slate-100" />
        <Kpi label={t("Υιοθέτηση", "Adoption")} value={d ? `${d.adoption_pct}%` : "—"} tint="text-sky-600" />
        <Kpi label={t("Προς εγγραφή", "To invite")} value={d ? String(d.to_invite) : "—"} tint="text-amber-600"
          sub={d ? t(`${d.contactable} με στοιχεία επικοινωνίας`, `${d.contactable} contactable`) : undefined} />
      </div>

      <div className="rx-card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <div ref={qrRef} className="grid shrink-0 place-items-center rounded-xl bg-white p-3 ring-1 ring-slate-200">
          {url && <QRCodeCanvas value={url} size={148} level="M" includeMargin />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">📣 {t("QR εγγραφής για τον πάγκο σου", "Counter registration QR")}</div>
          <p className="mt-0.5 text-xs text-slate-500">{t("Τύπωσέ το και βάλ' το στον πάγκο. Όποιος το σκανάρει εγγράφεται με το φαρμακείο σου ήδη επιλεγμένο ως αγαπημένο — χωρίς να ψάχνει σε λίστα.", "Print it for the counter. Whoever scans it registers with your pharmacy pre-selected as favourite.")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button onClick={printQR} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"><Printer className="h-4 w-4" /> {t("Εκτύπωση QR", "Print QR")}</button>
            <button onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700"><Copy className="h-4 w-4" /> {copied ? t("Αντιγράφηκε!", "Copied!") : t("Αντιγραφή συνδέσμου", "Copy link")}</button>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold text-slate-500">{t("Εγγεγραμμένοι πελάτες", "Registered customers")} ({d?.registered ?? 0})</div>
        {(!d || d.registered_list.length === 0) ? (
          <p className="text-sm text-slate-400">{t("Κανένας εγγεγραμμένος ακόμη — μοίρασε τον σύνδεσμο εγγραφής.", "No registered customers yet.")}</p>
        ) : d.registered_list.map((p, i) => (
          <div key={i} className="mb-2 flex items-center justify-between rx-card p-3">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200"><Heart className="h-4 w-4 text-rose-400" /> {p.name}</span>
            {p.since && <span className="text-xs text-slate-400">{t("Εγγραφή", "Joined")}: {dtl(p.since)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

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

/** Auth'd Rx photo with click-to-zoom (token rides via apiBlob, not an <img src>). */
function RxImage({ reqId }: { reqId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let alive = true; let obj: string | null = null;
    apiBlob(`/portal/rx-requests/${reqId}/image`).then((b) => { if (!alive) return; obj = URL.createObjectURL(b); setUrl(obj); }).catch(() => {});
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [reqId]);
  if (!url) return <div className="grid h-28 w-28 place-items-center rounded-lg bg-slate-100 text-xs text-slate-400 dark:bg-slate-800">…</div>;
  return (
    <>
      <button onClick={() => setZoom(true)} className="group relative shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Rx" className="h-28 w-28 rounded-lg object-cover ring-1 ring-slate-200" />
        <span className="absolute inset-0 grid place-items-center rounded-lg text-white opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100"><ZoomIn className="h-6 w-6" /></span>
      </button>
      {zoom && (
        <div onClick={() => setZoom(false)} className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/80 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Rx" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}

function RxRequestsTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["portal-rxreq"], queryFn: () => api<{ items: RxReq[] }>("/portal/rx-requests"), refetchInterval: 15000 });
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [dates, setDates] = useState<Record<string, string>>({});
  const reply = useMutation({
    mutationFn: (v: { id: string; reply: string; available_date?: string }) => api(`/portal/rx-requests/${v.id}/reply`, { method: "POST", body: JSON.stringify({ reply: v.reply, available_date: v.available_date || undefined }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portal-rxreq"] }),
  });
  const status = useMutation({
    mutationFn: (v: { id: string; status: string }) => api(`/portal/rx-requests/${v.id}/status`, { method: "POST", body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portal-rxreq"] }),
  });
  const items = data?.items ?? [];
  return (
    <div className="space-y-3">
      {items.length === 0 && <p className="text-sm text-slate-400">{t("Καμία ανάθεση συνταγής.", "No assigned prescriptions.")}</p>}
      {items.map((r) => {
        const id = oid(r); const c = r.cda;
        return (
          <div key={id} className="rx-card p-4">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-slate-800 dark:text-slate-200">{r.kind === "barcode" ? <>📋 Barcode <span className="font-mono text-xs">{r.barcode}</span></> : "📷 Φωτογραφία συνταγής"}</span>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-xs text-slate-400">{dtl(r.created_at)}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${rxStatusCls(r.status)}`}>{RX_STATUS[r.status] ?? r.status}</span>
              </div>
            </div>
            {/* Στοιχεία πελάτη — ξεχωριστά & με ετικέτες */}
            {(r.patient_name || r.patient_phone) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/50">
                {r.patient_name && <span className="inline-flex items-center gap-1.5"><span className="text-xs text-slate-400">{t("Πελάτης", "Patient")}:</span> <span className="font-semibold text-slate-800 dark:text-slate-100">{r.patient_name}</span></span>}
                {r.patient_phone && <a href={`tel:${r.patient_phone}`} className="inline-flex items-center gap-1.5 text-brand-600 hover:underline"><span className="text-xs text-slate-400">{t("Τηλέφωνο", "Phone")}:</span> <span className="font-semibold">📞 {r.patient_phone}</span></a>}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-4">
              {r.kind === "photo" && r.image_id && <RxImage reqId={id} />}
              {c?.found && (
                <div className="min-w-[220px] flex-1 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
                  <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">✓ {t("Επιβεβαιώθηκε από ΗΔΙΚΑ", "Verified by ΗΔΙΚΑ")}</div>
                  {!!c.medicines?.length && (
                    <div className="mt-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700/70 dark:text-emerald-400/70">{t("Φάρμακα", "Medicines")} ({c.medicines.length})</div>
                      <div className="mt-1 space-y-1">
                        {c.medicines.map((m, i) => (
                          <div key={i} className="flex items-start gap-2 rounded-md bg-white px-2.5 py-1.5 text-sm text-slate-700 ring-1 ring-emerald-100 dark:bg-slate-900/50 dark:text-slate-200 dark:ring-emerald-900">
                            <span className="shrink-0 text-emerald-600">💊</span><span className="leading-snug">{m}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-emerald-700 dark:text-emerald-400">
                    {c.doctor && <span className="inline-flex items-center gap-1"><span className="text-slate-400">{t("Ιατρός", "Doctor")}:</span> 👤 {c.doctor}</span>}
                    {c.issue_date && <span>📅 {t("Έκδοση", "Issued")} {c.issue_date}</span>}
                    {c.deadline_date && <span>⏳ {t("Λήξη", "Expires")} {c.deadline_date}</span>}
                    {c.intangible && <span>📲 {t("Άυλη", "Paperless")}</span>}
                    {typeof c.exec_count === "number" && <span>🔁 {c.exec_count} {t("εκτ.", "exec")}</span>}
                  </div>
                </div>
              )}
              {c && c.available && !c.found && <div className="text-xs text-amber-600">{t("Δεν εντοπίστηκε στην ΗΔΙΚΑ — έλεγξε χειροκίνητα.", "Not found in ΗΔΙΚΑ — check manually.")}</div>}
            </div>
            {r.note && <div className="mt-2 text-xs text-slate-500">📝 {r.note}</div>}
            {r.reply ? (
              <div className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{t("Απάντησες", "Replied")}: {r.reply}{r.available_date ? ` (${t("διαθ.", "avail.")} ${r.available_date})` : ""}</div>
            ) : (
              <div className="mt-3 space-y-2">
                <textarea value={replies[id] ?? ""} onChange={(e) => setReplies({ ...replies, [id]: e.target.value })} rows={2}
                  placeholder={t("Απάντηση στον πελάτη (π.χ. έλλειψη, οδηγίες)…", "Reply to the patient…")}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-500">{t("Ημ. διαθεσιμότητας", "Available date")}:</label>
                  <input type="date" value={dates[id] ?? ""} onChange={(e) => setDates({ ...dates, [id]: e.target.value })} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
                  <button onClick={() => { const rep = replies[id]?.trim() || (dates[id] ? `${t("Θα είναι διαθέσιμο", "Available on")} ${dates[id]}` : ""); if (rep) reply.mutate({ id, reply: rep, available_date: dates[id] }); }}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">{t("Στείλε απάντηση", "Send reply")}</button>
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
              <button onClick={() => status.mutate({ id, status: "in_progress" })} className="rounded-lg border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50">{t("Σε εξέλιξη", "In progress")}</button>
              <button onClick={() => status.mutate({ id, status: "done" })} className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">{t("Ολοκληρώθηκε", "Done")}</button>
              <button onClick={() => status.mutate({ id, status: "rejected" })} className="rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50">{t("Απόρριψη", "Reject")}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ServiceRow({ s }: { s: Service }) {
  const t = useT();
  const qc = useQueryClient();
  const on = s.active !== false;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(s.availability?.mode === "custom" ? "custom" : "always");
  const [slots, setSlots] = useState<Slot[]>(s.availability?.slots ?? []);
  const [ranges, setRanges] = useState<DateRange[]>(s.availability?.date_ranges ?? []);
  const inval = () => qc.invalidateQueries({ queryKey: ["portal-services"] });
  const toggle = useMutation({ mutationFn: (active: boolean) => api(`/portal/services/${oid(s)}/active`, { method: "POST", body: JSON.stringify({ active }) }), onSuccess: inval });
  const del = useMutation({ mutationFn: () => api(`/portal/services/${oid(s)}`, { method: "DELETE" }), onSuccess: inval });
  const save = useMutation({
    mutationFn: () => api(`/portal/services/${oid(s)}`, { method: "PATCH", body: JSON.stringify({
      name: s.name, kind: s.kind ?? "service", description: s.description ?? null, duration_min: s.duration_min ?? 15,
      active: on, availability: { mode, slots: mode === "custom" ? slots : [], date_ranges: mode === "custom" ? ranges : [] },
    }) }),
    onSuccess: () => { inval(); setOpen(false); },
  });
  return (
    <div className={`rx-card p-3 ${on ? "" : "opacity-60"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{s.name}</div>
          <div className="text-[11px] text-slate-400">🕒 {slotsSummary(s.availability)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{s.kind === "vaccination" ? t("Εμβολιασμός", "Vaccination") : t("Υπηρεσία", "Service")}</span>
          <button onClick={() => setOpen((o) => !o)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700">🕒 {t("Ωράριο", "Hours")}</button>
          <button onClick={() => toggle.mutate(!on)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${on ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}>{on ? t("Ενεργή", "On") : t("Ανενεργή", "Off")}</button>
          <button onClick={() => del.mutate()} className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50" title={t("Διαγραφή", "Delete")}><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={mode === "always"} onChange={() => setMode("always")} /> {t("Όλο το ωράριο του φαρμακείου", "All pharmacy hours")}</label>
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} /> {t("Συγκεκριμένες ημέρες & ώρες", "Specific days & hours")}</label>
          </div>
          {mode === "custom" && (
            <div className="space-y-4">
              {/* εβδομαδιαίο πρόγραμμα */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("Εβδομαδιαίο πρόγραμμα", "Weekly schedule")}</div>
                {slots.map((sl, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select value={sl.day} onChange={(e) => setSlots(slots.map((x, j) => j === i ? { ...x, day: +e.target.value } : x))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800">
                      {DAYS.map((d, di) => <option key={di} value={di}>{d}</option>)}
                    </select>
                    <input type="time" value={sl.start} onChange={(e) => setSlots(slots.map((x, j) => j === i ? { ...x, start: e.target.value } : x))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
                    <span className="text-slate-400">–</span>
                    <input type="time" value={sl.end} onChange={(e) => setSlots(slots.map((x, j) => j === i ? { ...x, end: e.target.value } : x))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
                    <button onClick={() => setSlots(slots.filter((_, j) => j !== i))} className="rounded-lg p-1 text-rose-500 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => setSlots([...slots, { day: 0, start: "09:00", end: "14:00" }])} className="rounded-lg border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700">+ {t("Προσθήκη ημέρας", "Add day")}</button>
              </div>
              {/* συγκεκριμένες ημερομηνίες / events */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">📅 {t("Συγκεκριμένες ημερομηνίες (events)", "Specific dates (events)")}</div>
                {ranges.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <DateField value={r.start_date} onChange={(iso) => setRanges(ranges.map((x, j) => j === i ? { ...x, start_date: iso, end_date: x.end_date && x.end_date >= iso ? x.end_date : iso } : x))} className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
                    <span className="text-slate-400">→</span>
                    <DateField value={r.end_date} onChange={(iso) => setRanges(ranges.map((x, j) => j === i ? { ...x, end_date: iso } : x))} className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
                    <input type="time" value={r.start} onChange={(e) => setRanges(ranges.map((x, j) => j === i ? { ...x, start: e.target.value } : x))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
                    <span className="text-slate-400">–</span>
                    <input type="time" value={r.end} onChange={(e) => setRanges(ranges.map((x, j) => j === i ? { ...x, end: e.target.value } : x))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
                    <button onClick={() => setRanges(ranges.filter((_, j) => j !== i))} className="rounded-lg p-1 text-rose-500 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
                <button onClick={() => { const today = new Date().toISOString().slice(0, 10); setRanges([...ranges, { start_date: today, end_date: today, start: "10:00", end: "18:00" }]); }} className="rounded-lg border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700">+ {t("Προσθήκη ημερομηνίας/event", "Add date/event")}</button>
              </div>
            </div>
          )}
          <button onClick={() => save.mutate()} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">{t("Αποθήκευση", "Save")}</button>
        </div>
      )}
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
      <p className="text-sm text-slate-500">{t("Όρισε τις δικές σου διαθέσιμες υπηρεσίες — μόνο οι ενεργές εμφανίζονται στους πελάτες για ραντεβού. Πάτησε «Ωράριο» για να ορίσεις ημέρες/ώρες.", "Define your own services — set days/hours via «Hours».")}</p>
      <div className="flex gap-2 rx-card p-4">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Νέα υπηρεσία (π.χ. Αντιγριπικός εμβολιασμός)", "New service")}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800">
          <option value="service">{t("Υπηρεσία", "Service")}</option>
          <option value="vaccination">{t("Εμβολιασμός", "Vaccination")}</option>
        </select>
        <button onClick={() => name.trim() && create.mutate()} className="rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700">{t("Προσθήκη", "Add")}</button>
      </div>
      {items.map((s) => <ServiceRow key={oid(s)} s={s} />)}
    </div>
  );
}

export default function PortalAdminPage() {
  const t = useT();
  const [tab, setTab] = useState("customers");
  const TABS: [string, string, typeof MessageSquare][] = [
    ["customers", t("Πελάτες πύλης", "Portal customers"), Heart],
    ["rx", t("Συνταγές", "Prescriptions"), FileText],
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
      {tab === "customers" && <PortalCustomersTab />}
      {tab === "rx" && <RxRequestsTab />}
      {tab === "availability" && <AvailabilityTab />}
      {tab === "appointments" && <AppointmentsTab />}
      {tab === "services" && <ServicesTab />}
    </ModuleGuard>
  );
}
