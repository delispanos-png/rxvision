"use client";

import { useEffect, useState, useCallback } from "react";
import { DateInput } from "@/components/ui/DateInput";
import { useRouter } from "next/navigation";
import {
  Pill, Wallet, ShieldCheck, RefreshCw, Stethoscope, Bell, LogOut, Building2,
  Calendar, ChevronDown, ChevronUp, CheckCircle2, Clock, Sparkles, X, Search, CalendarPlus, AlertCircle,
  PackageCheck, Gift, FileText, ShoppingBag, HeartPulse, FilePlus, MapPin, Home, Percent, Camera, Upload, Star, Navigation, Plus, Check,
  Sun, Moon, User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { Tooltip } from "@/components/ui/Tooltip";
import { LogoMark } from "@/components/brand/Logo";
import { patientApi, patientTokens, patientUpload, patientLogout, API_BASE, ApiError } from "@/lib/patientClient";
import { usePref } from "@/store/prefStore";
import { PharmacyPicker, MedicinePicker, type Medicine } from "@/components/portal/pickers";
import { RenewalCard, type Renewal } from "@/components/portal/RenewalCard";
import { ShopTab } from "@/components/portal/ShopTab";
import { Toaster, toast, confirmDialog } from "@/components/portal/Toaster";
import { TransferCard } from "@/components/portal/TransferCard";
import { pushSupported, isPushSubscribed, enablePush } from "@/lib/push";
import { BellRing } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/formatters";

type Pharmacy = { tenant_id: string; pharmacy_name: string };
type Pharm = { status: { isOpen: boolean; isOnDuty: boolean; isOvernightDuty: boolean; closingSoon: boolean; statusText: string }; schedule: { week: { day: number; status: string; intervals: { start: string; end: string }[] }[] } };
type Consent = { granted: boolean; at?: string | null };
type Me = { profile: { first_name: string; last_name: string; email?: string; phone?: string; amka?: string; phone_verified?: boolean; email_verified?: boolean; consents?: { health_data?: Consent; marketing?: Consent }; address?: string; city?: string; postal_code?: string; theme?: "light" | "dark" | null; avatar_url?: string | null }; active_tenant: string | null; pharmacies: Pharmacy[]; portal_mode?: "network" | "single"; caps?: { shop: boolean; loyalty: boolean } };
const PF_INP = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";
type DirPharmacy = { tenant_id: string; name: string; address?: string | null; city?: string | null; phone?: string | null; lat?: number | null; lon?: number | null; mine?: boolean; favorite?: boolean; status?: { isOpen: boolean; isOnDuty: boolean; isOvernightDuty: boolean; closingSoon: boolean; statusText: string } | null };
type Summary = { rx_count: number; paid_cents: number; total_cents: number; covered_cents: number; doctors: number; medicines: number; repeats_active: number; next_open_date?: string | null; first_at?: string | null; last_at?: string | null };
// tenant_id/pharmacy_name: κάθε εκτέλεση φέρει ΠΟΥ έγινε — ο πελάτης βλέπει όλων των φαρμακείων του.
type Rx = { barcode: string; executed_at: string; status?: string; patient_share?: number; repeat_current?: number; repeat_total?: number; repeat_root?: string | null; next_open_date?: string | null; medicines: string[]; pending?: string[]; partial?: boolean; doctor?: string | null; specialty?: string | null; tenant_id?: string; pharmacy_name?: string | null };
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
type Appt = { _id?: string; service_name: string; requested_at: string; status: string; tenant_id?: string; pharmacy_name?: string | null };
type Cda = { available?: boolean; found?: boolean; doctor?: string | null; medicines?: string[]; issue_date?: string | null; deadline_date?: string | null; intangible?: boolean; exec_count?: number | null; is_fyk?: boolean; has_vaccine?: boolean };
type RxReq = { _id?: string; kind: string; barcode?: string | null; note?: string | null; status: string; created_at: string; cda?: Cda | null; reply?: string | null; available_date?: string | null };
type LoyaltyMember = { patient_ref: string; name?: string; points: number; balance_cents: number; tier: string; next_tier: string | null; to_next: number; progress_pct: number; compliance: number | null; refills: number; expected: number; open_refills: number; potential_points: number; points_per_refill: number; cents_per_point: number; ledger: { type: string; cents: number; kind?: string; reason?: string; at: string }[] };
type LReward = { _id?: string; title: string; type: string; cost_points: number; cost_cents: number; note?: string };
type Loyalty = { enabled: boolean; enrolled?: boolean; terms?: string; member?: LoyaltyMember | null; rewards?: LReward[] };
const RTYPE_EMOJI: Record<string, string> = { product: "🛍️", service: "💉", percent: "🏷️", cash: "💶" };

const dt = (s?: string | null) => (s ? fmtDate(s) : "—");
const dtl = (s?: string | null) => (s ? fmtDateTime(s) : "—");
const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format((c || 0) / 100);
const bpShow = (v?: number | null) => (v == null ? "—" : (v / 10).toFixed(1).replace(".", ","));  // 154 → «15,4»
const wShow = (v?: number | null) => (v == null ? "—" : v.toFixed(2).replace(".", ","));            // βάρος 2 δεκαδικά
// χιλιομετρική (ευθεία) απόσταση — Haversine
const haversineKm = (a: { lat: number; lon: number }, lat2: number, lon2: number) => {
  const r = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - a.lat), dLon = toRad(lon2 - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
};

const TABS = [["home", "Αρχική"], ["rx", "Συνταγές"], ["shop", "e-Κατάστημα"], ["meds", "Πρόγραμμα λήψης"], ["health", "Υγεία"], ["wallet", "Επιβράβευση"], ["repeats", "Επαναλήψεις"], ["renewals", "Ανεκτέλεστα"], ["assign", "Ανάθεση συνταγής"], ["availability", "Διαθεσιμότητα"], ["appointments", "Ραντεβού"], ["pharmacies", "Φαρμακεία"]] as const;
// Σύντομες ετικέτες για τη στενή κάτω μπάρα (mobile) — αλλιώς κόβονται άσχημα.
const NAV_SHORT: Record<string, string> = { shop: "Κατάστημα", meds: "Πρόγραμμα" };

// Εικονίδιο ανά καρτέλα + οι 4 ΒΑΣΙΚΕΣ που μπαίνουν στην κάτω μπάρα (mobile). Οι υπόλοιπες
// ζουν στο φύλλο «Περισσότερα» ώστε να μη γεμίζει η οθόνη με 10 κουμπιά.
const TAB_ICON: Record<string, LucideIcon> = {
  home: Home, rx: FileText, shop: ShoppingBag, meds: Pill, health: HeartPulse, wallet: Gift,
  repeats: RefreshCw, renewals: AlertCircle, assign: FilePlus, availability: Search, appointments: CalendarPlus,
  pharmacies: MapPin,
};
const TAB_LABEL: Record<string, string> = Object.fromEntries(TABS.map(([k, l]) => [k, l]));

const DOW = ["Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ", "Κυρ"];
type Therapy = { med_key: string; name: string; dose: string | null; dosage_text: string | null; kind: string; per_day: number; runout: string | null; days_left: number | null; enabled: boolean; reservable: boolean; time?: string | null; meal?: string | null; interval_hours?: number | null };
type SlotCell = { slot: string; label: string; time: string; meds: { med_key: string; name: string; dose: string | null; time: string }[] };
type Schedule = { therapies: Therapy[]; week: { dow: number; slots: SlotCell[] }[]; slot_times: Record<string, string>; streak: number; taken_today?: { med_key: string; slot: string | null }[] };
// τελικές καταστάσεις ραντεβού → «κλειστά» (κοινό σε Αρχική & καρτέλα Ραντεβού)
const DONE = ["done", "cancelled", "declined", "completed"];
type Dose = { time: string; med_key: string; name: string; dose: string | null; meal?: string | null };
// Γεννήτρια δόσεων ημέρας: 1×/μέρα (ή «συγκεκριμένη ώρα») → μία δόση· >1×/μέρα → «κάθε X ώρες»
// από την ώρα 1ης λήψης (π.χ. iv=8 → 08:00, 16:00, 00:00). Κοινή για Ημερολόγιο & Αρχική.
const genDosesFor = (slots: SlotCell[], thMap: Record<string, Therapy>): Dose[] => {
  const dueKeys = Array.from(new Set(slots.flatMap((sl) => sl.meds.map((m) => m.med_key))));
  const out: Dose[] = [];
  dueKeys.forEach((mk) => {
    const th = thMap[mk]; if (!th) return;
    const pd = th.per_day || 1; const start = th.time || "08:00";
    if (pd <= 1 || th.interval_hours === 0) { out.push({ time: start, med_key: mk, name: th.name, dose: th.dose, meal: th.meal }); return; }
    const iv = th.interval_hours || Math.max(1, Math.round(24 / pd));
    const [h, mn] = start.split(":").map(Number);
    for (let i = 0; i * iv < 24; i++) {
      const tot = (h * 60 + mn + i * iv * 60) % 1440;
      out.push({ time: `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`, med_key: mk, name: th.name, dose: th.dose, meal: th.meal });
    }
  });
  return out.sort((a, b) => a.time.localeCompare(b.time));
};
type HMeas = { _id?: string; kind: string; systolic?: number; diastolic?: number; value?: number; at: string };
type Health = { height_cm?: number | null; latest: Record<string, HMeas>; history: Record<string, HMeas[]> };
const hStat = (k: string, m?: HMeas) => {
  if (!m) return "bg-slate-50 text-slate-500";
  if (k === "bp") return (m.systolic! >= 140 || m.diastolic! >= 90) ? "bg-rose-50 text-rose-700" : (m.systolic! >= 130 || m.diastolic! >= 85) ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700";
  if (k === "glucose") return m.value! >= 126 ? "bg-rose-50 text-rose-700" : m.value! >= 100 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700";
  return "bg-slate-50 text-slate-700";
};
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
  const [pharm, setPharm] = useState<Pharm | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [noPharmacy, setNoPharmacy] = useState(false);
  // deep-link «/portal?tab=shop» → τα push (π.χ. ξεχασμένο καλάθι) ανοίγουν τη σωστή καρτέλα
  const [tab, setTab] = useState<string>(() => {
    if (typeof window === "undefined") return "home";
    return new URLSearchParams(window.location.search).get("tab") || "home";
  });
  const [directory, setDirectory] = useState<DirPharmacy[]>([]);
  const [dirQuery, setDirQuery] = useState("");
  const [geo, setGeo] = useState<{ lat: number; lon: number } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [rx, setRx] = useState<Rx[]>([]);
  const [rxQuery, setRxQuery] = useState("");   // αναζήτηση αρ. συνταγής (barcode)
  const [rxFrom, setRxFrom] = useState("");     // ημ/νιακό διάστημα από (YYYY-MM-DD)
  const [rxTo, setRxTo] = useState("");         // …έως
  const [rxShowAll, setRxShowAll] = useState(false);
  const [repeats, setRepeats] = useState<Repeat[]>([]);
  const [avail, setAvail] = useState<Avail[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [appts, setAppts] = useState<Appt[]>([]);
  const [rxReqs, setRxReqs] = useState<RxReq[]>([]);
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [sched, setSched] = useState<Schedule | null>(null);
  const [medsView, setMedsView] = useState<"calendar" | "settings">("calendar");  // Πρόγραμμα: Ημερολόγιο | Ρυθμίσεις
  const [healthDate, setHealthDate] = useState<string | null>(null);   // Υγεία: επιλεγμένη ημερομηνία μετρήσεων
  const [openDay, setOpenDay] = useState<number | null>(() => (new Date().getDay() + 6) % 7);  // accordion: σήμερα ανοιχτή
  const [renewals, setRenewals] = useState<Renewal[] | null>(null);
  const [assignBc, setAssignBc] = useState("");
  const [assignNote, setAssignNote] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);
  const [availTarget, setAvailTarget] = useState("");
  const [apptView, setApptView] = useState<"open" | "closed">("open");   // Ραντεβού: Ανοιχτά | Κλειστά
  const [availMed, setAvailMed] = useState<Medicine | null>(null);
  const [availNote, setAvailNote] = useState("");
  const [apptTarget, setApptTarget] = useState("");
  const [appt, setAppt] = useState({ service_name: "", date: "", time: "" });
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [pf, setPf] = useState({ first_name: "", last_name: "", phone: "", address: "", city: "", postal_code: "" });
  const [pwd, setPwd] = useState({ current: "", next: "" });
  const [profileBusy, setProfileBusy] = useState(false);
  const { theme, setTheme } = usePref();
  const [switchOpen, setSwitchOpen] = useState(false);   // custom dropdown πάνω επιλογέα φαρμακείου
  const [pickupDate, setPickupDate] = useState("");   // ημ/νία παραλαβής για ειδοποίηση διαθεσιμότητας
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
      patientApi<Pharm>("/patient/pharmacy-hours").then(setPharm).catch(() => setPharm(null));
      if (n.items.length) setShowNotifs(true);
    } catch { /* patientApi redirects to /portal/login on 401 */ }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!me) return;
    const c = me.caps ?? { shop: true, loyalty: true };   // αν η ενεργή καρτέλα δεν προσφέρεται πια → Αρχική
    if ((tab === "shop" && !c.shop) || (tab === "wallet" && !c.loyalty)) { setTab("home"); return; }
    if (tab === "home") {   // KPI της Αρχικής χρειάζονται renewals (διαθέσιμες τώρα) + loyalty (πόντοι)
      patientApi<{ items: Renewal[] }>("/patient/renewals").then((d) => setRenewals(d.items)).catch(() => {});
      patientApi<Loyalty>("/patient/loyalty").then(setLoyalty).catch(() => {});
      // Πάνελ «κονσόλας» — ΜΟΝΟ σε desktop φαίνονται, αλλά τα δεδομένα είναι ήδη cached για τις καρτέλες.
      patientApi<Schedule>("/patient/meds/schedule").then(setSched).catch(() => {});
      patientApi<{ items: Appt[] }>("/patient/appointments").then((d) => setAppts(d.items)).catch(() => {});
    }
    if (tab === "meds") patientApi<Schedule>("/patient/meds/schedule").then(setSched).catch(() => {});
    if (tab === "health") patientApi<Health>("/patient/health").then(setHealth).catch(() => {});
    if (tab === "renewals") patientApi<{ items: Renewal[] }>("/patient/renewals").then((d) => setRenewals(d.items)).catch(() => {});
    if (tab === "wallet") patientApi<Loyalty>("/patient/loyalty").then(setLoyalty).catch(() => {});
    if (tab === "pharmacies" || directory.length === 0) patientApi<{ items: DirPharmacy[] }>("/patient/pharmacies/directory").then((d) => setDirectory(d.items)).catch(() => {});
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

  async function toggleMed(med_key: string, enabled: boolean) {
    setSched((s) => s ? { ...s, therapies: s.therapies.map((t) => t.med_key === med_key ? { ...t, enabled } : t) } : s);
    try {
      await patientApi("/patient/meds/reminder", { method: "POST", body: JSON.stringify({ med_key, enabled }) });
      if (enabled) {   // μόλις ενεργοποιήθηκε → ρώτα ώρα λήψης + σχέση με γεύμα
        const th = sched?.therapies.find((t) => t.med_key === med_key);
        const pd = th?.per_day || 1; setMedCfg({ med_key, time: th?.time || "08:00", meal: th?.meal || "none", mode: pd > 1 ? "interval" : "time", interval: th?.interval_hours || Math.max(1, Math.round(24 / pd)), per_day: pd });
      } else { setMedCfg((c) => c?.med_key === med_key ? null : c); }
      setSched(await patientApi<Schedule>("/patient/meds/schedule"));   // refresh grid
    } catch { /* revert on next fetch */ }
  }

  // Λήψη ΑΝΑ ΔΟΣΗ (med_key+slot) με toggle (πάτα ξανά = αναίρεση)· persisted στο backend.
  async function toggleIntake(med_key: string, slot: string, taken: boolean) {
    setSched((s) => {
      if (!s) return s;
      const cur = s.taken_today ?? [];
      const next = taken ? cur.filter((t) => !(t.med_key === med_key && t.slot === slot)) : [...cur, { med_key, slot }];
      return { ...s, taken_today: next };
    });
    try {
      const r = await patientApi<{ streak: number; points_awarded?: number }>(taken ? "/patient/meds/untaken" : "/patient/meds/taken", { method: "POST", body: JSON.stringify({ med_key, slot }) });
      setSched((s) => s ? { ...s, streak: r.streak } : s);
      if (!taken && r.points_awarded && r.points_awarded > 0) toast(`✓ Κέρδισες ${r.points_awarded} πόντους 🎁`);
    } catch { try { setSched(await patientApi<Schedule>("/patient/meds/schedule")); } catch { /* ignore */ } }
  }
  // Ρύθμιση φαρμάκου κατά την ΕΝΕΡΓΟΠΟΙΗΣΗ: ώρα λήψης (24ωρο) ή «κάθε X ώρες» + σχέση με γεύμα.
  const [medCfg, setMedCfg] = useState<{ med_key: string; time: string; meal: string; mode: "time" | "interval"; interval: number; per_day: number } | null>(null);
  async function saveMedCfg() {
    if (!medCfg) return;
    try {
      await patientApi("/patient/meds/reminder", { method: "POST", body: JSON.stringify({ med_key: medCfg.med_key, enabled: true, time: medCfg.time || null, meal: medCfg.meal, interval_hours: medCfg.mode === "interval" ? medCfg.interval : 0 }) });
      setSched(await patientApi<Schedule>("/patient/meds/schedule"));
    } catch { /* ignore */ }
    setMedCfg(null);
  }
  async function reserveMed(med_name: string) {
    if (!(await confirmDialog(`Κράτηση επανάληψης για «${med_name}» στο φαρμακείο σου;`))) return;
    try { await patientApi("/patient/meds/reserve", { method: "POST", body: JSON.stringify({ med_name }) }); toast("✓ Η κράτηση στάλθηκε στο φαρμακείο σου. Θα ειδοποιηθείς όταν είναι έτοιμη."); }
    catch { toast("Κάτι πήγε στραβά — δοκίμασε ξανά.", "error"); }
  }

  async function switchPharmacy(tenant_id: string, gotoTab?: string) {
    try {
      const d = await patientApi<{ access_token: string }>("/patient/auth/select-pharmacy", { method: "POST", body: JSON.stringify({ tenant_id }) });
      patientTokens.set(d.access_token, window.localStorage.getItem("patient_refresh_token"));
      // η επιλογή φαρμακείου ισχύει ΠΑΝΤΟΥ: ερωτήματα διαθεσιμότητας & ραντεβού στοχεύουν το ίδιο
      setAvailTarget(tenant_id); setApptTarget(tenant_id);
      if (gotoTab) setTab(gotoTab);
      await load();
    } catch { toast("Δεν ήταν δυνατή η επιλογή του φαρμακείου — δοκίμασε ξανά.", "error"); }
  }
  async function setFavoritePharmacy(tenant_id: string) {
    const prev = directory;
    setDirectory((ds) => ds.map((d) => ({ ...d, favorite: d.tenant_id === tenant_id ? !d.favorite : false })));
    try { await patientApi("/patient/pharmacies/favorite", { method: "POST", body: JSON.stringify({ tenant_id }) }); }
    catch { setDirectory(prev); }
  }
  function requestGeo() {
    if (!navigator.geolocation) { toast("Η συσκευή δεν υποστηρίζει εντοπισμό τοποθεσίας.", "error"); return; }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setGeo({ lat: p.coords.latitude, lon: p.coords.longitude }); setGeoBusy(false); },
      () => { setGeoBusy(false); toast("Δεν ήταν δυνατός ο εντοπισμός τοποθεσίας — έλεγξε τα δικαιώματα.", "error"); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }
  async function logout() { await patientLogout(); router.replace("/portal/login"); }

  // εφάρμοσε το αποθηκευμένο (server-side) θέμα του πελάτη όταν φορτώσει το προφίλ
  useEffect(() => {
    const th = me?.profile.theme;
    if (th === "light" || th === "dark") setTheme(th);
  }, [me?.profile.theme, setTheme]);

  function openProfile() {
    if (!me) return;
    setPf({ first_name: me.profile.first_name || "", last_name: me.profile.last_name || "",
            phone: me.profile.phone || "", address: me.profile.address || "",
            city: me.profile.city || "", postal_code: me.profile.postal_code || "" });
    setPwd({ current: "", next: "" });
    setShowProfile(true);
  }
  async function saveProfile() {
    setProfileBusy(true);
    try {
      await patientApi("/patient/me", { method: "PATCH", body: JSON.stringify(pf) });
      setMe((m) => (m ? { ...m, profile: { ...m.profile, ...pf } } : m));
      toast("Το προφίλ ενημερώθηκε", "success");
    } catch { toast("Κάτι πήγε στραβά — δοκίμασε ξανά.", "error"); } finally { setProfileBusy(false); }
  }
  async function changePwd() {
    if (pwd.next.length < 8) { toast("Ο νέος κωδικός πρέπει να έχει ≥8 χαρακτήρες.", "error"); return; }
    setProfileBusy(true);
    try {
      const s = await patientApi<{ access_token: string | null; refresh_token: string }>(
        "/patient/me/change-password",
        { method: "POST", body: JSON.stringify({ current_password: pwd.current, new_password: pwd.next }) });
      patientTokens.set(s.access_token, s.refresh_token);
      setPwd({ current: "", next: "" });
      toast("Ο κωδικός άλλαξε.", "success");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      toast(code === "bad_current_password" ? "Λάθος τρέχων κωδικός." : "Η αλλαγή απέτυχε.", "error");
    } finally { setProfileBusy(false); }
  }
  async function uploadAvatar(file: File) {
    const fd = new FormData(); fd.append("file", file);
    try {
      const r = await patientUpload<{ url: string }>("/patient/avatar", fd);
      setMe((m) => (m ? { ...m, profile: { ...m.profile, avatar_url: r.url } } : m));
      toast("Η φωτογραφία ενημερώθηκε.", "success");
    } catch { toast("Αποτυχία ανεβάσματος φωτογραφίας.", "error"); }
  }
  function toggleTheme() {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    patientApi("/patient/me", { method: "PATCH", body: JSON.stringify({ theme: t }) }).catch(() => {});
  }
  async function setConsent(kind: "health_data" | "marketing", granted: boolean) {
    try {
      const r = await patientApi<{ consent: Consent }>("/patient/me/consent",
        { method: "POST", body: JSON.stringify({ kind, granted }) });
      setMe((m) => (m ? { ...m, profile: { ...m.profile, consents: { ...(m.profile.consents || {}), [kind]: r.consent } } } : m));
      toast(granted ? "Καταχωρήθηκε η συγκατάθεση." : "Ανακλήθηκε η συγκατάθεση.", "success");
    } catch { toast("Κάτι πήγε στραβά — δοκίμασε ξανά.", "error"); }
  }

  // tenantId: η εκτέλεση μπορεί να έγινε σε ΑΛΛΟ φαρμακείο του πελάτη → πες στο API πού να ψάξει.
  async function toggleExpand(barcode: string, tenantId?: string) {
    if (expanded === barcode) { setExpanded(null); setDetail(null); return; }
    setExpanded(barcode); setDetail(null);
    const q = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : "";
    try { setDetail(await patientApi<RxDetail>(`/patient/prescriptions/${encodeURIComponent(barcode)}${q}`)); } catch { /* ignore */ }
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
  // «Το είδα» — κρύψε τοπικά αμέσως + μόνιμα στο backend (δεν ξαναεμφανίζεται).
  async function dismissNotif(id: string) {
    setNotifs((ns) => ns.filter((n) => n.id !== id));
    if (pickupFor === id) { setPickupFor(null); setPickupDate(""); }
    try { await patientApi("/patient/notifications/dismiss", { method: "POST", body: JSON.stringify({ id }) }); } catch { /* ignore */ }
  }
  // Απάντηση διαθεσιμότητας → «θα περάσω να το πάρω» (+ημ/νία) ή «δεν θα περάσω»· ενημερώνει το φαρμακείο & το κλείνει.
  async function notifPickup(id: string, coming: boolean, date?: string) {
    setNotifs((ns) => ns.filter((n) => n.id !== id));
    setPickupFor(null); setPickupDate("");
    try { await patientApi("/patient/notifications/pickup", { method: "POST", body: JSON.stringify({ id, coming, date: date || null }) }); } catch { /* ignore */ }
  }
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
  // Δυνατότητες ενεργού φαρμακείου → κρύψε καρτέλες που δεν προσφέρει (Κατάστημα/Επιβράβευση).
  const caps = me.caps ?? { shop: true, loyalty: true };
  // Καθολική λειτουργία «μεμονωμένο φαρμακείο» → κρύψε τον κατάλογο δικτύου + τον επιλογέα εναλλαγής.
  const single = me.portal_mode === "single";
  const visibleTabs = TABS.filter(([k]) => (k !== "shop" || caps.shop) && (k !== "wallet" || caps.loyalty) && (k !== "pharmacies" || !single));

  return (
    <div className="min-h-screen">
      {/* ── top bar ───────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur-md dark:border-slate-800/80 dark:bg-slate-900/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-1.5 px-3 sm:gap-3 sm:px-4 lg:px-6">
          <a href="https://rxvision.gr" title="rxvision.gr" className="flex items-center gap-2 transition hover:opacity-80">
            <LogoMark className="h-9 w-9" />
            <div className="leading-tight">
              <div className="text-sm font-extrabold tracking-tight text-slate-900 dark:text-slate-100">RxVision</div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Πύλη Πελατών</div>
            </div>
          </a>
          <div className="flex items-center gap-2">
            {!single && me.pharmacies.length > 0 && (() => {
              // custom dropdown: μικρά γράμματα + ★αγαπημένο + πόλη/χιλιομετρική απόσταση (native select αγνοεί το CSS στα options)
              const meta = (tid: string) => directory.find((d) => d.tenant_id === tid);
              const rows = me.pharmacies.map((p) => {
                const m = meta(p.tenant_id);
                const dist = geo && m?.lat != null && m?.lon != null ? haversineKm(geo, m.lat, m.lon) : null;
                return { tenant_id: p.tenant_id, name: p.pharmacy_name, city: m?.city ?? null, favorite: m?.favorite ?? false, dist };
              }).sort((a, b) => {
                const f = (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1); if (f) return f;
                const da = a.dist ?? Infinity, db = b.dist ?? Infinity; if (da !== db) return da - db;
                return a.name.localeCompare(b.name, "el");
              });
              const distText = (d: number) => (d < 1 ? `${Math.round(d * 1000)} μ` : `${d.toFixed(1)} χλμ`);
              const active = rows.find((r) => r.tenant_id === me.active_tenant) ?? rows[0];
              return (
                <div className="relative">
                  <button type="button" onClick={() => setSwitchOpen((v) => !v)}
                    className="flex max-w-[10rem] items-center gap-1.5 rounded-xl border border-slate-200 bg-white py-2 pl-2.5 pr-2 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50 sm:max-w-[15rem]">
                    <Building2 className="h-4 w-4 shrink-0 text-brand-500" />
                    <span className="min-w-0 flex-1 truncate text-left">{active?.name ?? "—"}</span>
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${switchOpen ? "rotate-180" : ""}`} />
                  </button>
                  {switchOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setSwitchOpen(false)} />
                      <div className="absolute right-0 z-50 mt-1.5 max-h-[70vh] w-[min(20rem,calc(100vw-1.5rem))] overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
                        <div className="flex items-center justify-between px-2 py-1">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Φαρμακεία δικτύου</span>
                          {!geo && <button type="button" onClick={() => requestGeo()} disabled={geoBusy}
                            className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-600 hover:bg-brand-100 disabled:opacity-60">
                            <Navigation className={`h-3 w-3 ${geoBusy ? "animate-pulse" : ""}`} /> Κοντινά</button>}
                        </div>
                        {rows.map((r) => {
                          const isActive = r.tenant_id === me.active_tenant;
                          return (
                            <button key={r.tenant_id} type="button"
                              onClick={() => { setSwitchOpen(false); if (!isActive) switchPharmacy(r.tenant_id); }}
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isActive ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                              {r.favorite
                                ? <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                                : <span className="h-3.5 w-3.5 shrink-0" />}
                              <span className="min-w-0 flex-1">
                                <span className={`block break-words text-[11px] font-semibold leading-snug ${isActive ? "text-brand-700" : "text-slate-700"}`}>{r.name}</span>
                                {(r.dist != null || r.city) && (
                                  <span className="block truncate text-[10px] text-slate-400">
                                    {r.dist != null ? distText(r.dist) : r.city}
                                    {r.dist != null && r.city ? ` · ${r.city}` : ""}
                                  </span>
                                )}
                              </span>
                              {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-brand-500" />}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
            <Tooltip label="Ειδοποιήσεις"><button onClick={() => { setTab("home"); setShowNotifs(true); }}
              className="relative grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
              <Bell className="h-[18px] w-[18px]" />
              {notifs.length > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{notifs.length}</span>}
            </button></Tooltip>
            <Tooltip label="Το προφίλ μου"><button onClick={openProfile}
              className="grid h-9 w-9 place-items-center overflow-hidden rounded-xl border border-slate-200 bg-white text-brand-600 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700">
              {me.profile.avatar_url
                ? <img src={`${API_BASE}${me.profile.avatar_url}`} alt="" className="h-full w-full object-cover" />
                : (me.profile.first_name || me.profile.last_name)
                  ? <span className="text-xs font-bold">{(me.profile.first_name?.[0] || "") + (me.profile.last_name?.[0] || "")}</span>
                  : <User className="h-[18px] w-[18px]" />}
            </button></Tooltip>
            <Tooltip label="Έξοδος"><button onClick={logout} className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"><LogOut className="h-[18px] w-[18px]" /></button></Tooltip>
          </div>
        </div>
      </header>

      {showProfile && me && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setShowProfile(false)}>
          <div className="max-h-[90vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Το προφίλ μου</h3>
              <button onClick={() => setShowProfile(false)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
            </div>

            <div className="mb-5 flex items-center gap-4">
              <div className="relative">
                <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
                  {me.profile.avatar_url
                    ? <img src={`${API_BASE}${me.profile.avatar_url}`} alt="" className="h-full w-full object-cover" />
                    : <User className="h-9 w-9 text-slate-400" />}
                </div>
                <label className="absolute -bottom-1 -right-1 grid h-7 w-7 cursor-pointer place-items-center rounded-full bg-brand-600 text-white shadow hover:bg-brand-700" title="Αλλαγή φωτογραφίας">
                  <Camera className="h-3.5 w-3.5" />
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])} />
                </label>
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold text-slate-900 dark:text-slate-100">{me.profile.first_name} {me.profile.last_name}</div>
                <div className="truncate text-sm text-slate-500 dark:text-slate-400">{me.profile.email}</div>
              </div>
            </div>

            <button onClick={toggleTheme} className="mb-5 flex w-full items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
              <span className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">{theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} {theme === "dark" ? "Σκοτεινό θέμα" : "Φωτεινό θέμα"}</span>
              <span className={`relative h-6 w-11 rounded-full transition ${theme === "dark" ? "bg-brand-600" : "bg-slate-300"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${theme === "dark" ? "left-[22px]" : "left-0.5"}`} /></span>
            </button>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Όνομα<input autoComplete="given-name" value={pf.first_name} onChange={(e) => setPf({ ...pf, first_name: e.target.value })} className={PF_INP} /></label>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Επώνυμο<input autoComplete="family-name" value={pf.last_name} onChange={(e) => setPf({ ...pf, last_name: e.target.value })} className={PF_INP} /></label>
              </div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Email {me.profile.email_verified ? <span className="text-emerald-600">✓ επιβεβαιωμένο</span> : <span className="text-amber-600">ανεπιβεβαίωτο</span>}
                <input type="email" autoComplete="email" value={me.profile.email || ""} readOnly title="Αλλαγή email με επιβεβαίωση — σύντομα" className={`${PF_INP} cursor-not-allowed opacity-70`} />
              </label>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">ΑΜΚΑ <span className="font-normal text-slate-400">· κλειδί ηλεκτρονικής συνταγογράφησης</span>
                <input value={me.profile.amka || ""} readOnly className={`${PF_INP} cursor-not-allowed font-mono opacity-70`} />
              </label>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Τηλέφωνο {me.profile.phone && !me.profile.phone_verified && <span className="text-amber-600">ανεπιβεβαίωτο</span>}<input autoComplete="tel" inputMode="tel" value={pf.phone} onChange={(e) => setPf({ ...pf, phone: e.target.value })} className={PF_INP} /></label>

              <div className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Διεύθυνση κατοικίας</div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Οδός & αριθμός<input autoComplete="street-address" value={pf.address} onChange={(e) => setPf({ ...pf, address: e.target.value })} className={PF_INP} placeholder="π.χ. Ερμού 15" /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Πόλη<input autoComplete="address-level2" value={pf.city} onChange={(e) => setPf({ ...pf, city: e.target.value })} className={PF_INP} /></label>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Τ.Κ.<input autoComplete="postal-code" inputMode="numeric" value={pf.postal_code} onChange={(e) => setPf({ ...pf, postal_code: e.target.value })} className={PF_INP} /></label>
              </div>
              <button onClick={saveProfile} disabled={profileBusy} className="w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">Αποθήκευση στοιχείων</button>
            </div>

            <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
              <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Αλλαγή κωδικού</div>
              <div className="space-y-3">
                <input type="password" autoComplete="current-password" placeholder="Τρέχων κωδικός" value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} className={PF_INP} />
                <input type="password" autoComplete="new-password" placeholder="Νέος κωδικός (≥8 χαρακτήρες)" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} className={PF_INP} />
                <button onClick={changePwd} disabled={profileBusy || !pwd.current || pwd.next.length < 8} className="w-full rounded-xl border border-slate-300 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">Αλλαγή κωδικού</button>
              </div>
            </div>

            <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
              <div className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">Συγκαταθέσεις (GDPR)</div>
              <p className="mb-3 text-[11px] text-slate-400">Ξεχωριστές & ανακλητές ανά πάσα στιγμή. Η επεξεργασία δεδομένων υγείας είναι διακριτή από το marketing.</p>
              {([
                { k: "health_data", label: "Επεξεργασία δεδομένων υγείας", sub: "Απαραίτητη για να βλέπεις συνταγές & ιστορικό στην πύλη." },
                { k: "marketing", label: "Ενημερώσεις & προσφορές (newsletter)", sub: "Email/SMS με νέα, προσφορές & χρήσιμες υπενθυμίσεις." },
              ] as const).map((c) => {
                const cur = me.profile.consents?.[c.k];
                const on = !!cur?.granted;
                return (
                  <div key={c.k} className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700 dark:text-slate-200">{c.label}</div>
                      <div className="text-[11px] text-slate-400">{c.sub}</div>
                      {cur?.at && <div className="text-[10px] text-slate-400">{on ? "Συγκατάθεση" : "Ανάκληση"}: {fmtDate(cur.at)}</div>}
                    </div>
                    <button onClick={() => setConsent(c.k, !on)} className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}>
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Desktop (lg+): σταθερό πλαϊνό μενού αριστερά + περιεχόμενο δεξιά.
          Tablet (sm–lg): pills πάνω από το περιεχόμενο.  Κινητό: σταθερή κάτω μπάρα. */}
      <div className="mx-auto flex max-w-7xl gap-6 px-4 lg:px-6">
        <aside className="hidden w-56 shrink-0 py-6 lg:block">
          <nav className="sticky top-20 space-y-1">
            {visibleTabs.map(([k, label]) => {
              const Icon = TAB_ICON[k] ?? Home;
              const on = tab === k;
              return (
                <button key={k} onClick={() => setTab(k)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition ${on
                    ? "bg-brand-600 text-white shadow-sm shadow-brand-500/30"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"}`}>
                  <Icon className={`h-4 w-4 shrink-0 ${on ? "" : "text-slate-400"}`} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {k === "renewals" && (renewals?.length ?? 0) > 0 && (
                    <span className={`grid h-5 min-w-[20px] shrink-0 place-items-center rounded-full px-1 text-[10px] font-bold ${on ? "bg-white/25 text-white" : "bg-rose-500 text-white"}`}>{renewals!.length}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 py-6 pb-24 sm:pb-6">
        {/* ══ ΑΡΧΙΚΗ (Home): όλο το ενημερωτικό — μόνο εδώ, όχι σε κάθε καρτέλα (εξοικονόμηση χώρου) ══ */}
        {tab === "home" && (<>
        {/* Εκκρεμές αίτημα μεταφοράς σε άλλο φαρμακείο — ο πελάτης εγκρίνει/απορρίπτει */}
        <TransferCard onDone={() => load()} />
        {/* ── ζωντανή κατάσταση φαρμακείου ───────────────────── */}
        {pharm && (
          <div className={`mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-3 text-white ${pharm.status.isOnDuty ? (pharm.status.isOvernightDuty ? "bg-indigo-600" : "bg-violet-600") : pharm.status.isOpen ? (pharm.status.closingSoon ? "bg-amber-500" : "bg-emerald-600") : "bg-slate-500"}`}>
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/20 text-lg">{pharm.status.isOvernightDuty ? "🌙" : pharm.status.isOnDuty ? "🚑" : pharm.status.isOpen ? "🟢" : "🔴"}</span>
              <div className="leading-tight">
                <div className="text-[10px] uppercase tracking-wide opacity-80">{activeName || "Το φαρμακείο σου"}</div>
                <div className="text-base font-extrabold">{pharm.status.statusText}</div>
              </div>
            </div>
            {(() => {
              const today = pharm.schedule.week.find((d) => d.day === ((new Date().getDay() + 6) % 7));
              const hrs = today && today.status !== "closed" ? today.intervals.map((i) => `${i.start}–${i.end}`).join(" & ") : "Κλειστά";
              return <div className="text-right text-xs opacity-90"><div className="opacity-70">Σήμερα</div><div className="font-semibold">{hrs}</div></div>;
            })()}
          </div>
        )}

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
                <li key={n.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-brand-600 shadow-sm"><Sparkles className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-sm font-semibold text-slate-800">{n.title}</div>
                      <div className="break-words text-sm text-slate-600">{n.body}</div>
                    </div>
                    <button onClick={() => dismissNotif(n.id)} title="Το είδα" className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/70 hover:text-slate-600"><X className="h-4 w-4" /></button>
                  </div>
                  {/* ενέργειες */}
                  {n.type === "answer" && pickupFor !== n.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-10">
                      <button onClick={() => { setPickupFor(n.id); setPickupDate(""); }} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"><CalendarPlus className="h-3.5 w-3.5" /> Θα περάσω να το πάρω</button>
                      <button onClick={() => dismissNotif(n.id)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"><CheckCircle2 className="h-3.5 w-3.5" /> Το είδα</button>
                    </div>
                  )}
                  {n.type === "answer" && pickupFor === n.id && (
                    <div className="mt-2 space-y-2 rounded-xl border border-brand-200 bg-white/70 p-2.5 pl-3">
                      <div className="text-xs font-medium text-slate-600">Πότε θα περάσεις; <span className="text-slate-400">(προαιρετικό)</span></div>
                      <DateInput value={pickupDate} onChange={setPickupDate} min={new Date().toISOString().slice(0, 10)} className="w-full" />
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => notifPickup(n.id, true, pickupDate)} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"><CheckCircle2 className="h-3.5 w-3.5" /> Στείλε στο φαρμακείο</button>
                        <button onClick={() => notifPickup(n.id, false)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Δεν θα περάσω</button>
                        <button onClick={() => { setPickupFor(null); setPickupDate(""); }} className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-600">Άκυρο</button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── KPI cards ──────────────────────────────────────── */}
        {summary && (() => {
          const coverPct = summary.total_cents > 0 ? Math.round((summary.covered_cents / summary.total_cents) * 100) : 0;
          const availNow = renewals?.length ?? 0;
          const points = loyalty?.member?.points ?? 0;
          return (
          <div className="mb-7 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <Kpi icon={Pill} tint="indigo" label="Συνταγές" value={String(summary.rx_count)}
              sub={summary.last_at ? `τελευταία ${dt(summary.last_at)}` : "—"} />
            <Kpi icon={ShieldCheck} tint="emerald" label="Σε κάλυψε το ταμείο" value={eur(summary.covered_cents)}
              sub={`σε ${summary.rx_count} συνταγές`} highlight />
            <Kpi icon={Wallet} tint="amber" label="Πλήρωσες" value={eur(summary.paid_cents)}
              sub={`από ${eur(summary.total_cents)} σύνολο`} />
            <Kpi icon={RefreshCw} tint="violet" label="Ενεργές επαναλήψεις" value={String(summary.repeats_active)}
              sub={summary.next_open_date ? `επόμενη ${dt(summary.next_open_date)}` : "καμία προγραμματισμένη"} />
            {/* νέα KPI που ενδιαφέρουν τον πελάτη */}
            <Kpi icon={Percent} tint="sky" label="Κάλυψη ταμείου" value={`${coverPct}%`}
              sub="της αξίας των φαρμάκων σου" />
            <Kpi icon={PackageCheck} tint="emerald" label="Διαθέσιμες τώρα" value={String(availNow)}
              sub={availNow > 0 ? "έτοιμες προς εκτέλεση" : "καμία εκκρεμής"} />
            {loyalty?.enabled
              ? <Kpi icon={Gift} tint="rose" label="Πόντοι επιβράβευσης" value={String(points)}
                  sub={loyalty.member ? "για εκπτώσεις & δώρα" : "μπες στο πρόγραμμα"} />
              : <Kpi icon={Pill} tint="sky" label="Διαφορετικά φάρμακα" value={String(summary.medicines)}
                  sub="στο ιστορικό σου" />}
            <Kpi icon={Stethoscope} tint="indigo" label="Γιατροί" value={String(summary.doctors)}
              sub="συνταγογράφησαν για σένα" />
          </div>
          );
        })()}

        {/* ── Κονσόλα (ΜΟΝΟ desktop) ─────────────────────────────
            Στο κινητό η Αρχική είναι ήδη γεμάτη & τα δεδομένα είναι ένα tap μακριά· σε desktop
            έμενε μεγάλο κενό, οπότε φέρνουμε εδώ ό,τι κοιτάει καθημερινά ο πελάτης. */}
        <div className="mb-7 hidden gap-4 lg:grid lg:grid-cols-3">
          {/* 1) σημερινές λήψεις */}
          <HomePanel icon={Pill} tint="violet" title="Οι λήψεις σου σήμερα"
            action={visibleTabs.some(([k]) => k === "meds") ? () => setTab("meds") : undefined}>
            {(() => {
              if (!sched) return <PanelHint text="Φόρτωση…" />;
              const todayDow = (new Date().getDay() + 6) % 7;
              const day = sched.week.find((d) => d.dow === todayDow);
              const thMap: Record<string, Therapy> = Object.fromEntries(sched.therapies.map((t) => [t.med_key, t]));
              const doses = day ? genDosesFor(day.slots, thMap) : [];
              if (doses.length === 0) return <PanelHint text="Καμία προγραμματισμένη λήψη σήμερα." />;
              const taken = new Set((sched.taken_today ?? []).map((t) => `${t.med_key}|${t.slot ?? ""}`));
              const left = doses.filter((d) => !taken.has(`${d.med_key}|${d.time}`)).length;
              return (
                <>
                  <div className="mb-2 text-xs font-semibold text-violet-700">
                    {left === 0 ? "✓ Τα πήρες όλα σήμερα!" : `Απομένουν ${left} από ${doses.length}`}
                  </div>
                  <ul className="space-y-1.5">
                    {doses.slice(0, 5).map((d, i) => {
                      const on = taken.has(`${d.med_key}|${d.time}`);
                      return (
                        <li key={i} className="flex items-center gap-2 text-sm">
                          <span className={`w-11 shrink-0 rounded-md px-1 py-0.5 text-center text-[11px] font-bold ${on ? "bg-emerald-100 text-emerald-700" : "bg-violet-100 text-violet-700"}`}>{d.time}</span>
                          <span className={`min-w-0 flex-1 truncate ${on ? "text-slate-400 line-through" : "text-slate-700"}`}>{d.name}</span>
                          {on && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                        </li>
                      );
                    })}
                  </ul>
                  {doses.length > 5 && <div className="mt-1.5 text-[11px] text-slate-400">+{doses.length - 5} ακόμη</div>}
                </>
              );
            })()}
          </HomePanel>

          {/* 2) τελευταίες συνταγές */}
          <HomePanel icon={FileText} tint="indigo" title="Τελευταίες συνταγές"
            action={visibleTabs.some(([k]) => k === "rx") ? () => setTab("rx") : undefined}>
            {rx.length === 0 ? <PanelHint text="Δεν υπάρχουν συνταγές ακόμη." /> : (
              <ul className="space-y-1.5">
                {rx.slice(0, 5).map((p) => (
                  <li key={p.barcode} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-mono text-[13px] text-slate-700">#{p.barcode.split(":")[0]}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">{new Date(p.executed_at).toLocaleDateString("el-GR")}</span>
                  </li>
                ))}
              </ul>
            )}
          </HomePanel>

          {/* 3) ανοιχτά ραντεβού */}
          <HomePanel icon={CalendarPlus} tint="sky" title="Ανοιχτά ραντεβού"
            action={visibleTabs.some(([k]) => k === "appointments") ? () => setTab("appointments") : undefined}>
            {(() => {
              const open = appts.filter((a) => !DONE.includes(a.status));
              if (open.length === 0) return <PanelHint text="Δεν έχεις ανοιχτά ραντεβού." />;
              return (
                <ul className="space-y-1.5">
                  {open.slice(0, 5).map((a, i) => (
                    <li key={a._id ?? i} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate text-slate-700">{a.service_name}</span>
                      <span className="shrink-0 text-[11px] text-slate-400">{new Date(a.requested_at).toLocaleDateString("el-GR")}</span>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </HomePanel>
        </div>
        </>)}

        {/* ── tabs (ΜΟΝΟ tablet) ─────────────────────────────────
            Κινητό: σταθερή κάτω μπάρα (βλ. τέλος). Desktop (lg+): πλαϊνό μενού — εδώ κρύβονται. */}
        <div className="mb-5 hidden flex-wrap gap-2 sm:flex lg:hidden">
          {visibleTabs.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-semibold transition ${tab === k
                ? "border-brand-600 bg-brand-600 text-white shadow-sm shadow-brand-500/30"
                : "border-slate-200 bg-white text-slate-700 shadow-sm hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"}`}>
              {label}
            </button>
          ))}
        </div>
        {/* Στο κινητό: τίτλος ενεργής ενότητας (η μπάρα είναι κάτω)· στην Αρχική ο χαιρετισμός είναι ο τίτλος */}
        {tab !== "home" && <div className="mb-4 flex items-center gap-2 sm:hidden">
          {(() => { const I = TAB_ICON[tab] || FileText; return <I className="h-5 w-5 text-brand-600" />; })()}
          <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{TAB_LABEL[tab]}</h2>
        </div>}

        {/* ── PRESCRIPTIONS ──────────────────────────────────── */}
        {tab === "rx" && (() => {
          const qn = rxQuery.trim();
          const filtered = rx.filter((p) => {
            const bc = p.barcode.split(":")[0];
            if (qn && !bc.includes(qn)) return false;
            const d = (p.executed_at || "").slice(0, 10);
            if (rxFrom && d < rxFrom) return false;
            if (rxTo && d > rxTo) return false;
            return true;
          });
          const active = !!(qn || rxFrom || rxTo);
          // Χωρίς φίλτρο: οι 5 πιο πρόσφατες (εκτός αν «όλες»). Με φίλτρο: όλα τα αποτελέσματα.
          const shown = active || rxShowAll ? filtered : filtered.slice(0, 5);
          return (
          <div className="space-y-3">
            {/* Αναζήτηση: αριθμός συνταγής + ημερομηνιακό διάστημα */}
            <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                <input value={rxQuery} onChange={(e) => setRxQuery(e.target.value)} inputMode="numeric" placeholder="Αναζήτηση με αριθμό συνταγής…"
                  className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-11 pr-3 text-[15px] focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-0.5 block text-[11px] font-medium text-slate-500">Από</label>
                  <DateInput value={rxFrom} onChange={setRxFrom} className="w-full" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-medium text-slate-500">Έως</label>
                  <DateInput value={rxTo} onChange={setRxTo} className="w-full" />
                </div>
              </div>
              {active && (
                <button onClick={() => { setRxQuery(""); setRxFrom(""); setRxTo(""); }} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"><X className="h-3.5 w-3.5" /> Καθαρισμός</button>
              )}
            </div>
            {/* πλαίσιο πλοήγησης: πόσα δείχνουμε */}
            {!active && rx.length > 5 && (
              <div className="flex items-center justify-between px-1 text-xs text-slate-500">
                <span>{rxShowAll ? `Όλες οι συνταγές (${filtered.length})` : "Οι 5 πιο πρόσφατες εκτελέσεις"}</span>
                <button onClick={() => setRxShowAll((v) => !v)} className="font-semibold text-brand-600 hover:text-brand-700">{rxShowAll ? "Δείξε λιγότερες" : "Δείξε όλες"}</button>
              </div>
            )}
            {active && <div className="px-1 text-xs text-slate-500">{filtered.length} {filtered.length === 1 ? "αποτέλεσμα" : "αποτελέσματα"}</div>}

            {rx.length === 0 && <Empty icon={Pill} text="Δεν υπάρχουν συνταγές ακόμα." />}
            {rx.length > 0 && shown.length === 0 && <Empty icon={Search} text="Καμία συνταγή για αυτά τα κριτήρια." />}
            {shown.map((p) => {
              const open = expanded === p.barcode;
              return (
                <div key={p.barcode} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md">
                  <button onClick={() => toggleExpand(p.barcode, p.tenant_id)} className="flex w-full items-center gap-2.5 p-2.5 text-left sm:p-3">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${p.partial ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"}`}><Pill className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-800">#{p.barcode.split(":")[0]}</span>
                        {p.partial
                          ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"><AlertCircle className="h-3 w-3" /> Μερική</span>
                          : <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700"><CheckCircle2 className="h-3 w-3" /> Πλήρης</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3 text-slate-400" /> {dt(p.executed_at)}</span>
                        {/* ΠΟΥ έγινε η εκτέλεση — ο πελάτης βλέπει εκτελέσεις από όλα τα φαρμακεία του */}
                        {p.pharmacy_name && (
                          <span className="inline-flex min-w-0 items-center gap-1 text-slate-500">
                            <Building2 className="h-3 w-3 shrink-0 text-slate-400" />
                            <span className="truncate">{p.pharmacy_name}</span>
                          </span>
                        )}
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
          );
        })()}

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

        {/* ── ΑΝΕΚΤΕΛΕΣΤΑ (διαθέσιμες ανανεώσεις) ───────────── */}
        {tab === "renewals" && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">Χρόνιες επαναλαμβανόμενες συνταγές σου που είναι <b>διαθέσιμες προς εκτέλεση</b> στο φαρμακείο σου. Δήλωσε αν θα τις παραλάβεις (& πότε θα περάσεις) ή όχι — έτσι ο φαρμακοποιός προγραμματίζει διαθεσιμότητα & παράδοση.</p>
            {renewals === null ? (
              <div className="p-6 text-center text-slate-400">Φόρτωση…</div>
            ) : renewals.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">Δεν υπάρχουν ανεκτέλεστα αυτή τη στιγμή. 👍</div>
            ) : (
              renewals.map((r, i) => (
                <RenewalCard key={r.key || i} r={r} onDone={() => patientApi<{ items: Renewal[] }>("/patient/renewals").then((d) => setRenewals(d.items)).catch(() => {})} />
              ))
            )}
          </div>
        )}

        {/* ── ΥΓΕΙΑ / ΜΕΤΡΗΣΕΙΣ ─────────────────────────────── */}
        {tab === "shop" && <ShopTab key={me.active_tenant ?? "none"} tenantKey={me.active_tenant ?? "none"} />}

        {tab === "meds" && (
          <div className="space-y-4">
            {/* δύο όψεις: Ημερολόγιο (πότε) & Ρυθμίσεις (ποια αγωγή θέλω ενημέρωση) */}
            <div className="flex gap-1.5 rounded-xl bg-slate-100 p-1">
              {([["calendar", "Ημερολόγιο", Calendar], ["settings", "Ρυθμίσεις", BellRing]] as const).map(([k, label, Icon]) => (
                <button key={k} onClick={() => setMedsView(k)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-semibold transition ${medsView === k ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}>
                  <Icon className="h-4 w-4" />{label}
                </button>
              ))}
            </div>

            {!sched ? <div className="py-10 text-center text-sm text-slate-400">Φόρτωση…</div>
             : sched.therapies.length === 0 ? <Empty icon={BellRing} text="Δεν βρέθηκαν ενεργές αγωγές αυτή τη στιγμή." />
             : medsView === "calendar" ? (<>
              {/* ── ΗΜΕΡΟΛΟΓΙΟ ── */}
              {!!sched.streak && <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-xs font-bold text-orange-700">🔥 {sched.streak} {sched.streak === 1 ? "μέρα" : "μέρες"} συνεπής λήψη στη σειρά!</div>}
              {sched.week.some((d) => d.slots.length > 0) ? (() => {
                const todayDow = (new Date().getDay() + 6) % 7;
                const takenSet = new Set((sched.taken_today ?? []).map((t) => `${t.med_key}|${t.slot ?? ""}`));
                const thMap: Record<string, Therapy> = Object.fromEntries(sched.therapies.map((t) => [t.med_key, t]));
                const genDoses = (d: { slots: SlotCell[] }) => genDosesFor(d.slots, thMap);   // βλ. genDosesFor
                // ΣΗΜΕΡΑ πρώτη & ανοιχτή· οι υπόλοιπες κλειστές (accordion) — κλικ για άνοιγμα.
                const days = sched.week.filter((d) => d.slots.length > 0)
                  .sort((a, b) => (a.dow === todayDow ? -1 : b.dow === todayDow ? 1 : a.dow - b.dow));
                return (
                <div className="space-y-2">
                  {days.map((d) => {
                    const today = d.dow === todayDow;
                    const open = openDay === d.dow;
                    // δόσεις της μέρας (γεννημένες ανά ώρα)· πλήθος «να πάρω» = μη-ειλημμένες
                    const doses = genDoses(d);
                    const pending = today ? doses.filter((x) => !takenSet.has(`${x.med_key}|${x.time}`)).length : 0;
                    return (
                      <div key={d.dow} className={`overflow-hidden rounded-2xl border ${today ? "border-violet-300 ring-1 ring-violet-200" : "border-slate-200"}`}>
                        <button onClick={() => setOpenDay(open ? null : d.dow)} className="flex w-full items-center justify-between gap-2 bg-white px-3.5 py-2.5 text-left">
                          <span className="flex items-center gap-2 text-sm font-bold text-slate-700">
                            {DOW[d.dow]}
                            {today && <span className="rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">σήμερα</span>}
                            {today && pending > 0 && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">{pending} να πάρω</span>}
                            {today && pending === 0 && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">✓ όλα</span>}
                          </span>
                          {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                        </button>
                        {open && (
                          <div className="space-y-1.5 border-t border-slate-100 bg-slate-50/40 px-3.5 py-3">
                            {doses.map((x, i) => {
                              const taken = today && takenSet.has(`${x.med_key}|${x.time}`);
                              return (
                                <button key={i} onClick={() => { if (today) toggleIntake(x.med_key, x.time, taken); }} disabled={!today}
                                  title={taken ? "Πάτα για αναίρεση" : "Πάτα «Το πήρα»"}
                                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition ${taken ? "bg-emerald-50 text-emerald-700" : today ? "bg-violet-50 text-violet-800 hover:bg-violet-100" : "bg-white text-slate-600"}`}>
                                  <span className="min-w-0 flex-1">
                                    <span className={`block truncate text-sm font-bold ${taken ? "line-through opacity-60" : ""}`}>{x.name}</span>
                                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">⏰ {x.time}{x.dose ? ` · ${x.dose}` : ""}{x.meal === "before" ? " · 🍽️ πριν" : x.meal === "after" ? " · 🍽️ μετά" : ""}</span>
                                  </span>
                                  {today && (taken
                                    ? <span className="shrink-0 self-center text-[11px] font-bold">✓ · ↺</span>
                                    : <span className="shrink-0 self-center rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-bold text-white">Το πήρα</span>)}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                );
              })() : <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">Δεν έχεις ενεργές υπενθυμίσεις.<br />Πήγαινε στις <b>Ρυθμίσεις</b> και ενεργοποίησε ποιες αγωγές θες να σου θυμίζουμε.</p>}
             </>) : (<>
              {/* ── ΡΥΘΜΙΣΕΙΣ (ποια αγωγή θέλω ενημέρωση) ── */}
              <div className="rounded-2xl bg-gradient-to-br from-violet-50 to-indigo-50 p-4">
                <div className="text-sm font-semibold text-violet-900">💊 Ποιες αγωγές να σου θυμίζουμε;</div>
                <p className="mt-1 text-xs text-violet-700">Φτιαγμένο από τις <b>οδηγίες του γιατρού σου</b> (όπως καταχωρήθηκαν στην ΗΔΥΚΑ). Άναψε τον διακόπτη σε όσες θες υπενθύμιση — θα εμφανιστούν στο <b>Ημερολόγιο</b>. <span className="opacity-70">Ακολούθα πάντα τις οδηγίες του γιατρού/φαρμακοποιού σου.</span></p>
              </div>
              <div className="space-y-2">
                {sched.therapies.map((th) => {
                  const warn = th.days_left !== null && th.days_left <= 7;
                  return (
                    <div key={th.med_key} className={`rounded-2xl border p-3 ${th.enabled ? "border-violet-200 bg-white" : "border-slate-200 bg-slate-50"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-800">{th.name}</div>
                          {th.dosage_text && <div className="mt-0.5 text-xs text-slate-500">{th.dosage_text}</div>}
                          {th.days_left !== null && (
                            <div className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${warn ? "bg-amber-100 text-amber-700" : "bg-emerald-50 text-emerald-600"}`}>
                              {warn ? "⏳" : "✓"} {th.days_left <= 0 ? "τελειώνει σήμερα" : `απομένουν ${th.days_left} ημέρες`}
                            </div>
                          )}
                        </div>
                        <button onClick={() => toggleMed(th.med_key, !th.enabled)}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition ${th.enabled ? "bg-violet-600" : "bg-slate-300"}`}>
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${th.enabled ? "left-[1.45rem]" : "left-0.5"}`} />
                        </button>
                      </div>
                      {/* όταν ενεργό: ώρα λήψης + σχέση με γεύμα (πάτα για αλλαγή) */}
                      {th.enabled && medCfg?.med_key !== th.med_key && (
                        <button onClick={() => setMedCfg({ med_key: th.med_key, time: th.time || "08:00", meal: th.meal || "none", mode: th.interval_hours ? "interval" : "time", interval: th.interval_hours || Math.max(1, Math.round(24 / (th.per_day || 1))), per_day: th.per_day || 1 })}
                          className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-lg bg-violet-50 px-2.5 py-1 text-xs text-violet-700 hover:bg-violet-100">
                          <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {th.interval_hours ? `κάθε ${th.interval_hours} ώρες` : (th.time || "—")}</span>
                          <span>{th.meal === "before" ? "🍽️ πριν το γεύμα" : th.meal === "after" ? "🍽️ μετά το γεύμα" : "άσχετο με γεύμα"}</span>
                          <span className="text-[10px] text-violet-400">· αλλαγή</span>
                        </button>
                      )}
                      {/* φόρμα ρύθμισης (εμφανίζεται στην ενεργοποίηση ή στην «αλλαγή») */}
                      {medCfg?.med_key === th.med_key && (
                        <div className="mt-2 space-y-2 rounded-xl border border-violet-200 bg-violet-50/50 p-2.5">
                          {medCfg.per_day > 1 && <div className="text-[11px] font-medium text-violet-700">💊 {medCfg.per_day} λήψεις/ημέρα — διάλεξε τρόπο:</div>}
                          {/* toggle ΜΟΝΟ για >1×/μέρα — είτε συγκεκριμένη ώρα ΕΙΤΕ κάθε X ώρες (όχι μαζί) */}
                          {medCfg.per_day > 1 && (
                            <div className="flex gap-1.5">
                              {([["time", "Συγκεκριμένη ώρα"], ["interval", "Κάθε X ώρες"]] as const).map(([mv, ml]) => (
                                <button key={mv} onClick={() => setMedCfg({ ...medCfg, mode: mv })} className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${medCfg.mode === mv ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>{ml}</button>
                              ))}
                            </div>
                          )}
                          {medCfg.per_day > 1 && medCfg.mode === "interval" && (
                            <div>
                              <div className="mb-1 text-[11px] font-medium text-slate-600">🔁 Κάθε πόσες ώρες;</div>
                              <select value={medCfg.interval} onChange={(e) => setMedCfg({ ...medCfg, interval: +e.target.value })} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-violet-400 focus:outline-none">
                                {[3, 4, 6, 8, 12].map((h) => <option key={h} value={h}>κάθε {h} ώρες</option>)}
                              </select>
                            </div>
                          )}
                          {/* ώρα (πάντα): «Ώρα λήψης» στη συγκεκριμένη ώρα, «Ώρα 1ης λήψης» στο interval */}
                          <div>
                            <div className="mb-1 text-[11px] font-medium text-slate-600">⏰ {medCfg.per_day > 1 && medCfg.mode === "interval" ? "Ώρα 1ης λήψης" : "Ώρα λήψης"} (24ωρο)</div>
                            <div className="flex items-center gap-1.5">
                              <select value={(medCfg.time || "08:00").split(":")[0]} onChange={(e) => setMedCfg({ ...medCfg, time: `${e.target.value}:${(medCfg.time || "08:00").split(":")[1] || "00"}` })} className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-violet-400 focus:outline-none">
                                {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")).map((h) => <option key={h} value={h}>{h}</option>)}
                              </select>
                              <span className="font-bold text-slate-400">:</span>
                              <select value={(medCfg.time || "08:00").split(":")[1] || "00"} onChange={(e) => setMedCfg({ ...medCfg, time: `${(medCfg.time || "08:00").split(":")[0]}:${e.target.value}` })} className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-violet-400 focus:outline-none">
                                {["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"].map((mn) => <option key={mn} value={mn}>{mn}</option>)}
                              </select>
                            </div>
                          </div>
                          {medCfg.per_day > 1 && medCfg.mode === "interval" && (
                            <div className="rounded-lg bg-white/70 px-2 py-1 text-[10px] text-slate-500">Δόσεις: {Array.from({ length: Math.ceil(24 / medCfg.interval) }, (_, i) => { const [h, mn] = medCfg.time.split(":").map(Number); const tot = ((h * 60 + mn + i * medCfg.interval * 60) % 1440); return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`; }).join(" · ")}</div>
                          )}
                          <div>
                            <div className="mb-1 text-[11px] font-medium text-slate-600">🍽️ Σε σχέση με το γεύμα</div>
                            <div className="flex gap-1.5">
                              {([["before", "Πριν"], ["after", "Μετά"], ["none", "Άσχετο"]] as const).map(([v, l]) => (
                                <button key={v} onClick={() => setMedCfg({ ...medCfg, meal: v })}
                                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${medCfg.meal === v ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>{l}</button>
                              ))}
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setMedCfg(null)} className="px-2 py-1 text-xs text-slate-400">Άκυρο</button>
                            <button onClick={saveMedCfg} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">Αποθήκευση</button>
                          </div>
                        </div>
                      )}
                      {th.reservable && (
                        <div className="mt-2">
                          <button onClick={() => reserveMed(th.name)} className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100">
                            🔁 Κράτηση επανάληψης
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
             </>)}
          </div>
        )}

        {tab === "health" && (() => {
          const lt = health?.latest ?? {}; const bp = lt.bp; const gl = lt.glucose; const wt = lt.weight;
          const bmi = health?.height_cm && wt?.value ? (wt.value / ((health.height_cm / 100) ** 2)) : undefined;
          const hist = health?.history ?? {};
          // σύγκριση τρέχουσας vs προηγούμενης (χαμηλότερα = καλύτερα για πίεση/ζάχαρο· βάρος = ουδέτερο)
          const trend = (k: "bp" | "glucose" | "weight") => {
            const h = hist[k] ?? []; if (h.length < 2) return null;
            const cur = k === "bp" ? (h[0].systolic ?? 0) : (h[0].value ?? 0);
            const prev = k === "bp" ? (h[1].systolic ?? 0) : (h[1].value ?? 0);
            const d = cur - prev; if (d === 0) return { d, better: null as boolean | null };
            return { d, better: k === "weight" ? null : d < 0 };  // πίεση/ζάχαρο: μείωση = βελτίωση
          };
          const tiles = [
            { k: "bp" as const, label: "Πίεση", val: bp ? `${bpShow(bp.systolic)}/${bpShow(bp.diastolic)}` : "—", sub: bp ? dt(bp.at) : "—", cls: hStat("bp", bp), watch: bp && !hStat("bp", bp).includes("emerald") },
            { k: "glucose" as const, label: "Ζάχαρο", val: gl ? `${gl.value}` : "—", sub: gl ? `mg/dL` : "—", cls: hStat("glucose", gl), watch: gl && !hStat("glucose", gl).includes("emerald") },
            { k: "weight" as const, label: "Βάρος", val: wt ? wShow(wt.value) : "—", sub: wt ? "kg" : "—", cls: "bg-slate-50 text-slate-700", watch: false },
          ];
          const watchList = tiles.filter((t) => t.watch).map((t) => t.label);
          // όλες οι ημερομηνίες μέτρησης (ενοποιημένες) — κάτω, με drill-down
          const byDate: Record<string, { bp?: HMeas; glucose?: HMeas; weight?: HMeas }> = {};
          (["bp", "glucose", "weight"] as const).forEach((k) => (hist[k] ?? []).forEach((m) => {
            const day = (m.at || "").slice(0, 10); if (!day) return;
            (byDate[day] ??= {})[k] = m;
          }));
          const dates = Object.keys(byDate).sort().reverse();
          const sel = healthDate && byDate[healthDate] ? healthDate : dates[0];
          const anyHist = dates.length > 0;
          const fmtM = (k: "bp" | "glucose" | "weight", m?: HMeas) => !m ? "—" : k === "bp" ? `${bpShow(m.systolic)}/${bpShow(m.diastolic)}` : k === "glucose" ? `${m.value} mg/dL` : `${wShow(m.value)} kg`;
          return (
            <div className="space-y-4">
              {/* ΤΡΕΧΟΥΣΕΣ (τελευταίες) μετρήσεις + σύγκριση με προηγούμενη */}
              <div>
                <div className="mb-2 text-sm font-bold text-slate-700">Τελευταίες μετρήσεις</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {tiles.map((tl) => {
                    const tr = trend(tl.k);
                    return (
                      <div key={tl.k} className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="flex items-center justify-between"><span className="text-xs text-slate-500">{tl.label}</span>{tl.watch ? <span className="text-[10px] font-bold text-amber-600">⚠️ προσοχή</span> : tl.val !== "—" && <span className="text-[10px] font-bold text-emerald-600">✓</span>}</div>
                        <div className={`mt-1 inline-flex rounded px-1.5 text-xl font-bold ${tl.cls}`}>{tl.val}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                          <span className="text-slate-400">{tl.sub}</span>
                          {tr && tr.d !== 0 && <span className={`font-bold ${tr.better === null ? "text-slate-500" : tr.better ? "text-emerald-600" : "text-rose-600"}`}>{tr.d > 0 ? "▲" : "▼"}{tl.k === "bp" ? (Math.abs(tr.d) / 10).toFixed(1).replace(".", ",") : tl.k === "weight" ? Math.abs(tr.d).toFixed(2).replace(".", ",") : Math.abs(tr.d).toFixed(0)}{tr.better === true ? " ✓" : tr.better === false ? " !" : ""}</span>}
                        </div>
                      </div>
                    );
                  })}
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs text-slate-500">ΔΜΣ</div>
                    <div className={`mt-1 inline-flex rounded px-1.5 text-xl font-bold ${bmi ? (bmi >= 30 ? "bg-rose-50 text-rose-700" : (bmi >= 25 || bmi < 18.5) ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700") : "bg-slate-50 text-slate-500"}`}>{bmi ? bmi.toFixed(1) : "—"}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{health?.height_cm ? `ύψος ${(health.height_cm / 100).toFixed(2).replace(".", ",")}μ` : "—"}</div>
                  </div>
                </div>
                {watchList.length > 0 && <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">⚠️ Χρειάζονται προσοχή: <b>{watchList.join(", ")}</b> — συζήτησέ το με τον φαρμακοποιό/γιατρό σου.</div>}
              </div>

              {/* ΗΜΕΡΟΜΗΝΙΕΣ μετρήσεων — κλικ για να δεις τις μετρήσεις εκείνης της μέρας */}
              {anyHist ? (
                <div>
                  <div className="mb-2 text-sm font-bold text-slate-700">Ιστορικό ανά ημερομηνία</div>
                  <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {dates.map((d) => (
                      <button key={d} onClick={() => setHealthDate(d)} className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold ${sel === d ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}>{dt(d)}</button>
                    ))}
                  </div>
                  {sel && (
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="mb-2 text-xs font-semibold text-slate-500">Μετρήσεις {dt(sel)}</div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        {(["bp", "glucose", "weight"] as const).map((k) => (
                          <div key={k} className="rounded-xl bg-slate-50 p-2.5">
                            <div className="text-[11px] text-slate-500">{k === "bp" ? "Πίεση" : k === "glucose" ? "Ζάχαρο" : "Βάρος"}</div>
                            <div className={`mt-0.5 text-sm font-bold ${byDate[sel][k] ? "text-slate-800" : "text-slate-300"}`}>{fmtM(k, byDate[sel][k])}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : <Empty icon={Pill} text="Δεν υπάρχουν μετρήσεις ακόμη — καταχωρούνται από το φαρμακείο σου." />}
            </div>
          );
        })()}

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
                    <div className="text-sm font-medium opacity-90">{m.balance_cents > 0 ? "διαθέσιμα για εξαργύρωση στο φαρμακείο" : "μάζεψε πόντους σε κάθε αγορά/επίσκεψη"}{m.points > 0 ? ` · ${m.points} πόντοι` : ""}</div>
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
              <div className={`grid grid-cols-2 gap-2 ${assignBusy ? "pointer-events-none opacity-60" : ""}`}>
                {/* Άνοιξε ΚΑΜΕΡΑ κατευθείαν (capture) */}
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
                  <Camera className="h-[18px] w-[18px]" /> Άνοιξε κάμερα
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) submitPhoto(f); }} />
                </label>
                {/* Επίλεξε αρχείο/φωτογραφία (χωρίς capture → gallery/αρχεία) */}
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
                  <Upload className="h-[18px] w-[18px]" /> Επίλεξε αρχείο
                  <input type="file" accept="image/*,application/pdf" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) submitPhoto(f); }} />
                </label>
              </div>
              {assignBusy && <div className="mt-2 flex items-center gap-2 text-xs text-slate-400"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Αποστολή…</div>}
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
                  <DateInput required value={appt.date} min={new Date().toISOString().slice(0, 10)} onChange={(v) => setAppt({ ...appt, date: v })} className="w-full" />
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
            {/* ΟΛΑ τα ραντεβού σε ΟΛΑ τα φαρμακεία — Ενεργά πρώτα, μετά ολοκληρωμένα· κάθε ένα
                με ΣΑΦΗ ένδειξη σε ποιο φαρμακείο αφορά (προσωπικό «ημερολόγιο» του πελάτη). */}
            {(() => {
              const activeA = appts.filter((a) => !DONE.includes(a.status));
              const pastA = appts.filter((a) => DONE.includes(a.status));
              const activeName = me.pharmacies.find((p) => p.tenant_id === me.active_tenant)?.pharmacy_name;
              const Card = (a: Appt, i: number) => {
                const forActive = !a.tenant_id || a.tenant_id === me.active_tenant;
                const phName = a.pharmacy_name || (forActive ? activeName : null);
                return (
                  <div key={a._id ?? i} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600"><Calendar className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-800">{a.service_name}</div>
                      <div className="text-xs text-slate-500">{dtl(a.requested_at)}</div>
                      {phName && <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-brand-600"><Building2 className="h-3 w-3" /> {phName}</div>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusCls(a.status)}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
                  </div>
                );
              };
              if (appts.length === 0) return <Empty icon={Calendar} text="Δεν έχεις ραντεβού." />;
              const list = apptView === "open" ? activeA : pastA;
              return (
                <div className="space-y-3">
                  {/* διαχωρισμός: ΑΝΟΙΧΤΑ vs ΚΛΕΙΣΤΑ */}
                  <div className="flex gap-1.5 rounded-xl bg-slate-100 p-1">
                    {([["open", "Ανοιχτά", activeA.length], ["closed", "Κλειστά", pastA.length]] as const).map(([k, label, n]) => (
                      <button key={k} onClick={() => setApptView(k)}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-semibold transition ${apptView === k ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}>
                        {label}<span className={`grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[10px] font-bold ${apptView === k ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-500"}`}>{n}</span>
                      </button>
                    ))}
                  </div>
                  {list.length === 0
                    ? <p className="py-8 text-center text-sm text-slate-400">{apptView === "open" ? "Κανένα ανοιχτό ραντεβού." : "Δεν υπάρχει ιστορικό ραντεβού."}</p>
                    : <div className={`space-y-2 ${apptView === "closed" ? "opacity-80" : ""}`}>{list.map(Card)}</div>}
                </div>
              );
            })()}
          </div>
        )}

        {/* ── NETWORK PHARMACY DIRECTORY ─────────────────────── */}
        {tab === "pharmacies" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2 text-xs text-brand-800">
              Διάλεξε φαρμακείο για να το <b>εξυπηρετηθείς</b> — ερωτήματα διαθεσιμότητας, αγορές, ανάθεση συνταγής. Το ιστορικό (συνταγές, παραγγελίες, ερωτήματα) είναι <b>ξεχωριστό ανά φαρμακείο</b>.
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                <input value={dirQuery} onChange={(e) => setDirQuery(e.target.value)} placeholder="Αναζήτηση φαρμακείου ή περιοχής…"
                  className="w-full rounded-2xl border border-slate-300 bg-white py-2.5 pl-11 pr-3 text-[15px] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
              </div>
              <button onClick={requestGeo} disabled={geoBusy} title="Ταξινόμηση κατά απόσταση"
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-2xl border px-3 py-2.5 text-xs font-semibold shadow-sm ${geo ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 bg-white text-slate-600"}`}>
                <Navigation className={`h-4 w-4 ${geoBusy ? "animate-pulse" : ""}`} /> {geo ? "Κοντινά" : "Βρες κοντινά"}
              </button>
            </div>
            {(() => {
              const qn = dirQuery.trim().toLowerCase();
              const list = directory
                .filter((d) => !qn || d.name.toLowerCase().includes(qn) || (d.city || "").toLowerCase().includes(qn) || (d.address || "").toLowerCase().includes(qn))
                .map((d) => ({ ...d, dist: geo && d.lat != null && d.lon != null ? haversineKm(geo, d.lat, d.lon) : null }));
              // αγαπημένο → δικά μου → υπόλοιπα· μέσα σε κάθε ομάδα κατά απόσταση (αν υπάρχει τοποθεσία)
              list.sort((a, b) => {
                const fa = (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1); if (fa) return fa;
                const ma = (a.mine ? 0 : 1) - (b.mine ? 0 : 1); if (ma) return ma;
                const da = a.dist ?? Infinity, db = b.dist ?? Infinity; if (da !== db) return da - db;
                return a.name.localeCompare(b.name, "el");
              });
              if (directory.length === 0) return <Empty icon={MapPin} text="Δεν βρέθηκαν φαρμακεία δικτύου." />;
              if (list.length === 0) return <Empty icon={Search} text="Κανένα φαρμακείο για αυτή την αναζήτηση." />;
              return (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{list.map((d) => {
                const s = d.status;
                const crossBg = s?.isOnDuty ? "bg-indigo-500" : s?.isOpen ? (s.closingSoon ? "bg-amber-500" : "bg-emerald-500") : "bg-slate-300";
                const isActive = d.tenant_id === me.active_tenant;
                return (
                  <div key={d.tenant_id} className={`rounded-2xl border bg-white p-3.5 shadow-sm ${isActive ? "border-brand-300 ring-1 ring-brand-100" : d.favorite ? "border-amber-200" : "border-slate-200"}`}>
                    <div className="flex items-start gap-3">
                      {/* σύμβολο φαρμακείου (σταυρός) — χρώμα κατά κατάσταση: πράσινο ανοιχτό, μπλε εφημερία, γκρι κλειστό */}
                      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${crossBg} shadow-sm`}><Plus className="h-6 w-6 text-white" strokeWidth={3} /></span>
                      <div className="min-w-0 flex-1 cursor-pointer" role="button" onClick={() => { if (!isActive) switchPharmacy(d.tenant_id); }}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-slate-800">{d.name}</span>
                          {d.favorite && <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"><Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" /> Αγαπημένο</span>}
                          {d.mine && <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-600">Δικό μου</span>}
                          {isActive && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">Ενεργό</span>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                          {(d.address || d.city) && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3 shrink-0 text-slate-400" />{[d.address, d.city].filter(Boolean).join(", ")}</span>}
                          {d.dist != null && <span className="inline-flex items-center gap-1 font-medium text-brand-600"><Navigation className="h-3 w-3" />{d.dist < 1 ? `${Math.round(d.dist * 1000)} μ` : `${d.dist.toFixed(1)} χλμ`}</span>}
                        </div>
                        {s && <div className={`mt-0.5 text-xs font-medium ${s.isOnDuty ? "text-indigo-600" : s.isOpen ? (s.closingSoon ? "text-amber-600" : "text-emerald-600") : "text-slate-400"}`}>{s.statusText}</div>}
                      </div>
                      <button onClick={() => setFavoritePharmacy(d.tenant_id)} title={d.favorite ? "Αφαίρεση αγαπημένου" : "Όρισε αγαπημένο"}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-slate-50">
                        <Star className={`h-[18px] w-[18px] ${d.favorite ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
                      </button>
                    </div>
                    {/* ενέργειες: επιλογή + γρήγορες δράσεις (σε αυτό το φαρμακείο) */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {isActive
                        ? <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Ενεργό φαρμακείο</span>
                        : <button onClick={() => switchPharmacy(d.tenant_id)} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"><Building2 className="h-3.5 w-3.5" /> Επίλεξε</button>}
                      <button onClick={() => switchPharmacy(d.tenant_id, "availability")} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"><Search className="h-3.5 w-3.5" /> Διαθεσιμότητα</button>
                      <button onClick={() => switchPharmacy(d.tenant_id, "shop")} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"><ShoppingBag className="h-3.5 w-3.5" /> Κατάστημα</button>
                      <button onClick={() => switchPharmacy(d.tenant_id, "assign")} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"><FilePlus className="h-3.5 w-3.5" /> Ανάθεση</button>
                      {d.phone && <a href={`tel:${d.phone}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">📞 {d.phone}</a>}
                    </div>
                  </div>
                );
              })}</div>
              );
            })()}
          </div>
        )}

        <p className="mt-8 text-center text-[11px] text-slate-300">RxVision · Πύλη Πελατών</p>
        </main>
      </div>

      {/* ── κάτω μπάρα πλοήγησης (ΜΟΝΟ κινητό) — ΚΥΛΙΟΜΕΝΗ λωρίδα όλων των διαθέσιμων ενοτήτων ──
          Σέρνεις με το δάχτυλο αριστερά/δεξιά· η ενεργή έρχεται στο κέντρο. Χωρίς «...» που κρύβει. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex gap-1 overflow-x-auto border-t border-slate-200 bg-white/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-md [-ms-overflow-style:none] [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden dark:border-slate-800 dark:bg-slate-900/95">
        {visibleTabs.map(([k, label]) => {
          const I = TAB_ICON[k] || FileText; const on = tab === k;
          return (
            <button key={k} onClick={() => setTab(k)} ref={on ? (el) => el?.scrollIntoView({ inline: "center", block: "nearest" }) : undefined}
              className={`flex min-w-[4.4rem] shrink-0 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition ${on ? "text-brand-600" : "text-slate-400"}`}>
              <I className={`h-[22px] w-[22px] ${on ? "" : "stroke-[1.75]"}`} />
              <span className="whitespace-nowrap">{NAV_SHORT[k] ?? label}</span>
            </button>
          );
        })}
      </nav>
      <Toaster />
    </div>
  );
}

const TINTS: Record<string, string> = {
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  violet: "bg-violet-50 text-violet-600",
  sky: "bg-sky-50 text-sky-600",
  rose: "bg-rose-50 text-rose-600",
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

// Πάνελ «κονσόλας» Αρχικής (desktop) — κάρτα με τίτλο, εικονίδιο & προαιρετικό «Όλα →».
function HomePanel({ icon: Icon, title, tint, action, children }: {
  icon: React.ComponentType<{ className?: string }>; title: string; tint: string;
  action?: () => void; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${TINTS[tint]}`}><Icon className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-slate-800">{title}</span>
        {action && (
          <button onClick={action} className="shrink-0 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-brand-600 hover:bg-brand-50">Όλα →</button>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function PanelHint({ text }: { text: string }) {
  return <p className="py-4 text-center text-xs text-slate-400">{text}</p>;
}

function Empty({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white py-12 text-center">
      <Icon className="mx-auto h-8 w-8 text-slate-300" />
      <p className="mt-2 text-sm text-slate-400">{text}</p>
    </div>
  );
}
