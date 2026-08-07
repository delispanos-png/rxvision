"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Play, Trash2, Plus, Inbox, Sparkles, Loader2, Mail, Bell, Send, MessageSquare, Check, X } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";
import { appConfirm } from "@/store/dialogStore";
import Link from "next/link";

type Routine = {
  _id: string; name: string; schedule: { kind: string; time: string; weekday?: number; dom?: number };
  schedule_label: string; action?: string; report_tool?: string; report_label: string; delivery?: string; email?: string | null;
  channel?: string; segment?: string; mode?: string; max_recipients?: number;
  enabled: boolean; last_run?: string | null; last_status?: string | null; next_run?: string | null; runs_count?: number;
};
type Run = {
  _id: string; routine_name: string; at: string; ok: boolean; report: string; read: boolean;
  kind?: string; status?: string; channel?: string; audience_count?: number; est_cost_cents?: number;
};
const eur = (c?: number) => `${((c || 0) / 100).toFixed(2).replace(".", ",")} €`;

// ίδια λίστα με REPORT_TOOLS του backend (copilot_service.py)
const REPORT_TOOLS: [string, string][] = [
  ["get_kpis", "Σύνοψη φαρμακείου (KPIs)"],
  ["get_top", "Κορυφαία λίστα (ιατροί/προϊόντα/πελάτες/ICD)"],
  ["get_unexecuted", "Ανεκτέλεστες δραστικές"],
  ["get_profitability", "Κερδοφορία"],
  ["get_low_margin", "Προϊόντα χαμηλού περιθωρίου"],
  ["get_reimbursement", "Εικόνα αποζημίωσης ΕΟΠΥΥ"],
  ["get_reimbursement_risk", "Ρίσκο ΕΟΠΥΥ"],
  ["get_today_tasks", "Εργασίες ημέρας (ασθενείς)"],
  ["get_winback", "Ασθενείς για win-back"],
  ["get_at_risk", "Ασθενείς σε ρίσκο"],
  ["get_vip", "VIP ασθενείς"],
  ["get_order_suggestions", "Προτάσεις παραγγελίας"],
  ["get_upcoming", "Μελλοντικές συνταγές"],
  ["get_portal_pending", "Εκκρεμή αιτήματα πελατών"],
];
const DAYS = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο", "Κυριακή"];
const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

