"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Repeat, Printer, QrCode, X } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { fmtDate, fmtDateTime } from "@/lib/formatters";
import { RepeatTree } from "@/components/prescriptions/RepeatTree";
import { useT } from "@/store/prefStore";
import { appAlert } from "@/store/dialogStore";

type T = (el: string, en: string) => string;

// Stored ΗΔΥΚΑ/CDA per-line detail (money in cents). Persisted at ingestion → no live fetch needed.
type LineDetails = {
  eof_code?: string | null; form?: string | null;
  execution_price?: number | null; retail_price?: number | null; reference_price?: number | null;
  patient_share?: number | null; difference?: number | null; participation_pct?: number | null;
  generic?: boolean | null; substitution_allowed?: boolean | null; lot?: string | null;
  dose?: string | null; frequency?: string | null; duration?: string | null;
  qr?: boolean | null; strip?: string | null;
  outstanding?: number | null;            // υπόλοιπη (ανεκτέλεστη) ποσότητα — ΗΔΥΚΑ 1.4.19
  qr_product_code?: string | null; qr_batch?: string | null; qr_expiry?: string | null;
  coupons?: Coupon[] | null;              // ΕΝΑ κουπόνι ανά εκτελεσμένο τεμάχιο (όσα η ποσότητα)
};
type Coupon = {
  execution_no?: number | null; strip?: string | null; qr?: boolean | null;
  qr_product_code?: string | null; qr_batch?: string | null; qr_expiry?: string | null;
  executed_at?: string | null;
};
type PrescDetails = {
  issue_date?: string | null; deadline_date?: string | null;
  exemption?: boolean | null; exemption_reason?: string | null; opinion?: boolean | null;
  fund_surcharge?: boolean | null;
  fund_surcharge_amount?: number | null; patient_share_total?: number | null; fund_share_total?: number | null;
  kyyap_covered?: number | null;   // ΚΥΥΑΠ (ΕΤΥΑΠ) — ποσό που πληρώνει το ΚΥΥΑΠ
  kyyap_difference?: number | null; supplementary_cover?: boolean | null; supplementary_amount?: number | null;
  interval_months?: number | null; // 1=μηνιαία, 2=δίμηνη (ρυθμός χρόνιας αγωγής)
  repeat_period_days?: number | null;
  chronic?: boolean | null;        // χρόνια πάθηση
  // γνωμάτευση
  opinion_doctor_name?: string | null; opinion_specialty?: string | null; opinion_date?: string | null;
  opinion_type?: string | null; opinion_barcode?: string | null; opinion_doctor_amka?: string | null;
  // τύπος / εκτελέσεις / επίσκεψη
  rx_type?: string | null; by_brand?: boolean | null; hiv_type?: string | null;
  narcotic_category?: string | null; exec_count?: number | null; active_executions?: string | null; visit_id?: string | null;
  // boolean flags (χαρακτηριστικά)
  single_dose?: boolean | null; high_cost?: boolean | null; heparin?: boolean | null; ifet_import?: boolean | null;
  desensitization?: boolean | null; eopyy_only?: boolean | null; narcotic?: boolean | null; hospital_only?: boolean | null;
  special_antibiotic?: boolean | null; ifet?: boolean | null; eopyy_preapproval?: boolean | null; outside_eopyy?: boolean | null;
  negative_list?: boolean | null; antibiotic?: boolean | null; vaccines?: boolean | null; home_delivery?: boolean | null;
  home_delivery_wish?: boolean | null; intangible?: boolean | null; consumables?: boolean | null;
  n3816?: boolean | null; ekas?: boolean | null;
};

type Item = {
  name: string | null; barcode: string | null; substance: string | null; category: string | null;
  atc?: string | null; narcotic?: boolean; high_cost?: boolean;
  quantity: number; retail_price: number; wholesale_price: number; margin: number;
  participation: number | null; patient_share: number; fund_share: number; is_executed: boolean;
  details?: LineDetails | null;
};

const catBadge = (t: T): Record<string, { label: string; cls: string }> => ({
  narcotic: { label: t("Ναρκωτικό", "Narcotic"), cls: "bg-rose-100 text-rose-700" },
  vaccine: { label: t("Εμβόλιο", "Vaccine"), cls: "bg-sky-100 text-sky-700" },
  allergen: { label: t("Αλλεργιογόνο", "Allergen"), cls: "bg-amber-100 text-amber-700" },
  fyk: { label: "ΦΥΚ", cls: "bg-violet-100 text-violet-700" },
});
function CategoryBadge({ category }: { category?: string | null }) {
  const t = useT();
  const b = category ? catBadge(t)[category] : undefined;
  if (!b) return null;
  return <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>;
}

// Κουπόνια μιας γραμμής: η αυθεντική per-τεμάχιο λίστα (μετά το full sync)· αλλιώς πέφτουμε
// στο μοναδικό legacy κουπόνι αν υπάρχει.
function couponsOf(it: Item): Coupon[] {
  const d = it.details;
  if (d?.coupons?.length) return d.coupons;
  if (d && (d.qr || d.strip)) return [{ qr: d.qr, strip: d.strip, qr_product_code: d.qr_product_code, qr_batch: d.qr_batch, qr_expiry: d.qr_expiry }];
  return [];
}

// Σαρώσιμος κωδικός κουπονιού: QR → GS1 DataMatrix (EU FMD, (01)GTIN(17)λήξη(10)παρτίδα(21)serial)·
// ΕΟΦ ταινία γνησιότητας → γραμμικός Code-128 του serial (για να σκανάρεται στο φαρμακείο).
// Render σε VECTOR SVG (όχι canvas): κρυστάλλινες ακμές σε οποιοδήποτε μέγεθος εκτύπωσης →
// αξιόπιστο & επαναλήψιμο σκανάρισμα (το canvas σμικρυμένο με CSS θόλωνε τα modules).
function CouponBarcode({ c, size }: { c: Coupon; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isQr = !!c.qr_product_code;
  const gtin = (c.qr_product_code || "").replace(/\D/g, "").padStart(14, "0").slice(-14);
  useEffect(() => {
    if (!ref.current || (!isQr && !c.strip)) return;
    let dead = false;
    (async () => {
      try {
        const bwipjs = (await import("bwip-js")).default;
        if (dead || !ref.current) return;
        let svg: string;
        if (isQr) {
          const ai = `(01)${gtin}` + (c.qr_expiry ? `(17)${c.qr_expiry}` : "")
            + (c.qr_batch ? `(10)${c.qr_batch}` : "") + (c.strip ? `(21)${c.strip}` : "");
          // padding 4 modules = επαρκής λευκή ζώνη (quiet zone) γύρω από τον DataMatrix.
          svg = bwipjs.toSVG({ bcid: "gs1datamatrix", text: ai, scale: 4, padding: 4, backgroundcolor: "FFFFFF" });
        } else {
          svg = bwipjs.toSVG({ bcid: "code128", text: String(c.strip), scale: 3, height: 22, includetext: true, textsize: 12, textyoffset: 2, paddingwidth: 12, paddingheight: 8, backgroundcolor: "FFFFFF" });
        }
        ref.current.innerHTML = svg;
        const el = ref.current.querySelector("svg");
        if (el) { el.removeAttribute("width"); el.removeAttribute("height"); el.setAttribute("style", "width:100%;height:auto;display:block"); }
      } catch { /* ignore render errors */ }
    })();
    return () => { dead = true; };
  }, [isQr, gtin, c.qr_expiry, c.qr_batch, c.strip]);
  if (!isQr && !c.strip) return null;
  // Default μέγεθος οθόνης (inline)· στην εκτύπωση το #coupon-print CSS το αντικαθιστά σε mm (!important).
  return <div ref={ref} style={{ width: size ?? (isQr ? 160 : 200), maxWidth: "100%" }} className={`${isQr ? "qr-canvas" : "eof-canvas"} overflow-hidden rounded border border-slate-200 bg-white`} />;
}

// Το string που θα έβγαζε ο σκάνερ διαβάζοντας τον κωδικό — για ΑΝΤΙΓΡΑΦΗ & επικόλληση στο εμπορικό
// πρόγραμμα χωρίς σκανάρισμα. GS1: AIs χωρίς παρενθέσεις, με GS (ASCII 29) μετά από μεταβλητού μήκους AI.
const GS = String.fromCharCode(29);
function couponScanString(c: Coupon): string {
  if (c.qr_product_code) {
    const gtin = (c.qr_product_code || "").replace(/\D/g, "").padStart(14, "0").slice(-14);
    let s = `01${gtin}`;
    let lastVar = false;                       // 01 & 17 = σταθερού μήκους
    if (c.qr_expiry) { s += `17${c.qr_expiry}`; lastVar = false; }
    if (c.qr_batch) { s += `10${c.qr_batch}`; lastVar = true; }   // 10 = μεταβλητό
    if (c.strip) { s += (lastVar ? GS : "") + `21${c.strip}`; }   // GS πριν το 21 μόνο μετά από μεταβλητό AI
    return s;
  }
  return c.strip || "";
}

// Γραμμωτός κωδικός (Code-128) του barcode της συνταγής — ο φαρμακοποιός το σκανάρει για να βρει
// τη συνταγή στο εμπορικό πρόγραμμα χωρίς να πληκτρολογεί τον αριθμό.
function LinearBarcode({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    let dead = false;
    (async () => {
      try {
        const bwipjs = (await import("bwip-js")).default;
        if (dead || !ref.current) return;
        const svg = bwipjs.toSVG({ bcid: "code128", text: value, scale: 4, height: 13, includetext: true, textsize: 11, textyoffset: 2, paddingwidth: 10, paddingheight: 6, backgroundcolor: "FFFFFF" });
        ref.current.innerHTML = svg;
        const el = ref.current.querySelector("svg");
        if (el) { el.removeAttribute("width"); el.removeAttribute("height"); el.setAttribute("style", "width:100%;height:auto;display:block"); }
      } catch { /* ignore render errors */ }
    })();
    return () => { dead = true; };
  }, [value]);
  if (!value) return null;
  return <div ref={ref} className={`rx-barcode bg-white ${className ?? ""}`} />;
}

