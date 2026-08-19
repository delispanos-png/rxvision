"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ScanBarcode, CheckCircle2, XCircle, RotateCcw, ChevronLeft, ChevronRight,
  X, FileText, Syringe, Pill, ShieldAlert, Ticket, PartyPopper, CalendarDays, ArrowRight, AlertTriangle, Filter, Printer, ClipboardList, Copy,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { fmtEur, fmtNum, scanRxBarcode } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { appConfirm, appAlert } from "@/store/dialogStore";
import { toastSuccess } from "@/store/toastStore";
import { ClosingReportModal } from "@/components/reimbursement/ClosingReportModal";

type Item = { barcode: string; external_id: string; exec_no: string | null; claim: number; retail?: number; patient?: number; fund: string; group: string; is_eopyy: boolean; is_vaccine: boolean; is_100: boolean; is_fyk: boolean; is_etyap: boolean; needs_original: boolean; needs_dose_check: boolean; needs_check: boolean; executed_at: string; checked: boolean; visual_checked: boolean; day: string };
type DayRow = { date: string; total: number; checked: number };
type Summary = { total: number; needs_check: number; clean: number; dose: number; fyk: number; narcotic: number; needs_original: number; opinion: number; desensitization: number; strips: number; hdika_note: number; vaccine: number };
type Check = { period: string; group: string; groups: string[]; total: number; checked: number; remaining: number; extra: string[]; summary?: Summary; by_day: DayRow[]; items: Item[] };
type Coupon = { name: string; barcode: string; quantity: number; category: string; executed: boolean; qr: boolean | null; qr_batch: string | null; qr_expiry: string | null; lot: string | null };
type Detail = { ok: boolean; found: boolean; barcode: string; exec_no?: number | null; fund: string; is_eopyy?: boolean; claim: number; n_coupons: number; has_opinion: boolean | null; is_fyk: boolean; has_vaccine: boolean; has_narcotic: boolean; is_etyap?: boolean; needs_original?: boolean; partial: boolean; coupons: Coupon[] };
type RxCheck = { type: string; level: string; title: string; detail: string; category?: "closing" | "advisory" | "info" };
type ClosingChecksRes = { items: { name: string; barcode: string | null; checks: RxCheck[] }[]; count: number; warnings: number };