export default function RoutinesPage() {
  const t = useT();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["copilot-routines"], queryFn: () => api<{ items: Routine[] }>("/copilot/routines") });
  const inbox = useQuery({ queryKey: ["copilot-routines-inbox"], queryFn: () => api<{ items: Run[]; unread: number }>("/copilot/routines-inbox"), refetchInterval: 60000 });
  const [showNew, setShowNew] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["copilot-routines"] }); qc.invalidateQueries({ queryKey: ["copilot-routines-inbox"] }); };
  const toggle = useMutation({ mutationFn: (r: Routine) => api(`/copilot/routines/${r._id}`, { method: "PUT", body: JSON.stringify({ enabled: !r.enabled }) }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (id: string) => api(`/copilot/routines/${id}`, { method: "DELETE" }), onSuccess: invalidate });
  const runNow = useMutation({
    mutationFn: (id: string) => { setRunningId(id); return api(`/copilot/routines/${id}/run`, { method: "POST" }); },
    onSettled: () => { setRunningId(null); invalidate(); },
  });
  const markRead = useMutation({ mutationFn: () => api("/copilot/routines-inbox/read", { method: "POST", body: JSON.stringify({}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["copilot-routines-inbox"] }) });
  const approve = useMutation({ mutationFn: (rid: string) => api(`/copilot/routines-inbox/${rid}/approve`, { method: "POST" }), onSuccess: invalidate });
  const reject = useMutation({ mutationFn: (rid: string) => api(`/copilot/routines-inbox/${rid}/reject`, { method: "POST" }), onSuccess: invalidate });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-lg"><CalendarClock className="h-6 w-6" /></span>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Ρουτίνες Copilot", "Copilot Routines")}</h1>
            <p className="text-xs text-slate-500">{t("Προγραμματισμένες, επαναλαμβανόμενες αναφορές — αυτόματα, στην ώρα που θες.", "Scheduled, recurring reports — automatically, at the time you want.")}</p>
          </div>
        </div>
        <button onClick={() => setShowNew((s) => !s)} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"><Plus className="h-4 w-4" /> {t("Νέα ρουτίνα", "New routine")}</button>
      </div>

      <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300">
        <Sparkles className="mr-1 inline h-3.5 w-3.5" />
        {t("Μπορείς να τη φτιάξεις και με λόγια στον ", "You can also create one by talking to the ")}
        <Link href="/copilot" className="font-semibold underline">Copilot</Link>
        {t(": π.χ. «κάθε πρωί στις 10:00 στείλε μου ποιος πελάτης έκανε τον μεγαλύτερο τζίρο».", ": e.g. «every morning at 10:00 send me who had the highest revenue».")}
      </div>

      {showNew && <NewRoutineForm onDone={() => { setShowNew(false); invalidate(); }} onCancel={() => setShowNew(false)} t={t} />}

      {/* Routines list */}
      <QueryState isLoading={list.isLoading} isError={list.isError} onRetry={() => list.refetch()}>
        {!list.data?.items?.length ? (
          <div className="rounded-2xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-400 dark:border-slate-700">{t("Καμία ρουτίνα ακόμη.", "No routines yet.")}</div>
        ) : (
          <div className="space-y-2">
            {list.data.items.map((r) => (
              <div key={r._id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {r.action === "message" && <MessageSquare className="h-4 w-4 text-violet-500" />}
                      <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{r.name}</span>
                      {r.action === "message" && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.mode === "auto" ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" : "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"}`}>
                          {r.mode === "auto" ? t(`αυτόματο ≤${r.max_recipients}`, `auto ≤${r.max_recipients}`) : t("με έγκριση", "needs approval")}
                        </span>
                      )}
                      {!r.enabled && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-700">{t("σε παύση", "paused")}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" /> {r.schedule_label}</span>
                      <span>· {r.report_label}</span>
                      <span className="inline-flex items-center gap-1">· {r.delivery === "email" ? <><Mail className="h-3.5 w-3.5" /> {r.email}</> : <><Bell className="h-3.5 w-3.5" /> {t("στην εφαρμογή", "in-app")}</>}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      {t("Επόμενη", "Next")}: {fmt(r.next_run)} · {t("Τελευταία", "Last")}: {fmt(r.last_run)}{r.last_status === "error" ? ` · ⚠️ ${t("σφάλμα", "error")}` : ""}{r.runs_count ? ` · ${r.runs_count} ${t("εκτελέσεις", "runs")}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button onClick={() => runNow.mutate(r._id)} disabled={runningId === r._id} title={t("Εκτέλεση τώρα", "Run now")} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600">
                      {runningId === r._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {t("Τώρα", "Now")}
                    </button>
                    <label className="inline-flex cursor-pointer items-center" title={r.enabled ? t("Ενεργή", "Enabled") : t("Σε παύση", "Paused")}>
                      <input type="checkbox" checked={r.enabled} onChange={() => toggle.mutate(r)} className="peer sr-only" />
                      <span className="relative h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-emerald-500 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" />
                    </label>
                    <button onClick={async () => { if (await appConfirm(t(`Διαγραφή της ρουτίνας «${r.name}»;`, `Delete routine «${r.name}»?`), { danger: true })) del.mutate(r._id); }} title={t("Διαγραφή", "Delete")} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </QueryState>

      {/* Inbox — delivered reports */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <Inbox className="h-4 w-4" /> {t("Παραδομένες αναφορές", "Delivered reports")}
            {!!inbox.data?.unread && <span className="rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white">{inbox.data.unread}</span>}
          </h3>
          {!!inbox.data?.unread && <button onClick={() => markRead.mutate()} className="text-xs font-medium text-sky-600 hover:underline">{t("Σήμανση ως διαβασμένα", "Mark all read")}</button>}
        </div>
        {!inbox.data?.items?.length ? (
          <p className="py-6 text-center text-sm text-slate-400">{t("Καμία αναφορά ακόμη.", "No reports yet.")}</p>
        ) : (
          <div className="space-y-2">
            {inbox.data.items.map((run) => {
              const pending = run.status === "pending_approval";
              return (
              <div key={run._id} className={`rounded-xl border p-3 ${pending ? "border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/20" : run.read ? "border-slate-200 dark:border-slate-700" : "border-sky-300 bg-sky-50/50 dark:border-sky-800 dark:bg-sky-950/20"}`}>
                <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-1 font-semibold text-slate-600 dark:text-slate-300">
                    {run.kind === "message" && <MessageSquare className="h-3 w-3" />}{run.routine_name}{!run.ok ? " · ⚠️" : ""}
                    {run.status === "sent" && run.kind === "message" && <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">{t("στάλθηκε", "sent")}</span>}
                    {run.status === "rejected" && <span className="rounded bg-slate-200 px-1 text-[10px] text-slate-500 dark:bg-slate-700">{t("απορρίφθηκε", "rejected")}</span>}
                  </span>
                  <span>{fmt(run.at)}</span>
                </div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-200">{run.report}</div>
                {pending && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button onClick={() => approve.mutate(run._id)} disabled={approve.isPending} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Check className="h-3.5 w-3.5" /> {t("Έγκριση & αποστολή", "Approve & send")}{run.audience_count != null ? ` (${run.audience_count} · ~${eur(run.est_cost_cents)})` : ""}</button>
                    <button onClick={() => reject.mutate(run._id)} disabled={reject.isPending} className="inline-flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800"><X className="h-3.5 w-3.5" /> {t("Απόρριψη", "Reject")}</button>
                  </div>
                )}
              </div>
            );})}
          </div>
        )}
      </section>
    </div>
  );
}

const SEGMENTS: [string, string, string | null][] = [
  ["all", "Όλοι οι πελάτες (με συναίνεση)", null],
  ["upcoming", "Επικείμενη επανάληψη", "ημέρες (π.χ. 30)"],
  ["inactive", "Ανενεργοί", "ημέρες (π.χ. 180)"],
  ["icd", "Με διάγνωση ICD-10", "κωδικός ICD-10"],
  ["substance", "Με δραστική/ATC", "ATC ή δραστική"],
];

function NewRoutineForm({ onDone, onCancel, t }: { onDone: () => void; onCancel: () => void; t: (a: string, b: string) => string }) {
  const [rtype, setRtype] = useState<"report" | "message">("report");
  const [name, setName] = useState("");
  // report
  const [tool, setTool] = useState("get_top");
  const [dim, setDim] = useState("patients");
  const [daysBack, setDaysBack] = useState("0");
  const [delivery, setDelivery] = useState("inapp");
  const [email, setEmail] = useState("");
  // message
  const [channel, setChannel] = useState("sms");
  const [segment, setSegment] = useState("all");
  const [segValue, setSegValue] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState("draft");
  const [maxRecipients, setMaxRecipients] = useState("100");
  // schedule
  const [kind, setKind] = useState("daily");
  const [time, setTime] = useState("10:00");
  const [weekday, setWeekday] = useState("0");
  const [dom, setDom] = useState("1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isTop = tool === "get_top";
  const segNeedsValue = SEGMENTS.find(([v]) => v === segment)?.[2] || null;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const schedule: Record<string, unknown> = { kind, time };
      if (kind === "weekly") schedule.weekday = Number(weekday);
      if (kind === "monthly") schedule.dom = Number(dom);
      let body: Record<string, unknown>;
      if (rtype === "message") {
        if (!message.trim()) { setErr(t("Γράψε το κείμενο του μηνύματος.", "Write the message text.")); setBusy(false); return; }
        body = { action: "message", name: name || t("Μήνυμα πελατών", "Customer message"), schedule, channel, segment, value: segNeedsValue ? segValue : null, subject: channel === "email" ? subject : null, message, mode, max_recipients: Number(maxRecipients) };
      } else {
        const report_args: Record<string, unknown> = {};
        if (isTop) { report_args.dim = dim; report_args.days_back = Number(daysBack); }
        body = { action: "report", name: name || REPORT_TOOLS.find(([v]) => v === tool)?.[1], schedule, report_tool: tool, report_args, delivery, email: delivery === "email" ? email : null };
      }
      const r = await api<{ ok: boolean }>("/copilot/routines", { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) { setErr(t("Αποτυχία.", "Failed.")); return; }
      onDone();
    } catch { setErr(t("Αποτυχία.", "Failed.")); }
    finally { setBusy(false); }
  };

  const field = "rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800";
  const Tab = ({ v, icon: Ic, label }: { v: "report" | "message"; icon: typeof Send; label: string }) => (
    <button onClick={() => setRtype(v)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${rtype === v ? "bg-sky-600 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600"}`}><Ic className="h-4 w-4" /> {label}</button>
  );
  return (
    <div className="rounded-2xl border border-sky-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tab v="report" icon={CalendarClock} label={t("Αναφορά", "Report")} />
        <Tab v="message" icon={MessageSquare} label={t("Μήνυμα σε πελάτες", "Message to customers")} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-500 sm:col-span-2">{t("Όνομα", "Name")}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={rtype === "message" ? t("π.χ. Υπενθύμιση επανάληψης", "e.g. Refill reminder") : t("π.χ. Πρωινός top πελάτης", "e.g. Morning top customer")} className={`mt-1 block w-full ${field}`} />
        </label>

        {rtype === "report" ? (
          <>
            <label className="block text-xs font-medium text-slate-500">{t("Αναφορά", "Report")}
              <select value={tool} onChange={(e) => setTool(e.target.value)} className={`mt-1 block w-full ${field}`}>
                {REPORT_TOOLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {isTop && (
              <label className="block text-xs font-medium text-slate-500">{t("Διάσταση", "Dimension")}
                <select value={dim} onChange={(e) => setDim(e.target.value)} className={`mt-1 block w-full ${field}`}>
                  <option value="patients">{t("Πελάτες", "Customers")}</option>
                  <option value="doctors">{t("Ιατροί", "Doctors")}</option>
                  <option value="products">{t("Προϊόντα", "Products")}</option>
                  <option value="icd10">ICD-10</option>
                </select>
              </label>
            )}
            {isTop && (
              <label className="block text-xs font-medium text-slate-500">{t("Περίοδος", "Period")}
                <select value={daysBack} onChange={(e) => setDaysBack(e.target.value)} className={`mt-1 block w-full ${field}`}>
                  <option value="0">{t("Σήμερα", "Today")}</option>
                  <option value="1">{t("Χθες", "Yesterday")}</option>
                </select>
              </label>
            )}
            <label className="block text-xs font-medium text-slate-500">{t("Παράδοση", "Delivery")}
              <select value={delivery} onChange={(e) => setDelivery(e.target.value)} className={`mt-1 block w-full ${field}`}>
                <option value="inapp">{t("Στην εφαρμογή", "In-app")}</option>
                <option value="email">Email</option>
              </select>
            </label>
            {delivery === "email" && (
              <label className="block text-xs font-medium text-slate-500">Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@pharmacy.gr" className={`mt-1 block w-full ${field}`} />
              </label>
            )}
          </>
        ) : (
          <>
            <label className="block text-xs font-medium text-slate-500">{t("Κανάλι", "Channel")}
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className={`mt-1 block w-full ${field}`}>
                <option value="sms">SMS</option>
                <option value="viber">Viber</option>
                <option value="email">Email</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-500">{t("Παραλήπτες", "Recipients")}
              <select value={segment} onChange={(e) => setSegment(e.target.value)} className={`mt-1 block w-full ${field}`}>
                {SEGMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {segNeedsValue && (
              <label className="block text-xs font-medium text-slate-500 sm:col-span-2">{t("Παράμετρος", "Parameter")}
                <input value={segValue} onChange={(e) => setSegValue(e.target.value)} placeholder={segNeedsValue} className={`mt-1 block w-full ${field}`} />
              </label>
            )}
            {channel === "email" && (
              <label className="block text-xs font-medium text-slate-500 sm:col-span-2">{t("Θέμα", "Subject")}
                <input value={subject} onChange={(e) => setSubject(e.target.value)} className={`mt-1 block w-full ${field}`} />
              </label>
            )}
            <label className="block text-xs font-medium text-slate-500 sm:col-span-2">{t("Μήνυμα", "Message")}
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder={t("Γεια σας {first}! …", "Hi {first}! …")} className={`mt-1 block w-full ${field}`} />
              <span className="mt-0.5 block text-[11px] text-slate-400">{t("Χρησιμοποίησε {first} για το όνομα. Στέλνεται μόνο σε πελάτες με συναίνεση, με χρέωση μονάδων.", "Use {first} for the name. Sent only to consented customers, charged per message.")}</span>
            </label>
            <label className="block text-xs font-medium text-slate-500">{t("Τρόπος αποστολής", "Send mode")}
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={`mt-1 block w-full ${field}`}>
                <option value="draft">{t("Με έγκρισή μου κάθε φορά", "Approve each time")}</option>
                <option value="auto">{t("Αυτόματα (με όριο)", "Automatic (with cap)")}</option>
              </select>
            </label>
            {mode === "auto" && (
              <label className="block text-xs font-medium text-slate-500">{t("Μέγιστοι παραλήπτες/φορά", "Max recipients/run")}
                <input type="number" min={1} max={5000} value={maxRecipients} onChange={(e) => setMaxRecipients(e.target.value)} className={`mt-1 block w-full ${field}`} />
              </label>
            )}
          </>
        )}

        <label className="block text-xs font-medium text-slate-500">{t("Συχνότητα", "Frequency")}
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={`mt-1 block w-full ${field}`}>
            <option value="daily">{t("Κάθε μέρα", "Daily")}</option>
            <option value="weekly">{t("Κάθε εβδομάδα", "Weekly")}</option>
            <option value="monthly">{t("Κάθε μήνα", "Monthly")}</option>
          </select>
        </label>
        <label className="block text-xs font-medium text-slate-500">{t("Ώρα", "Time")}
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`mt-1 block w-full ${field}`} />
        </label>
        {kind === "weekly" && (
          <label className="block text-xs font-medium text-slate-500">{t("Ημέρα", "Day")}
            <select value={weekday} onChange={(e) => setWeekday(e.target.value)} className={`mt-1 block w-full ${field}`}>
              {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </label>
        )}
        {kind === "monthly" && (
          <label className="block text-xs font-medium text-slate-500">{t("Ημέρα μήνα", "Day of month")}
            <input type="number" min={1} max={31} value={dom} onChange={(e) => setDom(e.target.value)} className={`mt-1 block w-full ${field}`} />
          </label>
        )}
      </div>
      {rtype === "message" && mode === "auto" && (
        <p className="mt-3 rounded-lg bg-amber-50 p-2 text-[11px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">⚠️ {t("Αυτόματη αποστολή: τα μηνύματα φεύγουν χωρίς να σε ρωτήσουμε (μέχρι το όριο). Χρησιμοποίησέ το μόνο αν είσαι σίγουρος.", "Automatic send: messages go out without asking (up to the cap). Use only if you're sure.")}</p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">{busy ? t("Αποθήκευση…", "Saving…") : t("Δημιουργία", "Create")}</button>
        <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700">{t("Άκυρο", "Cancel")}</button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
      </div>
    </div>
  );
}
