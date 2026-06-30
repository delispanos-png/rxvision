"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Truck, Pill, CalendarClock, PackageCheck, FileText, AlertTriangle, X, Check, Loader2, Send } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { Modal } from "@/components/ui/Modal";

// fallback defaults — τα πραγματικά timings έρχονται global από το adminpanel (/platform/status)
const DEF_REPEAT_S = 30, DEF_ESCALATE_M = 3;

/** Short attention beep via Web Audio (no asset). Browsers allow it once the user has interacted. */
function beep() {
  try {
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = new Ctx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start(); o.stop(ctx.currentTime + 0.45);
    o.onended = () => ctx.close();
  } catch { /* audio blocked until a user gesture — ignore */ }
}

type PortalItem = { id: string; kind: string; title: string; who?: string; when?: string };
type Order = { _id: string; patient_name?: string; total_cents?: number; mode?: string; status: string; has_medicine?: boolean; created_at?: string };

const eur = (c?: number) => `${((c || 0) / 100).toFixed(2).replace(".", ",")} €`;
const ORDER_ACTIONABLE = ["new", "preparing"];

function BellBtn({ icon: Icon, count, label, tint, active, onClick }: {
  icon: React.ComponentType<{ className?: string }>; count: number; label: string; tint: string; active: boolean; onClick: () => void;
}) {
  return (
    <Tooltip label={count > 0 ? `${label} (${count})` : label}>
      <button onClick={onClick} aria-label={label}
        className={`relative grid h-9 w-9 place-items-center rounded-lg hover:bg-white dark:hover:bg-slate-800 ${active ? "bg-white dark:bg-slate-800" : ""} text-slate-500 dark:text-slate-300`}>
        <Icon className={`h-[18px] w-[18px] ${count > 0 ? tint : ""}`} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-h-[16px] min-w-[16px] animate-pulse place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

// ── περιγραφή «τι να κάνεις» ανά αίτημα πελάτη ──
function portalCfg(kind: string, t: (a: string, b: string) => string) {
  switch (kind) {
    case "availability": return { Icon: Pill, label: t("Απάντησε σε ερώτηση διαθεσιμότητας", "Answer availability question"), cls: "bg-sky-50 text-sky-600" };
    case "pickup": return { Icon: PackageCheck, label: t("Ετοίμασε παραλαβή συνταγής", "Prepare prescription pickup"), cls: "bg-emerald-50 text-emerald-600" };
    case "rx_request": return { Icon: FileText, label: t("Ανάλαβε ανάθεση συνταγής", "Handle prescription request"), cls: "bg-violet-50 text-violet-600" };
    default: return { Icon: CalendarClock, label: t("Διαχειρίσου αίτημα ραντεβού", "Manage appointment request"), cls: "bg-amber-50 text-amber-600" };
  }
}

function fmtWhen(s?: string) { return s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""; }

/** Two top-bar alerts the pharmacist can't miss: pending patient requests (portal) + pending
 *  delivery orders. Click an icon → a LIST of what to do (no hunting across modules). The sound
 *  repeats every 30s and a popup escalates after 3 min while anything is still unhandled. */
export function NotificationBells({ modules }: { modules?: Record<string, string> }) {
  const router = useRouter();
  const t = useT();
  const on = (m: string) => modules?.[m] === "enabled" || modules?.[m] === "trial";
  const portalOn = on("patient_portal");
  const ordersOn = on("order_delivery");

  const portal = useQuery({
    queryKey: ["nb-portal"], queryFn: () => api<{ items: PortalItem[]; count: number }>("/portal/pending"),
    enabled: portalOn, refetchInterval: 15000, retry: false,
  });
  const orders = useQuery({
    queryKey: ["nb-orders-list"], queryFn: () => api<{ items: Order[] }>("/orders/delivery"),
    enabled: ordersOn, refetchInterval: 15000, retry: false,
  });
  // καθολικά timings από το adminpanel (public endpoint)
  const cfg = useQuery({
    queryKey: ["platform-notif-cfg"],
    queryFn: () => api<{ notifications?: { sound_repeat_seconds: number; escalate_popup_minutes: number } }>("/platform/status"),
    staleTime: 5 * 60 * 1000, retry: false,
  });
  const repeatMs = (cfg.data?.notifications?.sound_repeat_seconds ?? DEF_REPEAT_S) * 1000;
  const escalateMs = (cfg.data?.notifications?.escalate_popup_minutes ?? DEF_ESCALATE_M) * 60_000;

  const portalItems = portalOn ? (portal.data?.items ?? []) : [];
  const orderItems = ordersOn ? (orders.data?.items ?? []).filter((o) => ORDER_ACTIONABLE.includes(o.status)) : [];
  const portalCount = portalItems.length;
  const ordersCount = orderItems.length;
  const total = portalCount + ordersCount;

  const [panel, setPanel] = useState<null | "portal" | "orders">(null);
  const [acked, setAcked] = useState(0);            // επίπεδο εκκρεμοτήτων που ο χρήστης «είδε»
  const [escalate, setEscalate] = useState(false);  // το 3-λεπτο popup
  const [answers, setAnswers] = useState<Record<string, string>>({});  // γρήγορη απάντηση διαθεσιμότητας
  const [busyId, setBusyId] = useState<string | null>(null);
  const unacked = total > acked;

  // Αποδοχή/Απόρριψη/Απάντηση επιτόπου — καλεί τα υπάρχοντα endpoints και ανανεώνει τη λίστα
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (a: { id: string; url: string; body: object }) => { setBusyId(a.id); return api(a.url, { method: "POST", body: JSON.stringify(a.body) }); },
    onSettled: () => { setBusyId(null); qc.invalidateQueries({ queryKey: ["nb-portal"] }); qc.invalidateQueries({ queryKey: ["nb-orders-list"] }); },
  });
  const apptStatus = (id: string, status: string) => act.mutate({ id, url: `/portal/appointments/${id}/status`, body: { status } });
  const rxStatus = (id: string, status: string) => act.mutate({ id, url: `/portal/rx-requests/${id}/status`, body: { status } });
  const orderStatus = (id: string, status: string) => act.mutate({ id, url: `/orders/delivery/${id}/status`, body: { status } });
  const sendAnswer = (id: string) => { const a = (answers[id] || "").trim(); if (a) act.mutate({ id, url: `/portal/availability/${id}/answer`, body: { answer: a } }); };

  // αν λύθηκαν εκκρεμότητες (έπεσε ο αριθμός), χαμήλωσε το acked ώστε μια ΝΕΑ να ξαναχτυπήσει
  useEffect(() => { if (total < acked) setAcked(total); }, [total, acked]);

  // επαναλαμβανόμενος ήχος κάθε 30s + escalation σε popup μετά 3′, όσο υπάρχει κάτι αδιαχείριστο
  const sinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!unacked) { sinceRef.current = null; setEscalate(false); return; }
    if (sinceRef.current === null) sinceRef.current = Date.now();
    beep();
    const iv = window.setInterval(beep, repeatMs);
    const remaining = Math.max(0, escalateMs - (Date.now() - sinceRef.current));
    const esc = window.setTimeout(() => setEscalate(true), remaining);
    return () => { window.clearInterval(iv); window.clearTimeout(esc); };
  }, [unacked, repeatMs, escalateMs]);

  const acknowledge = () => { setAcked(total); setEscalate(false); };
  const openPanel = (which: "portal" | "orders") => { setPanel(panel === which ? null : which); acknowledge(); };
  const goPortal = () => { setPanel(null); setEscalate(false); acknowledge(); router.push("/portal-admin"); };
  const goOrders = () => { setPanel(null); setEscalate(false); acknowledge(); router.push("/orders-delivery"); };

  if (!portalOn && !ordersOn) return null;

  const Accept = ({ onClick, label }: { onClick: () => void; label: string }) => (
    <button onClick={onClick} disabled={act.isPending}
      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
      <Check className="h-3.5 w-3.5" /> {label}
    </button>
  );
  const Reject = ({ onClick, label }: { onClick: () => void; label: string }) => (
    <button onClick={onClick} disabled={act.isPending}
      className="inline-flex items-center gap-1 rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800">
      <X className="h-3.5 w-3.5" /> {label}
    </button>
  );

  const PortalRow = ({ it }: { it: PortalItem }) => {
    const c = portalCfg(it.kind, t);
    const busy = busyId === it.id && act.isPending;
    return (
      <div className="rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${c.cls}`}><c.Icon className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{c.label}</span>
            <span className="block text-xs text-slate-500">{it.title}{it.who ? ` · ${it.who}` : ""}{it.when ? ` · ${fmtWhen(it.when)}` : ""}</span>
          </span>
          {busy && <Loader2 className="mt-1.5 h-4 w-4 shrink-0 animate-spin text-slate-400" />}
        </div>
        {/* αποδοχή/απόρριψη επιτόπου */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-11">
          {it.kind === "availability" ? (
            <div className="flex w-full items-center gap-1.5">
              <input value={answers[it.id] || ""} onChange={(e) => setAnswers((s) => ({ ...s, [it.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && sendAnswer(it.id)} placeholder={t("Γράψε απάντηση…", "Type a reply…")}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
              <button onClick={() => sendAnswer(it.id)} disabled={act.isPending || !(answers[it.id] || "").trim()}
                className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"><Send className="h-3.5 w-3.5" /> {t("Στείλε", "Send")}</button>
            </div>
          ) : it.kind === "rx_request" ? (
            <>
              <Accept label={t("Αποδοχή", "Accept")} onClick={() => rxStatus(it.id, "in_progress")} />
              <Reject label={t("Απόρριψη", "Reject")} onClick={() => rxStatus(it.id, "rejected")} />
            </>
          ) : it.kind === "pickup" ? (
            <>
              <Accept label={t("Αποδοχή (έτοιμη)", "Accept (ready)")} onClick={() => apptStatus(it.id, "ready")} />
              <Reject label={t("Απόρριψη", "Reject")} onClick={() => apptStatus(it.id, "cancelled")} />
            </>
          ) : (
            <>
              <Accept label={t("Αποδοχή", "Accept")} onClick={() => apptStatus(it.id, "confirmed")} />
              <Reject label={t("Απόρριψη", "Reject")} onClick={() => apptStatus(it.id, "cancelled")} />
            </>
          )}
        </div>
      </div>
    );
  };

  const OrderRow = ({ o }: { o: Order }) => {
    const busy = busyId === o._id && act.isPending;
    return (
      <div className="rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600"><Truck className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
              {o.status === "new" ? t("Νέα παραγγελία", "New order") : t("Σε ετοιμασία", "Preparing")}
            </span>
            <span className="block text-xs text-slate-500">
              {o.patient_name || t("Πελάτης", "Customer")} · {eur(o.total_cents)} · {o.mode === "pickup" ? t("Παραλαβή", "Pickup") : t("Αποστολή", "Delivery")}{o.has_medicine ? ` · ${t("φάρμακο", "medicine")}` : ""}
            </span>
          </span>
          {busy && <Loader2 className="mt-1.5 h-4 w-4 shrink-0 animate-spin text-slate-400" />}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-11">
          {o.status === "new" ? (
            <>
              <Accept label={t("Αποδοχή (ετοιμασία)", "Accept (prepare)")} onClick={() => orderStatus(o._id, "preparing")} />
              <Reject label={t("Απόρριψη", "Reject")} onClick={() => orderStatus(o._id, "cancelled")} />
            </>
          ) : (
            <>
              <Accept label={o.mode === "pickup" ? t("Έτοιμη", "Ready") : t("Απεστάλη", "Dispatched")}
                onClick={() => orderStatus(o._id, o.mode === "pickup" ? "ready" : "shipped")} />
              <Reject label={t("Ακύρωση", "Cancel")} onClick={() => orderStatus(o._id, "cancelled")} />
            </>
          )}
        </div>
      </div>
    );
  };

  const list = (
    <div className="max-h-[60vh] space-y-0.5 overflow-auto">
      {panel === "portal" && (portalCount ? portalItems.map((it) => <PortalRow key={it.id} it={it} />)
        : <div className="px-3 py-6 text-center text-sm text-slate-400">{t("Καμία εκκρεμότητα 🎉", "Nothing pending 🎉")}</div>)}
      {panel === "orders" && (ordersCount ? orderItems.map((o) => <OrderRow key={o._id} o={o} />)
        : <div className="px-3 py-6 text-center text-sm text-slate-400">{t("Καμία εκκρεμότητα 🎉", "Nothing pending 🎉")}</div>)}
    </div>
  );

  return (
    <div className="relative flex items-center gap-1">
      {portalOn && <BellBtn icon={Bell} count={portalCount} tint="text-rose-500" active={panel === "portal"}
        label={t("Αιτήματα πελατών", "Patient requests")} onClick={() => openPanel("portal")} />}
      {ordersOn && <BellBtn icon={Truck} count={ordersCount} tint="text-amber-500" active={panel === "orders"}
        label={t("Παραγγελίες προς αποστολή", "Delivery orders")} onClick={() => openPanel("orders")} />}

      {/* dropdown λίστα «τι να κάνεις» */}
      {panel && (
        <>
          <button aria-hidden className="fixed inset-0 z-[190] cursor-default" onClick={() => setPanel(null)} />
          <div className="absolute right-0 top-full z-[200] mt-2 w-[min(92vw,22rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
              <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
                {panel === "portal" ? t("Αιτήματα πελατών", "Patient requests") : t("Παραγγελίες", "Orders")}
                <span className="ml-1.5 text-xs font-normal text-slate-400">({panel === "portal" ? portalCount : ordersCount})</span>
              </span>
              <button onClick={() => setPanel(null)} aria-label={t("Κλείσιμο", "Close")} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-1.5">{list}</div>
            <button onClick={panel === "portal" ? goPortal : goOrders}
              className="block w-full border-t border-slate-100 px-3 py-2 text-center text-sm font-semibold text-brand-600 hover:bg-brand-50 dark:border-slate-800 dark:hover:bg-slate-800">
              {t("Άνοιγμα σελίδας", "Open full page")} →
            </button>
          </div>
        </>
      )}

      {/* escalation popup μετά από 3 λεπτά χωρίς διαχείριση */}
      <Modal open={escalate && total > 0} onClose={acknowledge} size="md"
        title={<span className="flex items-center gap-2 text-rose-600"><AlertTriangle className="h-5 w-5" /> {t("Εκκρεμότητες που περιμένουν!", "Pending actions waiting!")}</span>}
        footer={<button onClick={acknowledge} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">{t("Το είδα", "Got it")}</button>}>
        <p className="mb-3 text-sm text-slate-500">{t("Υπάρχουν αιτήματα/παραγγελίες αδιαχείριστα πάνω από 3 λεπτά. Δες τι πρέπει να γίνει:", "Requests/orders unhandled for over 3 minutes. Here's what to do:")}</p>
        <div className="space-y-0.5">
          {portalItems.map((it) => <PortalRow key={`p-${it.id}`} it={it} />)}
          {orderItems.map((o) => <OrderRow key={`o-${o._id}`} o={o} />)}
        </div>
      </Modal>
    </div>
  );
}