// Σπάει τα per-line checks σε 🔴 «Για την κατάθεση» (category=closing → κίνδυνος περικοπής/ενέργεια) και
// 💡 «Συμβουλευτικά ΗΔΥΚΑ» (advisory → κλινικό/ενημερωτικό, collapsed). Ξεκαθαρίζει πού να εστιάσει ο ελεγκτής.
function CategorizedChecks({ res, t }: { res: ClosingChecksRes | null; t: (el: string, en: string) => string }) {
  if (!res || res.count === 0) return null;
  const flat = res.items.flatMap((it) => it.checks.map((c) => ({ ...c, drug: it.name })));
  const closing = flat.filter((c) => c.category === "closing");
  const info = flat.filter((c) => c.category === "info");   // ενημερωτικά (π.χ. 100% → δεν υποβάλλεται) — ΟΧΙ κίνδυνος
  const advisory = flat.filter((c) => c.category !== "closing" && c.category !== "info");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 text-[10px] font-bold">
        {closing.length > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">🔴 {closing.length} {t("για κατάθεση", "for submission")}</span>}
        {info.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">ℹ️ {info.length} {t("ενημερωτικό", "info")}</span>}
        {advisory.length > 0 && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">💡 {advisory.length} {t("συμβουλευτικά", "advisory")}</span>}
      </div>
      {info.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-2.5 dark:border-amber-900/50 dark:bg-amber-950/20">
          <div className="space-y-1">
            {info.map((c, i) => (
              <div key={i} className="text-[11px] text-amber-900 dark:text-amber-200"><b>{c.title}.</b> {c.detail}</div>
            ))}
          </div>
        </div>
      )}
      {closing.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-2.5 dark:border-rose-900/50 dark:bg-rose-950/20">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase text-rose-700 dark:text-rose-300"><ShieldAlert className="h-3.5 w-3.5" /> {t("Για την κατάθεση — κίνδυνος περικοπής", "For submission — cut risk")}</div>
          <div className="space-y-1">
            {closing.map((c, i) => (
              <div key={i} className="rounded-md bg-white/70 px-2 py-1 text-[11px] text-slate-700 dark:bg-slate-900/50 dark:text-slate-200"><span className="text-slate-400">{c.drug} · </span><b>{c.title}.</b> {c.detail}</div>
            ))}
          </div>
        </div>
      )}
      {advisory.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-800/40">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold uppercase text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">💡 {t("Συμβουλευτικά ΗΔΥΚΑ", "ΗΔΥΚΑ advisory")} ({advisory.length}) <span className="ml-auto text-slate-400">▾</span></summary>
          <div className="space-y-1 px-2.5 pb-2.5">
            {advisory.map((c, i) => (
              <div key={i} className="rounded-md bg-white px-2 py-1 text-[11px] text-slate-500 dark:bg-slate-900/60 dark:text-slate-400"><span className="text-slate-400">{c.drug} · </span><b>{c.title}.</b> {c.detail}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
type ScanFlags = { is_intangible: boolean; is_full_participation?: boolean; needs_original: boolean; is_fyk: boolean; has_desensitization: boolean; has_opinion: boolean; has_vaccine: boolean; is_etyap: boolean; exec_count: number | null; is_eopyy?: boolean; fund?: string; fund_name?: string };
type ScanRes = { ok: boolean; found: boolean; barcode: string; external_id?: string; exec_no?: string; n_executions?: number; wrong_day?: boolean; actual_days?: string[]; invalid_length?: boolean; digits?: number; other_tenant?: boolean; flags?: ScanFlags };
const grDate = (d: string) => d.split("-").reverse().join("/");

function fmtDay(d: string) { try { return new Date(d + "T00:00:00").toLocaleDateString("el-GR", { weekday: "long", day: "numeric", month: "long" }); } catch { return d; } }
function fmtDayShort(d: string) { try { return new Date(d + "T00:00:00").toLocaleDateString("el-GR", { weekday: "short", day: "numeric", month: "short" }); } catch { return d; } }

export default function PhysicalCheckPage() {
  const t = useT();
  const qc = useQueryClient();
  const { period } = useReimbPeriod();
  const inputRef = useRef<HTMLInputElement>(null);
  const [bc, setBc] = useState("");
  const [dayIdx, setDayIdx] = useState(0);
  const [last, setLast] = useState<{ found: boolean; barcode: string; flags?: ScanFlags; exec_no?: string; n_executions?: number } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [checks, setChecks] = useState<ClosingChecksRes | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const briefedPeriod = useRef<string | null>(null);
  // τρόπος κλεισίματος: ορίζεται από τις Ρυθμίσεις → Κλείσιμο Μήνα (tenant setting), όχι από την οθόνη
  // παραμετρικό: αυτόματο pop-up κουπονιών στο σκανάρισμα (επιλογή φαρμακοποιού, αποθηκεύεται τοπικά)
  const [couponsPopup, setCouponsPopup] = useState(false);
  useEffect(() => { setCouponsPopup(typeof window !== "undefined" && localStorage.getItem("rxv_coupons_on_scan") === "1"); }, []);
  function toggleCouponsPopup() {
    setCouponsPopup((v) => { const nv = !v; localStorage.setItem("rxv_coupons_on_scan", nv ? "1" : "0"); return nv; });
  }
  // παραμετρικό: εμφάνιση ΜΟΝΟ όσων χρειάζονται έλεγχο (ταινία/ιδιαιτερότητα) — όσες είναι όλο QR
  // χωρίς ιδιαιτερότητα κρύβονται (αυτόματα εντάξει).
  const [onlyChecks, setOnlyChecks] = useState(false);
  useEffect(() => { setOnlyChecks(typeof window !== "undefined" && localStorage.getItem("rxv_only_checks") === "1"); }, []);
  function toggleOnlyChecks() {
    setOnlyChecks((v) => { const nv = !v; localStorage.setItem("rxv_only_checks", nv ? "1" : "0"); return nv; });
  }
  const resumed = useRef(false);
  const [group, setGroup] = useState("all");
  const groupLabel = (g: string) => g === "all" ? t("Όλες μαζί", "All together") : g;

  const { data } = useQuery({ queryKey: ["reimb-physical", period, group], queryFn: () => api<Check>(`/reimbursement/physical?period=${period}&group=${encodeURIComponent(group)}`) });
  const { data: prefs } = useQuery({ queryKey: ["reimb-settings"], queryFn: () => api<{ closing_mode: string; list_open: boolean }>("/reimbursement/settings") });
  const mode: "classic" | "guided" | "express" | "cockpit" = prefs?.closing_mode === "guided" ? "guided" : prefs?.closing_mode === "express" ? "express" : prefs?.closing_mode === "cockpit" ? "cockpit" : "classic";
  const [listOpenLocal, setListOpenLocal] = useState<boolean | null>(null);   // session override του default από ρυθμίσεις
  const listOpen = listOpenLocal ?? (prefs?.list_open ?? false);
  const byDay = data?.by_day ?? [];
  // ενημερωτικό παράθυρο μήνα — εμφανίζεται μία φορά ανά μήνα όταν φορτώσει η περίληψη
  useEffect(() => {   // briefing pop-up μόνο στον κλασικό· στον καθοδηγούμενο το Στάδιο 1 είναι καθαρό μέτρημα
    if (mode === "classic" && data?.summary && briefedPeriod.current !== period) { briefedPeriod.current = period; setShowBriefing(true); }
  }, [data?.summary, period, mode]);
  // Ποιοτικό στάδιο (guided): worklist όσων χρειάζονται έλεγχο & δεν έχουν ελεγχθεί οπτικά
  const vAll = (data?.items ?? []).filter((i) => i.needs_check);
  const vRemaining = vAll.filter((i) => !i.visual_checked)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : b.claim - a.claim));
  const vCurrent = vRemaining[0];
  const vDoneCount = vAll.length - vRemaining.length;
  const { data: wizChecks } = useQuery({
    queryKey: ["wiz-checks", period, vCurrent?.external_id],
    queryFn: () => vCurrent ? api<ClosingChecksRes>(`/prescriptions/checks/${encodeURIComponent(vCurrent.external_id)}`) : Promise.resolve(null),
    enabled: mode === "guided" && !!vCurrent,
  });
  const { data: wizCoupons } = useQuery({
    queryKey: ["wiz-coupons", period, vCurrent?.external_id],
    queryFn: () => vCurrent ? api<Detail>(`/reimbursement/prescription?barcode=${encodeURIComponent(vCurrent.external_id)}`) : Promise.resolve(null),
    enabled: mode === "guided" && !!vCurrent,
  });

  // resume at the first not-yet-complete day, once
  useEffect(() => {
    if (data && !resumed.current && byDay.length) {
      resumed.current = true;
      const i = byDay.findIndex((d) => d.checked < d.total);
      setDayIdx(i < 0 ? byDay.length - 1 : i);
    }
  }, [data, byDay]);
  useEffect(() => { inputRef.current?.focus(); document.getElementById(`dayrow-${dayIdx}`)?.scrollIntoView({ block: "nearest" }); }, [dayIdx]);

  const scan = useMutation({
    mutationFn: ({ barcode, day }: { barcode: string; day?: string }) =>
      api<ScanRes>(`/reimbursement/physical/scan?period=${period}${day ? `&day=${encodeURIComponent(day)}` : ""}`, { method: "POST", body: JSON.stringify({ barcode }) }),
    onSuccess: (r) => {
      if (r.invalid_length) {   // κομμένο/λάθος σκανάρισμα (λιγότερα από 13 ψηφία) → ΔΕΝ το καταγράφουμε
        appAlert(
          t(`Άκυρο σκανάρισμα: ${r.digits ?? "<13"} ψηφία αντί για 13. Το barcode διαβάστηκε κομμένο (έπεσε ψηφίο) — ξανασκάναρε τη συνταγή ή πληκτρολόγησε το 13ψήφιο barcode.`,
            `Invalid scan: ${r.digits ?? "<13"} digits instead of 13. The barcode was read truncated — re-scan the prescription or type the 13-digit barcode.`),
          { title: t("⚠️ Κομμένο barcode", "⚠️ Truncated barcode") });
        return;
      }
      if (r.other_tenant) {  // ανήκει σε ΑΛΛΟ φαρμακείο (λάθος tenant) → ΔΕΝ μπαίνει στο «δεν υπάρχουν»
        appAlert(
          t(`Η συνταγή ${r.barcode} ΔΕΝ ανήκει σε αυτό το φαρμακείο (εκτελέστηκε σε άλλο). Έλεγξε ότι είσαι στο σωστό φαρμακείο.`,
            `Rx ${r.barcode} does NOT belong to this pharmacy (executed at another). Check you are on the correct pharmacy.`),
          { title: t("⚠️ Άλλο φαρμακείο", "⚠️ Different pharmacy") });
        return;
      }
      if (r.wrong_day) {     // βρέθηκε στον μήνα αλλά ΟΧΙ σε αυτή την ημέρα → ειδοποίηση, χωρίς μαρκάρισμα
        const days = (r.actual_days || []).map(grDate).join(", ");
        appAlert(
          t(`Η συνταγή ${r.barcode} ΔΕΝ εκτελέστηκε αυτή την ημέρα. Εκτελέστηκε: ${days}. Πήγαινε στη σωστή ημέρα για να την ελέγξεις.`,
            `Rx ${r.barcode} was NOT executed on this day. Executed on: ${days}. Go to the correct day to check it.`),
          { title: t("⚠️ Λάθος ημέρα", "⚠️ Wrong day") });
        return;
      }
      setLast({ found: r.found, barcode: r.barcode, flags: r.flags, exec_no: r.exec_no, n_executions: r.n_executions });
      qc.invalidateQueries({ queryKey: ["reimb-physical", period] });
      if (r.found && (mode === "express" || mode === "cockpit" || (mode === "classic" && localStorage.getItem("rxv_coupons_on_scan") === "1"))) openDetail(r.external_id || r.barcode);
    },
  });
  const reset = useMutation({
    mutationFn: (day?: string) => api(`/reimbursement/physical/reset?period=${period}${day ? `&day=${encodeURIComponent(day)}` : ""}`, { method: "POST" }),
    onSuccess: (_d, day) => { setLast(null); if (!day) { resumed.current = false; setDayIdx(0); } qc.invalidateQueries({ queryKey: ["reimb-physical", period] }); },
  });
  const visualMut = useMutation({
    mutationFn: ({ external_id, undo }: { external_id: string; undo?: boolean }) =>
      api(`/reimbursement/physical/visual?period=${period}${undo ? "&undo=true" : ""}`, { method: "POST", body: JSON.stringify({ barcode: external_id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reimb-physical", period] }),
  });
  const removeExtra = useMutation({
    mutationFn: (barcode: string) =>
      api(`/reimbursement/physical/extra/remove?period=${period}`, { method: "POST", body: JSON.stringify({ barcode }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reimb-physical", period] }),
  });

  const cur = byDay[dayIdx];
  const _dayRaw = (data?.items ?? []).filter((i) => i.day === cur?.date);
  const _topClaim: Record<string, number> = {};   // κορυφαία αξία ανά barcode → ομαδοποίηση φάσεων μαζί
  _dayRaw.forEach((i) => { _topClaim[i.barcode] = Math.max(_topClaim[i.barcode] ?? 0, i.claim); });
  const dayItems = [..._dayRaw].sort((a, b) =>
    // ελεγμένες κάτω· ομάδες (ίδιο barcode) μαζί ανά κορυφαία αξία· μέσα στην ομάδα κατά εκτέλεση (1→2)
    (a.checked !== b.checked ? (a.checked ? 1 : -1) : 0)
    || (_topClaim[b.barcode] - _topClaim[a.barcode])
    || (a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0)
    || (parseInt(a.exec_no || "0") - parseInt(b.exec_no || "0")));
  // φίλτρο «μόνο όσες χρειάζονται έλεγχο»: κρύβει τις all-QR χωρίς ιδιαιτερότητα (για την ΠΡΟΟΔΟ/μετρητές)
  const shownItems = onlyChecks ? dayItems.filter((i) => i.needs_check) : dayItems;
  const shownChecked = shownItems.filter((i) => i.checked).length;
  // ΓΡΑΜΜΕΣ ΠΙΝΑΚΑ: όπως shownItems ΑΛΛΑ κρατά ΠΑΝΤΑ όσες έχουν ήδη ελεγχθεί (σκαναριστεί) — ώστε μια
  // καθαρή all-QR συνταγή που σκάναρε να ΕΜΦΑΝΙΖΕΤΑΙ μαρκαρισμένη ως ελεγμένη (αντί να «εξαφανίζεται»).
  const tableRows = onlyChecks ? dayItems.filter((i) => i.needs_check || i.checked) : dayItems;
  // ανάλυση ανά ημέρα (για το hover στο ημερολόγιο): σύνολο + ανά κατηγορία/ταμείο
  const dayStats: Record<string, { total: number; checked: number; groups: Record<string, number> }> = {};
  (data?.items ?? []).forEach((i) => { const s = (dayStats[i.day] ||= { total: 0, checked: 0, groups: {} }); s.total++; if (i.checked) s.checked++; s.groups[i.group] = (s.groups[i.group] || 0) + 1; });
  const dayDone = onlyChecks ? (shownChecked >= shownItems.length) : (!!cur && cur.checked >= cur.total);
  const monthDone = byDay.length > 0 && byDay.every((d) => d.checked >= d.total);
  const daysComplete = byDay.filter((d) => d.checked >= d.total).length;

  function submit() {
    const v = scanRxBarcode(bc);
    if (!v) return;
    scan.mutate({ barcode: v, day: cur?.date });
    setBc("");
    inputRef.current?.focus();
  }
  async function nextDay() {
    if (!dayDone && cur && cur.total - cur.checked > 0 &&
        !(await appConfirm(t(`Λείπουν ${cur.total - cur.checked} συνταγές από αυτή τη μέρα. Να προχωρήσεις; (θα μείνουν εκκρεμείς)`, `${cur.total - cur.checked} prescriptions missing from this day. Proceed anyway?`)))) return;
    setDayIdx((i) => Math.min(i + 1, byDay.length - 1));
  }
  async function openDetail(barcode: string) {
    setDetail({ found: false } as Detail);
    setChecks(null);
    try { const d = await api<Detail>(`/reimbursement/prescription?barcode=${encodeURIComponent(barcode)}`); setDetail(d.found ? d : null); }
    catch { setDetail(null); }
    try { const c = await api<ClosingChecksRes>(`/prescriptions/checks/${encodeURIComponent(barcode)}`); setChecks(c.count > 0 ? c : null); }
    catch { /* checks optional */ }
  }
  const briefRows = (s: Summary): [string, number, boolean][] => [
    [t("💊 Έλεγχος δοσολογίας", "💊 Dosage check"), s.dose, true],
    [t("🔴 Ναρκωτικά", "🔴 Narcotics"), s.narcotic, true],
    [t("ΦΥΚ (Ν.3816)", "High-cost (L.3816)"), s.fyk, true],
    [t("📋 Με γνωμάτευση", "📋 With medical opinion"), s.opinion, true],
    [t("📄 Χρειάζονται πρωτότυπη χάρτινη", "📄 Need original paper Rx"), s.needs_original, true],
    [t("🧪 Απευαισθητοποίηση", "🧪 Desensitization"), s.desensitization, true],
    [t("⚠️ Ταινίες γνησιότητας (μη-QR)", "⚠️ Authenticity strips (non-QR)"), s.strips, true],
    [t("ℹ️ Σημείωση/περιορισμός ΗΔΥΚΑ", "ℹ️ ΗΔΥΚΑ note/restriction"), s.hdika_note, true],
    [t("💉 Εμβόλια", "💉 Vaccines"), s.vaccine, false],
  ];
  function printBriefing() {
    const s = data?.summary; if (!s) return;
    const rows = briefRows(s).map(([l, v]) => `<tr><td>${l}</td><td style="text-align:right"><b>${v}</b></td></tr>`).join("");
    const w = window.open("", "_blank", "width=620,height=760"); if (!w) return;
    w.document.write(`<html><head><title>${t("Έλεγχος συνταγών", "Prescription check")} ${period}</title></head><body style="font-family:system-ui,sans-serif;padding:24px">
      <h2>${t("Έλεγχος συνταγών — Τι θα συναντήσεις", "Prescription check — what to expect")} · ${period}</h2>
      <p>${t("Σύνολο εκτελέσεων", "Total executions")}: <b>${s.total}</b> · ${t("χρειάζονται έλεγχο", "need a check")}: <b>${s.needs_check}</b> · ${t("καθαρές (all-QR)", "clean (all-QR)")}: <b>${s.clean}</b></p>
      <table cellpadding="8" style="border-collapse:collapse;min-width:420px">${briefRows(s).map(([l, v]) => `<tr style="border-bottom:1px solid #ddd"><td>${l}</td><td style="text-align:right"><b>${v}</b></td></tr>`).join("")}</table>
      ${rows ? "" : ""}</body></html>`);
    w.document.close(); w.focus(); setTimeout(() => { w.print(); w.close(); }, 250);
    setShowBriefing(false);
  }

  const cols: Column<Item>[] = [
    { key: "checked", header: "", render: (r) => r.checked ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300" /> },
    { key: "barcode", header: "Barcode", render: (r) => (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(r.barcode); toastSuccess(t("Barcode αντιγράφηκε", "Barcode copied")); }}
          title={t("Αντιγραφή barcode", "Copy barcode")}
          className="grid h-6 w-6 shrink-0 place-items-center rounded border border-slate-200 text-slate-400 transition hover:border-emerald-400 hover:text-emerald-600 dark:border-slate-700 dark:hover:border-emerald-600">
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => openDetail(r.external_id)} className={`font-mono text-xs hover:text-emerald-600 hover:underline ${r.checked ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-200"}`}>{r.barcode}</button>
        {r.exec_no && <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">{t(`Εκτέλεση ${r.exec_no}`, `Execution ${r.exec_no}`)}</span>}
      </span>
    ) },
    { key: "group", header: t("Ταμείο", "Fund"), render: (r) => {
      const badge = r.is_100 ? "bg-amber-100 text-amber-800" : r.is_vaccine ? "bg-sky-100 text-sky-700" : r.is_eopyy ? "bg-emerald-100 text-emerald-700" : "bg-violet-100 text-violet-700";
      const lbl = r.group === "ΕΟΠΥΥ - Φάρμακα" ? "ΕΟΠΥΥ Φάρμ." : r.group === "ΕΟΠΥΥ - Εμβόλια" ? "Εμβόλια" : r.group === "Αμιγώς 100%" ? "100%" : r.group;
      return (
        <span className="inline-flex flex-nowrap items-center gap-1 whitespace-nowrap">
          <span className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold ${badge}`} title={r.group}>{lbl}</span>
          {r.needs_original && <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800" title={t("Χρειάζεται πρωτότυπη χάρτινη συνταγή ιατρού", "Needs original paper Rx")}>📄</span>}
          {r.is_fyk && <span className="shrink-0 rounded bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-800">ΦΥΚ</span>}
          {r.is_etyap && <span className="shrink-0 rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-800" title="ΕΤΥΑΠ">🛡️</span>}
          {r.needs_dose_check && <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-700" title={t("Περιέχει σκεύασμα που χρειάζεται έλεγχο δοσολογίας", "Contains an item needing a dosage check")}>E</span>}
        </span>
      );
    } },
    { key: "claim", header: t("Απαίτηση", "Claim"), align: "right", sortValue: (r) => r.claim, render: (r) => fmtEur(r.claim) },
  ];

  // ── EXPRESS: όλα σε μία οθόνη — κέντρο σκάναρε, αριστερά κουπόνια, δεξιά τι να κάνεις ──
  if (mode === "express" && !monthDone) {
    const tot = data?.total ?? 0; const scn = data?.checked ?? 0; const rem = data?.remaining ?? (tot - scn);
    const todo: string[] = [];
    if (detail?.found) {
      if (detail.is_eopyy === false && detail.fund && detail.fund !== "—") todo.push(t(`🏛️ ΔΕΝ είναι ΕΟΠΥΥ — ${detail.fund}: ξεχωριστή κατάθεση στο ταμείο.`, `🏛️ NOT ΕΟΠΥΥ — ${detail.fund}: separate submission.`));
      if (detail.needs_original) todo.push(t("📄 Επισύναψε την ΠΡΩΤΟΤΥΠΗ χάρτινη συνταγή.", "📄 Attach the ORIGINAL paper Rx."));
      if (detail.has_opinion) todo.push(t("📋 Επισύναψε τη ΓΝΩΜΑΤΕΥΣΗ.", "📋 Attach the medical opinion."));
      if (detail.is_fyk) todo.push(t("💊 ΦΥΚ — αντίγραφο τιμολογίου.", "💊 High-cost — invoice copy."));
      if ((detail.coupons || []).some((c) => c.qr === false)) todo.push(t("⚠️ Κράτησε τις ΤΑΙΝΙΕΣ γνησιότητας.", "⚠️ Keep the authenticity strips."));
      if (detail.is_etyap) todo.push(t("🛡️ ΕΤΥΑΠ — συμπληρωματική υποβολή.", "🛡️ ΕΤΥΑΠ — supplementary submission."));
    }
    return (
      <div className="mx-auto max-w-7xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-violet-200 bg-violet-50/60 px-4 py-2.5 text-sm dark:border-violet-900/60 dark:bg-violet-950/20">
          <div><span className="font-semibold text-violet-700 dark:text-violet-300">{t("Express κλείσιμο", "Express closing")}</span> · <b>{fmtNum(tot)}</b> {t("σύνολο", "total")} · <b className="text-emerald-600">{fmtNum(scn)}</b> {t("σκαναρισμένες", "scanned")} · <b className="text-amber-600">{fmtNum(rem)}</b> {t("μένουν", "remaining")}</div>
          <span className="inline-flex items-center gap-1.5">
            {data?.summary && <button onClick={() => setShowBriefing(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-600"><ClipboardList className="h-3 w-3" /> {t("Σύνοψη", "Briefing")}</button>}
            <button onClick={async () => { if (cur && await appConfirm(t(`Μηδενισμός ημέρας ${grDate(cur.date)};`, `Reset day ${cur ? grDate(cur.date) : ""}?`))) reset.mutate(cur.date); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-3 w-3" /> {t("Ημέρα", "Day")}</button>
            <button onClick={async () => { if (await appConfirm(t("Μηδενισμός ΟΛΟΥ του μήνα;", "Reset WHOLE month?"), { danger: true })) reset.mutate(undefined); }} className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:text-rose-600">{t("Μήνας", "Month")}</button>
          </span>
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_1.25fr_1fr]">
          {/* ΑΡΙΣΤΕΡΑ: κουπόνια τελευταίου σκαναρίσματος */}
          <div className="order-2 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40 lg:order-1">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500"><Ticket className="h-3.5 w-3.5" /> {t("Κουπόνια", "Coupons")}{detail?.found ? ` · ${detail.n_coupons}` : ""}</div>
            {detail?.found && detail.coupons ? (
              <div className="space-y-1.5">
                {detail.coupons.map((c, i) => { const strip = c.qr === false; return (
                  <div key={i} className={`flex items-start gap-2 rounded-lg border p-2 text-xs ${c.qr === true ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20" : strip ? "border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30" : "border-slate-200 dark:border-slate-700"}`}>
                    {c.qr === true ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : strip ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <Pill className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                    <div className="min-w-0 flex-1"><div className="font-medium text-slate-700 dark:text-slate-200">{c.name} {c.quantity > 1 && <span className="text-slate-400">×{c.quantity}</span>}</div>
                      {c.qr === true && <div className="text-[11px] font-semibold text-emerald-600">✓ QR{c.qr_batch ? ` · ${c.qr_batch}` : ""}</div>}
                      {strip && <div className="text-[11px] font-bold text-amber-700">⚠ {t("Ταινία", "Strip")}{c.lot ? ` · ${c.lot}` : ""}</div>}
                      {!c.executed && <div className="text-[10px] text-rose-500">{t("ανεκτέλεστο", "unexecuted")}</div>}
                    </div>
                  </div>); })}
              </div>
            ) : <p className="py-8 text-center text-xs text-slate-400">{t("Σκάναρε μια συνταγή για να δεις τα κουπόνια εδώ.", "Scan a prescription to see its coupons here.")}</p>}
          </div>
          {/* ΚΕΝΤΡΟ: σκανάρισμα */}
          <div className="order-1 lg:order-2">
            {cur && (
              <div className={`rounded-2xl border-2 p-5 ${dayDone ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
                <div className="flex items-center justify-between">
                  <button onClick={() => setDayIdx((i) => Math.max(0, i - 1))} disabled={dayIdx === 0} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronLeft className="h-5 w-5" /></button>
                  <div className="text-center"><div className="text-[10px] uppercase text-slate-400">{t("Ημέρα", "Day")} {dayIdx + 1}/{byDay.length}</div><div className="text-base font-bold capitalize text-slate-900 dark:text-slate-100">{fmtDay(cur.date)}</div></div>
                  <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronRight className="h-5 w-5" /></button>
                </div>
                <div className="mt-3 flex items-center justify-center gap-2"><span className={`text-3xl font-extrabold ${dayDone ? "text-emerald-600" : "text-slate-900 dark:text-slate-100"}`}>{cur.checked}</span><span className="text-slate-400">/ {cur.total}</span></div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${cur.total ? (cur.checked / cur.total) * 100 : 0}%` }} /></div>
                {dayDone ? (
                  <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="mt-4 w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">✓ {t("Επόμενη ημέρα", "Next day")} →</button>
                ) : (
                  <div className="mt-4 flex gap-2">
                    <input ref={inputRef} autoFocus value={bc} onChange={(e) => setBc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder={t("Σκάναρε barcode…", "Scan barcode…")} inputMode="numeric" className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 dark:border-slate-600 dark:bg-slate-800" />
                    <button onClick={submit} className="rounded-lg bg-violet-600 px-5 text-sm font-semibold text-white hover:bg-violet-700">{t("Έλεγχος", "Check")}</button>
                  </div>
                )}
                {last && <div className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${last.found ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{last.found ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}<span className="font-mono">{last.barcode}</span></div>}
              </div>
            )}
          </div>
          {/* ΔΕΞΙΑ: τι να ελέγξεις / καταθέσεις */}
          <div className="order-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500">🔎 {t("Τι να ελέγξεις / καταθέσεις", "What to check / submit")}</div>
            {detail?.found ? (
              <div className="space-y-2">
                {todo.length > 0 && <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-2.5 dark:border-emerald-900/50 dark:bg-emerald-950/20"><div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase text-emerald-700 dark:text-emerald-400"><ClipboardList className="h-3.5 w-3.5" /> {t("Για το ταμείο", "For the fund")}</div><ul className="space-y-0.5 text-[11px] text-slate-700 dark:text-slate-200">{todo.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
                {checks && checks.count > 0 ? <CategorizedChecks res={checks} t={t} />
                  : (todo.length === 0 && <p className="text-[11px] text-emerald-600">✓ {t("Καθαρή — όλα QR, καμία ιδιαιτερότητα.", "Clean — all QR, nothing special.")}</p>)}
              </div>
            ) : <p className="py-8 text-center text-xs text-slate-400">{t("Σκάναρε μια συνταγή για να δεις τι πρέπει να κάνεις.", "Scan a prescription to see what to do.")}</p>}
          </div>
        </div>
        <p className="text-center text-xs text-slate-400">{t("Αλλαγή τρόπου: Ρυθμίσεις → Κλείσιμο Μήνα", "Change mode: Settings → Month Closing")}</p>
        {showBriefing && data?.summary && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setShowBriefing(false)}>
            <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 text-sm font-bold text-slate-900 dark:text-slate-100">{t("Σύνοψη μήνα", "Month briefing")} · {period}</div>
              <div className="space-y-1">{briefRows(data.summary).filter(([, v]) => v > 0).map(([label, v], i) => <div key={i} className="flex justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-sm dark:bg-slate-800/50"><span>{label}</span><b>{v}</b></div>)}</div>
              <button onClick={() => setShowBriefing(false)} className="mt-3 w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white">{t("Κλείσιμο", "Close")}</button>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (mode === "express" && monthDone) return (
    <div className="space-y-4 py-10 text-center">
      <PartyPopper className="mx-auto h-12 w-12 text-emerald-500" />
      <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Ο μήνας έκλεισε! 🎉", "Month closed! 🎉")}</h2>
      <button onClick={async () => { if (await appConfirm(t("Νέος έλεγχος μήνα;", "New month check?"), { danger: true })) reset.mutate(undefined); }} className="mx-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-4 w-4" /> {t("Νέος έλεγχος", "New check")}</button>
    </div>
  );

  // ── GUIDED: Στάδιο 2 — Ποιοτικός (οπτικός) έλεγχος, μία συνταγή τη φορά ──
  if (mode === "guided" && monthDone && vCurrent) return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-2xl border-2 border-violet-300 bg-violet-50/50 p-4 dark:border-violet-800 dark:bg-violet-950/20">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase text-violet-600">{t("Στάδιο 2 — Ποιοτικός έλεγχος", "Stage 2 — Visual check")} · {period}</div>
            <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Οπτικός έλεγχος — μία συνταγή τη φορά", "Visual review — one Rx at a time")}</div>
          </div>
          <div className="text-right"><span className="text-2xl font-extrabold text-violet-600">{vDoneCount}</span><span className="text-slate-400">/{vAll.length}</span></div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${vAll.length ? (vDoneCount / vAll.length) * 100 : 0}%` }} /></div>
      </div>
      <div className="rounded-2xl border-2 border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] uppercase text-slate-400">{vCurrent.day ? fmtDay(vCurrent.day) : ""}</div>
            <div className="font-mono text-base font-bold text-slate-900 dark:text-slate-100">{vCurrent.barcode}</div>
          </div>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{fmtEur(vCurrent.claim)}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {vCurrent.needs_dose_check && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-700">E {t("δοσολογία", "dosage")}</span>}
          {vCurrent.is_fyk && <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-800">ΦΥΚ</span>}
          {vCurrent.needs_original && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">📄 {t("πρωτότυπη", "original")}</span>}
        </div>
        {/* Τι πρέπει να κάνεις / επισυνάψεις στο ταμείο για να είναι σωστή η υποβολή */}
        {(() => {
          const todo: string[] = [];
          if (vCurrent.needs_original) todo.push(t("📄 Επισύναψε την ΠΡΩΤΟΤΥΠΗ χάρτινη συνταγή ιατρού.", "📄 Attach the ORIGINAL paper prescription."));
          if (wizCoupons?.has_opinion) todo.push(t("📋 Επισύναψε τη ΓΝΩΜΑΤΕΥΣΗ.", "📋 Attach the medical opinion."));
          if (vCurrent.is_fyk) todo.push(t("💊 ΦΥΚ (Ν.3816) — επισύναψε αντίγραφο τιμολογίου/δελτίου ΦΥΚ.", "💊 High-cost (L.3816) — attach the purchase invoice copy."));
          if ((wizCoupons?.coupons || []).some((c) => c.qr === false)) todo.push(t("⚠️ Έλεγξε & κράτησε τις ΤΑΙΝΙΕΣ γνησιότητας (μη-QR).", "⚠️ Verify & keep the authenticity strips (non-QR)."));
          if (vCurrent.is_etyap) todo.push(t("🛡️ ΕΤΥΑΠ — μπαίνει στη συμπληρωματική υποβολή.", "🛡️ ΕΤΥΑΠ — goes to the supplementary submission."));
          return todo.length ? (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-2.5 dark:border-emerald-900/50 dark:bg-emerald-950/20">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase text-emerald-700 dark:text-emerald-400"><ClipboardList className="h-3.5 w-3.5" /> {t("Για την υποβολή στο ταμείο", "For the fund submission")}</div>
              <ul className="space-y-0.5 text-[11px] text-slate-700 dark:text-slate-200">{todo.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          ) : null;
        })()}
        {wizChecks && wizChecks.count > 0 ? (
          <div className="mt-3"><CategorizedChecks res={wizChecks} t={t} /></div>
        ) : null}
        {/* κουπόνια αυτής της εκτέλεσης (inline) */}
        {wizCoupons?.coupons?.length ? (
          <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500"><Ticket className="h-3.5 w-3.5" /> {t("Κουπόνια", "Coupons")} ({wizCoupons.n_coupons})</div>
            <div className="space-y-1.5">
              {wizCoupons.coupons.map((c, i) => {
                const strip = c.qr === false;
                return (
                  <div key={i} className={`flex items-start gap-2 rounded-lg border p-2 text-xs ${c.qr === true ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20" : strip ? "border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30" : "border-slate-200 dark:border-slate-700"}`}>
                    {c.qr === true ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : strip ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <Pill className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-700 dark:text-slate-200">{c.name} {c.quantity > 1 && <span className="text-slate-400">×{c.quantity}</span>}</div>
                      {c.qr === true && <div className="text-[11px] font-semibold text-emerald-600">✓ QR{c.qr_batch ? ` · batch ${c.qr_batch}` : ""}{c.qr_expiry ? ` · ${t("λήξη", "exp")} ${c.qr_expiry}` : ""}</div>}
                      {strip && <div className="text-[11px] font-bold text-amber-700">⚠ {t("Ταινία γνησιότητας", "Authenticity strip")}{c.lot ? ` · ${c.lot}` : ""}</div>}
                      {!c.executed && <div className="text-[10px] text-rose-500">{t("ανεκτέλεστο", "unexecuted")}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <button onClick={() => visualMut.mutate({ external_id: vCurrent.external_id })} className="mt-4 w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700">✓ {t("Ελέγχθηκε — Επόμενη", "Checked — Next")}</button>
      </div>
      <p className="text-center text-xs text-slate-400">{t("Αλλαγή τρόπου από Ρυθμίσεις → Κλείσιμο Μήνα", "Change mode in Settings → Month Closing")}</p>
    </div>
  );
  if (mode === "guided" && monthDone && !vCurrent) return (
    <div className="space-y-4 py-10 text-center">
      <PartyPopper className="mx-auto h-12 w-12 text-emerald-500" />
      <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Ο μήνας έκλεισε σωστά! 🎉", "Month closed correctly! 🎉")}</h2>
      <p className="text-sm text-slate-500">{t(`Αριθμητικός + οπτικός έλεγχος ολοκληρώθηκαν (${vAll.length} οπτικοί).`, `Numeric + visual checks done (${vAll.length} visual).`)}</p>
      <button onClick={async () => { if (await appConfirm(t("Νέος έλεγχος μήνα;", "New month check?"), { danger: true })) reset.mutate(undefined); }} className="mx-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-4 w-4" /> {t("Νέος έλεγχος", "New check")}</button>
    </div>
  );

  // ── GUIDED: Στάδιο 1 — Αριθμητικός, με ΗΜΕΡΟΛΟΓΙΟ (λιτό, χωρίς popup) ──
  if (mode === "guided" && !monthDone) {
    const yy = Number(period.split("-")[0]); const mm = Number(period.split("-")[1]);
    const dim = new Date(yy, mm, 0).getDate();
    const lead = (new Date(yy, mm - 1, 1).getDay() + 6) % 7;   // Δευτέρα = 0
    const bmap: Record<string, DayRow> = {}; byDay.forEach((d) => { bmap[d.date] = d; });
    const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: dim }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`)];
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        {(() => {
          const tot = data?.total ?? 0; const scn = data?.checked ?? 0; const rem = data?.remaining ?? (tot - scn);
          const pct = tot ? Math.round((scn / tot) * 100) : 0;
          return (
            <div className="rounded-2xl border-2 border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4 shadow-sm dark:border-violet-900/60 dark:from-violet-950/30 dark:to-slate-900">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-600">{t("Καθοδηγούμενο κλείσιμο · Στάδιο 1/2 — Αριθμητικός", "Guided closing · Stage 1/2 — Numeric")}</div>
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <button onClick={async () => { if (cur && await appConfirm(t(`Μηδενισμός ημέρας ${grDate(cur.date)};`, `Reset day ${cur ? grDate(cur.date) : ""}?`))) reset.mutate(cur.date); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-3 w-3" /> {t("Ημέρα", "Day")}</button>
                  <button onClick={async () => { if (await appConfirm(t("Μηδενισμός ΟΛΟΥ του μήνα;", "Reset WHOLE month?"), { danger: true })) reset.mutate(undefined); }} className="rounded-lg px-2 py-1 text-slate-400 hover:text-rose-600">{t("Μήνας", "Month")}</button>
                </span>
              </div>
              <div className="mt-3 flex items-center gap-4">
                <div className="relative shrink-0">
                  <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
                    <circle cx="18" cy="18" r="15.915" fill="none" className="stroke-slate-200 dark:stroke-slate-700" strokeWidth="4" />
                    <circle cx="18" cy="18" r="15.915" fill="none" className="stroke-emerald-500" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${pct} 100`} />
                  </svg>
                  <div className="absolute inset-0 grid place-items-center"><span className="text-sm font-extrabold text-slate-800 dark:text-slate-100">{pct}%</span></div>
                </div>
                <div className="grid flex-1 grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-slate-100 px-2 py-1 dark:bg-slate-800"><div className="text-lg font-extrabold leading-tight text-slate-800 dark:text-slate-100">{fmtNum(tot)}</div><div className="text-[9px] text-slate-500">{t("σύνολο", "total")}</div></div>
                  <div className="rounded-lg bg-emerald-100 px-2 py-1 dark:bg-emerald-950/40"><div className="text-lg font-extrabold leading-tight text-emerald-700">{fmtNum(scn)}</div><div className="text-[9px] text-emerald-700">{t("σκαναρισμένες", "scanned")}</div></div>
                  <div className="rounded-lg bg-amber-100 px-2 py-1 dark:bg-amber-950/40"><div className="text-lg font-extrabold leading-tight text-amber-700">{fmtNum(rem)}</div><div className="text-[9px] text-amber-700">{t("μένουν", "remaining")}</div></div>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500"><span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> {t("Ημέρες", "Days")}</span><b className="text-slate-700 dark:text-slate-200">{daysComplete}/{byDay.length}</b></div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${byDay.length ? (daysComplete / byDay.length) * 100 : 0}%` }} /></div>
              {/* εξέλιξη ανά κατηγορία υποβολής */}
              {(() => {
                const grp: Record<string, { tot: number; chk: number }> = {};
                (data?.items ?? []).forEach((i) => { const g = (grp[i.group] ||= { tot: 0, chk: 0 }); g.tot++; if (i.checked) g.chk++; });
                const rows = Object.entries(grp).sort((a, b) => b[1].tot - a[1].tot);
                const lbl = (g: string) => g === "ΕΟΠΥΥ - Φάρμακα" ? t("ΕΟΠΥΥ Φάρμακα", "EOPYY Meds") : g === "ΕΟΠΥΥ - Εμβόλια" ? t("Εμβόλια", "Vaccines") : g === "Αμιγώς 100%" ? t("Αμιγώς 100%", "Full 100%") : g;
                const col = (g: string) => g.includes("Εμβόλ") ? "bg-sky-500" : g.includes("100%") ? "bg-amber-500" : g.includes("ΕΤΥΑΠ") ? "bg-cyan-500" : g.includes("ΕΟΠΥΥ") || g.includes("Φάρμακα") ? "bg-emerald-500" : "bg-violet-500";
                return rows.length > 1 ? (
                  <details className="mt-2 border-t border-violet-100 pt-2 dark:border-violet-900/40">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400 hover:text-slate-600">▾ {t("Εξέλιξη ανά κατηγορία", "Progress by category")}</summary>
                    <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                      {rows.map(([g, v]) => { const p = v.tot ? Math.round((v.chk / v.tot) * 100) : 0; return (
                        <div key={g}>
                          <div className="flex items-center justify-between text-[10px] leading-tight"><span className="truncate pr-1 font-medium text-slate-600 dark:text-slate-300">{lbl(g)}</span><span className="shrink-0 tabular-nums text-slate-400">{v.chk}/{v.tot}</span></div>
                          <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className={`h-full rounded-full ${col(g)} transition-all`} style={{ width: `${p}%` }} /></div>
                        </div>
                      ); })}
                    </div>
                  </details>
                ) : null;
              })()}
              {rem === 0 && tot > 0 && <p className="mt-2 text-center text-xs font-semibold text-emerald-600">🎉 {t("Όλες σκαναρίστηκαν! Συνέχισε στο Στάδιο 2.", "All scanned! Continue to Stage 2.")}</p>}
            </div>
          );
        })()}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-2 text-sm font-semibold capitalize text-slate-700 dark:text-slate-200">{new Date(yy, mm - 1, 1).toLocaleDateString("el-GR", { month: "long", year: "numeric" })}</div>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-slate-400">{["Δε", "Τρ", "Τε", "Πέ", "Πα", "Σά", "Κυ"].map((w) => <div key={w}>{w}</div>)}</div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {cells.map((date, i) => {
              if (!date) return <div key={i} />;
              const dnum = Number(date.slice(-2)); const d = bmap[date];
              if (!d) return <div key={i} className="grid place-items-center rounded-md py-1 text-[11px] text-slate-300 dark:text-slate-600">{dnum}</div>;
              const done = d.checked >= d.total; const idx = byDay.findIndex((x) => x.date === date); const isCur = idx === dayIdx;
              return (
                <button key={i} onClick={() => { setDayIdx(idx); setLast(null); }}
                  className={`flex flex-col items-center justify-center rounded-md py-1 leading-none transition-colors ${done ? "bg-emerald-500 text-white" : d.checked > 0 ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"} ${isCur ? "ring-2 ring-violet-500 dark:ring-offset-slate-900" : ""}`}>
                  <span className="text-xs font-bold">{dnum}</span>
                  <span className="mt-0.5 text-[8px] opacity-80">{done ? "✓" : `${d.checked}/${d.total}`}</span>
                </button>
              );
            })}
          </div>
        </div>
        {cur && (
          <div className={`rounded-2xl border-2 p-5 ${dayDone ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
            <div className="flex items-center justify-between">
              <button onClick={() => setDayIdx((i) => Math.max(0, i - 1))} disabled={dayIdx === 0} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronLeft className="h-5 w-5" /></button>
              <div className="text-lg font-bold capitalize text-slate-900 dark:text-slate-100">{fmtDay(cur.date)}</div>
              <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronRight className="h-5 w-5" /></button>
            </div>
            <div className="mt-3 flex items-center justify-center gap-2"><span className={`text-3xl font-extrabold ${dayDone ? "text-emerald-600" : "text-slate-900 dark:text-slate-100"}`}>{cur.checked}</span><span className="text-slate-400">/ {cur.total} {t("σκαναρισμένες", "scanned")}</span></div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${cur.total ? (cur.checked / cur.total) * 100 : 0}%` }} /></div>
            {dayDone ? (
              <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="mt-4 w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">✓ {t("Ολοκληρώθηκε — Επόμενη ημέρα", "Done — Next day")} →</button>
            ) : (
              <div className="mt-4 flex gap-2">
                <input ref={inputRef} autoFocus value={bc} onChange={(e) => setBc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder={t("Σκάναρε barcode…", "Scan barcode…")} inputMode="numeric" className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 dark:border-slate-600 dark:bg-slate-800" />
                <button onClick={submit} className="rounded-lg bg-violet-600 px-5 text-sm font-semibold text-white hover:bg-violet-700">{t("Έλεγχος", "Check")}</button>
              </div>
            )}
            {last && <div className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${last.found ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{last.found ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}<span className="font-mono">{last.barcode}</span> — {last.found ? t("βρέθηκε ✓", "found ✓") : t("εκτός λίστας!", "not in list!")}{last.found && last.exec_no && (last.n_executions ?? 1) > 1 && <span className="ml-1 rounded bg-emerald-200/70 px-1.5 py-0.5 text-[11px] font-bold">{t(`Εκτέλεση ${last.exec_no}/${last.n_executions} — σκάναρε ξανά για την επόμενη`, `Execution ${last.exec_no}/${last.n_executions} — scan again for the next`)}</span>}</div>}
          </div>
        )}
        <p className="text-center text-xs text-slate-400">{t("Μόλις ολοκληρωθούν όλες οι μέρες → Στάδιο 2: οπτικός έλεγχος. (Αλλαγή τρόπου: Ρυθμίσεις → Κλείσιμο Μήνα)", "When all days are done → Stage 2: visual check. (Change mode: Settings → Month Closing)")}</p>
      </div>
    );
  }

  if (monthDone) return (
    <div className="space-y-4 py-10 text-center">
      <PartyPopper className="mx-auto h-12 w-12 text-emerald-500" />
      <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t("Ο μήνας ολοκληρώθηκε! 🎉", "Month complete! 🎉")}</h2>
      <p className="text-sm text-slate-500">{t(`Όλες οι ${data?.total ?? 0} συνταγές ελέγχθηκαν σε ${byDay.length} ημέρες.`, `All ${data?.total ?? 0} prescriptions checked across ${byDay.length} days.`)}</p>
      {!!data?.extra.length && <p className="text-sm text-rose-600">{t(`Προσοχή: ${data.extra.length} σκαναρίστηκαν εκτός λίστας.`, `Note: ${data.extra.length} scanned not in data.`)}</p>}
      <button onClick={async () => { if (await appConfirm(t("Μηδενισμός ελέγχου;", "Reset check?"), { danger: true })) reset.mutate(undefined); }} className="mx-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-4 w-4" /> {t("Νέος έλεγχος", "New check")}</button>
    </div>
  );

  // ── Πλαϊνά panels (αντικαθιστούν το pop-up): κουπόνια ΔΕΞΙΑ, μηνύματα/τι-να-κάνεις ΑΡΙΣΤΕΡΑ ──
  const sideTodo: string[] = [];
  if (detail?.found) {
    if (detail.is_eopyy === false && detail.fund && detail.fund !== "—") sideTodo.push(t(`🏛️ ΔΕΝ είναι ΕΟΠΥΥ — ${detail.fund}: ξεχωριστή κατάθεση στο ταμείο.`, `🏛️ NOT ΕΟΠΥΥ — ${detail.fund}: separate submission.`));
    if (detail.needs_original) sideTodo.push(t("📄 Επισύναψε την ΠΡΩΤΟΤΥΠΗ χάρτινη συνταγή.", "📄 Attach the ORIGINAL paper Rx."));
    if (detail.has_opinion) sideTodo.push(t("📋 Επισύναψε τη ΓΝΩΜΑΤΕΥΣΗ.", "📋 Attach the medical opinion."));
    if (detail.is_fyk) sideTodo.push(t("💊 ΦΥΚ — αντίγραφο τιμολογίου.", "💊 High-cost — invoice copy."));
    if ((detail.coupons || []).some((c) => c.qr === false)) sideTodo.push(t("⚠️ Κράτησε τις ΤΑΙΝΙΕΣ γνησιότητας.", "⚠️ Keep the authenticity strips."));
    if (detail.is_etyap) sideTodo.push(t("🛡️ ΕΤΥΑΠ — συμπληρωματική υποβολή.", "🛡️ ΕΤΥΑΠ — supplementary submission."));
  }
  const messagesPanel = (
    <aside className="order-2 lg:order-1 lg:sticky lg:top-20 lg:self-start">
      <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40">
        <div className="mb-2 text-[11px] font-bold uppercase text-slate-500">🔎 {t("Τι να ελέγξεις / καταθέσεις", "What to check / submit")}</div>
        {detail?.found ? (
          <div className="space-y-2">
            {sideTodo.length > 0 && <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-2.5 dark:border-emerald-900/50 dark:bg-emerald-950/20"><div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase text-emerald-700 dark:text-emerald-400"><ClipboardList className="h-3.5 w-3.5" /> {t("Για το ταμείο", "For the fund")}</div><ul className="space-y-0.5 text-[11px] text-slate-700 dark:text-slate-200">{sideTodo.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            {checks && checks.count > 0 ? <CategorizedChecks res={checks} t={t} />
              : (sideTodo.length === 0 && <p className="text-[11px] text-emerald-600">✓ {t("Καθαρή — όλα QR, καμία ιδιαιτερότητα.", "Clean — all QR, nothing special.")}</p>)}
          </div>
        ) : <p className="py-10 text-center text-xs text-slate-400">{t("Σκάναρε ή πάτησε μια συνταγή για να δεις τι πρέπει να κάνεις.", "Scan or tap a prescription to see what to do.")}</p>}
      </div>
    </aside>
  );
  const couponsPanel = (
    <aside className="order-3 lg:sticky lg:top-20 lg:self-start">
      <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40">
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500"><Ticket className="h-3.5 w-3.5" /> {t("Κουπόνια", "Coupons")}{detail?.found ? ` · ${detail.barcode}` : ""}{detail?.found && detail.exec_no != null && <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{t(`Εκτέλεση ${detail.exec_no}`, `Execution ${detail.exec_no}`)}</span>}</div>
        {detail?.found && detail.coupons ? (
          <div className="space-y-1.5">
            {detail.coupons.map((c, i) => { const strip = c.qr === false; return (
              <div key={i} className={`flex items-start gap-2 rounded-lg border p-2 text-xs ${c.qr === true ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20" : strip ? "border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30" : "border-slate-200 dark:border-slate-700"}`}>
                {c.qr === true ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : strip ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <Pill className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                <div className="min-w-0 flex-1"><div className="font-medium text-slate-700 dark:text-slate-200">{c.name} {c.quantity > 1 && <span className="text-slate-400">×{c.quantity}</span>}</div>
                  {c.qr === true && <div className="text-[11px] font-semibold text-emerald-600">✓ QR{c.qr_batch ? ` · ${c.qr_batch}` : ""}</div>}
                  {strip && <div className="text-[11px] font-bold text-amber-700">⚠ {t("Ταινία", "Strip")}{c.lot ? ` · ${c.lot}` : ""}</div>}
                  {!c.executed && <div className="text-[10px] text-rose-500">{t("ανεκτέλεστο", "unexecuted")}</div>}
                </div>
              </div>); })}
          </div>
        ) : <p className="py-10 text-center text-xs text-slate-400">{t("Σκάναρε ή πάτησε μια συνταγή για να δεις τα κουπόνια.", "Scan or tap a prescription to see coupons.")}</p>}
      </div>
    </aside>
  );
  // ── ΚΟΚΠΙΤ (4η επιλογή): 3 στήλες σε μία οθόνη — Ημέρα & Ταμεία | Κουπόνια | Έλεγχος ──
  if (mode === "cockpit") {
    // σύνολα ανά ταμείο για την επιλεγμένη ημέρα (πλήθος + αιτούμενο)
    const fundAgg: Record<string, { rx: number; claim: number; retail: number; patient: number }> = {};
    for (const it of dayItems) {   // ταμεία της ΕΠΙΛΕΓΜΕΝΗΣ ΗΜΕΡΑΣ (κατά ομάδα/«που ανήκουν»)
      const k = it.fund || it.group || "—";
      const g = (fundAgg[k] || (fundAgg[k] = { rx: 0, claim: 0, retail: 0, patient: 0 }));
      g.rx += 1; g.claim += it.claim || 0; g.retail += it.retail || 0; g.patient += it.patient || 0;
    }
    const fundLines = Object.entries(fundAgg).sort((a, b) => b[1].claim - a[1].claim);
    const colHead = (title: string, sub: string) => (
      <div className="rounded-2xl border border-slate-200 bg-white/70 p-3.5 dark:border-slate-700 dark:bg-slate-900/70">
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
      </div>
    );
    // δομημένες κάρτες ελέγχου (δεξιά στήλη, όπως το mockup)
    const allChk = (checks?.items || []).flatMap((it) => it.checks || []);
    const opticalChk = allChk.find((c) => c.type === "overdose" || c.type === "vial_dose");
    // Οι οπτικοί έλεγχοι (δόση/ποσότητα) φαίνονται ΜΟΝΟ στην κάρτα «Οπτικός έλεγχος» → τους εξαιρούμε
    // από τη λίστα «Λοιπές προειδοποιήσεις» ώστε να μη διπλοεμφανίζονται.
    const otherItems = (checks?.items || [])
      .map((it) => ({ ...it, checks: (it.checks || []).filter((c) => c.type !== "overdose" && c.type !== "vial_dose") }))
      .filter((it) => it.checks.length);
    const otherChecks = checks ? { ...checks, items: otherItems, count: otherItems.reduce((s, it) => s + it.checks.length, 0) } : null;
    const chk = (label: string, value: string, sub: string, tone: "danger" | "warning" | "ok" | "neutral") => (
      <div className={`rounded-2xl border p-3.5 ${tone === "danger" ? "border-rose-200 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/20" : tone === "warning" ? "border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20" : tone === "ok" ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
        <div className={`mt-1 text-sm font-bold ${tone === "danger" ? "text-rose-600 dark:text-rose-300" : tone === "warning" ? "text-amber-700 dark:text-amber-300" : tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-slate-800 dark:text-slate-100"}`}>{value}</div>
        {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
      </div>
    );
    return (
      <div className="mx-auto max-w-[1600px]">
        <div className="grid items-start gap-4 xl:grid-cols-[1.1fr_0.9fr_1.1fr]">
          {/* ΑΡΙΣΤΕΡΑ — Ημέρα & Ταμεία */}
          <section className="space-y-3 rounded-3xl border border-sky-100 bg-gradient-to-b from-sky-50/60 to-indigo-50/40 p-3 dark:border-slate-700 dark:from-slate-900 dark:to-slate-900">
            {colHead(t("Ημέρα & Ταμεία", "Day & Funds"), t("Ημερολόγιο, σύνολα ταμείων & σάρωση", "Calendar, fund totals & scan"))}
            {/* compact calendar */}
            <div className="rounded-2xl border border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900">
              <div className="mb-1 flex items-center justify-between px-1"><span className="text-xs font-bold text-slate-700 dark:text-slate-200">{t("Ημερολόγιο", "Calendar")}</span><span className="text-[11px] text-slate-400">{daysComplete}/{byDay.length} ✓</span></div>
              <div className="grid grid-cols-7 gap-0.5 text-center text-[9px] font-medium text-slate-400">{["Δε", "Τρ", "Τε", "Πέ", "Πα", "Σά", "Κυ"].map((w) => <div key={w}>{w}</div>)}</div>
              <div className="mt-0.5 grid grid-cols-7 gap-0.5">
                {(() => {
                  const yy = Number(period.split("-")[0]); const mm = Number(period.split("-")[1]);
                  const dim = new Date(yy, mm, 0).getDate(); const lead = (new Date(yy, mm - 1, 1).getDay() + 6) % 7;
                  const bmap: Record<string, DayRow> = {}; byDay.forEach((d) => { bmap[d.date] = d; });
                  const idxOf: Record<string, number> = {}; byDay.forEach((d, i) => { idxOf[d.date] = i; });
                  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: dim }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`)];
                  return cells.map((date, ci) => {
                    if (!date) return <div key={ci} />;
                    const dnum = Number(date.slice(-2)); const d = bmap[date];
                    if (!d) return <div key={ci} className="grid place-items-center rounded py-1 text-[10px] text-slate-300 dark:text-slate-600">{dnum}</div>;
                    const done = d.checked >= d.total; const i = idxOf[date]; const isCur = i === dayIdx;
                    return <button key={ci} onClick={() => setDayIdx(i)} className={`flex flex-col items-center rounded py-1 leading-none ${done ? "bg-emerald-500 text-white" : d.checked > 0 ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"} ${isCur ? "ring-2 ring-emerald-500" : ""}`}><span className="text-[11px] font-bold">{dnum}</span><span className="text-[8px] opacity-80">{done ? "✓" : `${d.checked}/${d.total}`}</span></button>;
                  });
                })()}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-1 text-[10px] text-slate-500">
                <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500" /> {t("Ολοκληρωμένη", "Complete")}</span>
                <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-amber-400" /> {t("Λείπει έλεγχος", "Needs check")}</span>
                <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-slate-300" /> {t("Εκκρεμεί", "Pending")}</span>
              </div>
            </div>
            {/* σύνολα ταμείων ημέρας */}
            <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
              <div className="mb-2 text-xs font-bold text-slate-700 dark:text-slate-200">{t("Σύνολα ταμείων — ημέρα", "Fund totals — day")}</div>
              {fundLines.length ? <div className="space-y-2">{fundLines.map(([f, v]) => (
                <details key={f} className="group rounded-xl border border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-800/40">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-sm">
                    <span className="inline-flex min-w-0 items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100"><span className="shrink-0 text-slate-400 transition-transform group-open:rotate-90">▸</span><span className="truncate">{f}</span></span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-slate-500">{v.rx} · <b className="text-slate-800 dark:text-slate-100">{fmtEur(v.claim)}</b></span>
                  </summary>
                  <div className="grid grid-cols-4 gap-1.5 border-t border-slate-200 px-2.5 py-2 text-center dark:border-slate-700">
                    {([[t("Συντ.", "Rx"), String(v.rx)], [t("Αιτούμενο", "Claim"), fmtEur(v.claim)], [t("Λιανική", "Retail"), fmtEur(v.retail)], [t("Συμμετοχή", "Copay"), fmtEur(v.patient)]] as [string, string][]).map(([lbl, val]) => (
                      <div key={lbl}><div className="text-[9px] uppercase text-slate-400">{lbl}</div><div className="text-[12px] font-bold text-slate-800 dark:text-slate-100">{val}</div></div>
                    ))}
                  </div>
                </details>))}</div> : <p className="text-xs text-slate-400">{t("Καμία εκτέλεση αυτή τη μέρα.", "No executions this day.")}</p>}
            </div>
            {/* σάρωση */}
            <div className={`rounded-2xl border-2 p-4 ${dayDone ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
              <div className="flex items-center justify-between">
                <button onClick={() => setDayIdx((i) => Math.max(0, i - 1))} disabled={dayIdx === 0} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronLeft className="h-5 w-5" /></button>
                <div className="text-center"><div className="text-[11px] uppercase tracking-wide text-slate-400">{t("Ημέρα", "Day")} {dayIdx + 1}/{byDay.length}</div><div className="text-base font-bold capitalize text-slate-900 dark:text-slate-100">{cur ? fmtDay(cur.date) : "—"}</div></div>
                <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronRight className="h-5 w-5" /></button>
              </div>
              <div className="mt-2 text-center text-sm"><span className={`text-2xl font-extrabold ${dayDone ? "text-emerald-600" : "text-slate-900 dark:text-slate-100"}`}>{cur?.checked ?? 0}</span><span className="text-slate-400"> / {cur?.total ?? 0} {t("σκαναρισμένες", "scanned")}</span></div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${cur?.total ? (cur.checked / cur.total) * 100 : 0}%` }} /></div>
              <div className="mt-3 flex gap-2">
                <input ref={inputRef} autoFocus value={bc} onChange={(e) => setBc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder={t("Barcode συνταγής…", "Prescription barcode…")} inputMode="numeric" className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-emerald-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
                <button onClick={submit} className="rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">{t("Έλεγχος", "Check")}</button>
              </div>
              {last && <div className={`mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold ${last.found ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{last.found ? `✓ ${last.barcode} — ${t("βρέθηκε", "found")}` : `✗ ${last.barcode} — ${t("δεν βρέθηκε", "not found")}`}</div>}
              {/* controls: μόνο όσες χρειάζονται έλεγχο + μηδενισμός ημέρας */}
              <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-2.5 dark:border-slate-800">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <button type="button" role="switch" aria-checked={onlyChecks} onClick={toggleOnlyChecks} className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${onlyChecks ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${onlyChecks ? "translate-x-4" : "translate-x-0.5"}`} /></button>
                  {t("Μόνο όσες χρειάζονται έλεγχο", "Only those needing a check")}
                </label>
                <button onClick={async () => { if (cur && await appConfirm(t(`Μηδενισμός ημέρας ${grDate(cur.date)};`, `Reset day ${cur ? grDate(cur.date) : ""}?`))) reset.mutate(cur.date); }} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:bg-rose-950/20"><RotateCcw className="h-3.5 w-3.5" /> {t("Μηδενισμός ημέρας", "Reset day")}</button>
              </div>
            </div>
          </section>

          {/* ΚΕΝΤΡΟ — Κουπόνια */}
          <section className="space-y-3 rounded-3xl border border-emerald-100 bg-gradient-to-b from-emerald-50/50 to-white p-3 dark:border-slate-700 dark:from-slate-900 dark:to-slate-900">
            {colHead(t("Κουπόνια", "Coupons"), t("Σκαναρισμένα κουπόνια & σύγκριση με τη συνταγή", "Scanned coupons vs the prescription"))}
            <div className="[&>aside]:order-none [&>aside]:!static">{couponsPanel}</div>
            {/* φάρμακα στην αρχική συνταγή (τι έγραψε ο γιατρός) */}
            {detail?.found && !!(detail.coupons || []).length && (
              <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                <div className="mb-2 text-[11px] font-bold uppercase text-slate-500">💊 {t("Φάρμακα στην αρχική συνταγή", "Meds on the original Rx")}</div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {Object.entries((detail.coupons || []).reduce((m, c) => { m[c.name] = (m[c.name] || 0) + (c.quantity || 1); return m; }, {} as Record<string, number>)).map(([name, qty]) => (
                    <div key={name} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="text-slate-700 dark:text-slate-200">{name}</span>
                      <span className="font-bold text-slate-400">×{qty}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* συνταγές ημέρας (accordion) */}
            <details className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
              <summary className="cursor-pointer list-none text-sm font-semibold text-slate-700 dark:text-slate-200">▸ {t("Συνταγές ημέρας", "Day's prescriptions")} ({tableRows.length})</summary>
              <div className="mt-2 overflow-x-auto"><DataTable pageSize={50} columns={cols} rows={tableRows} rowKey={(r) => r.external_id} empty={t("Καμία συνταγή.", "No prescriptions.")} /></div>
            </details>
          </section>

          {/* ΔΕΞΙΑ — Έλεγχος */}
          <section className="space-y-3 rounded-3xl border border-amber-100 bg-gradient-to-b from-amber-50/50 to-white p-3 dark:border-slate-700 dark:from-slate-900 dark:to-slate-900">
            {colHead(t("Έλεγχος", "Checks"), t("Σημεία κινδύνου & προσοχής πριν την υποβολή", "Risk & attention points before submission"))}
            {last?.found ? (
              <>
                {chk(t("Ταμείο", "Fund"), last.flags?.fund || detail?.fund || "ΕΟΠΥΥ",
                     (last.flags?.has_vaccine || detail?.has_vaccine) ? t("Εμβόλια", "Vaccines") : t("Φάρμακα", "Medicines"),
                     last.flags?.is_eopyy === false ? "warning" : "neutral")}
                {last.flags?.is_intangible
                  ? chk(t("Χάρτινη συνταγή", "Paper Rx"), t("ΟΧΙ — Άυλη", "NO — Paperless"), t("Δεν χρειάζεται χάρτινη — άυλη συνταγή.", "No paper needed — paperless Rx."), "ok")
                  : (detail?.needs_original || last.flags?.needs_original)
                    ? chk(t("Χάρτινη συνταγή", "Paper Rx"), t("ΝΑΙ", "YES"), t("Επισύναψε την ΠΡΩΤΟΤΥΠΗ συνταγή του γιατρού.", "Attach the doctor's ORIGINAL prescription."), "danger")
                    : chk(t("Χάρτινη συνταγή", "Paper Rx"), t("Έντυπη", "Printed"), t("Κράτησε τη χάρτινη συνταγή στο φαρμακείο.", "Keep the printed prescription."), "neutral")}
                {opticalChk
                  ? chk(t("Οπτικός έλεγχος", "Optical check"), opticalChk.title, opticalChk.detail, "warning")
                  : chk(t("Οπτικός έλεγχος", "Optical check"), t("Δεν χρειάζεται", "Not needed"), t("Καμία ιδιαιτερότητα δόσης/ποσότητας.", "No dose/quantity specialness."), "ok")}
                {/* Λοιπές προειδοποιήσεις + τι να καταθέσεις — ΧΩΡΙΣ τον οπτικό (είναι πιο πάνω) */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40">
                  <div className="mb-2 text-[11px] font-bold uppercase text-slate-500">🔎 {t("Λοιπές προειδοποιήσεις", "Other warnings")}</div>
                  {sideTodo.length > 0 && <div className="mb-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-2.5 dark:border-emerald-900/50 dark:bg-emerald-950/20"><div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase text-emerald-700 dark:text-emerald-400"><ClipboardList className="h-3.5 w-3.5" /> {t("Για το ταμείο", "For the fund")}</div><ul className="space-y-0.5 text-[11px] text-slate-700 dark:text-slate-200">{sideTodo.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
                  {otherChecks && otherChecks.count > 0 ? <CategorizedChecks res={otherChecks} t={t} />
                    : (sideTodo.length === 0 && <p className="text-[11px] text-emerald-600">✓ {t("Καθαρή — καμία άλλη ιδιαιτερότητα.", "Clean — nothing else special.")}</p>)}
                </div>
              </>
            ) : <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-xs text-slate-400 dark:border-slate-700 dark:bg-slate-900">{t("Σκάναρε ή πάτησε μια συνταγή για να δεις τους ελέγχους.", "Scan or tap a prescription to see the checks.")}</p>}
            <div className={`rounded-2xl border p-4 ${dayDone ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-rose-200 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20"}`}>
              <div className="text-[11px] font-bold uppercase text-slate-500">{t("Κατάσταση ημέρας", "Day status")}</div>
              <div className={`mt-1 text-sm font-bold ${dayDone ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}`}>{dayDone ? t("Έτοιμη ✓", "Ready ✓") : t("Δεν είναι έτοιμη για υποβολή", "Not ready for submission")}</div>
              {!dayDone && <p className="mt-1 text-xs text-slate-500">{t("Μένουν συνταγές για σκανάρισμα/έλεγχο.", "Prescriptions still to scan/check.")}</p>}
              {dayDone && <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="mt-3 w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">✓ {t("Επόμενη ημέρα", "Next day")} →</button>}
            </div>
          </section>
        </div>
        {showReport && <ClosingReportModal period={period} t={t} onClose={() => setShowReport(false)} />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)_320px]">
        {messagesPanel}
        <div className="order-1 min-w-0 space-y-4 lg:order-2">
      {/* διαχωρισμός ανά υποβολή (ταμείο) ή όλες μαζί — μόνο στον κλασικό */}
      {mode === "classic" && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900">
        <label className="text-sm font-medium text-slate-600 dark:text-slate-300">{t("Υποβολή:", "Submission:")}</label>
        <select value={group} onChange={(e) => { setGroup(e.target.value); resumed.current = false; setDayIdx(0); setLast(null); }} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-emerald-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800">
          {(data?.groups ?? ["all"]).map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
        </select>
        <span className="text-xs text-slate-400">{group === "all" ? t("όλες μαζί — δες την ομάδα κάθε συνταγής", "all — group shown per Rx") : t("μόνο αυτή η υποβολή", "this submission only")}</span>
      </div>}

      {/* month progress */}
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" /> {t("Ημέρες ολοκληρωμένες", "Days complete")}: <b className="text-slate-700 dark:text-slate-200">{daysComplete}/{byDay.length}</b></span>
        <span className="inline-flex items-center gap-1.5">
          <button onClick={() => setShowReport(true)} className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">🖨️ {t("Αναλυτική κατάθεση", "Detailed submission")}</button>
          {data?.summary && <button onClick={() => setShowBriefing(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 hover:bg-slate-50 dark:border-slate-600"><ClipboardList className="h-3 w-3" /> {t("Τι θα συναντήσω", "Briefing")}</button>}
          <button onClick={async () => { if (cur && await appConfirm(t(`Μηδενισμός ελέγχου ΜΟΝΟ για την ${grDate(cur.date)}; (η δουλειά των άλλων ημερών διατηρείται)`, `Reset check for ${cur ? grDate(cur.date) : ""} only? (other days kept)`))) reset.mutate(cur.date); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 hover:bg-slate-50 dark:border-slate-600"><RotateCcw className="h-3 w-3" /> {t("Μηδενισμός ημέρας", "Reset day")}</button>
          <button onClick={async () => { if (await appConfirm(t("Μηδενισμός ΟΛΟΥ του μήνα; (χάνεται ο έλεγχος όλων των ημερών)", "Reset the WHOLE month? (all days' checks lost)"), { danger: true })) reset.mutate(undefined); }} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-50 hover:text-rose-600 dark:hover:bg-slate-800">{t("όλος ο μήνας", "whole month")}</button>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${byDay.length ? (daysComplete / byDay.length) * 100 : 0}%` }} /></div>

      {/* days overview — compact ημερολόγιο + hover ανάλυση ανά μέρα */}
      {(() => {
        const yy = Number(period.split("-")[0]); const mm = Number(period.split("-")[1]);
        const dim = new Date(yy, mm, 0).getDate();
        const lead = (new Date(yy, mm - 1, 1).getDay() + 6) % 7;
        const bmap: Record<string, DayRow> = {}; byDay.forEach((d) => { bmap[d.date] = d; });
        const idxOf: Record<string, number> = {}; byDay.forEach((d, i) => { idxOf[d.date] = i; });
        const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: dim }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`)];
        const lbl = (g: string) => g === "ΕΟΠΥΥ - Φάρμακα" ? "ΕΟΠΥΥ Φάρμ." : g === "ΕΟΠΥΥ - Εμβόλια" ? t("Εμβόλια", "Vaccines") : g === "Αμιγώς 100%" ? t("Αμιγώς 100%", "Full 100%") : g;
        return (
          <div className="rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
            <div className="grid grid-cols-7 gap-0.5 text-center text-[9px] font-medium text-slate-400">{["Δε", "Τρ", "Τε", "Πέ", "Πα", "Σά", "Κυ"].map((w) => <div key={w}>{w}</div>)}</div>
            <div className="mt-0.5 grid grid-cols-7 gap-0.5">
              {cells.map((date, ci) => {
                if (!date) return <div key={ci} />;
                const dnum = Number(date.slice(-2)); const d = bmap[date];
                if (!d) return <div key={ci} className="grid place-items-center rounded py-1 text-[10px] text-slate-300 dark:text-slate-600">{dnum}</div>;
                const done = d.checked >= d.total; const i = idxOf[date]; const isCur = i === dayIdx; const st = dayStats[date];
                return (
                  <div key={ci} className="group relative">
                    <button onClick={() => setDayIdx(i)}
                      className={`flex w-full flex-col items-center justify-center rounded py-1 leading-none transition-transform group-hover:scale-110 ${done ? "bg-emerald-500 text-white" : d.checked > 0 ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"} ${isCur ? "ring-2 ring-emerald-500" : ""}`}>
                      <span className="text-[11px] font-bold">{dnum}</span>
                      <span className="text-[8px] opacity-80">{done ? "✓" : `${d.checked}/${d.total}`}</span>
                    </button>
                    <div className="pointer-events-none absolute left-1/2 top-full z-30 hidden w-40 -translate-x-1/2 translate-y-1 rounded-lg border border-slate-200 bg-white p-2 text-left shadow-lg group-hover:block dark:border-slate-700 dark:bg-slate-800">
                      <div className="mb-1 text-[11px] font-bold capitalize text-slate-800 dark:text-slate-100">{fmtDayShort(date)}</div>
                      <div className="mb-1 text-[10px] text-slate-500">{t("Εκτελέσεις", "Executions")}: <b className="text-slate-700 dark:text-slate-200">{d.total}</b> · {t("σκαναρ.", "scan.")} {d.checked}</div>
                      {st && Object.entries(st.groups).sort((a, b) => b[1] - a[1]).map(([g, c]) => (
                        <div key={g} className="flex justify-between gap-2 text-[10px] text-slate-600 dark:text-slate-300"><span className="truncate">{lbl(g)}</span><b>{c}</b></div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* current day card */}
      <div className={`rounded-2xl border-2 p-5 ${dayDone ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
        <div className="flex items-center justify-between">
          <button onClick={() => setDayIdx((i) => Math.max(0, i - 1))} disabled={dayIdx === 0} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800 sm:h-8 sm:w-8"><ChevronLeft className="h-5 w-5" /></button>
          <div className="text-center">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{t("Ημέρα", "Day")} {dayIdx + 1}/{byDay.length}</div>
            <div className="text-lg font-bold capitalize text-slate-900 dark:text-slate-100">{cur ? fmtDay(cur.date) : "—"}</div>
          </div>
          <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800 sm:h-8 sm:w-8"><ChevronRight className="h-5 w-5" /></button>
        </div>

        {/* day progress */}
        <div className="mt-3 flex items-center justify-center gap-2 text-sm">
          <span className={`text-2xl font-extrabold ${dayDone ? "text-emerald-600" : "text-slate-900 dark:text-slate-100"}`}>{onlyChecks ? shownChecked : (cur?.checked ?? 0)}</span>
          <span className="text-slate-400">/ {onlyChecks ? shownItems.length : (cur?.total ?? 0)} {onlyChecks ? t("που χρειάζονται έλεγχο", "needing a check") : t("συνταγές σκαναρισμένες", "prescriptions scanned")}</span>
        </div>

        {dayDone ? (
          <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="mt-4 w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            ✓ {t("Ολοκληρώθηκε — Επόμενη ημέρα", "Done — Next day")} →
          </button>
        ) : (
          <>
            <p className="mt-3 mb-2 text-center text-xs text-slate-500"><ScanBarcode className="mr-1 inline h-4 w-4 text-emerald-600" /> {t("Σκάναρε τις συνταγές αυτής της ημέρας", "Scan this day's prescriptions")}</p>
            <div className="flex gap-2">
              <input ref={inputRef} autoFocus value={bc} onChange={(e) => setBc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                placeholder={t("Barcode συνταγής…", "Prescription barcode…")} inputMode="numeric"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800" />
              <button onClick={submit} className="rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">{t("Έλεγχος", "Check")}</button>
            </div>
            <button onClick={nextDay} disabled={dayIdx >= byDay.length - 1} className="mt-2 w-full text-center text-xs text-slate-400 hover:text-slate-600">{t("Παράλειψη ημέρας (εκκρεμεί)", "Skip day (leave pending)")} →</button>
            {/* παραμετρική ρύθμιση: εμφάνιση pop-up κουπονιών σε κάθε σκανάρισμα */}
            <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <button type="button" role="switch" aria-checked={couponsPopup} onClick={toggleCouponsPopup}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${couponsPopup ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${couponsPopup ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
              <span className="inline-flex items-center gap-1"><Ticket className="h-3.5 w-3.5" /> {t("Εμφάνιση κουπονιών & μηνυμάτων στα πλαϊνά σε κάθε σκανάρισμα", "Show coupons & messages in the side panels on every scan")}</span>
            </label>
            {/* παραμετρικό: εμφάνιση μόνο όσων χρειάζονται έλεγχο (μόνο στον κλασικό) */}
            {mode === "classic" && <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <button type="button" role="switch" aria-checked={onlyChecks} onClick={toggleOnlyChecks}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${onlyChecks ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${onlyChecks ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
              <span className="inline-flex items-center gap-1"><Filter className="h-3.5 w-3.5" /> {t("Μόνο όσες χρειάζονται έλεγχο (κρύψε όσες δεν έχουν ιδιαιτερότητα)", "Only those needing a check (hide those with no specialness)")}</span>
            </label>}
          </>
        )}

        {last && (
          <div className="mt-3 space-y-2">
            <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium ${last.found ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
              {last.found ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              <span className="font-mono">{last.barcode}</span> — {last.found ? t("βρέθηκε ✓", "found ✓") : t("ΔΕΝ υπάρχει στα δεδομένα — έλεγξε το barcode ή τη συνταγή!", "NOT in our data — check the barcode/prescription!")}{last.found && last.exec_no && (last.n_executions ?? 1) > 1 && <span className="ml-1 rounded bg-emerald-200/70 px-1.5 py-0.5 text-[11px] font-bold">{t(`Εκτέλεση ${last.exec_no}/${last.n_executions} — σκάναρε ξανά για την επόμενη`, `Execution ${last.exec_no}/${last.n_executions} — scan again for the next`)}</span>}
            </div>
            {last.found && last.flags && (
              <div className="flex flex-wrap gap-1.5">
                {last.flags.is_full_participation && <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800 ring-1 ring-amber-300">💯 {t("100% συμμετοχή ασθενή — ΔΕΝ υποβάλλεται στο ταμείο (κρατείται στο φαρμακείο)", "100% patient share — NOT submitted (kept at the pharmacy)")}</span>}
                {last.flags.is_eopyy === false && last.flags.fund && !last.flags.is_full_participation && <span className="rounded-md bg-orange-100 px-2 py-1 text-xs font-bold text-orange-800 ring-1 ring-orange-300">🏛️ {t(`ΔΕΝ είναι ΕΟΠΥΥ · ${last.flags.fund} — ξεχωριστή κατάθεση`, `NOT ΕΟΠΥΥ · ${last.flags.fund} — separate submission`)}</span>}
                {last.flags.needs_original && <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">📄 {t("Χρειάζεται πρωτότυπη συνταγή ιατρού", "Needs original paper Rx")}</span>}
                {last.flags.is_fyk && <span className="rounded-md bg-fuchsia-100 px-2 py-1 text-xs font-semibold text-fuchsia-800">💊 {t("ΦΥΚ (Ν.3816)", "High-cost (L.3816)")}</span>}
                {last.flags.has_desensitization && <span className="rounded-md bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-800">🧪 {t("Εμβόλιο απευαισθητοποίησης — βάλε & αντίγραφο τιμολογίου παραλαβής", "Desensitization vaccine — include purchase invoice copy")}</span>}
                {last.flags.has_opinion && <span className="rounded-md bg-sky-100 px-2 py-1 text-xs font-semibold text-sky-800">📋 {t("Έχει γνωμάτευση", "Has medical opinion")}</span>}
                {last.flags.has_vaccine && <span className="rounded-md bg-teal-100 px-2 py-1 text-xs font-semibold text-teal-800">💉 {t("Συνταγή εμβολίων (ξεχωριστή υποβολή)", "Vaccine Rx (separate batch)")}</span>}
                {last.flags.is_etyap && <span className="rounded-md bg-cyan-100 px-2 py-1 text-xs font-semibold text-cyan-800">🛡️ {t("ΕΤΥΑΠ / συμπληρωματική κάλυψη — έλεγχος μόνο στον ΕΟΠΥΥ", "ΕΤΥΑΠ / supplementary cover")}</span>}
                {last.flags.is_intangible && <span className="rounded-md bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-800">📲 {t("Άυλη", "Paperless")}</span>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* this day's prescriptions — μόνο στον κλασικό (στο guided μένει λιτό: μόνο σκανάρισμα) */}
      {mode === "classic" && (
        <details open={listOpen} onToggle={(e) => setListOpenLocal((e.currentTarget as HTMLDetailsElement).open)} className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          {/* Ο μετρητής ΠΡΕΠΕΙ να ταιριάζει με ό,τι εμφανίζει ο πίνακας (shownItems), όχι με το σύνολο
              ημέρας — αλλιώς μια all-QR/καθαρή συνταγή (needs_check=false) «λείπει» ενώ ο τίτλος λέει π.χ. 45.
              Όταν το φίλτρο κρύβει καθαρές, το λέμε ρητά ώστε να είναι ξεκάθαρο ότι δεν χάθηκε τίποτα. */}
          <summary className="cursor-pointer list-none text-sm font-semibold text-slate-700 dark:text-slate-200">▸ {t("Συνταγές ημέρας", "Day's prescriptions")} ({tableRows.length}{onlyChecks && dayItems.length > tableRows.length ? ` ${t("από", "of")} ${dayItems.length} · ${dayItems.length - tableRows.length} ${t("all-QR κρυφές", "all-QR hidden")}` : ""})</summary>
          {onlyChecks && dayItems.length > tableRows.length && (
            <p className="mt-1 text-xs text-slate-400">{t("Οι all-QR χωρίς ιδιαιτερότητα είναι αυτόματα ΟΚ και κρύβονται (όσες σκανάρεις εμφανίζονται ελεγμένες). Κλείσε τον διακόπτη «Μόνο όσες χρειάζονται έλεγχο» για να δεις ΟΛΕΣ τις συνταγές της ημέρας.", "All-QR with no specialness are auto-OK and hidden (any you scan appear as checked). Turn off «Only those needing a check» to see ALL of the day's prescriptions.")}</p>
          )}
          <div className="mt-2"><DataTable pageSize={50} columns={cols} rows={tableRows} rowKey={(r) => r.external_id} empty={onlyChecks ? t("Καμία συνταγή χρειάζεται έλεγχο 🎉", "Nothing needs checking 🎉") : t("Καμία συνταγή.", "No prescriptions.")} /></div>
        </details>
      )}

      {/* extras (scanned but not in data) */}
      {!!data?.extra.length && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/50 dark:bg-rose-950/40">
          <div className="mb-1 text-sm font-semibold text-rose-700 dark:text-rose-300">{t("Σκαναρίστηκαν αλλά ΔΕΝ υπάρχουν στα δεδομένα μας:", "Scanned but NOT in our data:")}</div>
          <div className="flex flex-wrap gap-1.5">{data.extra.map((b) => (
            <span key={b} className="inline-flex items-center gap-1 rounded bg-white px-2 py-0.5 font-mono text-xs text-rose-700 dark:bg-slate-900">
              {b}
              <button
                onClick={async () => { if (await appConfirm(t(`Διαγραφή του σκαναρισμένου barcode ${b} από τη λίστα;`, `Remove scanned barcode ${b} from the list?`))) removeExtra.mutate(b); }}
                title={t("Διαγραφή", "Remove")}
                aria-label={t("Διαγραφή", "Remove")}
                className="ml-0.5 grid h-4 w-4 place-items-center rounded-full text-rose-400 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/40"
              ><X className="h-3 w-3" /></button>
            </span>
          ))}</div>
        </div>
      )}

        </div>
        {couponsPanel}
      </div>
      {showReport && <ClosingReportModal period={period} t={t} onClose={() => setShowReport(false)} />}
      {showBriefing && data?.summary && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setShowBriefing(false)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase text-emerald-600">{t("Ενημέρωση μήνα", "Month briefing")} · {period}</div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Τι θα συναντήσεις στο κλείσιμο", "What you'll meet at closing")}</h3>
              </div>
              <button onClick={() => setShowBriefing(false)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>
            <div className="mb-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-slate-100 p-2 dark:bg-slate-800"><div className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{data.summary.total}</div><div className="text-[10px] text-slate-500">{t("εκτελέσεις", "executions")}</div></div>
              <div className="rounded-xl bg-amber-100 p-2 dark:bg-amber-950/40"><div className="text-xl font-extrabold text-amber-700">{data.summary.needs_check}</div><div className="text-[10px] text-amber-700">{t("χρειάζονται έλεγχο", "need a check")}</div></div>
              <div className="rounded-xl bg-emerald-100 p-2 dark:bg-emerald-950/40"><div className="text-xl font-extrabold text-emerald-700">{data.summary.clean}</div><div className="text-[10px] text-emerald-700">{t("καθαρές (all-QR)", "clean (all-QR)")}</div></div>
            </div>
            <div className="space-y-1">
              {briefRows(data.summary).filter(([, v]) => v > 0).map(([label, v, warn], i) => (
                <div key={i} className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${warn ? "bg-amber-50 dark:bg-amber-950/20" : "bg-slate-50 dark:bg-slate-800/50"}`}>
                  <span className="text-slate-700 dark:text-slate-200">{label}</span><b className="text-slate-900 dark:text-slate-100">{v}</b>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">{t("Σκάναρε μέρα-μέρα. Οι all-QR χωρίς ιδιαιτερότητα είναι αυτόματα ΟΚ — με τον διακόπτη «Μόνο όσες χρειάζονται έλεγχο» εστιάζεις στις υπόλοιπες.", "Scan day by day. All-QR with no specialness are auto-OK — use the «only those needing a check» toggle to focus on the rest.")}</p>
            <div className="mt-4 flex gap-2">
              <button onClick={printBriefing} className="flex-1 rounded-xl border border-slate-300 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"><Printer className="mr-1 inline h-4 w-4" /> {t("Εκτύπωση", "Print")}</button>
              <button onClick={() => setShowBriefing(false)} className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">{t("Κλείσιμο & συνέχεια", "Close & continue")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Λεπτομέρειες κουπονιών & μηνυμάτων → πλέον στα πλαϊνά panels (καταργήθηκε το pop-up) */}
    </div>
  );
}
