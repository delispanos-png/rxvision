"use client";

import { useEffect, useState, useCallback } from "react";
import { DateInput } from "@/components/ui/DateInput";
import { useRouter } from "next/navigation";
import {
  Pill, RefreshCw, Stethoscope, Bell, LogOut, Building2,
  Calendar, ChevronDown, ChevronUp, ChevronRight, CheckCircle2, Clock, Sparkles, X, Search, CalendarPlus, AlertCircle,
  PackageCheck, Gift, FileText, ShoppingBag, HeartPulse, FilePlus, MapPin, Home, Camera, Upload, Star, Navigation, Plus, Check,
  Sun, Moon, User, Globe,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { Tooltip } from "@/components/ui/Tooltip";
import { LogoMark } from "@/components/brand/Logo";
import { patientApi, patientTokens, patientUpload, patientLogout, API_BASE, ApiError } from "@/lib/patientClient";
import { usePref, useT } from "@/store/prefStore";
import { PharmacyPicker, MedicinePicker, type Medicine } from "@/components/portal/pickers";
import { RenewalCard, type Renewal } from "@/components/portal/RenewalCard";
import { ShopTab } from "@/components/portal/ShopTab";
import { Toaster, toast, confirmDialog } from "@/components/portal/Toaster";
import { TransferCard } from "@/components/portal/TransferCard";
import { pushSupported, isPushSubscribed, enablePush } from "@/lib/push";
import { BellRing } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/formatters";

type Pharmacy = { tenant_id: string; pharmacy_name: string };
type Pharm = { status: { isOpen: boolean; isOnDuty: boolean; isOvernightDuty: boolean; closingSoon: boolean; statusText: string; statusTextEn?: string }; schedule: { week: { day: number; status: string; intervals: { start: string; end: string }[] }[] } };
type Consent = { granted: boolean; at?: string | null };
type Me = { profile: { first_name: string; last_name: string; email?: string; phone?: string; amka?: string; phone_verified?: boolean; email_verified?: boolean; twofa_enabled?: boolean; consents?: { health_data?: Consent; marketing?: Consent }; address?: string; city?: string; postal_code?: string; theme?: "light" | "dark" | null; avatar_url?: string | null }; active_tenant: string | null; pharmacies: Pharmacy[]; portal_mode?: "network" | "single"; caps?: { shop: boolean; loyalty: boolean } };
const PF_INP = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";
type Sess = { id: string; current: boolean; user_agent?: string | null; ip?: string | null; created_at?: string | null; last_seen?: string | null };
function deviceLabel(ua: string | null | undefined, t: (el: string, en: string) => string): string {
  if (!ua) return t("Άγνωστη συσκευή", "Unknown device");
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ") || t("Πρόγραμμα περιήγησης", "Browser");
}
type DirPharmacy = { tenant_id: string; name: string; address?: string | null; city?: string | null; phone?: string | null; lat?: number | null; lon?: number | null; mine?: boolean; favorite?: boolean; status?: { isOpen: boolean; isOnDuty: boolean; isOvernightDuty: boolean; closingSoon: boolean; statusText: string; statusTextEn?: string } | null };
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
const DOW_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pdmy = (iso: string) => { const [y, m, d] = iso.split("-"); return d && m ? `${d}/${m}${y ? "/" + y.slice(2) : ""}` : iso; };
const prange = (r: PRange) => (r.start_date === r.end_date ? pdmy(r.start_date) : `${pdmy(r.start_date)}–${pdmy(r.end_date)}`) + ` ${r.start}–${r.end}`;
type Appt = { _id?: string; service_name: string; requested_at: string; status: string; tenant_id?: string; pharmacy_name?: string | null };
type Cda = { available?: boolean; found?: boolean; doctor?: string | null; medicines?: string[]; issue_date?: string | null; deadline_date?: string | null; intangible?: boolean; exec_count?: number | null; is_fyk?: boolean; has_vaccine?: boolean };
type RxReq = { _id?: string; kind: string; barcode?: string | null; note?: string | null; status: string; created_at: string; cda?: Cda | null; reply?: string | null; available_date?: string | null };
type LoyaltyMember = { patient_ref: string; name?: string; points: number; balance_cents: number; tier: string; next_tier: string | null; to_next: number; progress_pct: number; compliance: number | null; refills: number; expected: number; open_refills: number; potential_points: number; points_per_refill: number; cents_per_point: number; ledger: { type: string; cents: number; kind?: string; reason?: string; at: string }[] };
type LReward = { _id?: string; title: string; type: string; cost_points: number; cost_cents: number; note?: string };
type Reservation = { code: string; reward: string; cost_points: number; expires_at: string | null };
type Referral = { code: string | null; referrer_cents: number; referred_cents: number };
type Loyalty = { enabled: boolean; enrolled?: boolean; terms?: string; member?: LoyaltyMember | null; rewards?: LReward[]; reservation?: Reservation | null; referral?: Referral | null };
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

const TABS = [["home", "Αρχική", "Home"], ["rx", "Συνταγές", "Prescriptions"], ["shop", "e-Κατάστημα", "e-Store"], ["meds", "Πρόγραμμα λήψης", "Medication schedule"], ["health", "Υγεία", "Health"], ["wallet", "Επιβράβευση", "Rewards"], ["repeats", "Επαναλήψεις", "Refills"], ["renewals", "Ανεκτέλεστα", "Unexecuted"], ["assign", "Ανάθεση συνταγής", "Assign prescription"], ["availability", "Διαθεσιμότητα", "Availability"], ["appointments", "Ραντεβού", "Appointments"], ["pharmacies", "Φαρμακεία", "Pharmacies"]] as const;
// Σύντομες ετικέτες για τη στενή κάτω μπάρα (mobile) — αλλιώς κόβονται άσχημα.
const NAV_SHORT: Record<string, [string, string]> = { shop: ["Κατάστημα", "Store"], meds: ["Πρόγραμμα", "Schedule"] };

// Εικονίδιο ανά καρτέλα + οι 4 ΒΑΣΙΚΕΣ που μπαίνουν στην κάτω μπάρα (mobile). Οι υπόλοιπες
// ζουν στο φύλλο «Περισσότερα» ώστε να μη γεμίζει η οθόνη με 10 κουμπιά.
const TAB_ICON: Record<string, LucideIcon> = {
  home: Home, rx: FileText, shop: ShoppingBag, meds: Pill, health: HeartPulse, wallet: Gift,
  repeats: RefreshCw, renewals: AlertCircle, assign: FilePlus, availability: Search, appointments: CalendarPlus,
  pharmacies: MapPin,
};
const TAB_LABEL: Record<string, [string, string]> = Object.fromEntries(TABS.map(([k, l, en]) => [k, [l, en]]));

const DOW = ["Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ", "Κυρ"];
type Therapy = { med_key: string; name: string; dose: string | null; dosage_text: string | null; kind: string; per_day: number; runout: string | null; days_left: number | null; enabled: boolean; reservable: boolean; time?: string | null; meal?: string | null; interval_hours?: number | null };
type SlotCell = { slot: string; label: string; time: string; meds: { med_key: string; name: string; dose: string | null; time: string }[] };
type Schedule = { therapies: Therapy[]; week: { dow: number; slots: SlotCell[] }[]; slot_times: Record<string, string>; streak: number; taken_today?: { med_key: string; slot: string | null }[] };
// τελικές καταστάσεις ραντεβού → «κλειστά» (κοινό σε Αρχική & καρτέλα Ραντεβού)
const DONE = ["done", "cancelled", "declined", "completed"];
type Dose = { time: string; med_key: string; name: string; dose: string | null; meal?: string | null };
// Μια δόση θεωρείται ΛΗΞΙΠΡΟΘΕΣΜΗ μόλις περάσουν 20' από την κανονική ώρα λήψης (grace) & δεν πάρθηκε.
const OVERDUE_GRACE_MIN = 20;
const hhmmToMin = (hm: string) => { const [h, m] = (hm || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const isOverdue = (time: string, nowMin: number) => nowMin >= hhmmToMin(time) + OVERDUE_GRACE_MIN;
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
  if (!m) return "bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400";
  if (k === "bp") return (m.systolic! >= 140 || m.diastolic! >= 90) ? "bg-rose-50 text-rose-700" : (m.systolic! >= 130 || m.diastolic! >= 85) ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700";
  if (k === "glucose") return m.value! >= 126 ? "bg-rose-50 text-rose-700" : m.value! >= 100 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700";
  return "bg-slate-50 dark:bg-slate-800/60 text-slate-700 dark:text-slate-200";
};
const TIER_GR: Record<string, string> = { Bronze: "Χάλκινο", Silver: "Ασημένιο", Gold: "Χρυσό", Platinum: "Πλατινένιο" };
const TIER_EN: Record<string, string> = { Bronze: "Bronze", Silver: "Silver", Gold: "Gold", Platinum: "Platinum" };

const STATUS_LABEL: Record<string, string> = {
  open: "Σε αναμονή", requested: "Ζητήθηκε", confirmed: "Επιβεβαιωμένο", ready: "Έτοιμη για παραλαβή",
  answered: "Απαντήθηκε", done: "Ολοκληρώθηκε", cancelled: "Ακυρώθηκε", rejected: "Απορρίφθηκε",
  new: "Νέα", in_progress: "Σε εξέλιξη",
};
const STATUS_LABEL_EN: Record<string, string> = {
  open: "Pending", requested: "Requested", confirmed: "Confirmed", ready: "Ready for pickup",
  answered: "Answered", done: "Completed", cancelled: "Cancelled", rejected: "Rejected",
  new: "New", in_progress: "In progress",
};
const statusCls = (s: string) =>
  ["confirmed", "ready", "answered", "done"].includes(s) ? "bg-emerald-100 text-emerald-700"
  : ["cancelled", "rejected"].includes(s) ? "bg-rose-100 text-rose-700"
  : "bg-amber-100 text-amber-700";

export default function PortalHome() {
  const t = useT();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [pharm, setPharm] = useState<Pharm | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [readyOrders, setReadyOrders] = useState(0);   // έτοιμες παραγγελίες προς παράδοση (KPI Αρχικής)
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
  const [showCard, setShowCard] = useState(false);   // modal κάρτας πιστότητας (QR) — γρήγορη πρόσβαση από Αρχική
  const [refCodeInput, setRefCodeInput] = useState("");   // κωδικός σύστασης φίλου (κατά την εγγραφή)
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
  const [phoneOtp, setPhoneOtp] = useState<{ cid: string; hint: string } | null>(null);
  const [phoneCode, setPhoneCode] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emailOtp, setEmailOtp] = useState<{ cid: string; hint: string } | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [sessions, setSessions] = useState<Sess[] | null>(null);
  const [twofaSetup, setTwofaSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [twofaCode, setTwofaCode] = useState("");
  const [twofaRecovery, setTwofaRecovery] = useState<string[] | null>(null);
  const [twofaDisable, setTwofaDisable] = useState<string | null>(null);
  const { theme, setTheme, locale, setLocale } = usePref();
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
    if (r === "ok") { setPushOn(true); setPushMsg(t("Ενεργοποιήθηκαν οι ειδοποιήσεις στο κινητό σου ✓", "Notifications on your phone are enabled ✓")); }
    else if (r === "denied") setPushMsg(t("Οι ειδοποιήσεις είναι μπλοκαρισμένες — ενεργοποίησέ τες από τις ρυθμίσεις του browser.", "Notifications are blocked — enable them in your browser settings."));
    else if (r === "unsupported") setPushMsg(t("Στο iPhone: πρόσθεσε πρώτα την εφαρμογή στην οθόνη αφετηρίας (Κοινή χρήση → Προσθήκη στην Αρχική).", "On iPhone: first add the app to your home screen (Share → Add to Home Screen)."));
    else setPushMsg(t("Κάτι πήγε στραβά. Δοκίμασε ξανά.", "Something went wrong. Please try again."));
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
      // έτοιμες παραγγελίες προς παράδοση (ready = προς παραλαβή, shipped = καθ' οδόν)
      patientApi<{ items: { status: string }[] }>("/patient/shop/orders")
        .then((d) => setReadyOrders((d.items ?? []).filter((o) => o.status === "ready" || o.status === "shipped").length))
        .catch(() => {});
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
      if (!taken && r.points_awarded && r.points_awarded > 0) toast(t(`✓ Κέρδισες ${r.points_awarded} πόντους 🎁`, `✓ You earned ${r.points_awarded} points 🎁`));
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
    if (!(await confirmDialog(t(`Κράτηση επανάληψης για «${med_name}» στο φαρμακείο σου;`, `Reserve a refill of «${med_name}» at your pharmacy?`)))) return;
    try { await patientApi("/patient/meds/reserve", { method: "POST", body: JSON.stringify({ med_name }) }); toast(t("✓ Η κράτηση στάλθηκε στο φαρμακείο σου. Θα ειδοποιηθείς όταν είναι έτοιμη.", "✓ Your reservation was sent to your pharmacy. You'll be notified when it's ready.")); }
    catch { toast(t("Κάτι πήγε στραβά — δοκίμασε ξανά.", "Something went wrong — please try again."), "error"); }
  }

  async function switchPharmacy(tenant_id: string, gotoTab?: string) {
    try {
      const d = await patientApi<{ access_token: string }>("/patient/auth/select-pharmacy", { method: "POST", body: JSON.stringify({ tenant_id }) });
      patientTokens.set(d.access_token, window.localStorage.getItem("patient_refresh_token"));
      // η επιλογή φαρμακείου ισχύει ΠΑΝΤΟΥ: ερωτήματα διαθεσιμότητας & ραντεβού στοχεύουν το ίδιο
      setAvailTarget(tenant_id); setApptTarget(tenant_id);
      if (gotoTab) setTab(gotoTab);
      await load();
    } catch { toast(t("Δεν ήταν δυνατή η επιλογή του φαρμακείου — δοκίμασε ξανά.", "Could not select the pharmacy — please try again."), "error"); }
  }
  async function setFavoritePharmacy(tenant_id: string) {
    const prev = directory;
    setDirectory((ds) => ds.map((d) => ({ ...d, favorite: d.tenant_id === tenant_id ? !d.favorite : false })));
    try { await patientApi("/patient/pharmacies/favorite", { method: "POST", body: JSON.stringify({ tenant_id }) }); }
    catch { setDirectory(prev); }
  }
  function requestGeo() {
    if (!navigator.geolocation) { toast(t("Η συσκευή δεν υποστηρίζει εντοπισμό τοποθεσίας.", "This device does not support location detection."), "error"); return; }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setGeo({ lat: p.coords.latitude, lon: p.coords.longitude }); setGeoBusy(false); },
      () => { setGeoBusy(false); toast(t("Δεν ήταν δυνατός ο εντοπισμός τοποθεσίας — έλεγξε τα δικαιώματα.", "Could not detect your location — check permissions."), "error"); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }
  async function logout() { await patientLogout(); router.replace("/portal/login"); }

  // εφάρμοσε το αποθηκευμένο (server-side) θέμα του πελάτη όταν φορτώσει το προφίλ
  useEffect(() => {
    const th = me?.profile.theme;
    if (th === "light" || th === "dark") setTheme(th);
  }, [me?.profile.theme, setTheme]);

  // φόρτωσε ενεργές συνεδρίες όταν ανοίγει το προφίλ
  useEffect(() => {
    if (!showProfile) return;
    setSessions(null);
    patientApi<{ items: Sess[] }>("/patient/me/sessions").then((r) => setSessions(r.items)).catch(() => setSessions([]));
  }, [showProfile]);
  async function revokeSession(id: string) {
    try {
      await patientApi(`/patient/me/sessions/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      setSessions((s) => s?.filter((x) => x.id !== id) ?? null);
      toast(t("Η συσκευή αποσυνδέθηκε.", "The device was signed out."), "success");
    } catch { toast(t("Αποτυχία.", "Failed."), "error"); }
  }
  async function revokeOtherSessions() {
    try {
      await patientApi("/patient/me/sessions/revoke-others", { method: "POST" });
      setSessions((s) => s?.filter((x) => x.current) ?? null);
      toast(t("Αποσυνδέθηκαν οι άλλες συσκευές.", "The other devices were signed out."), "success");
    } catch { toast(t("Αποτυχία.", "Failed."), "error"); }
  }

  function openProfile() {
    if (!me) return;
    setPf({ first_name: me.profile.first_name || "", last_name: me.profile.last_name || "",
            phone: me.profile.phone || "", address: me.profile.address || "",
            city: me.profile.city || "", postal_code: me.profile.postal_code || "" });
    setPwd({ current: "", next: "" });
    setEmailInput(me.profile.email || ""); setEmailOtp(null); setPhoneOtp(null);
    setTwofaSetup(null); setTwofaRecovery(null); setTwofaCode(""); setTwofaDisable(null);
    setShowProfile(true);
  }
  async function start2fa() {
    try { const r = await patientApi<{ secret: string; uri: string }>("/patient/me/2fa/setup", { method: "POST" }); setTwofaSetup(r); setTwofaCode(""); }
    catch { toast(t("Κάτι πήγε στραβά.", "Something went wrong."), "error"); }
  }
  async function confirm2fa() {
    try {
      const r = await patientApi<{ recovery_codes: string[] }>("/patient/me/2fa/confirm", { method: "POST", body: JSON.stringify({ code: twofaCode }) });
      setTwofaRecovery(r.recovery_codes); setTwofaSetup(null); setTwofaCode("");
      setMe((m) => (m ? { ...m, profile: { ...m.profile, twofa_enabled: true } } : m));
      toast(t("Το 2FA ενεργοποιήθηκε ✓", "2FA is enabled ✓"), "success");
    } catch (e) { const c = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null; toast(c === "wrong_code" ? t("Λάθος κωδικός.", "Wrong code.") : t("Αποτυχία.", "Failed."), "error"); }
  }
  async function disable2fa() {
    if (!twofaDisable) return;
    try {
      await patientApi("/patient/me/2fa/disable", { method: "POST", body: JSON.stringify({ code: twofaDisable }) });
      setMe((m) => (m ? { ...m, profile: { ...m.profile, twofa_enabled: false } } : m));
      setTwofaDisable(null);
      toast(t("Το 2FA απενεργοποιήθηκε.", "2FA is disabled."), "success");
    } catch (e) { const c = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null; toast(c === "wrong_code" ? t("Λάθος κωδικός.", "Wrong code.") : t("Αποτυχία.", "Failed."), "error"); }
  }
  async function saveProfile() {
    setProfileBusy(true);
    try {
      await patientApi("/patient/me", { method: "PATCH", body: JSON.stringify(pf) });
      setMe((m) => (m ? { ...m, profile: { ...m.profile, ...pf } } : m));
      toast(t("Το προφίλ ενημερώθηκε", "Your profile was updated"), "success");
    } catch { toast(t("Κάτι πήγε στραβά — δοκίμασε ξανά.", "Something went wrong — please try again."), "error"); } finally { setProfileBusy(false); }
  }
  async function changePwd() {
    if (pwd.next.length < 8) { toast(t("Ο νέος κωδικός πρέπει να έχει ≥8 χαρακτήρες.", "The new password must be at least 8 characters."), "error"); return; }
    setProfileBusy(true);
    try {
      const s = await patientApi<{ access_token: string | null; refresh_token: string }>(
        "/patient/me/change-password",
        { method: "POST", body: JSON.stringify({ current_password: pwd.current, new_password: pwd.next }) });
      patientTokens.set(s.access_token, s.refresh_token);
      setPwd({ current: "", next: "" });
      toast(t("Ο κωδικός άλλαξε.", "Your password was changed."), "success");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      toast(code === "bad_current_password" ? t("Λάθος τρέχων κωδικός.", "Wrong current password.") : t("Η αλλαγή απέτυχε.", "The change failed."), "error");
    } finally { setProfileBusy(false); }
  }
  async function uploadAvatar(file: File) {
    const fd = new FormData(); fd.append("file", file);
    try {
      const r = await patientUpload<{ url: string }>("/patient/avatar", fd);
      setMe((m) => (m ? { ...m, profile: { ...m.profile, avatar_url: r.url } } : m));
      toast(t("Η φωτογραφία ενημερώθηκε.", "Your photo was updated."), "success");
    } catch { toast(t("Αποτυχία ανεβάσματος φωτογραφίας.", "Photo upload failed."), "error"); }
  }
  function toggleTheme() {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    patientApi("/patient/me", { method: "PATCH", body: JSON.stringify({ theme: t }) }).catch(() => {});
  }
  async function startEmailVerify() {
    const em = emailInput.trim().toLowerCase();
    if (!em.includes("@")) { toast(t("Βάλε έγκυρο email.", "Enter a valid email."), "error"); return; }
    try {
      const r = await patientApi<{ challenge_id: string; hint: string }>(
        "/patient/me/email/verify/start", { method: "POST", body: JSON.stringify({ email: em }) });
      setEmailOtp({ cid: r.challenge_id, hint: r.hint }); setEmailCode("");
      toast(t(`Στάλθηκε κωδικός στο ${r.hint}.`, `A code was sent to ${r.hint}.`), "success");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      toast(code === "email_exists" ? t("Το email χρησιμοποιείται ήδη σε άλλον λογαριασμό.", "This email is already used by another account.") : code === "email_send_failed" ? t("Αποτυχία αποστολής email.", "Failed to send email.") : t("Κάτι πήγε στραβά.", "Something went wrong."), "error");
    }
  }
  async function confirmEmailVerify() {
    if (!emailOtp) return;
    try {
      const r = await patientApi<{ email: string }>(
        "/patient/me/email/verify/confirm", { method: "POST", body: JSON.stringify({ challenge_id: emailOtp.cid, code: emailCode }) });
      setMe((m) => (m ? { ...m, profile: { ...m.profile, email: r.email, email_verified: true } } : m));
      setEmailInput(r.email); setEmailOtp(null); setEmailCode("");
      toast(t("Το email επιβεβαιώθηκε ✓", "Email verified ✓"), "success");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      toast(code === "wrong_code" ? t("Λάθος κωδικός.", "Wrong code.") : code === "expired" ? t("Ο κωδικός έληξε — ζήτησε νέον.", "The code expired — request a new one.") : code === "email_exists" ? t("Το email χρησιμοποιείται ήδη.", "This email is already in use.") : t("Αποτυχία επιβεβαίωσης.", "Verification failed."), "error");
    }
  }
  async function startPhoneVerify() {
    if (!pf.phone || pf.phone.length < 8) { toast(t("Βάλε έγκυρο κινητό πρώτα.", "Enter a valid mobile number first."), "error"); return; }
    try {
      const r = await patientApi<{ challenge_id: string; hint: string }>(
        "/patient/me/phone/verify/start", { method: "POST", body: JSON.stringify({ phone: pf.phone }) });
      setPhoneOtp({ cid: r.challenge_id, hint: r.hint }); setPhoneCode("");
      toast(t(`Στάλθηκε κωδικός στο ${r.hint}.`, `A code was sent to ${r.hint}.`), "success");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      toast(code === "sms_failed" ? t("Αποτυχία αποστολής SMS.", "Failed to send SMS.") : t("Κάτι πήγε στραβά.", "Something went wrong."), "error");
    }
  }
  async function confirmPhoneVerify() {
    if (!phoneOtp) return;
    try {
      const r = await patientApi<{ phone: string }>(
        "/patient/me/phone/verify/confirm", { method: "POST", body: JSON.stringify({ challenge_id: phoneOtp.cid, code: phoneCode }) });
      setMe((m) => (m ? { ...m, profile: { ...m.profile, phone: r.phone, phone_verified: true } } : m));
      setPf((p) => ({ ...p, phone: r.phone }));
      setPhoneOtp(null); setPhoneCode("");
      toast(t("Το κινητό επιβεβαιώθηκε ✓", "Mobile number verified ✓"), "success");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      toast(code === "wrong_code" ? t("Λάθος κωδικός.", "Wrong code.") : code === "expired" ? t("Ο κωδικός έληξε — ζήτησε νέον.", "The code expired — request a new one.") : t("Αποτυχία επιβεβαίωσης.", "Verification failed."), "error");
    }
  }
  async function setConsent(kind: "health_data" | "marketing", granted: boolean) {
    try {
      const r = await patientApi<{ consent: Consent }>("/patient/me/consent",
        { method: "POST", body: JSON.stringify({ kind, granted }) });
      setMe((m) => (m ? { ...m, profile: { ...m.profile, consents: { ...(m.profile.consents || {}), [kind]: r.consent } } } : m));
      toast(granted ? t("Καταχωρήθηκε η συγκατάθεση.", "Consent recorded.") : t("Ανακλήθηκε η συγκατάθεση.", "Consent withdrawn."), "success");
    } catch { toast(t("Κάτι πήγε στραβά — δοκίμασε ξανά.", "Something went wrong — please try again."), "error"); }
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
    try { await patientApi("/patient/loyalty/join", { method: "POST", body: JSON.stringify({ referred_by_code: refCodeInput.trim().toUpperCase() || null }) }); setLoyalty(await patientApi<Loyalty>("/patient/loyalty")); }
    catch { /* ignore */ } finally { setAssignBusy(false); }
  }
  // Self-redeem: ο πελάτης δεσμεύει δώρο → κωδικός για το φαρμακείο· ακύρωση → επιστροφή πόντων.
  async function redeemReward(rewardId: string) {
    setAssignBusy(true);
    try { await patientApi("/patient/loyalty/redeem-request", { method: "POST", body: JSON.stringify({ reward_id: rewardId }) }); setLoyalty(await patientApi<Loyalty>("/patient/loyalty")); }
    catch { toast(t("Δεν ήταν δυνατή η δέσμευση — έλεγξε τους πόντους σου.", "Could not reserve — check your points balance.")); } finally { setAssignBusy(false); }
  }
  async function cancelReservation(code: string) {
    setAssignBusy(true);
    try { await patientApi("/patient/loyalty/cancel-request", { method: "POST", body: JSON.stringify({ code }) }); setLoyalty(await patientApi<Loyalty>("/patient/loyalty")); }
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
      if (c?.found) setAssignMsg(t(`✓ Επιβεβαιώθηκε από ΗΔΙΚΑ${c.medicines?.length ? ` — ${c.medicines.length} φάρμακα` : ""} · στάλθηκε στο φαρμακείο`, `✓ Verified via ΗΔΙΚΑ${c.medicines?.length ? ` — ${c.medicines.length} medicines` : ""} · sent to the pharmacy`));
      else if (c?.available) setAssignMsg(t("Στάλθηκε ✓ — δεν εντοπίστηκε στην ΗΔΙΚΑ, θα το ελέγξει το φαρμακείο", "Sent ✓ — not found in ΗΔΙΚΑ, the pharmacy will check it"));
      else setAssignMsg(t("Στάλθηκε στο φαρμακείο ✓", "Sent to the pharmacy ✓"));
      reloadRxReqs();
    } catch { setAssignMsg(t("Αποτυχία αποστολής.", "Failed to send.")); } finally { setAssignBusy(false); }
  }
  async function submitPhoto(file: File) {
    setAssignBusy(true); setAssignMsg(null);
    try {
      const fd = new FormData(); fd.append("file", file); if (assignNote) fd.append("note", assignNote);
      await patientUpload("/patient/rx-request/photo", fd);
      setAssignNote(""); setAssignMsg(t("Η φωτογραφία στάλθηκε ✓", "Photo sent ✓")); reloadRxReqs();
    } catch { setAssignMsg(t("Αποτυχία αποστολής φωτογραφίας.", "Failed to send photo.")); } finally { setAssignBusy(false); }
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
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-slate-800 bg-white p-8 text-center shadow-xl shadow-slate-200/50">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-100 text-brand-600"><CheckCircle2 className="h-7 w-7" /></div>
        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Ο λογαριασμός σου είναι έτοιμος", "Your account is ready")}</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("Δεν βρέθηκε ακόμα ιστορικό σε φαρμακείο. Μόλις εξυπηρετηθείς σε φαρμακείο του δικτύου με το ΑΜΚΑ σου, οι συνταγές σου θα εμφανιστούν εδώ αυτόματα.", "No pharmacy history yet. Once you're served at a network pharmacy with your ΑΜΚΑ, your prescriptions will appear here automatically.")}</p>
        <button onClick={logout} className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"><LogOut className="h-4 w-4" /> {t("Αποσύνδεση", "Sign out")}</button>
      </div>
    </div>
  );
  if (!me) return (
    <div className="flex min-h-dvh items-center justify-center text-slate-400">
      <div className="flex items-center gap-2 text-sm"><RefreshCw className="h-4 w-4 animate-spin" /> {t("Φόρτωση…", "Loading…")}</div>
    </div>
  );

  const activeName = me.pharmacies.find((p) => p.tenant_id === me.active_tenant)?.pharmacy_name;
  // Δυνατότητες ενεργού φαρμακείου → κρύψε καρτέλες που δεν προσφέρει (Κατάστημα/Επιβράβευση).
  const caps = me.caps ?? { shop: true, loyalty: true };
  // Καθολική λειτουργία «μεμονωμένο φαρμακείο» → κρύψε τον κατάλογο δικτύου + τον επιλογέα εναλλαγής.
  const single = me.portal_mode === "single";
  const visibleTabs = TABS.filter(([k]) => (k !== "shop" || caps.shop) && (k !== "wallet" || caps.loyalty) && (k !== "pharmacies" || !single));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── top bar ───────────────────────────────────────────── */}
      <header className="shrink-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur-md dark:border-slate-800/80 dark:bg-slate-900/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-1.5 px-3 sm:gap-3 sm:px-4 lg:px-6">
          <a href="https://rxvision.gr" title="rxvision.gr" className="flex min-w-0 items-center gap-2 transition hover:opacity-80">
            <LogoMark className="h-9 w-9 shrink-0" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-extrabold tracking-tight text-slate-900 dark:text-slate-100">RxVision</div>
              <div className="hidden text-[10px] font-medium uppercase tracking-wider text-slate-400 sm:block">{t("Πύλη Πελατών", "Customer Portal")}</div>
            </div>
          </a>
          <div className="flex shrink-0 items-center gap-2">
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
              const distText = (d: number) => (d < 1 ? `${Math.round(d * 1000)} ${t("μ", "m")}` : `${d.toFixed(1)} ${t("χλμ", "km")}`);
              const active = rows.find((r) => r.tenant_id === me.active_tenant) ?? rows[0];
              return (
                <div className="relative">
                  <button type="button" onClick={() => setSwitchOpen((v) => !v)}
                    className="flex max-w-[7.5rem] items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white py-2 pl-2.5 pr-2 text-[11px] font-semibold text-slate-700 dark:text-slate-200 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 sm:max-w-[15rem]">
                    <Building2 className="h-4 w-4 shrink-0 text-brand-500" />
                    <span className="min-w-0 flex-1 truncate text-left">{active?.name ?? "—"}</span>
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${switchOpen ? "rotate-180" : ""}`} />
                  </button>
                  {switchOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setSwitchOpen(false)} />
                      <div className="absolute right-0 z-50 mt-1.5 max-h-[70vh] w-[min(20rem,calc(100vw-1.5rem))] overflow-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white p-1 shadow-xl">
                        <div className="flex items-center justify-between px-2 py-1">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{t("Φαρμακεία δικτύου", "Network pharmacies")}</span>
                          {!geo && <button type="button" onClick={() => requestGeo()} disabled={geoBusy}
                            className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-600 hover:bg-brand-100 disabled:opacity-60">
                            <Navigation className={`h-3 w-3 ${geoBusy ? "animate-pulse" : ""}`} /> {t("Κοντινά", "Nearby")}</button>}
                        </div>
                        {rows.map((r) => {
                          const isActive = r.tenant_id === me.active_tenant;
                          return (
                            <button key={r.tenant_id} type="button"
                              onClick={() => { setSwitchOpen(false); if (!isActive) switchPharmacy(r.tenant_id); }}
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isActive ? "bg-brand-50" : "hover:bg-slate-50 dark:hover:bg-slate-800"}`}>
                              {r.favorite
                                ? <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                                : <span className="h-3.5 w-3.5 shrink-0" />}
                              <span className="min-w-0 flex-1">
                                <span className={`block break-words text-[11px] font-semibold leading-snug ${isActive ? "text-brand-700" : "text-slate-700 dark:text-slate-200"}`}>{r.name}</span>
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
            <div className="relative">
              <Tooltip label={t("Ειδοποιήσεις", "Notifications")}><button onClick={() => setShowNotifs((v) => !v)}
                className="relative grid h-9 w-9 place-items-center rounded-xl border border-slate-200 dark:border-slate-800 bg-white text-slate-500 dark:text-slate-400 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                <Bell className="h-[18px] w-[18px]" />
                {notifs.length > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{notifs.length}</span>}
              </button></Tooltip>
              {showNotifs && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowNotifs(false)} />
                  <div className="absolute right-0 top-full z-50 mt-2 w-[min(23rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
                    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
                      <span className="flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><Bell className="h-4 w-4" /> {t("Ειδοποιήσεις", "Notifications")}</span>
                      <button onClick={() => setShowNotifs(false)} className="grid h-6 w-6 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
                    </div>
                    {notifs.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-slate-400">{t("Καμία ειδοποίηση 🎉", "No notifications 🎉")}</div>
                    ) : (
                      <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
                        {notifs.map((n) => (
                          <li key={n.id} className="px-4 py-3">
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-slate-800"><Sparkles className="h-3.5 w-3.5" /></span>
                              <div className="min-w-0 flex-1">
                                <div className="break-words text-sm font-semibold text-slate-800 dark:text-slate-100">{n.title}</div>
                                <div className="break-words text-sm text-slate-600 dark:text-slate-300">{n.body}</div>
                              </div>
                              <button onClick={() => dismissNotif(n.id)} title={t("Το είδα — αφαίρεση", "Got it — dismiss")} className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
                            </div>
                            {n.type === "answer" && pickupFor !== n.id && (
                              <div className="mt-2 flex flex-wrap items-center gap-2 pl-10">
                                <button onClick={() => { setPickupFor(n.id); setPickupDate(""); }} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"><CalendarPlus className="h-3.5 w-3.5" /> {t("Θα περάσω να το πάρω", "I'll come to pick it up")}</button>
                                <button onClick={() => dismissNotif(n.id)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"><CheckCircle2 className="h-3.5 w-3.5" /> {t("Το είδα", "Got it")}</button>
                              </div>
                            )}
                            {n.type === "answer" && pickupFor === n.id && (
                              <div className="mt-2 space-y-2 rounded-xl border border-brand-200 bg-brand-50/60 p-2.5 pl-3 dark:border-slate-700 dark:bg-slate-800/60">
                                <div className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("Πότε θα περάσεις;", "When will you come by?")} <span className="text-slate-400">{t("(προαιρετικό)", "(optional)")}</span></div>
                                <DateInput value={pickupDate} onChange={setPickupDate} min={new Date().toISOString().slice(0, 10)} className="w-full" />
                                <div className="flex flex-wrap gap-2">
                                  <button onClick={() => notifPickup(n.id, true, pickupDate)} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"><CheckCircle2 className="h-3.5 w-3.5" /> {t("Στείλε στο φαρμακείο", "Send to pharmacy")}</button>
                                  <button onClick={() => notifPickup(n.id, false)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">{t("Δεν θα περάσω", "I won't come by")}</button>
                                  <button onClick={() => { setPickupFor(null); setPickupDate(""); }} className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-600">{t("Άκυρο", "Cancel")}</button>
                                </div>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
            <Tooltip label={t("Το προφίλ μου", "My profile")}><button onClick={openProfile}
              className="grid h-9 w-9 place-items-center overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white text-brand-600 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700">
              {me.profile.avatar_url
                ? <img src={`${API_BASE}${me.profile.avatar_url}`} alt="" className="h-full w-full object-cover" />
                : (me.profile.first_name || me.profile.last_name)
                  ? <span className="text-xs font-bold">{(me.profile.first_name?.[0] || "") + (me.profile.last_name?.[0] || "")}</span>
                  : <User className="h-[18px] w-[18px]" />}
            </button></Tooltip>
            <Tooltip label={t("Έξοδος", "Sign out")}><button onClick={logout} className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 dark:border-slate-800 bg-white text-slate-500 dark:text-slate-400 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"><LogOut className="h-[18px] w-[18px]" /></button></Tooltip>
          </div>
        </div>
      </header>

      {showProfile && me && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setShowProfile(false)}>
          <div className="max-h-[90vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Το προφίλ μου", "My profile")}</h3>
              <button onClick={() => setShowProfile(false)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
            </div>

            <div className="mb-5 flex items-center gap-4">
              <div className="relative">
                <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-full border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 dark:border-slate-700 dark:bg-slate-800">
                  {me.profile.avatar_url
                    ? <img src={`${API_BASE}${me.profile.avatar_url}`} alt="" className="h-full w-full object-cover" />
                    : <User className="h-9 w-9 text-slate-400" />}
                </div>
                <label className="absolute -bottom-1 -right-1 grid h-7 w-7 cursor-pointer place-items-center rounded-full bg-brand-600 text-white shadow hover:bg-brand-700" title={t("Αλλαγή φωτογραφίας", "Change photo")}>
                  <Camera className="h-3.5 w-3.5" />
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])} />
                </label>
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold text-slate-900 dark:text-slate-100">{me.profile.first_name} {me.profile.last_name}</div>
                <div className="truncate text-sm text-slate-500 dark:text-slate-400">{me.profile.email}</div>
              </div>
            </div>

            <button onClick={toggleTheme} className="mb-3 flex w-full items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-3 text-sm dark:border-slate-700">
              <span className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">{theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} {theme === "dark" ? t("Σκοτεινό θέμα", "Dark theme") : t("Φωτεινό θέμα", "Light theme")}</span>
              <span className={`relative h-6 w-11 rounded-full transition ${theme === "dark" ? "bg-brand-600" : "bg-slate-300"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${theme === "dark" ? "left-[22px]" : "left-0.5"}`} /></span>
            </button>

            {/* language switcher — mirrors the theme-toggle row above (locale persists via localStorage in setLocale) */}
            <div className="mb-5 flex w-full items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-3 text-sm dark:border-slate-700">
              <span className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200"><Globe className="h-4 w-4" /> {t("Γλώσσα", "Language")}</span>
              <span className="inline-flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                {(["el", "en"] as const).map((lc) => (
                  <button key={lc} type="button" onClick={() => setLocale(lc)}
                    className={`px-3 py-1 text-xs font-bold transition ${locale === lc ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"}`}>
                    {lc === "el" ? "ΕΛ" : "EN"}
                  </button>
                ))}
              </span>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Όνομα", "First name")}<input autoComplete="given-name" value={pf.first_name} onChange={(e) => setPf({ ...pf, first_name: e.target.value })} className={PF_INP} /></label>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Επώνυμο", "Last name")}<input autoComplete="family-name" value={pf.last_name} onChange={(e) => setPf({ ...pf, last_name: e.target.value })} className={PF_INP} /></label>
              </div>
              <div>
                {(() => { const verified = !!me.profile.email_verified && emailInput.trim().toLowerCase() === (me.profile.email || "").toLowerCase(); return (<>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">Email {verified ? <span className="text-emerald-600">{t("✓ επιβεβαιωμένο", "✓ verified")}</span> : <span className="text-amber-600">{t("ανεπιβεβαίωτο", "unverified")}</span>}</label>
                  <div className="mt-1 flex gap-2">
                    <input type="email" autoComplete="email" value={emailInput} onChange={(e) => { setEmailInput(e.target.value); setEmailOtp(null); }} className={`${PF_INP} !mt-0`} />
                    {!verified && emailInput.includes("@") && <button type="button" onClick={startEmailVerify} className="shrink-0 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700">{t("Επιβεβαίωση", "Verify")}</button>}
                  </div>
                  {emailOtp && (
                    <div className="mt-2 rounded-lg border border-brand-200 bg-brand-50 p-2 dark:border-brand-800 dark:bg-brand-900/20">
                      <div className="mb-1 text-[11px] text-slate-500 dark:text-slate-400">{t(`Κωδικός που στάλθηκε στο ${emailOtp.hint}:`, `Code sent to ${emailOtp.hint}:`)}</div>
                      <div className="flex gap-2">
                        <input inputMode="numeric" maxLength={6} value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ""))} placeholder={t("6ψήφιος κωδικός", "6-digit code")} className={`${PF_INP} !mt-0`} />
                        <button type="button" onClick={confirmEmailVerify} disabled={emailCode.length < 4} className="shrink-0 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">OK</button>
                      </div>
                    </div>
                  )}
                </>); })()}
              </div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">ΑΜΚΑ <span className="font-normal text-slate-400">{t("· κλειδί ηλεκτρονικής συνταγογράφησης", "· e-prescription key")}</span>
                <input value={me.profile.amka || ""} readOnly className={`${PF_INP} cursor-not-allowed font-mono opacity-70`} />
              </label>
              <div>
                {(() => { const verified = !!me.profile.phone_verified && pf.phone === me.profile.phone; return (<>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Τηλέφωνο", "Phone")} {verified ? <span className="text-emerald-600">{t("✓ επιβεβαιωμένο", "✓ verified")}</span> : pf.phone && <span className="text-amber-600">{t("ανεπιβεβαίωτο", "unverified")}</span>}</label>
                  <div className="mt-1 flex gap-2">
                    <input autoComplete="tel" inputMode="tel" value={pf.phone} onChange={(e) => { setPf({ ...pf, phone: e.target.value }); setPhoneOtp(null); }} className={`${PF_INP} !mt-0`} />
                    {!verified && pf.phone.length >= 8 && <button type="button" onClick={startPhoneVerify} className="shrink-0 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700">{t("Επιβεβαίωση", "Verify")}</button>}
                  </div>
                  {phoneOtp && (
                    <div className="mt-2 rounded-lg border border-brand-200 bg-brand-50 p-2 dark:border-brand-800 dark:bg-brand-900/20">
                      <div className="mb-1 text-[11px] text-slate-500 dark:text-slate-400">{t(`Κωδικός που στάλθηκε στο ${phoneOtp.hint}:`, `Code sent to ${phoneOtp.hint}:`)}</div>
                      <div className="flex gap-2">
                        <input inputMode="numeric" maxLength={6} value={phoneCode} onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ""))} placeholder={t("6ψήφιος κωδικός", "6-digit code")} className={`${PF_INP} !mt-0`} />
                        <button type="button" onClick={confirmPhoneVerify} disabled={phoneCode.length < 4} className="shrink-0 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">OK</button>
                      </div>
                    </div>
                  )}
                </>); })()}
              </div>

              <div className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Διεύθυνση κατοικίας", "Home address")}</div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Οδός & αριθμός", "Street & number")}<input autoComplete="street-address" value={pf.address} onChange={(e) => setPf({ ...pf, address: e.target.value })} className={PF_INP} placeholder={t("π.χ. Ερμού 15", "e.g. Ermou 15")} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Πόλη", "City")}<input autoComplete="address-level2" value={pf.city} onChange={(e) => setPf({ ...pf, city: e.target.value })} className={PF_INP} /></label>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Τ.Κ.", "Postal code")}<input autoComplete="postal-code" inputMode="numeric" value={pf.postal_code} onChange={(e) => setPf({ ...pf, postal_code: e.target.value })} className={PF_INP} /></label>
              </div>
              <button onClick={saveProfile} disabled={profileBusy} className="w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{t("Αποθήκευση στοιχείων", "Save details")}</button>
            </div>

            <div className="mt-5 border-t border-slate-100 dark:border-slate-800 pt-4 dark:border-slate-800">
              <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Αλλαγή κωδικού", "Change password")}</div>
              <div className="space-y-3">
                <input type="password" autoComplete="current-password" placeholder={t("Τρέχων κωδικός", "Current password")} value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} className={PF_INP} />
                <input type="password" autoComplete="new-password" placeholder={t("Νέος κωδικός (≥8 χαρακτήρες)", "New password (≥8 characters)")} value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} className={PF_INP} />
                <button onClick={changePwd} disabled={profileBusy || !pwd.current || pwd.next.length < 8} className="w-full rounded-xl border border-slate-300 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">{t("Αλλαγή κωδικού", "Change password")}</button>
              </div>
            </div>

            <div className="mt-5 border-t border-slate-100 dark:border-slate-800 pt-4 dark:border-slate-800">
              <div className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Συγκαταθέσεις (GDPR)", "Consents (GDPR)")}</div>
              <p className="mb-3 text-[11px] text-slate-400">{t("Ξεχωριστές & ανακλητές ανά πάσα στιγμή. Η επεξεργασία δεδομένων υγείας είναι διακριτή από το marketing.", "Separate and revocable at any time. Processing of health data is distinct from marketing.")}</p>
              {([
                { k: "health_data", label: t("Επεξεργασία δεδομένων υγείας", "Health data processing"), sub: t("Απαραίτητη για να βλέπεις συνταγές & ιστορικό στην πύλη.", "Required to view your prescriptions & history in the portal.") },
                { k: "marketing", label: t("Ενημερώσεις & προσφορές (newsletter)", "Updates & offers (newsletter)"), sub: t("Email/SMS με νέα, προσφορές & χρήσιμες υπενθυμίσεις.", "Email/SMS with news, offers & helpful reminders.") },
              ] as const).map((c) => {
                const cur = me.profile.consents?.[c.k];
                const on = !!cur?.granted;
                return (
                  <div key={c.k} className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700 dark:text-slate-200">{c.label}</div>
                      <div className="text-[11px] text-slate-400">{c.sub}</div>
                      {cur?.at && <div className="text-[10px] text-slate-400">{on ? t("Συγκατάθεση", "Consent") : t("Ανάκληση", "Withdrawal")}: {fmtDate(cur.at)}</div>}
                    </div>
                    <button onClick={() => setConsent(c.k, !on)} className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}>
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 border-t border-slate-100 dark:border-slate-800 pt-4 dark:border-slate-800">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Ενεργές συνεδρίες", "Active sessions")}</div>
                {sessions && sessions.some((s) => !s.current) && <button onClick={revokeOtherSessions} className="text-xs font-semibold text-rose-600 hover:underline">{t("Αποσύνδεση όλων των άλλων", "Sign out all others")}</button>}
              </div>
              {!sessions ? <div className="text-xs text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : sessions.length === 0 ? <div className="text-xs text-slate-400">—</div> : (
                <div className="space-y-2">
                  {sessions.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 dark:border-slate-700">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200"><span className="min-w-0 truncate">{deviceLabel(s.user_agent, t)}</span> {s.current && <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">{t("τρέχουσα", "current")}</span>}</div>
                        <div className="truncate text-[11px] text-slate-400">{s.ip || "—"}{s.last_seen ? ` · ${fmtDateTime(s.last_seen)}` : ""}</div>
                      </div>
                      {!s.current && <button onClick={() => revokeSession(s.id)} className="shrink-0 rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-900/20">{t("Αποσύνδεση", "Sign out")}</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-5 border-t border-slate-100 dark:border-slate-800 pt-4 dark:border-slate-800">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Έλεγχος 2 παραγόντων (2FA)", "Two-factor authentication (2FA)")}</div>
                {me.profile.twofa_enabled && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">{t("✓ Ενεργό", "✓ Enabled")}</span>}
              </div>
              {twofaRecovery ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
                  <div className="mb-2 text-xs font-semibold text-amber-800 dark:text-amber-300">{t("Φύλαξε τους εφεδρικούς κωδικούς (εμφανίζονται ΜΙΑ φορά — χρησιμεύουν αν χάσεις το κινητό):", "Save your recovery codes (shown ONCE — useful if you lose your phone):")}</div>
                  <div className="grid grid-cols-2 gap-1 font-mono text-sm text-slate-700 dark:text-slate-200">{twofaRecovery.map((c) => <div key={c}>{c}</div>)}</div>
                  <button onClick={() => setTwofaRecovery(null)} className="mt-3 w-full rounded-lg bg-brand-600 py-2 text-xs font-semibold text-white hover:bg-brand-700">{t("Τους αποθήκευσα", "I saved them")}</button>
                </div>
              ) : twofaSetup ? (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 dark:border-slate-700">
                  <div className="mb-2 text-[11px] text-slate-500 dark:text-slate-400">{t("Σκάναρε με εφαρμογή authenticator (Google Authenticator, Authy…):", "Scan with an authenticator app (Google Authenticator, Authy…):")}</div>
                  <div className="mb-2 flex justify-center rounded-lg bg-white p-2"><QRCodeCanvas value={twofaSetup.uri} size={150} /></div>
                  <div className="mb-2 break-all text-center font-mono text-[10px] text-slate-400">{twofaSetup.secret}</div>
                  <div className="flex gap-2">
                    <input inputMode="numeric" maxLength={6} value={twofaCode} onChange={(e) => setTwofaCode(e.target.value.replace(/\D/g, ""))} placeholder={t("6ψήφιος κωδικός", "6-digit code")} className={`${PF_INP} !mt-0`} />
                    <button onClick={confirm2fa} disabled={twofaCode.length < 6} className="shrink-0 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{t("Ενεργοποίηση", "Enable")}</button>
                  </div>
                </div>
              ) : me.profile.twofa_enabled ? (
                twofaDisable !== null ? (
                  <div className="flex gap-2">
                    <input inputMode="numeric" value={twofaDisable} onChange={(e) => setTwofaDisable(e.target.value)} placeholder={t("Κωδικός 2FA ή εφεδρικός", "2FA or recovery code")} className={`${PF_INP} !mt-0`} />
                    <button onClick={disable2fa} className="shrink-0 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700">{t("Απενεργοποίηση", "Disable")}</button>
                  </div>
                ) : (
                  <button onClick={() => setTwofaDisable("")} className="text-xs font-semibold text-rose-600 hover:underline">{t("Απενεργοποίηση 2FA", "Disable 2FA")}</button>
                )
              ) : (
                <div>
                  <p className="mb-2 text-[11px] text-slate-400">{t("Δεύτερο επίπεδο ασφάλειας με εφαρμογή authenticator — για τα δεδομένα υγείας σου.", "A second layer of security with an authenticator app — for your health data.")}</p>
                  <button onClick={start2fa} className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700">{t("Ενεργοποίηση 2FA", "Enable 2FA")}</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Desktop (lg+): σταθερό πλαϊνό μενού αριστερά + περιεχόμενο δεξιά.
          Tablet (sm–lg): pills πάνω από το περιεχόμενο.  Κινητό: σταθερή κάτω μπάρα. */}
      <div id="portal-scroll" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]">
      <div className="mx-auto flex w-full max-w-7xl gap-6 px-4 lg:px-6">
        <aside className="hidden w-56 shrink-0 py-6 lg:block">
          <nav className="sticky top-20 space-y-1">
            {visibleTabs.map(([k, label, labelEn]) => {
              const Icon = TAB_ICON[k] ?? Home;
              const on = tab === k;
              return (
                <button key={k} onClick={() => setTab(k)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition ${on
                    ? "bg-brand-600 text-white shadow-sm shadow-brand-500/30"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"}`}>
                  <Icon className={`h-4 w-4 shrink-0 ${on ? "" : "text-slate-400"}`} />
                  <span className="min-w-0 flex-1 truncate">{t(label, labelEn)}</span>
                  {k === "renewals" && (renewals?.length ?? 0) > 0 && (
                    <span className={`grid h-5 min-w-[20px] shrink-0 place-items-center rounded-full px-1 text-[10px] font-bold ${on ? "bg-white/25 text-white" : "bg-rose-500 text-white"}`}>{renewals!.length}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 py-6">
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
                <div className="text-[10px] uppercase tracking-wide opacity-80">{activeName || t("Το φαρμακείο σου", "Your pharmacy")}</div>
                <div className="text-base font-extrabold">{t(pharm.status.statusText, pharm.status.statusTextEn ?? pharm.status.statusText)}</div>
              </div>
            </div>
            {(() => {
              const today = pharm.schedule.week.find((d) => d.day === ((new Date().getDay() + 6) % 7));
              const hrs = today && today.status !== "closed" ? today.intervals.map((i) => `${i.start}–${i.end}`).join(" & ") : t("Κλειστά", "Closed");
              return <div className="text-right text-xs opacity-90"><div className="opacity-70">{t("Σήμερα", "Today")}</div><div className="font-semibold">{hrs}</div></div>;
            })()}
          </div>
        )}

        {/* ── hero ───────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100 sm:text-2xl">{t(`Γεια σου, ${me.profile.first_name} 👋`, `Hi ${me.profile.first_name} 👋`)}</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
            {activeName ? <><Building2 className="h-4 w-4 text-brand-500" /> {activeName}</> : t("Η υγεία σου, οργανωμένη.", "Your health, organized.")}
          </p>
        </div>

        {/* ── enable phone push ──────────────────────────────── */}
        {pushSup && !pushOn && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-indigo-50 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-brand-800">
              <BellRing className="h-5 w-5 shrink-0 text-brand-600" />
              {t("Λάβε ειδοποίηση στο κινητό μόλις η συνταγή σου είναι έτοιμη ή ανοίγει.", "Get a phone notification the moment your prescription is ready or opens.")}
            </div>
            <button onClick={onEnablePush} disabled={pushBusy}
              className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
              {pushBusy ? "…" : t("Ενεργοποίηση", "Enable")}
            </button>
          </div>
        )}
        {pushMsg && <div className="mb-4 rounded-xl bg-slate-100 dark:bg-slate-800 px-4 py-2.5 text-sm text-slate-700 dark:text-slate-200">{pushMsg}</div>}


        {/* Κάρτα πιστότητας — γρήγορη πρόσβαση από την Αρχική (ο πελάτης δεν την ψάχνει) */}
        {loyalty?.enabled && loyalty.member && (
          <button onClick={() => setShowCard(true)}
            className="mb-4 flex w-full items-center gap-3 rounded-2xl bg-gradient-to-r from-amber-400 to-rose-400 px-4 py-3 text-left text-white shadow-lg shadow-amber-500/30 transition hover:brightness-105">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20"><Gift className="h-5 w-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-extrabold">{t("🪪 Κάρτα πιστότητας", "🪪 Loyalty card")}</span>
              <span className="block truncate text-[11px] text-white/85">{t(`Δείξε το QR στο φαρμακείο · ${loyalty.member.points} πόντοι`, `Show the QR at the pharmacy · ${loyalty.member.points} points`)}</span>
            </span>
            <span className="shrink-0 rounded-lg bg-white/20 px-2.5 py-1 text-xs font-bold">{t("Εμφάνιση →", "Show →")}</span>
          </button>
        )}
        {showCard && loyalty?.member && (
          <div onClick={() => setShowCard(false)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-2xl dark:bg-slate-900">
              <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{t("🪪 Κάρτα μέλους", "🪪 Membership card")}</div>
              <div className="mb-4 text-xs text-slate-400">{t("Δείξε το QR στο φαρμακείο για πόντους & εξαργύρωση", "Show the QR at the pharmacy for points & redemption")}</div>
              <div className="mx-auto w-fit rounded-2xl bg-white p-3 ring-1 ring-slate-200"><QRCodeCanvas value={`RXVL:${loyalty.member.patient_ref}`} size={190} level="M" includeMargin /></div>
              <div className="mt-2 font-mono text-[11px] tracking-wide text-slate-400">{loyalty.member.patient_ref}</div>
              <div className="mt-2 text-2xl font-extrabold text-slate-900 dark:text-slate-100">{loyalty.member.points} <span className="text-sm font-semibold text-slate-500">{t("πόντοι", "points")}</span></div>
              <button onClick={() => setShowCard(false)} className="mt-5 w-full rounded-xl bg-slate-100 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300">{t("Κλείσιμο", "Close")}</button>
            </div>
          </div>
        )}

        {/* ── KPI cards ──────────────────────────────────────── */}
        {summary && (() => {
          const points = loyalty?.member?.points ?? 0;
          // Πρόγραμμα λήψης «σήμερα»: πόσες δόσεις πρέπει να πάρει vs πόσες πήρε
          const todayDow = (new Date().getDay() + 6) % 7;
          const thMap = Object.fromEntries((sched?.therapies ?? []).map((t) => [t.med_key, t]));
          const todaySlots = sched?.week.find((w) => w.dow === todayDow)?.slots ?? [];
          const dosesList = genDosesFor(todaySlots, thMap);
          const dosesToday = dosesList.length;
          const nowD = new Date();
          const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
          const takenKeys = new Set((sched?.taken_today ?? []).map((tk) => `${tk.med_key}|${tk.slot ?? ""}`));
          // ΟΛΑ ΑΝΑ ΔΟΣΗ της ΣΗΜΕΡΙΝΗΣ λίστας — ώστε τα 3 νούμερα να είναι πάντα συνεπή (taken+overdue+pending):
          // «Πήρα» = δόσεις της λίστας που πάρθηκαν (αγνοεί ορφανά taken records που φούσκωναν το νούμερο).
          const takenToday = dosesList.filter((d) => takenKeys.has(`${d.med_key}|${d.time}`)).length;
          // «Έπρεπε να πάρω» = πέρασαν 20' από την ώρα & ΑΥΤΗ η δόση δεν πάρθηκε (όχι καθαρή αφαίρεση —
          // μια νωρίς-ειλημμένη μελλοντική δόση δεν «ακυρώνει» μια εκπρόθεσμη).
          const overdue = dosesList.filter((d) => isOverdue(d.time, nowMin) && !takenKeys.has(`${d.med_key}|${d.time}`)).length;
          // Παραπομπή: μόνο αν η καρτέλα-στόχος είναι διαθέσιμη → η κάρτα γίνεται clickable
          const go = (k: string) => (visibleTabs.some(([t]) => t === k) ? () => setTab(k) : undefined);
          return (
          <div className="mb-7 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <Kpi icon={Pill} tint="indigo" label={t("Συνταγές", "Prescriptions")} value={String(summary.rx_count)}
              sub={summary.last_at ? t(`τελευταία ${dt(summary.last_at)}`, `latest ${dt(summary.last_at)}`) : "—"} onClick={go("rx")} />
            <Kpi icon={Clock} tint="sky" label={t("Να πάρω σήμερα", "To take today")} value={String(dosesToday)}
              sub={dosesToday > 0 ? t("συνολικά για σήμερα", "total for today") : t("καμία δόση σήμερα", "no doses today")} onClick={go("meds")} />
            <Kpi icon={CheckCircle2} tint="emerald" label={t("Πήρα σήμερα", "Taken today")} value={String(takenToday)}
              sub={dosesToday > 0 ? t(`${takenToday}/${dosesToday} δόσεις`, `${takenToday}/${dosesToday} doses`) : "—"} highlight onClick={go("meds")} />
            <Kpi icon={AlertCircle} tint="amber" label={t("Έπρεπε να πάρω", "Should have taken")} value={String(overdue)}
              sub={overdue > 0 ? t("πέρασε η ώρα λήψης", "past the time to take") : t("όλα στην ώρα τους", "all on time")} onClick={go("meds")} />
            <Kpi icon={RefreshCw} tint="violet" label={t("Ενεργές επαναλήψεις", "Active refills")} value={String(summary.repeats_active)}
              sub={summary.next_open_date ? t(`επόμενη ${dt(summary.next_open_date)}`, `next ${dt(summary.next_open_date)}`) : t("καμία προγραμματισμένη", "none scheduled")} onClick={go("repeats")} />
            <Kpi icon={PackageCheck} tint="emerald" label={t("Έτοιμες παραγγελίες", "Ready orders")} value={String(readyOrders)}
              sub={readyOrders > 0 ? t("προς παράδοση / παραλαβή", "for delivery / pickup") : t("καμία εκκρεμής", "none pending")} onClick={go("shop")} />
            {loyalty?.enabled
              ? <Kpi icon={Gift} tint="rose" label={t("Πόντοι επιβράβευσης", "Reward points")} value={String(points)}
                  sub={loyalty.member ? t("για εκπτώσεις & δώρα", "for discounts & gifts") : t("μπες στο πρόγραμμα", "join the program")} onClick={go("wallet")} />
              : <Kpi icon={Pill} tint="sky" label={t("Διαφορετικά φάρμακα", "Distinct medicines")} value={String(summary.medicines)}
                  sub={t("στο ιστορικό σου", "in your history")} onClick={go("rx")} />}
            <Kpi icon={Stethoscope} tint="indigo" label={t("Γιατροί", "Doctors")} value={String(summary.doctors)}
              sub={t("συνταγογράφησαν για σένα", "prescribed for you")} onClick={go("rx")} />
          </div>
          );
        })()}

        {/* ── Κονσόλα (ΜΟΝΟ desktop) ─────────────────────────────
            Στο κινητό η Αρχική είναι ήδη γεμάτη & τα δεδομένα είναι ένα tap μακριά· σε desktop
            έμενε μεγάλο κενό, οπότε φέρνουμε εδώ ό,τι κοιτάει καθημερινά ο πελάτης. */}
        <div className="mb-7 hidden gap-4 lg:grid lg:grid-cols-3">
          {/* 1) σημερινές λήψεις */}
          <HomePanel icon={Pill} tint="violet" title={t("Οι λήψεις σου σήμερα", "Your doses today")}
            action={visibleTabs.some(([k]) => k === "meds") ? () => setTab("meds") : undefined}>
            {(() => {
              if (!sched) return <PanelHint text={t("Φόρτωση…", "Loading…")} />;
              const todayDow = (new Date().getDay() + 6) % 7;
              const day = sched.week.find((d) => d.dow === todayDow);
              const thMap: Record<string, Therapy> = Object.fromEntries(sched.therapies.map((t) => [t.med_key, t]));
              const doses = day ? genDosesFor(day.slots, thMap) : [];
              if (doses.length === 0) return <PanelHint text={t("Καμία προγραμματισμένη λήψη σήμερα.", "No doses scheduled today.")} />;
              const taken = new Set((sched.taken_today ?? []).map((t) => `${t.med_key}|${t.slot ?? ""}`));
              const left = doses.filter((d) => !taken.has(`${d.med_key}|${d.time}`)).length;
              return (
                <>
                  <div className="mb-2 text-xs font-semibold text-violet-700">
                    {left === 0 ? t("✓ Τα πήρες όλα σήμερα!", "✓ You've taken them all today!") : t(`Απομένουν ${left} από ${doses.length}`, `${left} of ${doses.length} remaining`)}
                  </div>
                  <ul className="space-y-1.5">
                    {doses.slice(0, 5).map((d, i) => {
                      const on = taken.has(`${d.med_key}|${d.time}`);
                      return (
                        <li key={i} className="flex items-center gap-2 text-sm">
                          <span className={`w-11 shrink-0 rounded-md px-1 py-0.5 text-center text-[11px] font-bold ${on ? "bg-emerald-100 text-emerald-700" : "bg-violet-100 text-violet-700"}`}>{d.time}</span>
                          <span className={`min-w-0 flex-1 truncate ${on ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-200"}`}>{d.name}</span>
                          {on && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                        </li>
                      );
                    })}
                  </ul>
                  {doses.length > 5 && <div className="mt-1.5 text-[11px] text-slate-400">+{doses.length - 5} {t("ακόμη", "more")}</div>}
                </>
              );
            })()}
          </HomePanel>

          {/* 2) τελευταίες συνταγές */}
          <HomePanel icon={FileText} tint="indigo" title={t("Τελευταίες συνταγές", "Latest prescriptions")}
            action={visibleTabs.some(([k]) => k === "rx") ? () => setTab("rx") : undefined}>
            {rx.length === 0 ? <PanelHint text={t("Δεν υπάρχουν συνταγές ακόμη.", "No prescriptions yet.")} /> : (
              <ul className="space-y-1.5">
                {rx.slice(0, 5).map((p) => (
                  <li key={p.barcode} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-mono text-[13px] text-slate-700 dark:text-slate-200">#{p.barcode.split(":")[0]}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">{new Date(p.executed_at).toLocaleDateString("el-GR")}</span>
                  </li>
                ))}
              </ul>
            )}
          </HomePanel>

          {/* 3) ανοιχτά ραντεβού */}
          <HomePanel icon={CalendarPlus} tint="sky" title={t("Ανοιχτά ραντεβού", "Open appointments")}
            action={visibleTabs.some(([k]) => k === "appointments") ? () => setTab("appointments") : undefined}>
            {(() => {
              const open = appts.filter((a) => !DONE.includes(a.status));
              if (open.length === 0) return <PanelHint text={t("Δεν έχεις ανοιχτά ραντεβού.", "You have no open appointments.")} />;
              return (
                <ul className="space-y-1.5">
                  {open.slice(0, 5).map((a, i) => (
                    <li key={a._id ?? i} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">{a.service_name}</span>
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
          {visibleTabs.map(([k, label, labelEn]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-semibold transition ${tab === k
                ? "border-brand-600 bg-brand-600 text-white shadow-sm shadow-brand-500/30"
                : "border-slate-200 dark:border-slate-800 bg-white text-slate-700 dark:text-slate-200 shadow-sm hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"}`}>
              {t(label, labelEn)}
            </button>
          ))}
        </div>
        {/* Στο κινητό: τίτλος ενεργής ενότητας (η μπάρα είναι κάτω)· στην Αρχική ο χαιρετισμός είναι ο τίτλος */}
        {tab !== "home" && <div className="mb-4 flex items-center gap-2 sm:hidden">
          {(() => { const I = TAB_ICON[tab] || FileText; return <I className="h-5 w-5 text-brand-600" />; })()}
          <h2 className="text-lg font-extrabold tracking-tight text-slate-900 dark:text-slate-100">{t(TAB_LABEL[tab][0], TAB_LABEL[tab][1])}</h2>
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
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-3 shadow-sm">
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                <input value={rxQuery} onChange={(e) => setRxQuery(e.target.value)} inputMode="numeric" placeholder={t("Αναζήτηση με αριθμό συνταγής…", "Search by prescription number…")}
                  className="w-full rounded-xl border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800 py-2.5 pl-11 pr-3 text-[15px] focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-0.5 block text-[11px] font-medium text-slate-500 dark:text-slate-400">{t("Από", "From")}</label>
                  <DateInput value={rxFrom} onChange={setRxFrom} className="w-full" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-medium text-slate-500 dark:text-slate-400">{t("Έως", "To")}</label>
                  <DateInput value={rxTo} onChange={setRxTo} className="w-full" />
                </div>
              </div>
              {active && (
                <button onClick={() => { setRxQuery(""); setRxFrom(""); setRxTo(""); }} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"><X className="h-3.5 w-3.5" /> {t("Καθαρισμός", "Clear")}</button>
              )}
            </div>
            {/* πλαίσιο πλοήγησης: πόσα δείχνουμε */}
            {!active && rx.length > 5 && (
              <div className="flex items-center justify-between px-1 text-xs text-slate-500 dark:text-slate-400">
                <span>{rxShowAll ? t(`Όλες οι συνταγές (${filtered.length})`, `All prescriptions (${filtered.length})`) : t("Οι 5 πιο πρόσφατες εκτελέσεις", "The 5 most recent executions")}</span>
                <button onClick={() => setRxShowAll((v) => !v)} className="font-semibold text-brand-600 hover:text-brand-700">{rxShowAll ? t("Δείξε λιγότερες", "Show fewer") : t("Δείξε όλες", "Show all")}</button>
              </div>
            )}
            {active && <div className="px-1 text-xs text-slate-500 dark:text-slate-400">{filtered.length} {filtered.length === 1 ? t("αποτέλεσμα", "result") : t("αποτελέσματα", "results")}</div>}

            {rx.length === 0 && <Empty icon={Pill} text={t("Δεν υπάρχουν συνταγές ακόμα.", "No prescriptions yet.")} />}
            {rx.length > 0 && shown.length === 0 && <Empty icon={Search} text={t("Καμία συνταγή για αυτά τα κριτήρια.", "No prescriptions for these criteria.")} />}
            {shown.map((p) => {
              const open = expanded === p.barcode;
              return (
                <div key={p.barcode} className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 shadow-sm transition hover:shadow-md">
                  <button onClick={() => toggleExpand(p.barcode, p.tenant_id)} className="flex w-full items-center gap-2.5 p-2.5 text-left sm:p-3">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${p.partial ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"}`}><Pill className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">#{p.barcode.split(":")[0]}</span>
                        {p.partial
                          ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"><AlertCircle className="h-3 w-3" /> {t("Μερική", "Partial")}</span>
                          : <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700"><CheckCircle2 className="h-3 w-3" /> {t("Πλήρης", "Complete")}</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                        <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3 text-slate-400" /> {dt(p.executed_at)}</span>
                        {/* ΠΟΥ έγινε η εκτέλεση — ο πελάτης βλέπει εκτελέσεις από όλα τα φαρμακεία του */}
                        {p.pharmacy_name && (
                          <span className="inline-flex min-w-0 items-center gap-1 text-slate-500 dark:text-slate-400">
                            <Building2 className="h-3 w-3 shrink-0 text-slate-400" />
                            <span className="min-w-0 truncate">{p.pharmacy_name}</span>
                          </span>
                        )}
                        {p.next_open_date && <span className="inline-flex items-center gap-1 text-emerald-600"><Clock className="h-3 w-3" /> {t("ανοίγει", "opens")} {dt(p.next_open_date)}</span>}
                      </div>
                    </div>
                    {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                  </button>
                  {open && (
                    <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 px-4 py-3">
                      {!detail ? <div className="flex items-center gap-2 text-xs text-slate-400"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Φόρτωση…", "Loading…")}</div> : (
                        <>
                          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                            {activeName && <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5 text-slate-400" /> {activeName}</span>}
                            {detail.doctor && <span className="inline-flex items-center gap-1"><Stethoscope className="h-3.5 w-3.5 text-slate-400" /> {detail.doctor}{detail.specialty ? ` · ${detail.specialty}` : ""}</span>}
                            {detail.repeat_total && detail.repeat_total > 1 ? <span className="inline-flex items-center gap-1"><RefreshCw className="h-3.5 w-3.5 text-slate-400" /> {t("επανάληψη", "refill")} {detail.repeat_current}/{detail.repeat_total}</span> : null}
                          </div>
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("Φάρμακα", "Medicines")}</div>
                          <ul className="divide-y divide-slate-200/70">
                            {detail.items.map((it, i) => (
                              <li key={i} className={`flex items-start justify-between gap-3 py-2 text-sm ${it.is_executed ? "text-slate-700 dark:text-slate-200" : "text-slate-400"}`}>
                                <span className="flex min-w-0 items-start gap-2">
                                  {it.is_executed
                                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                                    : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />}
                                  <span className="min-w-0">
                                    <span className="flex flex-wrap items-center gap-2">
                                      <span className={it.is_executed ? "" : "line-through"}>{it.name}{it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : ""}</span>
                                      {!it.is_executed && <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">{t("δεν παραλήφθηκε", "not dispensed")}</span>}
                                    </span>
                                    {it.dosage && <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">💊 {it.dosage}</span>}
                                  </span>
                                </span>
                                {it.is_executed && <span className="shrink-0 font-medium">{eur(it.retail_price)}</span>}
                              </li>
                            ))}
                          </ul>
                          {detail.icd10 && detail.icd10.length > 0 && (
                            <div className="mt-3 text-xs text-slate-400">{t("Διάγνωση:", "Diagnosis:")} {detail.icd10.join(", ")}</div>
                          )}
                          <div className="mt-3 flex items-center justify-end gap-4 border-t border-slate-200/70 pt-3 text-xs">
                            <span className="text-slate-500 dark:text-slate-400">{t("Σύνολο:", "Total:")} <b className="text-slate-700 dark:text-slate-200">{eur(detail.amount_total)}</b></span>
                            <span className="text-amber-600">{t("Πλήρωσες:", "You paid:")} <b>{eur(detail.patient_share)}</b></span>
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
            {repeats.length === 0 && <Empty icon={RefreshCw} text={t("Δεν υπάρχουν επόμενες επαναλήψεις.", "No upcoming refills.")} />}
            {repeats.map((p) => {
              const open = expanded === p.barcode;
              return (
              <div key={p.barcode} className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 shadow-sm">
                <button onClick={() => toggleExpand(p.barcode)} className="flex w-full items-center gap-3 p-4 text-left">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><RefreshCw className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">#{p.barcode.split(":")[0]}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="flex items-center justify-end gap-1 text-[11px] font-medium uppercase tracking-wide text-emerald-600"><Clock className="h-3 w-3" /> {t("ανοίγει", "opens")}</div>
                    <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{dt(p.next_open_date)}</div>
                  </div>
                  {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                </button>
                {open && (
                  <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 px-4 py-3">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("Φάρμακα συνταγής", "Prescription medicines")}</div>
                    {p.medicines.length === 0 ? <div className="text-xs text-slate-400">—</div> : (
                      <ul className="divide-y divide-slate-200/70">
                        {p.medicines.map((m, i) => (
                          <li key={i} className="flex items-start gap-2 py-2 text-sm text-slate-700 dark:text-slate-200">
                            <Pill className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                            <div className="min-w-0">
                              <div className="font-medium">{m.name}</div>
                              {m.dosage && <div className="text-xs text-slate-500 dark:text-slate-400">💊 {m.dosage}</div>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-2 text-[11px] text-slate-400">{t(`Θα είναι διαθέσιμη για εκτέλεση από ${dt(p.next_open_date)} — δεν έχει εκτελεστεί ακόμα.`, `Available for execution from ${dt(p.next_open_date)} — not executed yet.`)}</p>
                  </div>
                )}
                {pickupDone[p.barcode] ? (
                  <div className="flex items-center gap-1.5 border-t border-slate-100 dark:border-slate-800 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" /> {t(`Θα περάσεις να την παραλάβεις ${dtl(pickupDone[p.barcode])}`, `You'll come to pick it up ${dtl(pickupDone[p.barcode])}`)}
                  </div>
                ) : pickupFor === p.barcode ? (
                  <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 px-4 py-3">
                    <input type="datetime-local" value={pickupAt} min={new Date().toISOString().slice(0, 16)} onChange={(e) => setPickupAt(e.target.value)}
                      className="mb-2 w-full min-w-0 appearance-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
                    <div className="flex gap-2">
                      <button onClick={() => bookPickup(p)} disabled={!pickupAt}
                        className="flex-1 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{t("Στείλε", "Send")}</button>
                      <button onClick={() => { setPickupFor(null); setPickupAt(""); }}
                        className="shrink-0 rounded-xl px-3 py-2.5 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700">{t("Άκυρο", "Cancel")}</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setPickupFor(p.barcode); setPickupAt(""); }}
                    className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 dark:border-slate-800 bg-white py-2.5 text-sm font-semibold text-brand-700 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <PackageCheck className="h-4 w-4" /> {t("Θα περάσω να την παραλάβω", "I'll come to pick it up")}
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
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("Χρόνιες επαναλαμβανόμενες συνταγές σου που είναι ", "Your chronic recurring prescriptions that are ")}<b>{t("διαθέσιμες προς εκτέλεση", "available for execution")}</b>{t(" στο φαρμακείο σου. Δήλωσε αν θα τις παραλάβεις (& πότε θα περάσεις) ή όχι — έτσι ο φαρμακοποιός προγραμματίζει διαθεσιμότητα & παράδοση.", " at your pharmacy. Tell us whether you'll pick them up (& when) or not — so your pharmacist can plan availability & delivery.")}</p>
            {renewals === null ? (
              <div className="p-6 text-center text-slate-400">{t("Φόρτωση…", "Loading…")}</div>
            ) : renewals.length === 0 ? (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white p-6 text-center text-sm text-slate-400">{t("Δεν υπάρχουν ανεκτέλεστα αυτή τη στιγμή. 👍", "Nothing unexecuted right now. 👍")}</div>
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
            <div className="flex gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
              {([["calendar", t("Ημερολόγιο", "Calendar"), Calendar], ["settings", t("Ρυθμίσεις", "Settings"), BellRing]] as const).map(([k, label, Icon]) => (
                <button key={k} onClick={() => setMedsView(k)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-semibold transition ${medsView === k ? "bg-white text-violet-700 shadow-sm" : "text-slate-500 dark:text-slate-400"}`}>
                  <Icon className="h-4 w-4" />{label}
                </button>
              ))}
            </div>

            {!sched ? <div className="py-10 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>
             : sched.therapies.length === 0 ? <Empty icon={BellRing} text={t("Δεν βρέθηκαν ενεργές αγωγές αυτή τη στιγμή.", "No active treatments right now.")} />
             : medsView === "calendar" ? (<>
              {/* ── ΗΜΕΡΟΛΟΓΙΟ ── */}
              {!!sched.streak && <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-xs font-bold text-orange-700">🔥 {t(`${sched.streak} ${sched.streak === 1 ? "μέρα" : "μέρες"} συνεπής λήψη στη σειρά!`, `${sched.streak} ${sched.streak === 1 ? "day" : "days"} of consistent intake in a row!`)}</div>}
              {sched.week.some((d) => d.slots.length > 0) ? (() => {
                const todayDow = (new Date().getDay() + 6) % 7;
                const _n = new Date();
                const nowMin = _n.getHours() * 60 + _n.getMinutes();
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
                    const overdueCount = today ? doses.filter((x) => !takenSet.has(`${x.med_key}|${x.time}`) && isOverdue(x.time, nowMin)).length : 0;
                    return (
                      <div key={d.dow} className={`overflow-hidden rounded-2xl border ${today ? "border-violet-300 ring-1 ring-violet-200" : "border-slate-200 dark:border-slate-800"}`}>
                        <button onClick={() => setOpenDay(open ? null : d.dow)} className="flex w-full items-center justify-between gap-2 bg-white px-3.5 py-2.5 text-left">
                          <span className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                            {t(DOW[d.dow], DOW_EN[d.dow])}
                            {today && <span className="rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">{t("σήμερα", "today")}</span>}
                            {today && overdueCount > 0 && <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">⚠ {t(`${overdueCount} ληξιπρόθεσμα`, `${overdueCount} overdue`)}</span>}
                            {today && pending > 0 && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">{t(`${pending} να πάρω`, `${pending} to take`)}</span>}
                            {today && pending === 0 && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">{t("✓ όλα", "✓ all")}</span>}
                          </span>
                          {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                        </button>
                        {open && (
                          <div className="space-y-1.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/40 px-3.5 py-3">
                            {doses.map((x, i) => {
                              const taken = today && takenSet.has(`${x.med_key}|${x.time}`);
                              const overdue = today && !taken && isOverdue(x.time, nowMin);   // 20' μετά την ώρα & δεν πάρθηκε → ληξιπρόθεσμο
                              return (
                                <button key={i} onClick={() => { if (today) toggleIntake(x.med_key, x.time, taken); }} disabled={!today}
                                  title={taken ? t("Πάτα για αναίρεση", "Tap to undo") : overdue ? t("Ληξιπρόθεσμο — πάτα «Το πήρα»", "Overdue — tap «Taken»") : t("Πάτα «Το πήρα»", "Tap «Taken»")}
                                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition ${taken ? "bg-emerald-50 text-emerald-700" : overdue ? "bg-rose-50 text-rose-800 ring-1 ring-rose-300" : today ? "bg-violet-50 text-violet-800 hover:bg-violet-100" : "bg-white text-slate-600 dark:text-slate-300"}`}>
                                  <span className="min-w-0 flex-1">
                                    <span className={`block truncate text-sm font-bold ${taken ? "line-through opacity-60" : ""}`}>{x.name}{overdue && <span className="ml-1.5 rounded-full bg-rose-600 px-1.5 py-0.5 align-middle text-[9px] font-bold tracking-wide text-white">{t("ΛΗΞΙΠΡΟΘΕΣΜΟ", "OVERDUE")}</span>}</span>
                                    <span className={`mt-0.5 block truncate text-[11px] ${overdue ? "font-semibold text-rose-600" : "text-slate-500 dark:text-slate-400"}`}>⏰ {x.time}{overdue ? t(" · πέρασε η ώρα", " · time passed") : ""}{x.dose ? ` · ${x.dose}` : ""}{x.meal === "before" ? t(" · 🍽️ πριν", " · 🍽️ before") : x.meal === "after" ? t(" · 🍽️ μετά", " · 🍽️ after") : ""}</span>
                                  </span>
                                  {today && (taken
                                    ? <span className="shrink-0 self-center text-[11px] font-bold">✓ · ↺</span>
                                    : <span className={`shrink-0 self-center rounded-full px-2.5 py-1 text-[11px] font-bold text-white ${overdue ? "bg-rose-600" : "bg-violet-600"}`}>{t("Το πήρα", "Taken")}</span>)}
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
              })() : <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">{t("Δεν έχεις ενεργές υπενθυμίσεις.", "You have no active reminders.")}<br />{t("Πήγαινε στις ", "Go to ")}<b>{t("Ρυθμίσεις", "Settings")}</b>{t(" και ενεργοποίησε ποιες αγωγές θες να σου θυμίζουμε.", " and turn on which treatments you'd like reminders for.")}</p>}
             </>) : (<>
              {/* ── ΡΥΘΜΙΣΕΙΣ (ποια αγωγή θέλω ενημέρωση) ── */}
              <div className="rounded-2xl bg-gradient-to-br from-violet-50 to-indigo-50 p-4">
                <div className="text-sm font-semibold text-violet-900">{t("💊 Ποιες αγωγές να σου θυμίζουμε;", "💊 Which treatments should we remind you about?")}</div>
                <p className="mt-1 text-xs text-violet-700">{t("Φτιαγμένο από τις ", "Built from your ")}<b>{t("οδηγίες του γιατρού σου", "doctor's instructions")}</b>{t(" (όπως καταχωρήθηκαν στην ΗΔΥΚΑ). Άναψε τον διακόπτη σε όσες θες υπενθύμιση — θα εμφανιστούν στο ", " (as recorded in ΗΔΥΚΑ). Turn on the switch for the ones you want reminders for — they'll appear in the ")}<b>{t("Ημερολόγιο", "Calendar")}</b>{t(". ", ". ")}<span className="opacity-70">{t("Ακολούθα πάντα τις οδηγίες του γιατρού/φαρμακοποιού σου.", "Always follow your doctor's/pharmacist's instructions.")}</span></p>
              </div>
              <div className="space-y-2">
                {sched.therapies.map((th) => {
                  const warn = th.days_left !== null && th.days_left <= 7;
                  return (
                    <div key={th.med_key} className={`rounded-2xl border p-3 ${th.enabled ? "border-violet-200 bg-white" : "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{th.name}</div>
                          {th.dosage_text && <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{th.dosage_text}</div>}
                          {th.days_left !== null && (
                            <div className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${warn ? "bg-amber-100 text-amber-700" : "bg-emerald-50 text-emerald-600"}`}>
                              {warn ? "⏳" : "✓"} {th.days_left <= 0 ? t("τελειώνει σήμερα", "ends today") : t(`απομένουν ${th.days_left} ημέρες`, `${th.days_left} days left`)}
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
                          <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {th.interval_hours ? t(`κάθε ${th.interval_hours} ώρες`, `every ${th.interval_hours} hours`) : (th.time || "—")}</span>
                          <span>{th.meal === "before" ? t("🍽️ πριν το γεύμα", "🍽️ before meal") : th.meal === "after" ? t("🍽️ μετά το γεύμα", "🍽️ after meal") : t("άσχετο με γεύμα", "unrelated to meals")}</span>
                          <span className="text-[10px] text-violet-400">{t("· αλλαγή", "· change")}</span>
                        </button>
                      )}
                      {/* φόρμα ρύθμισης (εμφανίζεται στην ενεργοποίηση ή στην «αλλαγή») */}
                      {medCfg?.med_key === th.med_key && (
                        <div className="mt-2 space-y-2 rounded-xl border border-violet-200 bg-violet-50/50 p-2.5">
                          {medCfg.per_day > 1 && <div className="text-[11px] font-medium text-violet-700">💊 {t(`${medCfg.per_day} λήψεις/ημέρα — διάλεξε τρόπο:`, `${medCfg.per_day} intakes/day — choose a mode:`)}</div>}
                          {/* toggle ΜΟΝΟ για >1×/μέρα — είτε συγκεκριμένη ώρα ΕΙΤΕ κάθε X ώρες (όχι μαζί) */}
                          {medCfg.per_day > 1 && (
                            <div className="flex gap-1.5">
                              {([["time", t("Συγκεκριμένη ώρα", "Specific time")], ["interval", t("Κάθε X ώρες", "Every X hours")]] as const).map(([mv, ml]) => (
                                <button key={mv} onClick={() => setMedCfg({ ...medCfg, mode: mv })} className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${medCfg.mode === mv ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 dark:border-slate-800 bg-white text-slate-600 dark:text-slate-300"}`}>{ml}</button>
                              ))}
                            </div>
                          )}
                          {medCfg.per_day > 1 && medCfg.mode === "interval" && (
                            <div>
                              <div className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">{t("🔁 Κάθε πόσες ώρες;", "🔁 Every how many hours?")}</div>
                              <select value={medCfg.interval} onChange={(e) => setMedCfg({ ...medCfg, interval: +e.target.value })} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-violet-400 focus:outline-none">
                                {[3, 4, 6, 8, 12].map((h) => <option key={h} value={h}>{t(`κάθε ${h} ώρες`, `every ${h} hours`)}</option>)}
                              </select>
                            </div>
                          )}
                          {/* ώρα (πάντα): «Ώρα λήψης» στη συγκεκριμένη ώρα, «Ώρα 1ης λήψης» στο interval */}
                          <div>
                            <div className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">⏰ {medCfg.per_day > 1 && medCfg.mode === "interval" ? t("Ώρα 1ης λήψης", "First intake time") : t("Ώρα λήψης", "Intake time")} {t("(24ωρο)", "(24h)")}</div>
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
                            <div className="rounded-lg bg-white/70 px-2 py-1 text-[10px] text-slate-500 dark:text-slate-400">{t("Δόσεις:", "Doses:")} {Array.from({ length: Math.ceil(24 / medCfg.interval) }, (_, i) => { const [h, mn] = medCfg.time.split(":").map(Number); const tot = ((h * 60 + mn + i * medCfg.interval * 60) % 1440); return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`; }).join(" · ")}</div>
                          )}
                          <div>
                            <div className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">{t("🍽️ Σε σχέση με το γεύμα", "🍽️ Relative to meals")}</div>
                            <div className="flex gap-1.5">
                              {([["before", t("Πριν", "Before")], ["after", t("Μετά", "After")], ["none", t("Άσχετο", "Neither")]] as const).map(([v, l]) => (
                                <button key={v} onClick={() => setMedCfg({ ...medCfg, meal: v })}
                                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${medCfg.meal === v ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 dark:border-slate-800 bg-white text-slate-600 dark:text-slate-300"}`}>{l}</button>
                              ))}
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setMedCfg(null)} className="px-2 py-1 text-xs text-slate-400">{t("Άκυρο", "Cancel")}</button>
                            <button onClick={saveMedCfg} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">{t("Αποθήκευση", "Save")}</button>
                          </div>
                        </div>
                      )}
                      {th.reservable && (
                        <div className="mt-2">
                          <button onClick={() => reserveMed(th.name)} className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100">
                            🔁 {t("Κράτηση επανάληψης", "Reserve a refill")}
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
            { k: "bp" as const, label: t("Πίεση", "Blood pressure"), val: bp ? `${bpShow(bp.systolic)}/${bpShow(bp.diastolic)}` : "—", sub: bp ? dt(bp.at) : "—", cls: hStat("bp", bp), watch: bp && !hStat("bp", bp).includes("emerald") },
            { k: "glucose" as const, label: t("Ζάχαρο", "Glucose"), val: gl ? `${gl.value}` : "—", sub: gl ? `mg/dL` : "—", cls: hStat("glucose", gl), watch: gl && !hStat("glucose", gl).includes("emerald") },
            { k: "weight" as const, label: t("Βάρος", "Weight"), val: wt ? wShow(wt.value) : "—", sub: wt ? "kg" : "—", cls: "bg-slate-50 dark:bg-slate-800/60 text-slate-700 dark:text-slate-200", watch: false },
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
                <div className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">{t("Τελευταίες μετρήσεις", "Latest measurements")}</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {tiles.map((tl) => {
                    const tr = trend(tl.k);
                    return (
                      <div key={tl.k} className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4">
                        <div className="flex items-center justify-between"><span className="text-xs text-slate-500 dark:text-slate-400">{tl.label}</span>{tl.watch ? <span className="text-[10px] font-bold text-amber-600">{t("⚠️ προσοχή", "⚠️ attention")}</span> : tl.val !== "—" && <span className="text-[10px] font-bold text-emerald-600">✓</span>}</div>
                        <div className={`mt-1 inline-flex rounded px-1.5 text-xl font-bold ${tl.cls}`}>{tl.val}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                          <span className="text-slate-400">{tl.sub}</span>
                          {tr && tr.d !== 0 && <span className={`font-bold ${tr.better === null ? "text-slate-500 dark:text-slate-400" : tr.better ? "text-emerald-600" : "text-rose-600"}`}>{tr.d > 0 ? "▲" : "▼"}{tl.k === "bp" ? (Math.abs(tr.d) / 10).toFixed(1).replace(".", ",") : tl.k === "weight" ? Math.abs(tr.d).toFixed(2).replace(".", ",") : Math.abs(tr.d).toFixed(0)}{tr.better === true ? " ✓" : tr.better === false ? " !" : ""}</span>}
                        </div>
                      </div>
                    );
                  })}
                  <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400">{t("ΔΜΣ", "BMI")}</div>
                    <div className={`mt-1 inline-flex rounded px-1.5 text-xl font-bold ${bmi ? (bmi >= 30 ? "bg-rose-50 text-rose-700" : (bmi >= 25 || bmi < 18.5) ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700") : "bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400"}`}>{bmi ? bmi.toFixed(1) : "—"}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{health?.height_cm ? t(`ύψος ${(health.height_cm / 100).toFixed(2).replace(".", ",")}μ`, `height ${(health.height_cm / 100).toFixed(2).replace(".", ",")}m`) : "—"}</div>
                  </div>
                </div>
                {watchList.length > 0 && <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">{t("⚠️ Χρειάζονται προσοχή:", "⚠️ Need attention:")} <b>{watchList.join(", ")}</b>{t(" — συζήτησέ το με τον φαρμακοποιό/γιατρό σου.", " — discuss it with your pharmacist/doctor.")}</div>}
              </div>

              {/* ΗΜΕΡΟΜΗΝΙΕΣ μετρήσεων — κλικ για να δεις τις μετρήσεις εκείνης της μέρας */}
              {anyHist ? (
                <div>
                  <div className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">{t("Ιστορικό ανά ημερομηνία", "History by date")}</div>
                  <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {dates.map((d) => (
                      <button key={d} onClick={() => setHealthDate(d)} className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold ${sel === d ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 dark:border-slate-800 bg-white text-slate-600 dark:text-slate-300"}`}>{dt(d)}</button>
                    ))}
                  </div>
                  {sel && (
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4">
                      <div className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">{t("Μετρήσεις", "Measurements")} {dt(sel)}</div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        {(["bp", "glucose", "weight"] as const).map((k) => (
                          <div key={k} className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-2.5">
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">{k === "bp" ? t("Πίεση", "Blood pressure") : k === "glucose" ? t("Ζάχαρο", "Glucose") : t("Βάρος", "Weight")}</div>
                            <div className={`mt-0.5 text-sm font-bold ${byDate[sel][k] ? "text-slate-800 dark:text-slate-100" : "text-slate-300"}`}>{fmtM(k, byDate[sel][k])}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : <Empty icon={Pill} text={t("Δεν υπάρχουν μετρήσεις ακόμη — καταχωρούνται από το φαρμακείο σου.", "No measurements yet — they are recorded by your pharmacy.")} />}
            </div>
          );
        })()}

        {/* ── ΕΠΙΒΡΑΒΕΥΣΗ / ΠΟΡΤΟΦΟΛΙ ───────────────────────── */}
        {tab === "wallet" && (
          <div className="space-y-4">
            {loyalty && !loyalty.enabled && <Empty icon={Gift} text={t("Το φαρμακείο σου δεν έχει ενεργό πρόγραμμα επιβράβευσης ακόμη.", "Your pharmacy doesn't have an active rewards program yet.")} />}
            {loyalty?.enabled && loyalty.enrolled === false && (
              <div className="space-y-3">
                <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-rose-500 to-amber-500 p-5 text-white shadow-lg">
                  <div className="text-lg font-extrabold">{t("🎁 Μπες στο πρόγραμμα επιβράβευσης!", "🎁 Join the rewards program!")}</div>
                  <p className="mt-1 text-sm opacity-90">{t("Κέρδισε πόντους με κάθε εκτέλεση των επαναλαμβανόμενων συνταγών σου & εξαργύρωσέ τους σε προϊόντα, υπηρεσίες και εκπτώσεις.", "Earn points on every execution of your recurring prescriptions & redeem them for products, services and discounts.")}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4">
                  <div className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Όροι συμμετοχής", "Terms of participation")}</div>
                  <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{loyalty.terms}</pre>
                  <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">{t("Σε έφερε φίλος; Κωδικός σύστασης (προαιρετικό)", "Referred by a friend? Referral code (optional)")}
                    <input value={refCodeInput} onChange={(e) => setRefCodeInput(e.target.value.toUpperCase().slice(0, 6))} placeholder={t("π.χ. AB3K9P", "e.g. AB3K9P")}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-sm tracking-widest dark:border-slate-700 dark:bg-slate-800" /></label>
                  <button onClick={joinLoyalty} disabled={assignBusy}
                    className="mt-3 w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{t("✓ Αποδέχομαι τους όρους & εγγραφή", "✓ I accept the terms & sign up")}</button>
                  <p className="mt-1 text-center text-[11px] text-slate-400">{t("Οι πόντοι ξεκινούν να μετρούν από τη στιγμή της εγγραφής σου.", "Points start counting from the moment you sign up.")}</p>
                </div>
              </div>
            )}
            {loyalty?.enabled && loyalty.enrolled && !loyalty.member && <Empty icon={Gift} text={t("Μόλις εκτελέσεις τις επόμενες επαναλαμβανόμενες συνταγές σου, θα αρχίσεις να μαζεύεις πόντους!", "Once you execute your next recurring prescriptions, you'll start collecting points!")} />}
            {loyalty?.enabled && loyalty.enrolled && loyalty.member && (() => {
              const m = loyalty.member!;
              return (
                <>
                  {/* πορτοφόλι */}
                  <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-rose-500 via-pink-500 to-amber-500 p-5 text-white shadow-lg">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium opacity-90">{t("💳 Το πορτοφόλι σου", "💳 Your wallet")}</span>
                      <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-bold">{TIER_GR[m.tier] ? t(TIER_GR[m.tier], TIER_EN[m.tier] ?? m.tier) : m.tier}</span>
                    </div>
                    <div className="mt-1 text-4xl font-extrabold">{eur(m.balance_cents)}</div>
                    <div className="text-sm font-medium opacity-90">{m.balance_cents > 0 ? t("διαθέσιμα για εξαργύρωση στο φαρμακείο", "available to redeem at the pharmacy") : t("μάζεψε πόντους σε κάθε αγορά/επίσκεψη", "collect points on every purchase/visit")}{m.points > 0 ? t(` · ${m.points} πόντοι`, ` · ${m.points} points`) : ""}</div>
                  </div>

                  {/* κάρτα μέλους με QR — ο πελάτης τη δείχνει στο φαρμακείο για ταυτοποίηση/εξαργύρωση */}
                  <div className="flex items-center gap-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4">
                    <div className="grid shrink-0 place-items-center rounded-xl bg-white p-2 ring-1 ring-slate-200">
                      <QRCodeCanvas value={`RXVL:${m.patient_ref}`} size={104} level="M" includeMargin />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{t("🪪 Κάρτα μέλους", "🪪 Membership card")}</div>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t("Δείξε αυτόν τον κωδικό στο φαρμακείο — ο φαρμακοποιός τον σκανάρει για να σε ταυτοποιήσει & να εξαργυρώσεις πόντους.", "Show this code at the pharmacy — the pharmacist scans it to identify you & let you redeem points.")}</p>
                      <div className="mt-1 font-mono text-[10px] tracking-wide text-slate-400">{m.patient_ref}</div>
                    </div>
                  </div>

                  {/* Σύστησε φίλο — μοιράσου τον κωδικό σου, κερδίστε κι οι δύο πόντους */}
                  {loyalty.referral?.code && (
                    <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 dark:border-sky-900/40 dark:bg-sky-950/20">
                      <div className="text-sm font-bold text-sky-900 dark:text-sky-200">{t("👥 Σύστησε έναν φίλο", "👥 Refer a friend")}</div>
                      <p className="mt-0.5 text-xs text-sky-700 dark:text-sky-300">{t(`Μοιράσου τον κωδικό σου. Όταν εγγραφεί, κερδίζετε πόντους και οι δύο${loyalty.referral.referrer_cents ? ` (εσύ +${eur(loyalty.referral.referrer_cents)})` : ""}.`, `Share your code. When they sign up, you both earn points${loyalty.referral.referrer_cents ? ` (you +${eur(loyalty.referral.referrer_cents)})` : ""}.`)}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="flex-1 rounded-lg border border-sky-300 bg-white px-3 py-2 text-center font-mono text-lg font-bold tracking-widest text-sky-800 dark:bg-slate-900">{loyalty.referral.code}</span>
                        <button onClick={() => { const c = loyalty.referral!.code!; const share = t(`Μπες στο πρόγραμμα επιβράβευσης του φαρμακείου με τον κωδικό μου: ${c}`, `Join the pharmacy's rewards program with my code: ${c}`); if (navigator.share) { navigator.share({ text: share }).catch(() => {}); } else { navigator.clipboard?.writeText(c); toast(t("Ο κωδικός αντιγράφηκε!", "Code copied!")); } }}
                          className="shrink-0 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700">{t("Μοιράσου", "Share")}</button>
                      </div>
                    </div>
                  )}

                  {/* στόχος / πρόοδος */}
                  {m.next_tier && (
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">{t("🎯 Επόμενος στόχος:", "🎯 Next goal:")} {TIER_GR[m.next_tier] ? t(TIER_GR[m.next_tier], TIER_EN[m.next_tier] ?? m.next_tier) : m.next_tier}</span>
                        <span className="text-slate-500 dark:text-slate-400">{t(`${m.to_next} πόντοι ακόμη`, `${m.to_next} points to go`)}</span>
                      </div>
                      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div className="h-full rounded-full bg-gradient-to-r from-rose-400 to-amber-400" style={{ width: `${m.progress_pct}%` }} />
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{t(`${Math.ceil(m.to_next / Math.max(1, m.points_per_refill))} εκτελέσεις ακόμη για το επόμενο επίπεδο`, `${Math.ceil(m.to_next / Math.max(1, m.points_per_refill))} more executions for the next tier`)}</div>
                    </div>
                  )}

                  {/* nudge: ανοιχτές συνταγές → πόντοι */}
                  {m.open_refills > 0 && (
                    <button onClick={() => setTab("repeats")} className="block w-full rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4 text-left transition hover:bg-emerald-100">
                      <div className="text-sm font-bold text-emerald-800">🔔 {t(`Έχεις ${m.open_refills} ${m.open_refills === 1 ? "συνταγή έτοιμη" : "συνταγές έτοιμες"} για εκτέλεση!`, `You have ${m.open_refills} ${m.open_refills === 1 ? "prescription ready" : "prescriptions ready"} for execution!`)}</div>
                      <div className="mt-0.5 text-sm text-emerald-700">{t(`Εκτέλεσέ ${m.open_refills === 1 ? "την" : "τες"} στο φαρμακείο σου & κέρδισε `, `Execute ${m.open_refills === 1 ? "it" : "them"} at your pharmacy & earn `)}<b>+{t(`${m.potential_points} πόντους`, `${m.potential_points} points`)}</b> ({eur(m.potential_points * m.cents_per_point)}). →</div>
                    </button>
                  )}

                  {/* συνέπεια */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 text-center">
                      <div className="text-2xl font-bold text-sky-600">{m.compliance ?? "—"}%</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t("Συνέπεια στις επαναλήψεις", "Refill adherence")}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 text-center">
                      <div className="text-2xl font-bold text-rose-600">{m.refills}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{t("Εκτελέσεις που μέτρησαν", "Executions that counted")}</div>
                    </div>
                  </div>

                  {/* δώρα — τι δικαιούται ο πελάτης με βάση τα στάνταρ του φαρμακείου */}
                  {/* Ενεργή δέσμευση δώρου — κωδικός για το φαρμακείο */}
                  {loyalty.reservation && (
                    <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
                      <div className="text-sm font-bold text-amber-900 dark:text-amber-200">{t("🎁 Δεσμευμένο δώρο:", "🎁 Reserved gift:")} {loyalty.reservation.reward}</div>
                      <div className="mt-1 text-xs text-amber-800 dark:text-amber-300">{t("Δείξε αυτόν τον κωδικό στο φαρμακείο για να το παραλάβεις:", "Show this code at the pharmacy to pick it up:")}</div>
                      <div className="mt-2 flex items-center gap-3">
                        <span className="rounded-xl bg-white px-4 py-2 font-mono text-2xl font-extrabold tracking-widest text-amber-700 shadow-sm dark:bg-slate-900">{loyalty.reservation.code}</span>
                        <button onClick={() => loyalty.reservation && cancelReservation(loyalty.reservation.code)} disabled={assignBusy} className="text-xs font-semibold text-amber-700 underline hover:text-amber-900 disabled:opacity-50">{t("Ακύρωση", "Cancel")}</button>
                      </div>
                      <div className="mt-1 text-[11px] text-amber-600">{t("Οι πόντοι είναι δεσμευμένοι μέχρι την παραλαβή· η κράτηση λήγει σε 48 ώρες.", "The points are held until pickup; the reservation expires in 48 hours.")}</div>
                    </div>
                  )}
                  {!!loyalty.rewards?.length && (() => {
                    const cpp = m.cents_per_point || 1;
                    const ranked = [...loyalty.rewards].map((r) => ({ ...r, afford: m.balance_cents >= r.cost_cents, need: Math.max(0, Math.ceil((r.cost_cents - m.balance_cents) / cpp)) }))
                      .sort((a, b) => Number(b.afford) - Number(a.afford) || a.cost_points - b.cost_points);
                    const unlocked = ranked.filter((r) => r.afford).length;
                    return (
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">{t("🎁 Τα δώρα σου", "🎁 Your gifts")}</div>
                          {unlocked > 0 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">{t(`${unlocked} διαθέσιμα τώρα`, `${unlocked} available now`)}</span>}
                        </div>
                        <div className="space-y-1.5">
                          {ranked.map((r, i) => (
                            <div key={r._id ?? i} className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${r.afford ? "border-emerald-300 bg-emerald-50" : "border-slate-200 dark:border-slate-800 bg-white"}`}>
                              <span className={r.afford ? "font-medium text-slate-800 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}>{RTYPE_EMOJI[r.type] ?? "🎁"} {r.title}</span>
                              <div className="shrink-0 text-right">
                                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t(`${r.cost_points} π.`, `${r.cost_points} pts`)} · {eur(r.cost_cents)}</div>
                                {r.afford
                                  ? <button onClick={() => r._id && redeemReward(r._id)} disabled={assignBusy || !!loyalty.reservation} title={loyalty.reservation ? t("Έχεις ήδη ενεργή δέσμευση", "You already have an active reservation") : t("Δέσμευσέ το", "Reserve it")} className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">{t("Δέσμευσέ το", "Reserve it")}</button>
                                  : <div className="text-[11px] text-slate-400">🔒 {t(`σου λείπουν ${r.need} πόντοι`, `${r.need} points short`)}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="mt-1.5 text-[11px] text-slate-400">{t("Πάτα «Δέσμευσέ το» για να κρατήσεις ένα δώρο — θα πάρεις κωδικό που δείχνεις στο φαρμακείο για την παραλαβή.", "Tap «Reserve it» to hold a gift — you'll get a code to show at the pharmacy for pickup.")}</p>
                      </div>
                    );
                  })()}

                  {/* πώς κερδίζω */}
                  <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/60 p-4 text-sm text-slate-600 dark:text-slate-300">
                    <div className="font-semibold text-slate-700 dark:text-slate-200">{t("💡 Πώς μαζεύω πόντους", "💡 How I collect points")}</div>
                    <p className="mt-1">{t("Κάθε φορά που εκτελείς εγκαίρως μια επαναλαμβανόμενη συνταγή σου, κερδίζεις ", "Every time you execute a recurring prescription on time, you earn ")}<b>{t(`${m.points_per_refill} πόντους`, `${m.points_per_refill} points`)}</b>{t(". Όσο πιο συνεπής, τόσο πιο γρήγορα ανεβαίνεις επίπεδο & γεμίζει το πορτοφόλι σου!", ". The more consistent you are, the faster you level up & fill your wallet!")}</p>
                  </div>

                  {/* ιστορικό */}
                  {!!m.ledger?.length && (
                    <div>
                      <div className="mb-1 text-xs font-semibold text-slate-500 dark:text-slate-400">{t("Κινήσεις", "Activity")}</div>
                      {m.ledger.map((l, i) => (
                        <div key={i} className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 bg-white px-3 py-2 text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{l.type === "redeem" ? t(`🛍️ Εξαργύρωση${l.kind === "parapharma" ? " (παραφάρμακα)" : l.kind === "service" ? " (υπηρεσία)" : ""}`, `🛍️ Redemption${l.kind === "parapharma" ? " (parapharmaceuticals)" : l.kind === "service" ? " (service)" : ""}`) : t("🎁 Πίστωση", "🎁 Credit")}<span className="ml-2 text-xs text-slate-400">{dt(l.at)}</span></span>
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
            <form onSubmit={submitBarcode} className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm">
              <h3 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{t("1) Με barcode συνταγής", "1) By prescription barcode")}</h3>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t("Πληκτρολόγησε ή σκάναρε το barcode της συνταγής για να την αναθέσεις στο φαρμακείο.", "Type or scan the prescription barcode to assign it to the pharmacy.")}</p>
              <input value={assignBc} onChange={(e) => setAssignBc(e.target.value)} placeholder={t("π.χ. 2602120442459", "e.g. 2602120442459")}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              <button type="submit" disabled={assignBusy || assignBc.trim().length < 4}
                className="mt-3 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{t("Αποστολή barcode", "Send barcode")}</button>
            </form>

            {/* 2) φωτογραφία συνταγής ιατρού */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm">
              <h3 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{t("2) Φωτογραφία συνταγής ιατρού", "2) Photo of the doctor's prescription")}</h3>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t("Φωτογράφισε τη χάρτινη συνταγή του γιατρού και στείλε την στο φαρμακείο.", "Take a photo of the paper prescription and send it to the pharmacy.")}</p>
              <div className={`grid grid-cols-2 gap-2 ${assignBusy ? "pointer-events-none opacity-60" : ""}`}>
                {/* Άνοιξε ΚΑΜΕΡΑ κατευθείαν (capture) */}
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
                  <Camera className="h-[18px] w-[18px]" /> {t("Άνοιξε κάμερα", "Open camera")}
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) submitPhoto(f); }} />
                </label>
                {/* Επίλεξε αρχείο/φωτογραφία (χωρίς capture → gallery/αρχεία) */}
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800 px-3 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                  <Upload className="h-[18px] w-[18px]" /> {t("Επίλεξε αρχείο", "Choose file")}
                  <input type="file" accept="image/*,application/pdf" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) submitPhoto(f); }} />
                </label>
              </div>
              {assignBusy && <div className="mt-2 flex items-center gap-2 text-xs text-slate-400"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Αποστολή…", "Sending…")}</div>}
            </div>

            {/* σημείωση + 3η μελλοντική επιλογή */}
            <textarea value={assignNote} onChange={(e) => setAssignNote(e.target.value)} rows={2} placeholder={t("Σημείωση προς το φαρμακείο (προαιρετικό)", "Note to the pharmacy (optional)")}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
              {t("3) Σύνδεση στην εθνική πύλη συνταγών (άυλες) — ", "3) Connect to the national prescription portal (intangible) — ")}<b>{t("σύντομα", "coming soon")}</b>{t(": θα μπορείς να αντλείς τις άυλες συνταγές σου και να τις αναθέτεις απευθείας.", ": you'll be able to pull your intangible prescriptions and assign them directly.")}
            </div>

            {/* οι αναθέσεις μου */}
            {rxReqs.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">{t("Οι αναθέσεις μου", "My assignments")}</div>
                {rxReqs.map((r) => (
                  <div key={r._id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">{r.kind === "barcode" ? <>📋 Barcode <span className="break-all font-mono text-xs">{r.barcode}</span></> : <>📷 {t("Φωτογραφία συνταγής", "Prescription photo")}</>}<span className="ml-2 text-xs text-slate-400">{dt(r.created_at)}</span></span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusCls(r.status)}`}>{t(STATUS_LABEL[r.status] ?? r.status, STATUS_LABEL_EN[r.status] ?? r.status)}</span>
                    </div>
                    {r.cda?.found && (
                      <div className="mt-1.5 rounded-lg bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800">
                        <div className="font-semibold">{t("✓ Επιβεβαιώθηκε από ΗΔΙΚΑ", "✓ Verified via ΗΔΙΚΑ")}</div>
                        {!!r.cda.medicines?.length && <div className="mt-0.5 text-emerald-700">💊 {r.cda.medicines.join(" · ")}</div>}
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-emerald-600">
                          {r.cda.doctor && <span>👤 {r.cda.doctor}</span>}
                          {r.cda.issue_date && <span>📅 {dt(r.cda.issue_date)}</span>}
                          {r.cda.intangible && <span>📲 {t("Άυλη", "Intangible")}</span>}
                        </div>
                      </div>
                    )}
                    {r.cda && r.cda.available && !r.cda.found && (
                      <div className="mt-1.5 text-xs text-amber-600">{t("Δεν εντοπίστηκε στην ΗΔΙΚΑ — θα το ελέγξει το φαρμακείο.", "Not found in ΗΔΙΚΑ — the pharmacy will check it.")}</div>
                    )}
                    {r.reply && (
                      <div className="mt-1.5 rounded-lg bg-sky-50 px-2 py-1.5 text-xs text-sky-800">
                        <span className="font-semibold">{t("💬 Φαρμακείο:", "💬 Pharmacy:")}</span> {r.reply}
                        {r.available_date && <span className="ml-1 font-semibold">{t("· διαθέσιμο", "· available")} {dt(r.available_date)}</span>}
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
            <form onSubmit={askAvailability} className="space-y-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100"><Search className="h-4 w-4 text-brand-500" /> {t("Ρώτα για διαθεσιμότητα", "Ask about availability")}</div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Φαρμακείο", "Pharmacy")}</div>
                <PharmacyPicker linked={me.pharmacies} value={availTarget} onChange={setAvailTarget} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Φάρμακο (λίστα / barcode / σάρωση)", "Medicine (list / barcode / scan)")}</div>
                <MedicinePicker value={availMed} onChange={setAvailMed} />
              </div>
              <input value={availNote} onChange={(e) => setAvailNote(e.target.value)} placeholder={t("Σχόλιο (προαιρετικό)", "Comment (optional)")}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
              <button className="w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700">{t("Αποστολή ερώτησης", "Send question")}</button>
            </form>
            {avail.length === 0 && <Empty icon={Search} text={t("Δεν έχεις στείλει ερωτήσεις διαθεσιμότητας.", "You haven't sent any availability questions.")} />}
            {(() => {
              const row = (a: Avail, i: number) => (
                <div key={a._id ?? i} className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600"><Pill className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{a.medicine_name || a.query}</div>
                    {a.answer ? <div className="mt-0.5 text-sm text-emerald-700">{a.answer}</div> : <div className="mt-0.5 text-xs text-amber-600">{t("Σε αναμονή απάντησης…", "Awaiting a reply…")}</div>}
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusCls(a.answer ? "answered" : a.status)}`}>{a.answer ? t("Απαντήθηκε", "Answered") : t(STATUS_LABEL[a.status] ?? a.status, STATUS_LABEL_EN[a.status] ?? a.status)}</span>
                </div>
              );
              return (
                <>
                  {avail.slice(0, 2).map(row)}
                  {avail.length > 2 && (
                    <details className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
                      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-600 dark:text-slate-300">
                        {t("Ιστορικό", "History")} ({avail.length - 2})
                      </summary>
                      <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 p-3">
                        {avail.slice(2).map(row)}
                      </div>
                    </details>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ── APPOINTMENTS ───────────────────────────────────── */}
        {tab === "appointments" && (
          <div className="space-y-4">
            <form onSubmit={bookAppt} className="space-y-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100"><CalendarPlus className="h-4 w-4 text-brand-500" /> {t("Κλείσε ραντεβού", "Book an appointment")}</div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Φαρμακείο", "Pharmacy")}</div>
                <PharmacyPicker linked={me.pharmacies} value={apptTarget} onChange={setApptTarget} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Υπηρεσία", "Service")}</div>
                <select required value={appt.service_name} onChange={(e) => setAppt({ ...appt, service_name: e.target.value })}
                  className="w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100">
                  <option value="">{t("— Επίλεξε υπηρεσία —", "— Choose a service —")}</option>
                  {services.map((s, i) => <option key={s._id ?? i} value={s.name}>{s.name}</option>)}
                  <option value="Εμβολιασμός">{t("Εμβολιασμός", "Vaccination")}</option>
                </select>
                {(() => {
                  const sel = services.find((s) => s.name === appt.service_name);
                  if (!sel) return null;
                  const av = sel.availability;
                  const parts = av && av.mode === "custom" ? [
                    ...(av.slots ?? []).map((s) => `${t(PDAYS[s.day], DOW_EN[s.day])} ${s.start}–${s.end}`),
                    ...(av.date_ranges ?? []).map((r) => `📅 ${prange(r)}`),
                  ] : [];
                  const txt = parts.length ? t("Διαθέσιμο: ", "Available: ") + parts.join(" · ") : t("Διαθέσιμο όλο το ωράριο του φαρμακείου", "Available during the pharmacy's full hours");
                  return <div className="mt-1 text-[11px] font-medium text-brand-600">🕒 {txt}</div>;
                })()}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Ημερομηνία", "Date")}</div>
                  <DateInput required value={appt.date} min={new Date().toISOString().slice(0, 10)} onChange={(v) => setAppt({ ...appt, date: v })} className="w-full" />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Ώρα", "Time")}</div>
                  <input type="time" required value={appt.time}
                    onChange={(e) => setAppt({ ...appt, time: e.target.value })}
                    className="w-full min-w-0 appearance-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
                </div>
              </div>
              <button className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700">{t("Κλείσε ραντεβού", "Book appointment")}</button>
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
                  <div key={a._id ?? i} className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-3.5 shadow-sm">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600"><Calendar className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{a.service_name}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{dtl(a.requested_at)}</div>
                      {phName && <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-brand-600"><Building2 className="h-3 w-3" /> {phName}</div>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusCls(a.status)}`}>{t(STATUS_LABEL[a.status] ?? a.status, STATUS_LABEL_EN[a.status] ?? a.status)}</span>
                  </div>
                );
              };
              if (appts.length === 0) return <Empty icon={Calendar} text={t("Δεν έχεις ραντεβού.", "You have no appointments.")} />;
              const list = apptView === "open" ? activeA : pastA;
              return (
                <div className="space-y-3">
                  {/* διαχωρισμός: ΑΝΟΙΧΤΑ vs ΚΛΕΙΣΤΑ */}
                  <div className="flex gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
                    {([["open", t("Ανοιχτά", "Open"), activeA.length], ["closed", t("Κλειστά", "Closed"), pastA.length]] as const).map(([k, label, n]) => (
                      <button key={k} onClick={() => setApptView(k)}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-semibold transition ${apptView === k ? "bg-white text-violet-700 shadow-sm" : "text-slate-500 dark:text-slate-400"}`}>
                        {label}<span className={`grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[10px] font-bold ${apptView === k ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-500 dark:text-slate-400"}`}>{n}</span>
                      </button>
                    ))}
                  </div>
                  {list.length === 0
                    ? <p className="py-8 text-center text-sm text-slate-400">{apptView === "open" ? t("Κανένα ανοιχτό ραντεβού.", "No open appointments.") : t("Δεν υπάρχει ιστορικό ραντεβού.", "No appointment history.")}</p>
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
              {t("Διάλεξε φαρμακείο για να ", "Choose a pharmacy to ")}<b>{t("εξυπηρετηθείς", "get served")}</b>{t(" — ερωτήματα διαθεσιμότητας, αγορές, ανάθεση συνταγής. Το ιστορικό (συνταγές, παραγγελίες, ερωτήματα) είναι ", " — availability questions, purchases, prescription assignment. Your history (prescriptions, orders, questions) is ")}<b>{t("ξεχωριστό ανά φαρμακείο", "separate per pharmacy")}</b>.
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                <input value={dirQuery} onChange={(e) => setDirQuery(e.target.value)} placeholder={t("Αναζήτηση φαρμακείου ή περιοχής…", "Search pharmacy or area…")}
                  className="w-full rounded-2xl border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800 py-2.5 pl-11 pr-3 text-[15px] shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
              </div>
              <button onClick={requestGeo} disabled={geoBusy} title={t("Ταξινόμηση κατά απόσταση", "Sort by distance")}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-2xl border px-3 py-2.5 text-xs font-semibold shadow-sm ${geo ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800 text-slate-600 dark:text-slate-300"}`}>
                <Navigation className={`h-4 w-4 ${geoBusy ? "animate-pulse" : ""}`} /> {geo ? t("Κοντινά", "Nearby") : t("Βρες κοντινά", "Find nearby")}
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
              if (directory.length === 0) return <Empty icon={MapPin} text={t("Δεν βρέθηκαν φαρμακεία δικτύου.", "No network pharmacies found.")} />;
              if (list.length === 0) return <Empty icon={Search} text={t("Κανένα φαρμακείο για αυτή την αναζήτηση.", "No pharmacy for this search.")} />;
              return (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{list.map((d) => {
                const s = d.status;
                const crossBg = s?.isOnDuty ? "bg-indigo-500" : s?.isOpen ? (s.closingSoon ? "bg-amber-500" : "bg-emerald-500") : "bg-slate-300";
                const isActive = d.tenant_id === me.active_tenant;
                return (
                  <div key={d.tenant_id} className={`rounded-2xl border bg-white p-3.5 shadow-sm ${isActive ? "border-brand-300 ring-1 ring-brand-100" : d.favorite ? "border-amber-200" : "border-slate-200 dark:border-slate-800"}`}>
                    <div className="flex items-start gap-3">
                      {/* σύμβολο φαρμακείου (σταυρός) — χρώμα κατά κατάσταση: πράσινο ανοιχτό, μπλε εφημερία, γκρι κλειστό */}
                      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${crossBg} shadow-sm`}><Plus className="h-6 w-6 text-white" strokeWidth={3} /></span>
                      <div className="min-w-0 flex-1 cursor-pointer" role="button" onClick={() => { if (!isActive) switchPharmacy(d.tenant_id); }}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-slate-800 dark:text-slate-100">{d.name}</span>
                          {d.favorite && <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"><Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" /> {t("Αγαπημένο", "Favorite")}</span>}
                          {d.mine && <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-600">{t("Δικό μου", "Mine")}</span>}
                          {isActive && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">{t("Ενεργό", "Active")}</span>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {(d.address || d.city) && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3 shrink-0 text-slate-400" />{[d.address, d.city].filter(Boolean).join(", ")}</span>}
                          {d.dist != null && <span className="inline-flex items-center gap-1 font-medium text-brand-600"><Navigation className="h-3 w-3" />{d.dist < 1 ? `${Math.round(d.dist * 1000)} ${t("μ", "m")}` : `${d.dist.toFixed(1)} ${t("χλμ", "km")}`}</span>}
                        </div>
                        {s && <div className={`mt-0.5 text-xs font-medium ${s.isOnDuty ? "text-indigo-600" : s.isOpen ? (s.closingSoon ? "text-amber-600" : "text-emerald-600") : "text-slate-400"}`}>{t(s.statusText, s.statusTextEn ?? s.statusText)}</div>}
                      </div>
                      <button onClick={() => setFavoritePharmacy(d.tenant_id)} title={d.favorite ? t("Αφαίρεση αγαπημένου", "Remove favorite") : t("Όρισε αγαπημένο", "Set as favorite")}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800">
                        <Star className={`h-[18px] w-[18px] ${d.favorite ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
                      </button>
                    </div>
                    {/* ενέργειες: επιλογή + γρήγορες δράσεις (σε αυτό το φαρμακείο) */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {isActive
                        ? <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> {t("Ενεργό φαρμακείο", "Active pharmacy")}</span>
                        : <button onClick={() => switchPharmacy(d.tenant_id)} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"><Building2 className="h-3.5 w-3.5" /> {t("Επίλεξε", "Select")}</button>}
                      <button onClick={() => switchPharmacy(d.tenant_id, "availability")} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"><Search className="h-3.5 w-3.5" /> {t("Διαθεσιμότητα", "Availability")}</button>
                      <button onClick={() => switchPharmacy(d.tenant_id, "shop")} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"><ShoppingBag className="h-3.5 w-3.5" /> {t("Κατάστημα", "Store")}</button>
                      <button onClick={() => switchPharmacy(d.tenant_id, "assign")} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"><FilePlus className="h-3.5 w-3.5" /> {t("Ανάθεση", "Assign")}</button>
                      {d.phone && <a href={`tel:${d.phone}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">📞 {d.phone}</a>}
                    </div>
                  </div>
                );
              })}</div>
              );
            })()}
          </div>
        )}

        <p className="mt-8 text-center text-[11px] text-slate-300">{t("RxVision · Πύλη Πελατών", "RxVision · Customer Portal")}</p>
        </main>
      </div>
      </div>

      {/* ── κάτω μπάρα πλοήγησης (ΜΟΝΟ κινητό) — flex-item ΕΞΩ από το scroll → μένει μόνιμα κάτω.
          ΚΥΛΙΟΜΕΝΗ λωρίδα ενοτήτων· σέρνεις αριστερά/δεξιά· η ενεργή έρχεται στο κέντρο. */}
      <nav className="shrink-0 z-30 flex gap-1 overflow-x-auto border-t border-slate-200 dark:border-slate-800 bg-white/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-md [-ms-overflow-style:none] [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden dark:border-slate-800 dark:bg-slate-900/95">
        {visibleTabs.map(([k, label, labelEn]) => {
          const I = TAB_ICON[k] || FileText; const on = tab === k;
          return (
            <button key={k} onClick={() => setTab(k)} ref={on ? (el) => el?.scrollIntoView({ inline: "center", block: "nearest" }) : undefined}
              className={`flex min-w-[4.4rem] shrink-0 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition ${on ? "text-brand-600" : "text-slate-400"}`}>
              <I className={`h-[22px] w-[22px] ${on ? "" : "stroke-[1.75]"}`} />
              <span className="whitespace-nowrap">{NAV_SHORT[k] ? t(NAV_SHORT[k][0], NAV_SHORT[k][1]) : t(label, labelEn)}</span>
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

function Kpi({ icon: Icon, label, value, sub, tint, highlight, onClick }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub: string; tint: string; highlight?: boolean;
  onClick?: () => void;   // αν δοθεί → η κάρτα γίνεται παραπομπή (clickable) στη σχετική καρτέλα
}) {
  const cls = `group relative overflow-hidden rounded-2xl border p-3 text-left shadow-sm transition hover:shadow-md sm:p-4 ${highlight ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white" : "border-slate-200 dark:border-slate-800 bg-white"} ${onClick ? "cursor-pointer hover:-translate-y-0.5 hover:border-brand-300" : ""}`;
  const inner = (
    <>
      <span className={`grid h-8 w-8 place-items-center rounded-xl sm:h-9 sm:w-9 ${TINTS[tint]}`}><Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" /></span>
      {onClick && <ChevronRight className="absolute right-2.5 top-2.5 h-4 w-4 text-slate-300 opacity-0 transition group-hover:translate-x-0.5 group-hover:text-brand-500 group-hover:opacity-100" />}
      <div className="mt-2 truncate text-lg font-extrabold tracking-tight text-slate-900 dark:text-slate-100 sm:mt-3 sm:text-2xl">{value}</div>
      <div className="truncate text-xs font-semibold text-slate-600 dark:text-slate-300 sm:text-[13px]">{label}</div>
      <div className="mt-0.5 truncate text-[11px] text-slate-400">{sub}</div>
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className={`${cls} w-full`}>{inner}</button>
    : <div className={cls}>{inner}</div>;
}

// Πάνελ «κονσόλας» Αρχικής (desktop) — κάρτα με τίτλο, εικονίδιο & προαιρετικό «Όλα →».
function HomePanel({ icon: Icon, title, tint, action, children }: {
  icon: React.ComponentType<{ className?: string }>; title: string; tint: string;
  action?: () => void; children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${TINTS[tint]}`}><Icon className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-slate-800 dark:text-slate-100">{title}</span>
        {action && (
          <button onClick={action} className="shrink-0 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-brand-600 hover:bg-brand-50">{t("Όλα →", "All →")}</button>
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
    <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 bg-white py-12 text-center">
      <Icon className="mx-auto h-8 w-8 text-slate-300" />
      <p className="mt-2 text-sm text-slate-400">{text}</p>
    </div>
  );
}