// Χαρακτηριστικά συνταγής (CDA flags) → badges + κάρτα Γνωμάτευσης. Βοηθούν τον φαρμακοποιό
// να βγάλει συμπεράσματα και τροφοδοτούν μελλοντικά KPI.
const FLAG_DEFS: [keyof PrescDetails, string, string, string][] = [
  ["chronic", "Χρόνια αγωγή", "Chronic", "bg-amber-100 text-amber-700"],
  ["high_cost", "Υψηλού κόστους", "High cost", "bg-rose-100 text-rose-700"],
  ["narcotic", "Ναρκωτικό", "Narcotic", "bg-rose-100 text-rose-700"],
  ["heparin", "Με ηπαρίνη", "Heparin", "bg-rose-100 text-rose-700"],
  ["negative_list", "Αρνητική λίστα", "Negative list", "bg-rose-100 text-rose-700"],
  ["antibiotic", "Αντιβιοτικό", "Antibiotic", "bg-orange-100 text-orange-700"],
  ["special_antibiotic", "Ειδικό αντιβιοτικό", "Special antibiotic", "bg-orange-100 text-orange-700"],
  ["n3816", "Ν.3816 (ΦΥΚ)", "Law 3816", "bg-violet-100 text-violet-700"],
  ["ifet", "ΙΦΕΤ", "ΙΦΕΤ", "bg-violet-100 text-violet-700"],
  ["ifet_import", "Εισαγωγή ΙΦΕΤ", "ΙΦΕΤ import", "bg-violet-100 text-violet-700"],
  ["vaccines", "Εμβόλια", "Vaccines", "bg-sky-100 text-sky-700"],
  ["desensitization", "Απευαισθητοποίηση", "Desensitization", "bg-sky-100 text-sky-700"],
  ["single_dose", "Μονοδοσιακό", "Single-dose", "bg-slate-100 text-slate-700"],
  ["consumables", "Με αναλώσιμα", "Consumables", "bg-slate-100 text-slate-700"],
  ["eopyy_only", "Μόνο ΕΟΠΥΥ", "EOPYY only", "bg-indigo-100 text-indigo-700"],
  ["hospital_only", "Μόνο νοσοκομείο", "Hospital only", "bg-indigo-100 text-indigo-700"],
  ["eopyy_preapproval", "Προέγκριση ΕΟΠΥΥ", "EOPYY pre-approval", "bg-indigo-100 text-indigo-700"],
  ["outside_eopyy", "Εκτός δαπάνης ΕΟΠΥΥ", "Outside EOPYY", "bg-slate-100 text-slate-700"],
  ["home_delivery", "Κατ' οίκον παράδοση", "Home delivery", "bg-emerald-100 text-emerald-700"],
  ["intangible", "Άυλη", "Intangible", "bg-slate-100 text-slate-700"],
  ["ekas", "ΕΚΑΣ", "ΕΚΑΣ", "bg-slate-100 text-slate-700"],
  ["exemption", "Απαλλαγή συμμετοχής", "Co-pay exemption", "bg-emerald-100 text-emerald-700"],
  ["supplementary_cover", "Συμπληρωματική κάλυψη", "Supplementary cover", "bg-emerald-100 text-emerald-700"],
];

