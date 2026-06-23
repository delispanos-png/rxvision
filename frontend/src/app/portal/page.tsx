"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Pill, Wallet, ShieldCheck, RefreshCw, Stethoscope, Bell, LogOut, Building2,
  Calendar, ChevronDown, ChevronUp, CheckCircle2, Clock, Sparkles, X, Search, CalendarPlus, AlertCircle,
  PackageCheck, Gift,
} from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { Tooltip } from "@/components/ui/Tooltip";
import { LogoMark } from "@/components/brand/Logo";
import { patientApi, patientTokens, patientUpload } from "@/lib/patientClient";
import { PharmacyPicker, MedicinePicker, type Medicine } from "@/components/portal/pickers";
import { pushSupported, isPushSubscribed, enablePush } from "@/lib/push";
import { BellRing } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/formatters";

type Pharmacy = { tenant_id: string; pharmacy_name: string };
type Me = { profile: { first_name: string; last_name: string }; active_tenant: string | null; pharmacies: Pharmacy[] };
type Summary = { rx_count: number; paid_cents: number; total_cents: number; covered_cents: number; doctors: number; medicines: number; repeats_active: number; next_open_date?: string | null; first_at?: string | null; last_at?: string | null };
type Rx = { barcode: string; executed_at: string; status?: string; patient_share?: number; repeat_current?: number; repeat_total?: number; repeat_root?: string | null; next_open_date?: string | null; medicines: string[]; pending?: string[]; partial?: boolean; doctor?: string | null; specialty?: string | null };
type RepeatMed = { name: string; dosage?: string | null };
type Repeat = Omit<Rx, "medicines"> & { medicines: RepeatMed[] };
type RxItem = { name?: string | null; quantity?: number; retail_price?: number; is_executed?: boolean; dosage?: string | null };
type RxDetail = Rx & { amount_total?: number; icd10?: string[]; items: RxItem[] };
type Notif = { id: string; type: string; title: string; body: string; when?: string | null };
type Avail = { _id?: string; query: string; medicine_name?: string | null; status: string; answer?: string | null; created_at: string };
type PRange = { start_date: string; end_date: string; start: string; end: string };
type Service = { _id?: string; name: string; kind?: string; description?: string; availability?: { mode: string; slots: { day: number; start: string; end: string }[]; date_ranges?: PRange[] } };
const PDAYS = ["Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ", "Κυρ"];
const pdmy = (iso: string) => { const [y, m, d] = iso.split("-"); return d && m ? `${d}/${m}${y ? "/" + y.slice(2) : ""}` : iso; };
const prange = (r: PRange) => (r.start_date === r.end_date ? pdmy(r.start_date) : `${pdmy(r.start_date)}–${pdmy(r.end_date)}`) + ` ${r.start}–${r.end}`;
type Appt = { _id?: string; service_name: string; requested_at: string; status: string };
type Cda = { available?: boolean; found?: boolean; doctor?: string | null; medicines?: string[]; issue_date?: string | null; deadline_date?: string | null; intangible?: boolean; exec_count?: number | null; is_fyk?: boolean; has_vaccine?: boolean };
type RxReq = { _id?: string; kind: string; barcode?: string | null; note?: string | null; status: string; created_at: string; cda?: Cda | null; reply?: string | null; available_date?: string | null };
type LoyaltyMember = { patient_ref: string; name?: string; points: number; balance_cents: number; tier: string; next_tier: string | null; to_next: number; progress_pct: number; compliance: number | null; refills: number; expected: number; open_refills: number; potential_points: number; points_per_refill: number; cents_per_point: number; ledger: { type: string; cents: number; kind?: string; reason?: string; at: string }[] };
type LReward = { _id?: string; title: string; type: string; cost_points: number; cost_cents: number; note?: string };
type Loyalty = { enabled: boolean; enrolled?: boolean; terms?: string; member?: LoyaltyMember | null; rewards?: LReward[] };
const RTYPE_EMOJI: Record<string, string> = { product: "🛍️", service: "💉", percent: "🏷️", cash: "💶" };

const dt = (s?: string | null) => (s ? fmtDate(s) : "—");
const dtl = (s?: string | null) => (s ? fmtDateTime(s) : "—");
const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format((c || 0) / 100);

const TABS = [["rx", "Συνταγές"], ["wallet", "Επιβράβευση"], ["repeats", "Επαναλήψεις"], ["assign", "Ανάθεση συνταγής"], ["availability", "Διαθεσιμότητα"], ["appointments", "Ραντεβού"]] as const;
const TIER_GR: Record<string, string> = { Bronze: "Χάλκινο", Silver: "Ασημένιο", Gold: "Χρυσό", Platinum: "Πλατινένιο" };

const STATUS_LABEL: Record<string, string> = {
  open: "Σε αναμονή", requested: "Ζητήθηκε", confirmed: "Επιβεβαιωμένο", ready: "Έτοιμη για παραλαβή",
  answered: "Απαντήθηκε", done: "Ολοκληρώθηκε", cancelled: "Ακυρώθηκε", rejected: "Απορρίφθηκε",
  new: "Νέα", in_progress: "Σε εξέλιξη",
};
const statusCls = (s: string) =>
  ["confirmed", "ready", "answered", "done"].includes(s) ? "bg-emerald-100 text-emerald-700"
  : ["cancelled", "rejected"].includes(s) ? "bg-rose-100 text-rose-700"
  : "bg-amber-100 text-amber-700";

export default function PortalHome() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [noPharmacy, setNoPharmacy] = useState(false);
  const [tab, setTab] = useState<string>("rx");
  const [rx, setRx] = useState<Rx[]>([]);
  const [repeats, setRepeats] = useState<Repeat[]>([]);
  const [avail, setAvail] = useState<Avail[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [appts, setAppts] = useState<Appt[]>([]);
  const [rxReqs, setRxReqs] = useState<RxReq[]>([]);
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [assignBc, setAssignBc] = useState("");
  const [assignNote, setAssignNote] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);
  const [availTarget, setAvailTarget] = useState("");
  const [availMed, setAvailMed] = useState<Medicine | null>(null);
  const [availNote, setAvailNote] = useState("");
  const [apptTarget, setApptTarget] = useState("");
  const [appt, setAppt] = useState({ service_name: "", date: "", time: "" });
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<RxDetail | null>(null);
  const [pickupFor, setPickupFor] = useState<string | null>(null);
  const [pickupAt, setPickupAt] = useState("");
  const [pickupDone, setPickupDone] = useState<Record<string, string>>({});
  const [pushSup, setPushSup] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  useEffect(() => {
    setPushSup(pushSupported());
    isPushSubscribed().then(setPushOn).catch(() => {});
  }, []);
  async function onEnablePush() {
    setPushBusy(true); setPushMsg(null);
    const r = await enablePush();
    setPushBusy(false);
    if (r === "ok") { setPushOn(true); setPushMsg("Ενεργοποιήθηκαν οι ειδοποιήσεις στο κινητό σου ✓"); }
    else if (r === "denied") setPushMsg("Οι ειδοποιήσεις είναι μπλοκαρισμένες — ενεργοποίησέ τες από τις ρυθμίσεις του browser.");
    else if (r === "unsupported") setPushMsg("Στο iPhone: πρόσθεσε πρώτα την εφαρμογή στην οθόνη αφετηρίας (Κοινή χρήση → Προσθήκη στην Αρχική).");
    else setPushMsg("Κάτι πήγε στραβά. Δοκίμασε ξανά.");
  }

  const load = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!patientTokens.access) {
      if (!window.localStorage.getItem("patient_refresh_token")) { router.replace("/portal/login"); return; }
      setNoPharmacy(true); return;
    }
    try {
      const m = await patientApi<Me>("/patient/me");
      setMe(m);
      if (m.active_tenant) { setAvailTarget((t) => t || m.active_tenant!); setApptTarget((t) => t || m.active_tenant!); }
      const [s, p, r, n] = await Promise.all([
        patientApi<Summary>("/patient/summary"),
        patientApi<{ items: Rx[] }>("/patient/prescriptions"),
        patientApi<{ items: Repeat[] }>("/patient/repeats"),
        patientApi<{ items: Notif[] }>("/patient/notifications"),
      ]);
      setSummary(s); setRx(p.items); setRepeats(r.items); setNotifs(n.items);
      if (n.items.length) setShowNotifs(true);
    } catch { /* patientApi redirects to /portal/login on 401 */ }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!me) return;
    if (tab === "wallet") patientApi<Loyalty>("/patient/loyalty").then(setLoyalty).catch(() => {});
    if (tab === "assign") patientApi<{ items: RxReq[] }>("/patient/rx-requests").then((d) => setRxReqs(d.items)).catch(() => {});
    if (tab === "availability") patientApi<{ items: Avail[] }>("/patient/availability").then((d) => setAvail(d.items)).catch(() => {});
    if (tab === "appointments") {
      if (apptTarget) patientApi<{ items: Service[] }>(`/patient/services?tenant_id=${apptTarget}`).then((d) => setServices(d.items)).catch(() => {});
      patientApi<{ items: Appt[] }>("/patient/appointments").then((d) => setAppts(d.items)).catch(() => {});
    }
  }, [tab, me, apptTarget]);

  // Live updates: poll every 12s so a pharmacist's answer / status change appears WITHOUT a manual
  // refresh. Pauses while the tab is hidden to save battery/requests.
  useEffect(() => {
    if (!me) return;
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const n = await patientApi<{ items: Notif[] }>("/patient/notifications");
        setNotifs(n.items);
        if (n.items.length) setShowNotifs(true);
        if (tab === "availability") setAvail((await patientApi<{ items: Avail[] }>("/patient/availability")).items);
        if (tab === "appointments") setAppts((await patientApi<{ items: Appt[] }>("/patient/appointments")).items);
      } catch { /* ignore transient errors */ }
    };
    const id = window.setInterval(tick, 12000);
    return () => window.clearInterval(id);
  }, [me, tab]);

  async function switchPharmacy(tenant_id: string) {
    const d = await patientApi<{ access_token: string }>("/patient/auth/select-pharmacy", { method: "POST", body: JSON.stringify({ tenant_id }) });
    patientTokens.set(d.access_token, window.localStorage.getItem("patient_refresh_token"));
    await load();
  }
  function logout() { patientTokens.clear(); router.replace("/portal/login"); }

  async function toggleExpand(barcode: string) {
    if (expanded === barcode) { setExpanded(null); setDetail(null); return; }
    setExpanded(barcode); setDetail(null);
    try { setDetail(await patientApi<RxDetail>(`/patient/prescriptions/${encodeURIComponent(barcode)}`)); } catch { /* ignore */ }
  }

  async function askAvailability(e: React.FormEvent) {
    e.preventDefault();
    if (!availMed && !availNote.trim()) return;
    await patientApi("/patient/availability", { method: "POST", body: JSON.stringify({
      tenant_id: availTarget || undefined,
      medicine_barcode: availMed?.barcode ?? undefined,
      medicine_name: availMed?.name ?? undefined,
      query: availNote || undefined,
    }) });
    setAvailMed(null); setAvailNote("");
    patientApi<{ items: Avail[] }>("/patient/availability").then((d) => setAvail(d.items));
  }
  const reloadRxReqs = () => patientApi<{ items: RxReq[] }>("/patient/rx-requests").then((d) => setRxReqs(d.items)).catch(() => {});
  async function joinLoyalty() {
    setAssignBusy(true);
    try { await patientApi("/patient/loyalty/join", { method: "POST" }); setLoyalty(await patientApi<Loyalty>("/patient/loyalty")); }
    catch { /* ignore */ } finally { setAssignBusy(false); }
  }
  async function submitBarcode(e: React.FormEvent) {
    e.preventDefault();
    if (assignBc.trim().length < 4) return;
    setAssignBusy(true); setAssignMsg(null);
    try {
      const r = await patientApi<{ id: string; cda?: Cda }>("/patient/rx-request", { method: "POST", body: JSON.stringify({ barcode: assignBc.trim(), note: assignNote || undefined }) });
      const c = r.cda;
      setAssignBc(""); setAssignNote("");
      if (c?.found) setAssignMsg(`✓ Επιβεβαιώθηκε από ΗΔΙΚΑ${c.medicines?.length ? ` — ${c.medicines.length} φάρμακα` : ""} · στάλθηκε στο φαρμακείο`);
      else if (c?.available) setAssignMsg("Στάλθηκε ✓ — δεν εντοπίστηκε στην ΗΔΙΚΑ, θα το ελέγξει το φαρμακείο");
      else setAssignMsg("Στάλθηκε στο φαρμακείο ✓");
      reloadRxReqs();
    } catch { setAssignMsg("Αποτυχία αποστολής."); } finally { setAssignBusy(false); }
  }
  async function submitPhoto(file: File) {
    setAssignBusy(true); setAssignMsg(null);
    try {
      const fd = new FormData(); fd.append("file", file); if (assignNote) fd.append("note", assignNote);
      await patientUpload("/patient/rx-request/photo", fd);
      setAssignNote(""); setAssignMsg("Η φωτογραφία στάλθηκε ✓"); reloadRxReqs();
    } catch { setAssignMsg("Αποτυχία αποστολής φωτογραφίας."); } finally { setAssignBusy(false); }
  }
  async function bookAppt(e: React.FormEvent) {
    e.preventDefault();
    if (!appt.service_name || !appt.date || !appt.time) return;
    const when = new Date(`${appt.date}T${appt.time}`);
    if (isNaN(when.getTime())) return;
    await patientApi("/patient/appointments", { method: "POST", body: JSON.stringify({
      tenant_id: apptTarget || undefined, service_name: appt.service_name,
      requested_at: when.toISOString(),
    }) });
    setAppt({ service_name: "", date: "", time: "" });
    patientApi<{ items: Appt[] }>("/patient/appointments").then((d) => setAppts(d.items));
  }
  async function bookPickup(p: Rx | Repeat) {
    if (!pickupAt) return;
    const names = p.medicines.map((m) => typeof m === "string" ? m : m.name).slice(0, 6).join(", ");
    await patientApi("/patient/appointments", { method: "POST", body: JSON.stringify({
      tenant_id: me?.active_tenant || undefined,
      kind: "pickup",
      service_name: "Παραλαβή συνταγής",
      requested_at: new Date(pickupAt).toISOString(),
      note: names,
    }) });
    setPickupDone((d) => ({ ...d, [p.barcode]: pickupAt }));
    setPickupFor(null); setPickupAt("");
  }

  if (noPharmacy) return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-200/50">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-100 text-brand-600"><CheckCircle2 className="h-7 w-7" /></div>
        <h1 className="text-lg font-bold text-slate-900">Ο λογαριασμός σου είναι έτοιμος</h1>
        <p className="mt-2 text-sm text-slate-500">Δεν βρέθηκε ακόμα ιστορικό σε φαρμακείο. Μόλις εξυπηρετηθείς σε φαρμακείο του δικτύου με το ΑΜΚΑ σου, οι συνταγές σου θα εμφανιστούν εδώ αυτόματα.</p>
        <button onClick={logout} className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"><LogOut className="h-4 w-4" /> Αποσύνδεση</button>
      </div>
    </div>
  );
  if (!me) return (
    <div className="flex min-h-screen items-center justify-center text-slate-400">
      <div className="flex items-center gap-2 text-sm"><RefreshCw className="h-4 w-4 animate-spin" /> Φόρτωση…</div>
    </div>
  );

  const activeName = me.pharmacies.find((p) => p.tenant_id === me.active_tenant)?.pharmacy_name;

  return (
    <div className="min-h-screen">
      {/* ── top bar ───────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-1.5 px-3 sm:gap-3 sm:px-4">
          <div className="flex items-center gap-2">
            <LogoMark className="h-9 w-9" />
            <div className="leading-tight">
              <div className="text-sm font-extrabold tracking-tight text-slate-900">RxVision</div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Πύλη Πελατών</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {me.pharmacies.length > 0 && (
              <div className="relative">
                <Building2 className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <select value={me.active_tenant ?? ""} onChange={(e) => switchPharmacy(e.target.value)}
                  className="max-w-[8rem] truncate rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-7 text-xs font-medium text-slate-700 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 sm:max-w-[16rem]">
                  {me.pharmacies.map((p) => <option key={p.tenant_id} value={p.tenant_id}>{p.pharmacy_name}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              </div>
            )}
            <Tooltip label="Ειδοποιήσεις"><button onClick={() => setShowNotifs((v) => !v)}
              className="relative grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50">
              <Bell className="h-[18px] w-[18px]" />
              {notifs.length > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{notifs.length}</span>}
            </button></Tooltip>
            <Tooltip label="Έξοδος"><button onClick={logout} className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50"><LogOut className="h-[18px] w-[18px]" /></button></Tooltip>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {/* ── hero ───────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl">Γεια σου, {me.profile.first_name} 👋</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
            {activeName ? <><Building2 className="h-4 w-4 text-brand-500" /> {activeName}</> : "Η υγεία σου, οργανωμένη."}
          </p>
        </div>

        {/* ── enable phone push ──────────────────────────────── */}
        {pushSup && !pushOn && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-indigo-50 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-brand-800">
              <BellRing className="h-5 w-5 shrink-0 text-brand-600" />
              Λάβε ειδοποίηση στο κινητό μόλις η συνταγή σου είναι έτοιμη ή ανοίγει.
            </div>
            <button onClick={onEnablePush} disabled={pushBusy}
              className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
              {pushBusy ? "…" : "Ενεργοποίηση"}
            </button>
          </div>
        )}
        {pushMsg && <div className="mb-4 rounded-xl bg-slate-100 px-4 py-2.5 text-sm text-slate-700">{pushMsg}</div>}

        {/* ── notifications ──────────────────────────────────── */}
        {showNotifs && notifs.length > 0 && (
          <div className="mb-6 overflow-hidden rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-indigo-50 shadow-sm">
            <div className="flex items-center justify-between border-b border-brand-100/70 px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-sm font-bold text-brand-700"><Bell className="h-4 w-4" /> Ειδοποιήσεις</span>
              <button onClick={() => setShowNotifs(false)} className="grid h-6 w-6 place-items-center rounded-lg text-brand-400 hover:bg-white/60"><X className="h-4 w-4" /></button>
            </div>
            <ul className="divide-y divide-brand-100/60">
              {notifs.map((n) => (
                <li key={n.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-brand-600 shadow-sm"><Sparkles className="h-3.5 w-3.5" /></span>
                  <div className="min-w-0">
                    <div className="break-words text-sm font-semibold text-slate-800">{n.title}</div>
                    <div className="break-words text-sm text-slate-600">{n.body}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── KPI cards ──────────────────────────────────────── */}
        {summary && (
          <div className="mb-7 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <Kpi icon={Pill} tint="indigo" label="Συνταγές" value={String(summary.rx_count)}
              sub={summary.last_at ? `τελευταία ${dt(summary.last_at)}` : "—"} />
            <Kpi icon={ShieldCheck} tint="emerald" label="Σε κάλυψε το ταμείο" value={eur(summary.covered_cents)}
              sub={`σε ${summary.rx_count} συνταγές`} highlight />
            <Kpi icon={Wallet} tint="amber" label="Πλήρωσες" value={eur(summary.paid_cents)}
              sub={`από ${eur(summary.total_cents)} σύνολο`} />
            <Kpi icon={RefreshCw} tint="violet" label="Ενεργές επαναλήψεις" value={String(summary.repeats_active)}
              sub={summary.next_open_date ? `επόμενη ${dt(summary.next_open_date)}` : "καμία προγραμματισμένη"} />
          </div>
        )}

        {/* ── tabs ───────────────────────────────────────────── */}
        <div className="mb-5 flex gap-2 overflow-x-auto p-0.5">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-none whitespace-nowrap rounded-xl border px-4 py-2.5 text-sm font-semibold transition sm:flex-1 ${tab === k
                ? "border-brand-600 bg-brand-600 text-white shadow-sm shadow-brand-500/30"
                : "border-slate-200 bg-white text-slate-700 shadow-sm hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* ── PRESCRIPTIONS ──────────────────────────────────── */}
        {tab === "rx" && (
          <div className="space-y-3">
            {rx.length === 0 && <Empty icon={Pill} text="Δεν υπάρχουν συνταγές ακόμα." />}
            {rx.map((p) => {
              const open = expanded === p.barcode;
              return (
                <div key={p.barcode} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md">
                  <button onClick={() => toggleExpand(p.barcode)} className="flex w-full items-center gap-3 p-4 text-left">
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${p.partial ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"}`}><Pill className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-800">#{p.barcode.split(":")[0]}</span>
                        {p.partial
                          ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700"><AlertCircle className="h-3 w-3" /> Μερική</span>
                          : <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700"><CheckCircle2 className="h-3 w-3" /> Πλήρης</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3 text-slate-400" /> εκτέλεση {dt(p.executed_at)}</span>
                        {p.next_open_date && <span className="inline-flex items-center gap-1 text-emerald-600"><Clock className="h-3 w-3" /> ανοίγει {dt(p.next_open_date)}</span>}
                      </div>
                    </div>
                    {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                  </button>
                  {open && (
                    <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
                      {!detail ? <div className="flex items-center gap-2 text-xs text-slate-400"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Φόρτωση…</div> : (
                        <>
                          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                            {activeName && <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-slate-400" /> {activeName}</span>}
                            {detail.doctor && <span className="inline-flex items-center gap-1"><Stethoscope className="h-3.5 w-3.5 text-slate-400" /> {detail.doctor}{detail.specialty ? ` · ${detail.specialty}` : ""}</span>}
                            {detail.repeat_total && detail.repeat_total > 1 ? <span className="inline-flex items-center gap-1"><RefreshCw className="h-3.5 w-3.5 text-slate-400" /> επανάληψη {detail.repeat_current}/{detail.repeat_total}</span> : null}
                          </div>
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Φάρμακα</div>
                          <ul className="divide-y divide-slate-200/70">
                            {detail.items.map((it, i) => (
                              <li key={i} className={`flex items-start justify-between gap-3 py-2 text-sm ${it.is_executed ? "text-slate-700" : "text-slate-400"}`}>
                                <span className="flex min-w-0 items-start gap-2">
                                  {it.is_executed
                                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                                    : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />}
                                  <span className="min-w-0">
                                    <span className="flex flex-wrap items-center gap-2">
                                      <span className={it.is_executed ? "" : "line-through"}>{it.name}{it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : ""}</span>
                                      {!it.is_executed && <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">δεν παραλήφθηκε</span>}
                                    </span>
                                    {it.dosage && <span className="mt-0.5 block text-xs text-slate-500">💊 {it.dosage}</span>}
                                  </span>
                                </span>
                                {it.is_executed && <span className="shrink-0 font-medium">{eur(it.retail_price)}</span>}
                              </li>
                            ))}
                          </ul>
                          {detail.icd10 && detail.icd10.length > 0 && (
                            <div className="mt-3 text-xs text-slate-400">Διάγνωση: {detail.icd10.join(", ")}</div>
                          )}
                          <div className="mt-3 flex items-center justify-end gap-4 border-t border-slate-200/70 pt-3 text-xs">
                            <span className="text-slate-500">Σύνολο: <b className="text-slate-700">{eur(detail.amount_total)}</b></span>
                            <span className="text-amber-600">Πλήρωσες: <b>{eur(detail.patient_share)}</b></span>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── REPEATS ────────────────────────────────────────── */}
        {tab === "repeats" && (
          <div className="space-y-3">
            {repeats.length === 0 && <Empty icon={RefreshCw} text="Δεν υπάρχουν επόμενες επαναλήψεις." />}
            {repeats.map((p) => {
              const open = expanded === p.barcode;
              return (
              <div key={p.barcode} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <button onClick={() => toggleExpand(p.barcode)} className="flex w-full items-center gap-3 p-4 text-left">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><RefreshCw className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm font-semibold text-slate-800">#{p.barcode.split(":")[0]}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="flex items-center justify-end gap-1 text-[11px] font-medium uppercase tracking-wide text-emerald-600"><Clock className="h-3 w-3" /> ανοίγει</div>
                    <div className="text-sm font-bold text-slate-800">{dt(p.next_open_date)}</div>
                  </div>
                  {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                </button>
                {open && (
                  <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Φάρμακα συνταγής</div>
                    {p.medicines.length === 0 ? <div className="text-xs text-slate-400">—</div> : (
                      <ul className="divide-y divide-slate-200/70">
                        {p.medicines.map((m, i) => (
                          <li key={i} className="flex items-start gap-2 py-2 text-sm text-slate-700">
                            <Pill className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                            <div className="min-w-0">
                              <div className="font-medium">{m.name}</div>
                              {m.dosage && <div className="text-xs text-slate-500">💊 {m.dosage}</div>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-2 text-[11px] text-slate-400">Θα είναι διαθέσιμη για εκτέλεση από {dt(p.next_open_date)} — δεν έχει εκτελεστεί ακόμα.</p>
                  </div>
                )}
                {pickupDone[p.barcode] ? (
                  <div className="flex items-center gap-1.5 border-t border-slate-100 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" /> Θα περάσεις να την παραλάβεις {dtl(pickupDone[p.barcode])}
                  </div>
                ) : pickupFor === p.barcode ? (
                  <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
                    <input type="datetime-local" value={pickupAt} min={new Date().toISOString().slice(0, 16)} onChange={(e) => setPickupAt(e.target.value)}
                      className="mb-2 w-full min-w-0 appearance-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
                    <div className="flex gap-2">
                      <button onClick={() => bookPickup(p)} disabled={!pickupAt}
                        className="flex-1 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Στείλε</button>
                      <button onClick={() => { setPickupFor(null); setPickupAt(""); }}
                        className="shrink-0 rounded-xl px-3 py-2.5 text-sm text-slate-500 hover:bg-slate-100">Άκυρο</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setPickupFor(p.barcode); setPickupAt(""); }}
                    className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 bg-white py-2.5 text-sm font-semibold text-brand-700 hover:bg-slate-50">
                    <PackageCheck className="h-4 w-4" /> Θα περάσω να την παραλάβω
                  </button>
                )}
              </div>
              );
            })}
          </div>
        )}

        {/* ── ΕΠΙΒΡΑΒΕΥΣΗ / ΠΟΡΤΟΦΟΛΙ ───────────────────────── */}
        {tab === "wallet" && (
          <div className="space-y-4">
            {loyalty && !loyalty.enabled && <Empty icon={Gift} text="Το φαρμακείο σου δεν έχει ενεργό πρόγραμμα επιβράβευσης ακόμη." />}
            {loyalty?.enabled && loyalty.enrolled === false && (
              <div className="space-y-3">
                <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-rose-500 to-amber-500 p-5 text-white shadow-lg">
                  <div className="text-lg font-extrabold">🎁 Μπες στο πρόγραμμα επιβράβευσης!</div>
                  <p className="mt-1 text-sm opacity-90">Κέρδισε πόντους με κάθε εκτέλεση των επαναλαμβανόμενων συνταγών σου & εξαργύρωσέ τους σε προϊόντα, υπηρεσίες και εκπτώσεις.</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="mb-1 text-sm font-semibold text-slate-700">Όροι συμμετοχής</div>
                  <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">{loyalty.terms}</pre>
                  <button onClick={joinLoyalty} disabled={assignBusy}
                    className="mt-3 w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">✓ Αποδέχομαι τους όρους & εγγραφή</button>
                  <p className="mt-1 text-center text-[11px] text-slate-400">Οι πόντοι ξεκινούν να μετρούν από τη στιγμή της εγγραφής σου.</p>
                </div>
              </div>
            )}
            {loyalty?.enabled && loyalty.enrolled && !loyalty.member && <Empty icon={Gift} text="Μόλις εκτελέσεις τις επόμενες επαναλαμβανόμενες συνταγές σου, θα αρχίσεις να μαζεύεις πόντους!" />}
            {loyalty?.enabled && loyalty.enrolled && loyalty.member && (() => {
              const m = loyalty.member!;
              return (
                <>
                  {/* πορτοφόλι */}
                  <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-rose-500 via-pink-500 to-amber-500 p-5 text-white shadow-lg">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium opacity-90">💳 Το πορτοφόλι σου</span>
                      <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-bold">{TIER_GR[m.tier] ?? m.tier}</span>
                    </div>
                    <div className="mt-1 text-4xl font-extrabold">{eur(m.balance_cents)}</div>
                    <div className="text-sm opacity-90">{m.points} πόντοι · για αγορές στο φαρμακείο</div>
                  </div>

                  {/* κάρτα μέλους με QR — ο πελάτης τη δείχνει στο φαρμακείο για ταυτοποίηση/εξαργύρωση */}
                  <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="grid shrink-0 place-items-center rounded-xl bg-white p-2 ring-1 ring-slate-200">
                      <QRCodeCanvas value={`RXVL:${m.patient_ref}`} size={104} level="M" includeMargin />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-800">🪪 Κάρτα μέλους</div>
                      <p className="mt-0.5 text-xs text-slate-500">Δείξε αυτόν τον κωδικό στο φαρμακείο — ο φαρμακοποιός τον σκανάρει για να σε ταυτοποιήσει & να εξαργυρώσεις πόντους.</p>
                      <div className="mt-1 font-mono text-[10px] tracking-wide text-slate-400">{m.patient_ref}</div>
                    </div>
                  </div>

                  {/* στόχος / πρόοδος */}
                  {m.next_tier && (
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-slate-800">🎯 Επόμενος στόχος: {TIER_GR[m.next_tier] ?? m.next_tier}</span>
                        <span className="text-slate-500">{m.to_next} πόντοι ακόμη</span>
                      </div>
                      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-gradient-to-r from-rose-400 to-amber-400" style={{ width: `${m.progress_pct}%` }} />
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{Math.ceil(m.to_next / Math.max(1, m.points_per_refill))} εκτελέσεις ακόμη για το επόμενο επίπεδο</div>
                    </div>
                  )}

                  {/* nudge: ανοιχτές συνταγές → πόντοι */}
                  {m.open_refills > 0 && (
                    <button onClick={() => setTab("repeats")} className="block w-full rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4 text-left transition hover:bg-emerald-100">
                      <div className="text-sm font-bold text-emerald-800">🔔 Έχεις {m.open_refills} {m.open_refills === 1 ? "συνταγή έτοιμη" : "συνταγές έτοιμες"} για εκτέλεση!</div>
                      <div className="mt-0.5 text-sm text-emerald-700">Εκτέλεσέ {m.open_refills === 1 ? "την" : "τες"} στο φαρμακείο σου & κέρδισε <b>+{m.potential_points} πόντους</b> ({eur(m.potential_points * m.cents_per_point)}). →</div>
                    </button>
                  )}

                  {/* συνέπεια */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center">
                      <div className="text-2xl font-bold text-sky-600">{m.compliance ?? "—"}%</div>
                      <div className="text-xs text-slate-500">Συνέπεια στις επαναλήψεις</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center">
                      <div className="text-2xl font-bold text-rose-600">{m.refills}</div>
                      <div className="text-xs text-slate-500">Εκτελέσεις που μέτρησαν</div>
                    </div>
                  </div>

                  {/* δώρα — τι δικαιούται ο πελάτης με βάση τα στάνταρ του φαρμακείου */}
                  {!!loyalty.rewards?.length && (() => {
                    const cpp = m.cents_per_point || 1;
                    const ranked = [...loyalty.rewards].map((r) => ({ ...r, afford: m.balance_cents >= r.cost_cents, need: Math.max(0, Math.ceil((r.cost_cents - m.balance_cents) / cpp)) }))
                      .sort((a, b) => Number(b.afford) - Number(a.afford) || a.cost_points - b.cost_points);
                    const unlocked = ranked.filter((r) => r.afford).length;
                    return (
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <div className="text-xs font-semibold text-slate-500">🎁 Τα δώρα σου</div>
                          {unlocked > 0 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">{unlocked} διαθέσιμα τώρα</span>}
                        </div>
                        <div className="space-y-1.5">
                          {ranked.map((r, i) => (
                            <div key={r._id ?? i} className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${r.afford ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                              <span className={r.afford ? "font-medium text-slate-800" : "text-slate-500"}>{RTYPE_EMOJI[r.type] ?? "🎁"} {r.title}</span>
                              <div className="shrink-0 text-right">
                                <div className="text-xs font-semibold text-slate-600">{r.cost_points} π. · {eur(r.cost_cents)}</div>
                                {r.afford
                                  ? <div className="text-[11px] font-bold text-emerald-700">✓ Μπορείς να το πάρεις</div>
                                  : <div className="text-[11px] text-slate-400">🔒 σου λείπουν {r.need} πόντοι</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="mt-1.5 text-[11px] text-slate-400">Δείξε την κάρτα μέλους σου στο φαρμακείο για να παραλάβεις όσα δικαιούσαι.</p>
                      </div>
                    );
                  })()}

                  {/* πώς κερδίζω */}
                  <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                    <div className="font-semibold text-slate-700">💡 Πώς μαζεύω πόντους</div>
                    <p className="mt-1">Κάθε φορά που εκτελείς εγκαίρως μια επαναλαμβανόμενη συνταγή σου, κερδίζεις <b>{m.points_per_refill} πόντους</b>. Όσο πιο συνεπής, τόσο πιο γρήγορα ανεβαίνεις επίπεδο & γεμίζει το πορτοφόλι σου!</p>
                  </div>

                  {/* ιστορικό */}
                  {!!m.ledger?.length && (
                    <div>
                      <div className="mb-1 text-xs font-semibold text-slate-500">Κινήσεις</div>
                      {m.ledger.map((l, i) => (
                        <div key={i} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                          <span className="text-slate-700">{l.type === "redeem" ? `🛍️ Εξαργύρωση${l.kind === "parapharma" ? " (παραφάρμακα)" : l.kind === "service" ? " (υπηρεσία)" : ""}` : "🎁 Πίστωση"}<span className="ml-2 text-xs text-slate-400">{dt(l.at)}</span></span>
                          <span className={`font-semibold ${l.type === "redeem" ? "text-rose-600" : "text-emerald-600"}`}>{l.type === "redeem" ? "−" : "+"}{eur(Math.abs(l.cents))}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ── ΑΝΑΘΕΣΗ ΣΥΝΤΑΓΗΣ ──────────────────────────────── */}
        {tab === "assign" && (
          <div className="space-y-4">
            {assignMsg && <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{assignMsg}</div>}

            {/* 1) με barcode */}
            <form onSubmit={submitBarcode} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="mb-1 text-sm font-semibold text-slate-800">1) Με barcode συνταγής</h3>
              <p className="mb-3 text-xs text-slate-500">Πληκτρολόγησε ή σκάναρε το barcode της συνταγής για να την αναθέσεις στο φαρμακείο.</p>
              <input value={assignBc} onChange={(e) => setAssignBc(e.target.value)} placeholder="π.χ. 2602120442459"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              <button type="submit" disabled={assignBusy || assignBc.trim().length < 4}
                className="mt-3 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">Αποστολή barcode</button>
            </form>

            {/* 2) φωτογραφία συνταγής ιατρού */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="mb-1 text-sm font-semibold text-slate-800">2) Φωτογραφία συνταγής ιατρού</h3>
              <p className="mb-3 text-xs text-slate-500">Φωτογράφισε τη χάρτινη συνταγή του γιατρού και στείλε την στο φαρμακείο.</p>
              <input type="file" accept="image/*,application/pdf" capture="environment" disabled={assignBusy}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) submitPhoto(f); }}
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-indigo-700" />
            </div>

            {/* σημείωση + 3η μελλοντική επιλογή */}
            <textarea value={assignNote} onChange={(e) => setAssignNote(e.target.value)} rows={2} placeholder="Σημείωση προς το φαρμακείο (προαιρετικό)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              3) Σύνδεση στην εθνική πύλη συνταγών (άυλες) — <b>σύντομα</b>: θα μπορείς να αντλείς τις άυλες συνταγές σου και να τις αναθέτεις απευθείας.
            </div>

            {/* οι αναθέσεις μου */}
            {rxReqs.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-500">Οι αναθέσεις μου</div>
                {rxReqs.map((r) => (
                  <div key={r._id} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-700">{r.kind === "barcode" ? <>📋 Barcode <span className="font-mono text-xs">{r.barcode}</span></> : <>📷 Φωτογραφία συνταγής</>}<span className="ml-2 text-xs text-slate-400">{dt(r.created_at)}</span></span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusCls(r.status)}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                    </div>
                    {r.cda?.found && (
                      <div className="mt-1.5 rounded-lg bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800">
                        <div className="font-semibold">✓ Επιβεβαιώθηκε από ΗΔΙΚΑ</div>
                        {!!r.cda.medicines?.length && <div className="mt-0.5 text-emerald-700">💊 {r.cda.medicines.join(" · ")}</div>}
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-emerald-600">
                          {r.cda.doctor && <span>👤 {r.cda.doctor}</span>}
                          {r.cda.issue_date && <span>📅 {dt(r.cda.issue_date)}</span>}
                          {r.cda.intangible && <span>📲 Άυλη</span>}
                        </div>
                      </div>
                    )}
                    {r.cda && r.cda.available && !r.cda.found && (
                      <div className="mt-1.5 text-xs text-amber-600">Δεν εντοπίστηκε στην ΗΔΙΚΑ — θα το ελέγξει το φαρμακείο.</div>
                    )}
                    {r.reply && (
                      <div className="mt-1.5 rounded-lg bg-sky-50 px-2 py-1.5 text-xs text-sky-800">
                        <span className="font-semibold">💬 Φαρμακείο:</span> {r.reply}
                        {r.available_date && <span className="ml-1 font-semibold">· διαθέσιμο {dt(r.available_date)}</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── AVAILABILITY ───────────────────────────────────── */}
        {tab === "availability" && (
          <div className="space-y-4">
            <form onSubmit={askAvailability} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-800"><Search className="h-4 w-4 text-brand-500" /> Ρώτα για διαθεσιμότητα</div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">Φαρμακείο</div>
                <PharmacyPicker linked={me.pharmacies} value={availTarget} onChange={setAvailTarget} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">Φάρμακο (λίστα / barcode / σάρωση)</div>
                <MedicinePicker value={availMed} onChange={setAvailMed} />
              </div>
              <input value={availNote} onChange={(e) => setAvailNote(e.target.value)} placeholder="Σχόλιο (προαιρετικό)"
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
              <button className="w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700">Αποστολή ερώτησης</button>
            </form>
            {avail.length === 0 && <Empty icon={Search} text="Δεν έχεις στείλει ερωτήσεις διαθεσιμότητας." />}
            {avail.map((a, i) => (
              <div key={a._id ?? i} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600"><Pill className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-800">{a.medicine_name || a.query}</div>
                  {a.answer ? <div className="mt-0.5 text-sm text-emerald-700">{a.answer}</div> : <div className="mt-0.5 text-xs text-amber-600">Σε αναμονή απάντησης…</div>}
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusCls(a.answer ? "answered" : a.status)}`}>{a.answer ? "Απαντήθηκε" : (STATUS_LABEL[a.status] ?? a.status)}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── APPOINTMENTS ───────────────────────────────────── */}
        {tab === "appointments" && (
          <div className="space-y-4">
            <form onSubmit={bookAppt} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-800"><CalendarPlus className="h-4 w-4 text-brand-500" /> Κλείσε ραντεβού</div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">Φαρμακείο</div>
                <PharmacyPicker linked={me.pharmacies} value={apptTarget} onChange={setApptTarget} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">Υπηρεσία</div>
                <select required value={appt.service_name} onChange={(e) => setAppt({ ...appt, service_name: e.target.value })}
                  className="w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100">
                  <option value="">— Επίλεξε υπηρεσία —</option>
                  {services.map((s, i) => <option key={s._id ?? i} value={s.name}>{s.name}</option>)}
                  <option value="Εμβολιασμός">Εμβολιασμός</option>
                </select>
                {(() => {
                  const sel = services.find((s) => s.name === appt.service_name);
                  if (!sel) return null;
                  const av = sel.availability;
                  const parts = av && av.mode === "custom" ? [
                    ...(av.slots ?? []).map((s) => `${PDAYS[s.day]} ${s.start}–${s.end}`),
                    ...(av.date_ranges ?? []).map((r) => `📅 ${prange(r)}`),
                  ] : [];
                  const txt = parts.length ? "Διαθέσιμο: " + parts.join(" · ") : "Διαθέσιμο όλο το ωράριο του φαρμακείου";
                  return <div className="mt-1 text-[11px] font-medium text-brand-600">🕒 {txt}</div>;
                })()}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">Ημερομηνία</div>
                  <input type="date" required value={appt.date} min={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setAppt({ ...appt, date: e.target.value })}
                    className="w-full min-w-0 appearance-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">Ώρα</div>
                  <input type="time" required value={appt.time}
                    onChange={(e) => setAppt({ ...appt, time: e.target.value })}
                    className="w-full min-w-0 appearance-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
                </div>
              </div>
              <button className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700">Κλείσε ραντεβού</button>
            </form>
            {appts.length === 0 && <Empty icon={Calendar} text="Δεν έχεις ραντεβού." />}
            {appts.map((a, i) => (
              <div key={a._id ?? i} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600"><Calendar className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-800">{a.service_name}</div>
                  <div className="text-xs text-slate-500">{dtl(a.requested_at)}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusCls(a.status)}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
              </div>
            ))}
          </div>
        )}

        <p className="mt-8 text-center text-[11px] text-slate-300">RxVision · Πύλη Πελατών</p>
      </main>
    </div>
  );
}

const TINTS: Record<string, string> = {
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  violet: "bg-violet-50 text-violet-600",
};

function Kpi({ icon: Icon, label, value, sub, tint, highlight }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub: string; tint: string; highlight?: boolean;
}) {
  return (
    <div className={`overflow-hidden rounded-2xl border p-3 shadow-sm transition hover:shadow-md sm:p-4 ${highlight ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white" : "border-slate-200 bg-white"}`}>
      <span className={`grid h-8 w-8 place-items-center rounded-xl sm:h-9 sm:w-9 ${TINTS[tint]}`}><Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" /></span>
      <div className="mt-2 truncate text-lg font-extrabold tracking-tight text-slate-900 sm:mt-3 sm:text-2xl">{value}</div>
      <div className="truncate text-xs font-semibold text-slate-600 sm:text-[13px]">{label}</div>
      <div className="mt-0.5 truncate text-[11px] text-slate-400">{sub}</div>
    </div>
  );
}

function Empty({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white py-12 text-center">
      <Icon className="mx-auto h-8 w-8 text-slate-300" />
      <p className="mt-2 text-sm text-slate-400">{text}</p>
    </div>
  );
}