function RxCharacteristics({ d }: { d?: PrescDetails | null }) {
  const t = useT();
  if (!d) return null;
  const flags = FLAG_DEFS.filter(([k]) => d[k]);
  const rxType = d.rx_type === "2" ? t("Ελεύθερη", "Free") : d.rx_type === "1" ? t("Τυπική", "Typical") : null;
  const hiv = d.hiv_type === "1" ? t("HIV — αντιρετροϊκή", "HIV — antiretroviral") : d.hiv_type === "2" ? t("HIV — προφύλαξη", "HIV — prophylaxis") : null;
  const opinionType = d.opinion_type === "1" ? t("Νοσοκομειακή", "Hospital") : d.opinion_type === "2" ? t("Ειδικότητας", "Specialty") : null;
  const hasOpinion = d.opinion && (d.opinion_doctor_name || d.opinion_date || d.opinion_specialty || d.opinion_barcode);
  if (!flags.length && !rxType && !hiv && !d.by_brand && !hasOpinion && !d.repeat_period_days) return null;
  return (
    <PanelCard title={t("Χαρακτηριστικά συνταγής", "Prescription characteristics")}>
      <div className="flex flex-wrap gap-1.5">
        {rxType ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">{rxType}</span> : null}
        {d.by_brand ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">{t("Με εμπορική ονομασία", "By brand name")}</span> : null}
        {flags.map(([k, el, en, cls]) => (
          <span key={k} className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{t(el, en)}{k === "narcotic" && d.narcotic_category ? ` (${d.narcotic_category})` : ""}</span>
        ))}
        {hiv ? <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-medium text-rose-700">{hiv}</span> : null}
        {d.repeat_period_days ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">{t(`Περίοδος επανάληψης ${d.repeat_period_days} ημ.`, `Repeat period ${d.repeat_period_days}d`)}</span> : null}
      </div>
      {hasOpinion ? (
        <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Γνωμάτευση", "Medical opinion")}{opinionType ? ` · ${opinionType}` : ""}</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
            <Field label={t("Ιατρός", "Doctor")} value={d.opinion_doctor_name} />
            <Field label={t("Ειδικότητα", "Specialty")} value={d.opinion_specialty} />
            <Field label={t("Ημ/νία", "Date")} value={d.opinion_date} />
            <Field label={t("ΑΜΚΑ ιατρού", "Doctor ΑΜΚΑ")} value={d.opinion_doctor_amka} />
            <Field label={t("Barcode", "Barcode")} value={d.opinion_barcode} />
          </div>
        </div>
      ) : null}
      {d.exemption_reason ? <div className="mt-2 text-xs text-slate-500">{t("Λόγος απαλλαγής", "Exemption reason")}: {d.exemption_reason}</div> : null}
    </PanelCard>
  );
}
type Detail = {
  external_id: string; executed_at: string; status: string | null; source: string;
  repeat_current: number; repeat_total: number; repeat_root: string | null; next_open_date: string | null;
  amount_total: number; amount_claimed: number; patient_share: number; wholesale_cost: number;
  fund_payable: number; patient_payable: number;
  icd10: string[]; icd10_named?: string[]; has_unexecuted_substances: boolean;
  doctor: { name: string | null; specialty: string | null } | null;
  fund: { name: string | null; code: string | null } | null;
  patient: { sex: string | null; birth_year: number | null; area: string | null; full_name: string | null; amka: string | null } | null;
  details?: PrescDetails | null;
  items: Item[];
  summary?: SummaryItem[];        // σύνολο όλων των εκτελέσεων της συνταγής
  execution_count?: number;
};
type SummaryItem = {
  name: string | null; category: string | null; substance: string | null;
  quantity: number; amount: number; executions: number; is_executed: boolean;
};

type IdikaLine = {
  name: string; eof_code: string | null; form: string | null; substance: string | null; atc: string | null;
  is_executed: boolean; dose: string | null; frequency: string | null; duration: string | null; lot: string | null;
  execution_price: number | null; retail_price: number | null; reference_price: number | null;
  participation_pct: number | null; patient_share: number | null; difference: number | null;
  substitution_allowed: boolean; generic: boolean;
};
type Idika = {
  details: {
    issue_date: string | null; deadline_date: string | null; fund_surcharge: boolean;
    fund_surcharge_amount: number | null; patient_share_total: number | null; fund_share_total: number | null;
    exemption: boolean; opinion: boolean;
  };
  lines: IdikaLine[];
};

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const eurR = (v: number | null) => (v == null ? "—" : new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format(v));
const dt = (s: string) => fmtDateTime(s);
// GS1 ημερομηνία λήξης (YYMMDD) → DD/MM/YYYY (ή MM/YYYY αν η μέρα είναι 00 = τέλος μήνα).
const fmtGs1Expiry = (v?: string | null) => {
  const s = (v || "").replace(/\D/g, "");
  if (s.length !== 6) return v || null;
  const yy = `20${s.slice(0, 2)}`, mm = s.slice(2, 4), dd = s.slice(4, 6);
  return dd === "00" ? `${mm}/${yy}` : `${dd}/${mm}/${yy}`;
};
const sexLabel = (s: string | null, t: T) => (s === "M" ? t("Άνδρας", "Male") : s === "F" ? t("Γυναίκα", "Female") : "—");
const yesNo = (v: boolean | null | undefined, t: T) => (v == null ? null : v ? t("Ναι", "Yes") : t("Όχι", "No"));
// Human-readable posology (ΗΔΥΚΑ CDA spec frequency table): «12 h»→«2 φορές/ημέρα» κ.λπ.
const _FREQ: Record<string, string> = {
  "2 wk": "κάθε 2 εβδομάδες", "1 wk": "1 φορά/εβδομάδα", "1 d": "1 φορά/ημέρα",
  "4 d": "2 φορές/εβδομάδα", "2 d": "3 φορές/εβδομάδα", "12 h": "2 φορές/ημέρα",
  "8 h": "3 φορές/ημέρα", "6 h": "4 φορές/ημέρα", "1 once": "εφάπαξ",
  "1 pain": "επί πόνου", "1 dyspnea": "επί δύσπνοιας", "1 without": "άνευ",
};
const _UNIT: Record<string, string> = { h: "ώρες", d: "ημέρες", wk: "εβδομάδες", mo: "μήνες" };
const _qty = (v?: string | null): [string, string] | null => {
  const m = /([\d.]+)\s*([A-Za-z]+)/.exec(v || "");
  if (!m) return null;
  const f = parseFloat(m[1]);
  return [isNaN(f) ? m[1] : String(Math.round(f)), m[2]];
};
const fmtDosage = (dose?: string | null, freq?: string | null, dur?: string | null): string | null => {
  const parts: string[] = [];
  if (dose) parts.push(String(dose).replace(/_/g, " ").trim());
  const fq = _qty(freq);
  if (fq) parts.push(_FREQ[`${fq[0]} ${fq[1]}`] || `κάθε ${fq[0]} ${_UNIT[fq[1]] || fq[1]}`);
  const dq = _qty(dur);
  if (dq) parts.push(`για ${dq[0]} ${_UNIT[dq[1]] || dq[1]}`);
  return parts.length ? parts.join(" · ") : null;
};
const hasStoredHdyka = (d: Detail) =>
  !!(d.details && Object.keys(d.details).length) || d.items.some((i) => i.details && Object.keys(i.details).length);

type RxCheck = { type: string; level: string; title: string; detail: string };
type ChecksRes = { items: { name: string; barcode: string | null; checks: RxCheck[] }[]; count: number; warnings: number };

function ClosingChecks({ id, t }: { id: string; t: (el: string, en: string) => string }) {
  const qc = useQueryClient();
  const checks = useQuery({ queryKey: ["rx-checks", id], queryFn: () => api<ChecksRes>(`/prescriptions/checks/${encodeURIComponent(id)}`), retry: false });
  const settings = useQuery({ queryKey: ["rx-check-settings"], queryFn: () => api<{ ultra_levure_check: boolean }>("/prescriptions/check-settings"), retry: false });
  const data = checks.data;
  async function toggleUL() {
    await api("/prescriptions/check-settings", { method: "POST", body: JSON.stringify({ ultra_levure_check: !(settings.data?.ultra_levure_check ?? true) }) });
    qc.invalidateQueries({ queryKey: ["rx-check-settings"] });
    qc.invalidateQueries({ queryKey: ["rx-checks", id] });
  }
  const hasUL = !!data?.items.some((it) => it.checks.some((c) => c.type === "ultra_levure"));
  if (!data || data.count === 0) return null;
  return (
    <div className={`mb-4 rounded-2xl border p-4 ${data.warnings ? "border-amber-300 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20" : "border-sky-200 bg-sky-50/60 dark:border-sky-900/50 dark:bg-sky-950/20"}`}>
      <div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100">
        🔎 {t("Έλεγχος κλεισίματος", "Closing checks")}
        {data.warnings > 0 && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">{data.warnings} {t("προσοχή", "to review")}</span>}
      </div>
      <div className="space-y-2.5">
        {data.items.map((it, i) => (
          <div key={i}>
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">{it.name}</div>
            <div className="mt-1 space-y-1">
              {it.checks.map((c, j) => (
                <div key={j} className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs ${c.level === "warning" ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "bg-white text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"}`}>
                  <span className="mt-0.5 shrink-0">{c.level === "warning" ? "⚠️" : "ℹ️"}</span>
                  <span><b>{c.title}.</b> {c.detail}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {hasUL && (
        <div className="mt-2.5 flex items-center justify-between border-t border-amber-200/60 pt-2 text-[11px] text-slate-500 dark:border-amber-900/40">
          <span>{t("Έλεγχος Ultra-Levure (παραμετρικός)", "Ultra-Levure check (optional)")}</span>
          <button onClick={toggleUL} className={`rounded-full px-2.5 py-0.5 font-semibold ${settings.data?.ultra_levure_check ?? true ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}>
            {settings.data?.ultra_levure_check ?? true ? t("Ενεργός — απενεργοποίηση", "On — turn off") : t("Ανενεργός — ενεργοποίηση", "Off — turn on")}
          </button>
        </div>
      )}
    </div>
  );
}

export default function PrescriptionDetailPage() {
  const t = useT();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["rx-detail", id],
    queryFn: () => api<Detail>(`/prescriptions/detail/${encodeURIComponent(id)}`),
    retry: false,
  });

  // «Πελάτης παρουσίασης» → κλειδώνουμε εκτυπώσεις ΗΔΥΚΑ & κουπονιών (δεν τυπώνουμε πραγματικά έγγραφα σε demo).
  const { data: me } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<{ demo?: boolean }>("/auth/me"), retry: false });
  const demo = !!me?.demo;

  const idika = useQuery({
    queryKey: ["rx-idika", id],
    queryFn: () => api<Idika>(`/prescriptions/idika/${encodeURIComponent(id)}`),
    // Auto-fetch live ONLY when the details aren't stored yet (pre re-download). Once stored,
    // the section renders from the DB with no ΗΔΥΚΑ call.
    enabled: !!data && !hasStoredHdyka(data),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const [lineTab, setLineTab] = useState<"exec" | "summary" | "unexec">("exec");
  const [coupon, setCoupon] = useState<Item | null>(null);
  const [couponSheet, setCouponSheet] = useState(false);
  const [execSheet, setExecSheet] = useState(false);
  // αντιγραφή κωδικού κουπονιού στο πρόχειρο (αντί σκαναρίσματος από οθόνη)
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  async function copyCoupon(c: Coupon) {
    const s = couponScanString(c);
    try { await navigator.clipboard.writeText(s); } catch { /* clipboard μη διαθέσιμο */ }
    setCopiedKey(s); setTimeout(() => setCopiedKey((k) => (k === s ? null : k)), 1600);
  }
  // χαρτί εκτύπωσης κουπονιών: A4 φύλλο ή θερμικό ρολό 80/58mm (αποθηκεύεται)
  const [paper, setPaper] = useState<"a4" | "th80" | "th58">("a4");
  useEffect(() => { const p = typeof window !== "undefined" && localStorage.getItem("rxv_coupon_paper"); if (p === "a4" || p === "th80" || p === "th58") setPaper(p); }, []);
  function pickPaper(p: "a4" | "th80" | "th58") { setPaper(p); localStorage.setItem("rxv_coupon_paper", p); }

  if (isLoading) return <div className="text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;
  if (!data) return <div className="text-slate-500">{t("Η συνταγή δεν βρέθηκε.", "Prescription not found.")}</div>;

  const d = data;
  const age = d.patient?.birth_year ? new Date().getFullYear() - d.patient.birth_year : null;
  const profit = d.amount_total - d.wholesale_cost;
  // repeat_current/repeat_total now come straight from the ΗΔΥΚΑ CDA (1.1.4 = planned count,
  // 1.1.4.1 = position), so "X/Y" is authoritative even when sibling barcodes aren't synced.
  const recurring = d.repeat_total > 1;
  // Το wholesale_cost κλιμακώνεται πλέον στο authoritative λιανική αξία (ανά εκτέλεση), οπότε
  // το μεικτό κέρδος είναι έγκυρο όποτε έχουμε εκτίμηση χονδρικής (>0).
  const marginReliable = d.wholesale_cost > 0;

  // BLOCK 2 tabs + BLOCK 3 coupon popup (hooks declared before the early returns above)
  const executed = d.items.filter((it) => it.is_executed);
  const unexecuted = d.items.filter((it) => !it.is_executed || (it.details?.outstanding ?? 0) > 0);
  // πλήθος κουπονιών (ανά τεμάχιο) σε ΑΥΤΗ την εκτέλεση — όχι ανά γραμμή
  const allCoupons = executed.flatMap(couponsOf);
  const qrCount = allCoupons.filter((c) => c.qr).length;
  const eofCount = allCoupons.filter((c) => !c.qr && c.strip).length;
  // flat list με όνομα φαρμάκου, ταξινομημένο QR → ΕΟΦ για την εκτύπωση κουπονιών
  const flatCoupons = executed.flatMap((it) => couponsOf(it).map((c) => ({ c, name: it.name })));
  const qrCoupons = flatCoupons.filter((x) => x.c.qr);
  const eofCoupons = flatCoupons.filter((x) => !x.c.qr && x.c.strip);

  // Fetch the official ΗΔΥΚΑ PDF (auth header can't ride a plain window.open, so fetch as a blob).
  const openIdikaPrint = async () => {
    const base = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";
    const token = typeof window !== "undefined" ? window.localStorage.getItem("access_token") : null;
    try {
      const res = await fetch(`${base}/prescriptions/idika-print/${encodeURIComponent(id)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) { appAlert(t("Το έντυπο ΗΔΥΚΑ δεν είναι διαθέσιμο.", "ΗΔΥΚΑ printout unavailable.")); return; }
      window.open(URL.createObjectURL(await res.blob()), "_blank");
    } catch { appAlert(t("Αποτυχία λήψης εντύπου ΗΔΥΚΑ.", "Failed to fetch ΗΔΥΚΑ printout.")); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t("Πίσω", "Back")}
        </button>
        <div className="flex items-center gap-2">
          {/* Σε «πελάτη παρουσίασης» κρύβουμε τις εκτυπώσεις ΗΔΥΚΑ & κουπονιών (όχι πραγματικά έγγραφα σε demo). */}
          {!demo && (
            <button onClick={openIdikaPrint} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100">
              <Printer className="h-4 w-4" /> {t("Εκτύπωση ΗΔΥΚΑ", "ΗΔΥΚΑ printout")}
            </button>
          )}
          <button onClick={() => setExecSheet(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Printer className="h-4 w-4" /> {t("Εκτύπωση εκτέλεσης", "Print execution")}
          </button>
          {!demo && executed.some((it) => couponsOf(it).length) ? (
            <button onClick={() => setCouponSheet(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <QrCode className="h-4 w-4" /> {t("Εκτύπωση κουπονιών", "Print coupons")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-1.5 text-xl font-bold text-slate-900">
          <span>{t("Συνταγή", "Prescription")} {d.external_id}</span>
          <CopyButton value={d.external_id.split(":")[0]} className="!p-1" />
        </h1>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">{d.status || t("ΕΚΤΕΛΕΣΜΕΝΗ", "EXECUTED")}</span>
          {recurring && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">
              <Repeat className="h-3.5 w-3.5" /> {t(`Επανάληψη ${d.repeat_current}/${d.repeat_total}`, `Repeat ${d.repeat_current}/${d.repeat_total}`)}
            </span>
          )}
          {d.details?.interval_months ? (
            <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">{d.details.interval_months === 2 ? t("Δίμηνη", "Bi-monthly") : t("Μηνιαία", "Monthly")}</span>
          ) : null}
          {d.details?.chronic ? (
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">{t("Χρόνια αγωγή", "Chronic")}</span>
          ) : null}
        </div>
      </div>

      <ClosingChecks id={id} t={t} />

      {/* Πληρωτέο από Ταμείο — the headline number (what the pharmacy collects from the fund) */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-600 px-5 py-4 text-white">
        <div>
          <div className="text-xs uppercase tracking-wide text-brand-100">{t("Πληρωτέο από Ταμείο", "Payable by Fund")}</div>
          <div className="text-xs text-brand-200">{t("Τι έχει να εισπράξει το φαρμακείο από το ταμείο", "What the pharmacy collects from the fund")}</div>
        </div>
        <div className="text-3xl font-extrabold">{eur(d.fund_payable)}</div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          [t("Σύνολο αξίας", "Total value"), eur(d.amount_total)],
          [t("Πληρωτέο από Ασφ/νο", "Payable by patient"), eur(d.patient_payable)],
          [t("Χονδρικό κόστος", "Wholesale cost"), marginReliable ? eur(d.wholesale_cost) : t("Ν/Α", "N/A")],
          [t("Μεικτό κέρδος", "Gross profit"), marginReliable ? eur(profit) : t("Ν/Α", "N/A")],
        ].map(([l, v]) => (
          <div key={l} className="rx-card p-4">
            <div className="text-xs text-slate-400">{l}</div>
            <div className="mt-1 text-lg font-bold text-slate-900">{v}</div>
          </div>
        ))}
      </div>
      {/* ΚΥΥΑΠ (ΕΤΥΑΠ σωμάτων ασφαλείας): τριμερής επιμερισμός Ασφ/νος · ΚΥΥΑΠ · ΕΟΠΥΥ */}
      {d.details?.kyyap_covered ? (
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="rounded-lg bg-amber-50 px-3 py-1.5 font-medium text-amber-700">{t("Από Ασφ/νο", "From patient")}: {eur(d.patient_payable)}</span>
          <span className="rounded-lg bg-violet-50 px-3 py-1.5 font-medium text-violet-700">{t("Από ΚΥΥΑΠ", "From ΚΥΥΑΠ")}: {eur(d.details.kyyap_covered)}</span>
          <span className="rounded-lg bg-brand-50 px-3 py-1.5 font-medium text-brand-700">{t("Από ΕΟΠΥΥ", "From ΕΟΠΥΥ")}: {eur(d.fund_payable - d.details.kyyap_covered)}</span>
        </div>
      ) : null}
      {marginReliable ? (
        <div className="-mt-2 text-xs text-slate-400">
          {t("Η χονδρική τιμή εκτιμάται από την επίσημη κλιμακωτή διατίμηση (μεικτό κέρδος φαρμακείου ανά τιμή) — ενδεικτικό.",
             "Wholesale price is estimated from the official progressive markup scale — indicative.")}
        </div>
      ) : (
        <div className="-mt-2 text-xs text-slate-400">
          {t("Χονδρικό κόστος & μεικτό κέρδος: Ν/Α — γαληνικό/μαγιστρικό σκεύασμα (δεν ισχύει η κανονική διατίμηση & δεν έχουμε χονδρική τιμή).",
             "Wholesale cost & gross profit: N/A — galenic/compounded preparation (standard pricing doesn't apply and no wholesale price is available).")}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <PanelCard title={t("Ιατρός", "Doctor")}>
          <div className="text-sm font-semibold text-slate-800">{d.doctor?.name || t("Άγνωστος", "Unknown")}</div>
          <div className="text-xs text-slate-500">{d.doctor?.specialty || "—"}</div>
        </PanelCard>
        <PanelCard title={t("Ασθενής", "Patient")}>
          <div className="text-sm font-semibold text-slate-800">{d.patient?.full_name || t("—", "—")}</div>
          <div className="text-xs text-slate-500">{sexLabel(d.patient?.sex ?? null, t)}{age ? t(`, ${age} ετών`, `, ${age} years old`) : ""}{d.patient?.amka ? ` · ΑΜΚΑ ${d.patient.amka}` : ""}</div>
          <div className="text-xs text-slate-500">{d.patient?.area || "—"} · {t("Ταμείο", "Fund")}: {d.fund?.name || "—"}</div>
        </PanelCard>
        <PanelCard title={t("Συνταγή", "Prescription")}>
          <div className="text-sm text-slate-700">{t("Εκτέλεση", "Execution")}: {dt(d.executed_at)}</div>
          <div className="text-xs text-slate-500">
            {recurring ? t(`Επανάληψη ${d.repeat_current}/${d.repeat_total}`, `Repeat ${d.repeat_current}/${d.repeat_total}`)
              : d.execution_count && d.execution_count > 1 ? t(`${d.execution_count} εκτελέσεις`, `${d.execution_count} executions`)
              : t("Μία εκτέλεση", "Single execution")}
            {d.next_open_date ? t(` · Επόμενη: ${fmtDate(d.next_open_date)}`, ` · Next: ${fmtDate(d.next_open_date)}`) : ""}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {(d.icd10_named ?? d.icd10 ?? []).map((c, i) => (
              <span key={i} className="rounded bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">{c}</span>
            ))}
          </div>
        </PanelCard>
      </div>

      {/* repeat tree — all executions of this prescription's barcode */}
      <RepeatTree externalId={id} />

      {/* Χαρακτηριστικά συνταγής (CDA flags) — βοηθούν τον φαρμακοποιό + τροφοδοτούν KPI */}
      <RxCharacteristics d={d.details} />

      {/* Φάρμακα — tabs: Εκτέλεση (αυτή η εκτέλεση) / Συνοπτικά (όλη η συνταγή) / Ανεκτέλεστα */}
      <PanelCard title={t("Φάρμακα", "Medicines")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-slate-200 p-1 text-sm dark:border-slate-700">
            {([["exec", t("Εκτέλεση", "Execution")],
               ["summary", `${t("Συνοπτικά", "Summary")}${d.execution_count && d.execution_count > 1 ? ` (${d.execution_count})` : ""}`],
               ["unexec", `${t("Ανεκτέλεστα", "Unexecuted")}${unexecuted.length ? ` (${unexecuted.length})` : ""}`]] as ["exec" | "summary" | "unexec", string][]).map(([k, label]) => (
              <button key={k} onClick={() => setLineTab(k)}
                className={`rounded-lg px-3 py-1.5 font-medium transition ${lineTab === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300"}`}>{label}</button>
            ))}
          </div>
          {lineTab === "exec" && (qrCount || eofCount) ? (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800">{qrCount} QR · {eofCount} ΕΟΦ</span>
          ) : null}
        </div>
        {/* διαγνώσεις (γενικά) — κωδικός + τίτλος */}
        {(d.icd10_named?.length || d.icd10?.length) ? (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(d.icd10_named ?? d.icd10 ?? []).map((c, i) => (
              <span key={i} className="rounded bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">{c}</span>
            ))}
          </div>
        ) : null}
        <div className="space-y-2">
          {/* Συνοπτικά = άθροισμα ΟΛΩΝ των εκτελέσεων της συνταγής (όχι μόνο αυτής) */}
          {lineTab === "summary" ? (d.summary ?? []).map((s, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className={`font-semibold ${s.is_executed ? "text-slate-800 dark:text-slate-100" : "text-slate-500"}`}>{s.name || "—"}</span>
                  <CategoryBadge category={s.category} />
                </span>
                <span className="shrink-0 text-sm text-slate-600">×{s.quantity}{s.amount != null && <span className="ml-2 font-medium text-slate-800 dark:text-slate-100">{eur(s.amount)}</span>}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">{[s.substance, `${s.executions} ${s.executions === 1 ? t("εκτέλεση", "execution") : t("εκτελέσεις", "executions")}`].filter(Boolean).join(" · ")}</div>
            </div>
          )) : (lineTab === "exec" ? executed : unexecuted).map((it, i) => {
            const ln = it.details || {};
            const out = ln.outstanding ?? 0;
            const cps = couponsOf(it);
            const isQr = cps[0]?.qr;
            return (
              <div key={i} className={`rounded-xl border p-3 ${it.is_executed ? "border-slate-200 dark:border-slate-700" : "border-slate-300 bg-slate-50 dark:bg-slate-800/60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={`font-semibold ${it.is_executed ? "text-slate-800 dark:text-slate-100" : "text-slate-500"}`}>{it.name || "—"}</span>
                    {it.atc && <span className="text-[10px] text-slate-400">{it.atc}</span>}
                    <CategoryBadge category={it.category} />
                    {it.is_executed && cps.length ? (
                      <button onClick={() => setCoupon(it)}
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isQr ? "bg-sky-50 text-sky-700 hover:bg-sky-100" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}>
                        {cps.length > 1 ? `${cps.length} ` : ""}{isQr ? "QR" : "ΕΟΦ"} ↗
                      </button>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-sm text-slate-600">
                    {lineTab === "unexec"
                      ? <span className="font-semibold text-amber-700">{t("Υπόλοιπο", "Remaining")}: {out || it.quantity}</span>
                      : <>×{it.quantity}{ln.retail_price != null && <span className="ml-2 font-medium text-slate-800 dark:text-slate-100">{eur(ln.retail_price)}</span>}</>}
                  </span>
                </div>
                {lineTab !== "unexec" && (it.substance || fmtDosage(ln.dose, ln.frequency, ln.duration)) ? (
                  <div className="mt-1 text-xs text-slate-500">{[it.substance, fmtDosage(ln.dose, ln.frequency, ln.duration)].filter(Boolean).join(" · ")}</div>
                ) : null}
              </div>
            );
          })}
          {(lineTab === "summary" ? (d.summary ?? []) : lineTab === "exec" ? executed : unexecuted).length === 0 && (
            <div className="py-6 text-center text-sm text-slate-400">
              {lineTab === "unexec" ? t("Δεν υπάρχουν ανεκτέλεστα φάρμακα.", "No unexecuted medicines.")
                : lineTab === "summary" ? t("Δεν υπάρχουν εκτελέσεις.", "No executions.")
                : t("Δεν υπάρχουν γραμμές φαρμάκων.", "No medicine lines.")}
            </div>
          )}
        </div>
      </PanelCard>

      {/* Full ΗΔΥΚΑ details — ALWAYS shown, from the stored data (no button). Falls back to a live
          fetch only while a prescription's details aren't stored yet (i.e. before the re-download). */}
      <PanelCard title={t("Πλήρη στοιχεία ΗΔΥΚΑ", "Full ΗΔΥΚΑ details")}>
        {hasStoredHdyka(d) ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
              <Field label={t("Ημ/νία έκδοσης", "Issue date")} value={d.details?.issue_date} />
              <Field label={t("Προθεσμία εκτέλεσης", "Execution deadline")} value={d.details?.deadline_date} />
              <Field label={t("Επιβάρυνση 1€", "€1 surcharge")} value={yesNo(d.details?.fund_surcharge, t)} />
              <Field label={t("Απαλλαγή συμμετοχής", "Co-payment exemption")} value={yesNo(d.details?.exemption, t)} />
              <Field label={t("Γνωμάτευση", "Opinion")} value={yesNo(d.details?.opinion, t)} />
              <Field label={t("Συμμετοχή ασθενή (σύν.)", "Patient share (total)")} value={d.details?.patient_share_total != null ? eur(d.details.patient_share_total) : null} />
              <Field label={t("Από ταμείο (σύν.)", "From fund (total)")} value={d.details?.fund_share_total != null ? eur(d.details.fund_share_total) : null} />
              <Field label={t("Διαφορά ΚΥΥΑΠ", "ΚΥΥΑΠ difference")} value={d.details?.kyyap_difference != null ? eur(d.details.kyyap_difference) : null} />
              <Field label={t("Συμπληρωματική κάλυψη", "Supplementary cover")} value={d.details?.supplementary_amount != null ? eur(d.details.supplementary_amount) : null} />
              <Field label={t("Πλήθος εκτελέσεων", "Execution count")} value={d.details?.exec_count != null ? String(d.details.exec_count) : null} />
              <Field label={t("Id επίσκεψης", "Visit Id")} value={d.details?.visit_id} />
            </div>
            <div className="space-y-3">
              {d.items.map((it, i) => {
                const ln = it.details || {};
                return (
                  <div key={i} className={`rounded-xl border p-4 ${it.is_executed ? "border-slate-200" : "border-slate-300 bg-slate-100 dark:bg-slate-800/60"}`}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${it.is_executed ? "text-slate-800" : "text-slate-500"}`}>{it.name}</span>
                      {it.atc && <span className="text-[10px] text-slate-400">{it.atc}</span>}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${it.is_executed ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{it.is_executed ? t("Εκτελέστηκε", "Executed") : t("Δεν εκτελέστηκε", "Not executed")}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
                      <Field label={t("Δραστική", "Active substance")} value={it.substance} />
                      <Field label={t("Μορφή", "Form")} value={ln.form} />
                      <Field label={t("Ποσότητα", "Quantity")} value={String(it.quantity)} />
                      <Field label={t("Δοσολογία", "Dosage")} value={fmtDosage(ln.dose, ln.frequency, ln.duration)} />
                      <Field label={t("Ταινία γνησιότητας", "Authenticity strip")} value={ln.strip || ln.lot} />
                      <Field label={t("Τιμή εκτέλεσης", "Execution price")} value={ln.execution_price != null ? eur(ln.execution_price) : null} />
                      <Field label={t("Τιμή λιανικής", "Retail price")} value={ln.retail_price != null ? eur(ln.retail_price) : null} />
                      <Field label={t("Τιμή αναφοράς", "Reference price")} value={ln.reference_price != null ? eur(ln.reference_price) : null} />
                      <Field label={t("Συμμετοχή %", "Co-payment %")} value={ln.participation_pct != null ? `${ln.participation_pct}%` : null} />
                      <Field label={t("Διαφορά", "Difference")} value={ln.difference != null ? eur(ln.difference) : null} />
                      <Field label={t("Τύπος κουπονιού", "Coupon type")} value={ln.qr ? "QR" : ln.strip ? t("Ταινία", "Strip") : null} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : idika.isLoading ? (
          <div className="py-6 text-center text-sm text-slate-400">{t("Άντληση από ΗΔΥΚΑ…", "Fetching from ΗΔΥΚΑ…")}</div>
        ) : idika.isError || !idika.data ? (
          <div className="py-4 text-sm text-rose-600">{t("Αποτυχία άντλησης από ΗΔΥΚΑ.", "Failed to fetch from ΗΔΥΚΑ.")} <button onClick={() => idika.refetch()} className="underline">{t("Δοκίμασε ξανά", "Try again")}</button></div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
              <Field label={t("Ημ/νία έκδοσης", "Issue date")} value={idika.data.details.issue_date} />
              <Field label={t("Προθεσμία εκτέλεσης", "Execution deadline")} value={idika.data.details.deadline_date} />
              <Field label={t("Επιβάρυνση 1€", "€1 surcharge")} value={yesNo(idika.data.details.fund_surcharge, t)} />
              <Field label={t("Απαλλαγή συμμετοχής", "Co-payment exemption")} value={yesNo(idika.data.details.exemption, t)} />
              <Field label={t("Γνωμάτευση", "Opinion")} value={yesNo(idika.data.details.opinion, t)} />
              <Field label={t("Συμμετοχή ασθενή (σύν.)", "Patient share (total)")} value={eurR(idika.data.details.patient_share_total)} />
              <Field label={t("Από ταμείο (σύν.)", "From fund (total)")} value={eurR(idika.data.details.fund_share_total)} />
            </div>
            <div className="space-y-3">
              {idika.data.lines.map((ln, i) => (
                <div key={i} className={`rounded-xl border p-4 ${ln.is_executed ? "border-slate-200" : "border-slate-300 bg-slate-100 dark:bg-slate-800/60"}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`font-semibold ${ln.is_executed ? "text-slate-800" : "text-slate-500"}`}>{ln.name}</span>
                    {ln.atc && <span className="text-[10px] text-slate-400">{ln.atc}</span>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${ln.is_executed ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{ln.is_executed ? t("Εκτελέστηκε", "Executed") : t("Δεν εκτελέστηκε", "Not executed")}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
                    <Field label={t("Δραστική", "Active substance")} value={ln.substance} />
                    <Field label={t("Μορφή", "Form")} value={ln.form} />
                    <Field label={t("Δοσολογία", "Dosage")} value={fmtDosage(ln.dose, ln.frequency, ln.duration)} />
                    <Field label={t("Ταινία γνησιότητας", "Authenticity strip")} value={ln.lot} />
                    <Field label={t("Τιμή εκτέλεσης", "Execution price")} value={eurR(ln.execution_price)} />
                    <Field label={t("Τιμή λιανικής", "Retail price")} value={eurR(ln.retail_price)} />
                    <Field label={t("Τιμή αναφοράς", "Reference price")} value={eurR(ln.reference_price)} />
                    <Field label={t("Συμμετοχή %", "Co-payment %")} value={ln.participation_pct != null ? `${ln.participation_pct}%` : null} />
                    <Field label={t("Διαφορά", "Difference")} value={eurR(ln.difference)} />
                    <Field label={t("Αντικατάσταση", "Substitution")} value={ln.substitution_allowed ? t("Επιτρέπεται", "Allowed") : t("Όχι", "No")} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </PanelCard>

      {/* BLOCK 3 — αναλυτικά κουπόνι (QR / ΕΟΦ) που εκτελέστηκε σε αυτή τη γραμμή */}
      {coupon ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCoupon(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t("Στοιχεία κουπονιού", "Coupon details")}</h3>
              <button onClick={() => setCoupon(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>
            <div className="mb-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              {coupon.name}
              <span className="ml-2 text-xs font-normal text-slate-400">×{coupon.quantity} · {couponsOf(coupon).length} {couponsOf(coupon).length === 1 ? t("κουπόνι", "coupon") : t("κουπόνια", "coupons")}</span>
            </div>
            {/* ΕΝΑ κουπόνι ανά εκτελεσμένο τεμάχιο, με τον πραγματικό GS1 DataMatrix (EU FMD) */}
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {couponsOf(coupon).map((c, ci) => (
                <div key={ci} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800">#{ci + 1}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${c.qr ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}>{c.qr ? "QR (HMVS)" : t("Ταινία ΕΟΦ", "ΕΟΦ strip")}</span>
                  </div>
                  <div className="flex justify-center rounded-lg bg-white p-2">
                    <CouponBarcode c={c} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                    <Field label={t("Serial", "Serial")} value={c.strip} />
                    {c.qr ? (<>
                      <Field label={t("Κωδικός προϊόντος (GTIN)", "Product code (GTIN)")} value={c.qr_product_code} />
                      <Field label={t("Παρτίδα", "Batch")} value={c.qr_batch} />
                      <Field label={t("Λήξη", "Expiry")} value={fmtGs1Expiry(c.qr_expiry)} />
                    </>) : null}
                  </div>
                </div>
              ))}
              {couponsOf(coupon).length === 0 ? (
                <div className="py-4 text-center text-sm text-slate-400">{t("Δεν υπάρχουν στοιχεία κουπονιού.", "No coupon data.")}</div>
              ) : null}
            </div>
            {couponsOf(coupon).length > 0 && couponsOf(coupon).length < coupon.quantity ? (
              <p className="mt-3 text-xs text-slate-400">{t(`Εμφανίζονται ${couponsOf(coupon).length} από ${coupon.quantity} τεμάχια — τα υπόλοιπα συμπληρώνονται με τον πλήρη συγχρονισμό.`, `Showing ${couponsOf(coupon).length} of ${coupon.quantity} units — the rest fill in after full sync.`)}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Καθαρό φύλλο εκτύπωσης ΕΚΤΕΛΕΣΗΣ (A4) — όχι print-screen· κρύβει όλη την εφαρμογή και τυπώνει μόνο το #exec-print */}
      {execSheet ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4 print:static print:bg-white print:p-0" onClick={() => setExecSheet(false)}>
          <style jsx global>{`
            #exec-print .rx-barcode { width: 230px; height: auto; }
            @media print {
              @page { size: A4; margin: 14mm; }
              body * { visibility: hidden !important; }
              #exec-print, #exec-print * { visibility: visible !important; }
              #exec-print { position: absolute; left: 0; top: 0; width: 100%; color: #000; }
              #exec-print .rx-barcode { width: 60mm !important; height: auto !important; }
              .no-print { display: none !important; }
            }
          `}</style>
          <div id="exec-print" className="mx-auto max-w-3xl rounded-2xl bg-white p-8 text-slate-900 shadow-xl print:max-w-full print:rounded-none print:p-0 print:shadow-none" onClick={(e) => e.stopPropagation()}>
            {/* header */}
            <div className="mb-5 flex items-start justify-between gap-3 border-b border-slate-300 pb-4">
              <div>
                <div className="text-lg font-extrabold tracking-tight">RxVision</div>
                <h3 className="mt-1 text-base font-bold">{t("Εκτέλεση συνταγής", "Prescription execution")}</h3>
                <div className="font-mono text-sm text-slate-600">{d.external_id}</div>
                {/* γραμμωτός κωδικός για σκανάρισμα στο εμπορικό πρόγραμμα */}
                <LinearBarcode value={d.external_id.split(":")[0]} className="mt-1.5" />
              </div>
              <div className="text-right text-xs text-slate-500">
                <div>{t("Ημ/νία εκτέλεσης", "Execution date")}: <b className="text-slate-800">{dt(d.executed_at)}</b></div>
                <div>{t("Κατάσταση", "Status")}: {d.status || t("ΕΚΤΕΛΕΣΜΕΝΗ", "EXECUTED")}</div>
                {recurring ? <div>{t(`Επανάληψη ${d.repeat_current}/${d.repeat_total}`, `Repeat ${d.repeat_current}/${d.repeat_total}`)}</div> : null}
              </div>
              <div className="no-print flex items-center gap-2">
                <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100"><Printer className="h-4 w-4" /> {t("Εκτύπωση", "Print")}</button>
                <button onClick={() => setExecSheet(false)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
              </div>
            </div>

            {/* amounts */}
            <div className="mb-5 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg border border-slate-300 p-3">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{t("Σύνολο αξίας", "Total value")}</div>
                <div className="mt-0.5 text-lg font-bold">{eur(d.amount_total)}</div>
              </div>
              <div className="rounded-lg border border-slate-300 p-3">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{t("Πληρωτέο από Ασφ/νο", "Payable by patient")}</div>
                <div className="mt-0.5 text-lg font-bold">{eur(d.patient_payable)}</div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-50 p-3">
                <div className="text-[10px] uppercase tracking-wide text-slate-600">{t("Πληρωτέο από Ταμείο", "Payable by Fund")}</div>
                <div className="mt-0.5 text-lg font-extrabold">{eur(d.fund_payable)}</div>
              </div>
            </div>

            {/* doctor / patient */}
            <div className="mb-5 grid grid-cols-2 gap-4 text-sm">
              <div className="rounded-lg border border-slate-300 p-3">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t("Ιατρός", "Doctor")}</div>
                <div className="font-semibold">{d.doctor?.name || t("Άγνωστος", "Unknown")}</div>
                <div className="text-xs text-slate-600">{d.doctor?.specialty || "—"}</div>
              </div>
              <div className="rounded-lg border border-slate-300 p-3">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t("Ασθενής", "Patient")}</div>
                <div className="font-semibold">{d.patient?.full_name || "—"}</div>
                <div className="text-xs text-slate-600">{sexLabel(d.patient?.sex ?? null, t)}{age ? t(`, ${age} ετών`, `, ${age} y`) : ""}{d.patient?.amka ? ` · ΑΜΚΑ ${d.patient.amka}` : ""}</div>
                <div className="text-xs text-slate-600">{t("Ταμείο", "Fund")}: {d.fund?.name || "—"}</div>
              </div>
            </div>

            {/* diagnoses */}
            {(d.icd10_named?.length || d.icd10?.length) ? (
              <div className="mb-4 text-sm">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t("Διαγνώσεις (ICD-10)", "Diagnoses (ICD-10)")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {(d.icd10_named ?? d.icd10 ?? []).map((c, i) => (
                    <span key={i} className="rounded border border-slate-300 px-2 py-0.5 text-[11px]">{c}</span>
                  ))}
                </div>
              </div>
            ) : null}

            {/* medicines table */}
            <div className="mb-4">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t("Φάρμακα εκτέλεσης", "Executed medicines")}</div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b-2 border-slate-400 text-left text-[11px] uppercase text-slate-500">
                    <th className="py-1.5 pr-2">{t("Φάρμακο", "Medicine")}</th>
                    <th className="py-1.5 px-1 text-center">{t("Ποσ.", "Qty")}</th>
                    <th className="py-1.5 px-1 text-right">{t("Αξία", "Value")}</th>
                    <th className="py-1.5 px-1 text-right">{t("Ασφ/νος", "Patient")}</th>
                    <th className="py-1.5 pl-1 text-right">{t("Ταμείο", "Fund")}</th>
                  </tr>
                </thead>
                <tbody>
                  {executed.map((it, i) => (
                    <tr key={i} className="border-b border-slate-200 align-top">
                      <td className="py-1.5 pr-2">
                        <div className="font-medium">{it.name || "—"}</div>
                        {it.substance ? <div className="text-[11px] text-slate-500">{it.substance}</div> : null}
                      </td>
                      <td className="py-1.5 px-1 text-center">{it.quantity}</td>
                      <td className="py-1.5 px-1 text-right">{eur(it.retail_price)}</td>
                      <td className="py-1.5 px-1 text-right">{eur(it.patient_share)}</td>
                      <td className="py-1.5 pl-1 text-right font-medium">{eur(it.fund_share)}</td>
                    </tr>
                  ))}
                  {executed.length === 0 ? (
                    <tr><td colSpan={5} className="py-3 text-center text-slate-400">{t("Καμία γραμμή εκτέλεσης.", "No executed lines.")}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="mt-6 border-t border-slate-300 pt-3 text-[10px] text-slate-400">
              {t("Εκτυπώθηκε από RxVision", "Printed by RxVision")} · {fmtDateTime(new Date().toISOString())}
            </div>
          </div>
        </div>
      ) : null}

      {/* Φύλλο εκτύπωσης κουπονιών (QR/ΕΟΦ) της ΤΡΕΧΟΥΣΑΣ εκτέλεσης — barcode + serial σε ΠΡΑΓΜΑΤΙΚΟ μέγεθος (mm),
          με επιλογή χαρτιού: A4 φύλλο ή θερμικό ρολό 80/58mm (αποδείξεων). */}
      {couponSheet ? (() => {
        const P = ({
          a4:   { page: "A4",        margin: "10mm", qr: 25, eof: 58, col: false, label: "A4" },
          th80: { page: "72mm auto", margin: "3mm",  qr: 26, eof: 64, col: true,  label: "80mm" },
          th58: { page: "48mm auto", margin: "2mm",  qr: 22, eof: 44, col: true,  label: "58mm" },
        } as const)[paper];
        return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4 print:static print:bg-white print:p-0" onClick={() => setCouponSheet(false)}>
          <style jsx global>{`
            @media print {
              @page { size: ${P.page}; margin: ${P.margin}; }
              body * { visibility: hidden !important; }
              #coupon-print, #coupon-print * { visibility: visible !important; }
              #coupon-print { position: absolute; left: 0; top: 0; width: 100%; }
              /* ΠΡΑΓΜΑΤΙΚΟ φυσικό μέγεθος σε mm — υψηλή native ανάλυση downscaled = κρυστάλλινο & σαρώσιμο */
              #coupon-print .qr-canvas { width: ${P.qr}mm !important; height: auto !important; }
              #coupon-print .eof-canvas { width: ${P.eof}mm !important; height: auto !important; }
              #coupon-print .coupon-item { width: auto !important; max-width: 100% !important; }
              #coupon-print .rx-barcode { width: 55mm !important; height: auto !important; }
              ${P.col ? "#coupon-print .coupon-grid { flex-direction: column !important; align-items: center !important; gap: 4mm !important; }" : ""}
              .no-print { display: none !important; }
            }
          `}</style>
          <div id="coupon-print" className="mx-auto max-w-3xl rounded-2xl bg-white p-6 shadow-xl print:max-w-full print:rounded-none print:p-0 print:shadow-none" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">{t("Κουπόνια εκτέλεσης", "Execution coupons")}</h3>
                <div className="text-sm text-slate-500">{t("Συνταγή", "Prescription")} {d.external_id} · {dt(d.executed_at)}{d.patient?.full_name ? ` · ${d.patient.full_name}` : ""}</div>
                {/* γραμμωτός κωδικός συνταγής — σκανάρισμα στο εμπορικό πρόγραμμα χωρίς πληκτρολόγηση */}
                <LinearBarcode value={d.external_id.split(":")[0]} className="mt-1.5 w-[200px] max-w-full" />
              </div>
              <div className="no-print flex flex-wrap items-center gap-2">
                {/* επιλογή χαρτιού */}
                <div className="inline-flex overflow-hidden rounded-lg border border-slate-300">
                  {([["a4", "A4"], ["th80", t("Θερμικό 80mm", "Thermal 80mm")], ["th58", t("Θερμικό 58mm", "Thermal 58mm")]] as const).map(([k, lbl]) => (
                    <button key={k} onClick={() => pickPaper(k)} className={`px-2.5 py-1.5 text-xs font-medium ${paper === k ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>{lbl}</button>
                  ))}
                </div>
                <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100"><Printer className="h-4 w-4" /> {t("Εκτύπωση", "Print")}</button>
                <button onClick={() => setCouponSheet(false)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <p className="no-print mb-4 text-xs text-slate-400">{t(`💡 Κλικ σε ένα κουπόνι = αντιγραφή του κωδικού στο πρόχειρο (επικόλλησέ τον στο εμπορικό πρόγραμμα — χωρίς σκανάρισμα). · Για εκτύπωση: χαρτί ${P.label}, πραγματικό μέγεθος (σαρώσιμα).`, `💡 Click a coupon to copy its code to the clipboard (paste it into your pharmacy software — no scanning needed). · For printing: ${P.label} paper, real size.`)}</p>
            <div className="space-y-5">
              {qrCoupons.length > 0 && (
                <section>
                  <h4 className="mb-2 border-b border-slate-200 pb-1 text-xs font-bold uppercase tracking-wide text-sky-700">QR · DataMatrix ({qrCoupons.length})</h4>
                  <div className="coupon-grid flex flex-wrap gap-2.5">
                    {qrCoupons.map((x, i) => (
                      <div key={i} className="coupon-item flex w-[88px] break-inside-avoid cursor-copy flex-col items-center gap-0.5" onClick={() => copyCoupon(x.c)} title={t("Κλικ για αντιγραφή του κωδικού", "Click to copy the code")}>
                        <CouponBarcode c={x.c} />
                        <div className="w-full truncate text-center text-[8px] leading-tight text-slate-500" title={`${x.name} · ${x.c.strip ?? ""}`}>{x.name}</div>
                        <div className={`no-print text-[9px] font-semibold ${copiedKey === couponScanString(x.c) ? "text-emerald-600" : "text-brand-600"}`}>{copiedKey === couponScanString(x.c) ? t("✓ Αντιγράφηκε", "✓ Copied") : t("📋 Αντιγραφή", "📋 Copy")}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {eofCoupons.length > 0 && (
                <section>
                  <h4 className="mb-2 border-b border-slate-200 pb-1 text-xs font-bold uppercase tracking-wide text-amber-700">{t("ΕΟΦ · Ταινίες γνησιότητας", "ΕΟΦ strips")} ({eofCoupons.length})</h4>
                  <div className="coupon-grid flex flex-wrap gap-2.5">
                    {eofCoupons.map((x, i) => (
                      <div key={i} className="coupon-item flex w-[154px] break-inside-avoid cursor-copy flex-col items-center gap-0.5" onClick={() => copyCoupon(x.c)} title={t("Κλικ για αντιγραφή του κωδικού", "Click to copy the code")}>
                        <CouponBarcode c={x.c} />
                        <div className="w-full truncate text-center text-[8px] leading-tight text-slate-500" title={x.name ?? undefined}>{x.name}</div>
                        <div className={`no-print text-[9px] font-semibold ${copiedKey === couponScanString(x.c) ? "text-emerald-600" : "text-brand-600"}`}>{copiedKey === couponScanString(x.c) ? t("✓ Αντιγράφηκε", "✓ Copied") : t("📋 Αντιγραφή", "📋 Copy")}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {qrCoupons.length === 0 && eofCoupons.length === 0 && (
                <div className="py-6 text-center text-sm text-slate-400">{t("Δεν υπάρχουν κουπόνια προς εκτύπωση.", "No coupons to print.")}</div>
              )}
            </div>
          </div>
        </div>
        );
      })() : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="font-medium text-slate-800">{value || "—"}</div>
    </div>
  );
}
