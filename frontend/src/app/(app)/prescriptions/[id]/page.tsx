"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
function CouponBarcode({ c }: { c: Coupon }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const isQr = !!c.qr_product_code;
  const gtin = (c.qr_product_code || "").replace(/\D/g, "").padStart(14, "0").slice(-14);
  useEffect(() => {
    if (!ref.current || (!isQr && !c.strip)) return;
    let dead = false;
    (async () => {
      try {
        const bwipjs = (await import("bwip-js")).default;
        if (dead || !ref.current) return;
        if (isQr) {
          const ai = `(01)${gtin}` + (c.qr_expiry ? `(17)${c.qr_expiry}` : "")
            + (c.qr_batch ? `(10)${c.qr_batch}` : "") + (c.strip ? `(21)${c.strip}` : "");
          bwipjs.toCanvas(ref.current, { bcid: "gs1datamatrix", text: ai, scale: 5, padding: 6, backgroundcolor: "FFFFFF" });
        } else {
          // Code-128 αρκετά μεγάλο/ψηλό + ορατός αριθμός, σε native ανάλυση ώστε να σκανάρεται.
          bwipjs.toCanvas(ref.current, { bcid: "code128", text: String(c.strip), scale: 3, height: 22, includetext: true, textsize: 12, textyoffset: 2, paddingwidth: 12, paddingheight: 8, backgroundcolor: "FFFFFF" });
        }
      } catch { /* ignore render errors */ }
    })();
    return () => { dead = true; };
  }, [isQr, gtin, c.qr_expiry, c.qr_batch, c.strip]);
  if (!isQr && !c.strip) return null;
  // Render σε ΥΨΗΛΗ native ανάλυση (σαρώσιμο) αλλά περιορισμένο σε ΦΥΣΙΚΟ μέγεθος μέσω CSS
  // (.qr-canvas / .eof-canvas — βλ. print styles). Downscale υψηλής ανάλυσης = κρυστάλλινο στην εκτύπωση.
  return <canvas ref={ref} className={`${isQr ? "qr-canvas" : "eof-canvas"} rounded border border-slate-200 bg-white`} />;
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

  if (isLoading) return <div className="text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;
  if (!data) return <div className="text-slate-500">{t("Η συνταγή δεν βρέθηκε.", "Prescription not found.")}</div>;

  const d = data;
  const age = d.patient?.birth_year ? new Date().getFullYear() - d.patient.birth_year : null;
  const profit = d.amount_total - d.wholesale_cost;
  // repeat_current/repeat_total now come straight from the ΗΔΥΚΑ CDA (1.1.4 = planned count,
  // 1.1.4.1 = position), so "X/Y" is authoritative even when sibling barcodes aren't synced.
  const recurring = d.repeat_total > 1;
  // Το wholesale_cost κλιμακώνεται πλέον στο authoritative amount_total (ανά εκτέλεση), οπότε
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
          <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
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
          [t("Χονδρικό κόστος", "Wholesale cost"), marginReliable ? eur(d.wholesale_cost) : "—"],
          [t("Μεικτό κέρδος", "Gross profit"), marginReliable ? eur(profit) : "—"],
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
          {t("Η χονδρική τιμή είναι εκτίμηση (ελλείψει επίσημου Δελτίου Τιμών) — το μεικτό κέρδος είναι ενδεικτικό.",
             "Wholesale price is an estimate (no official price bulletin) — gross profit is indicative.")}
        </div>
      ) : (
        <div className="-mt-2 text-xs text-slate-400">
          {t("Το χονδρικό κόστος & το μεικτό κέρδος δεν είναι διαθέσιμα για αυτή την εκτέλεση.",
             "Wholesale cost & gross profit are not available for this execution.")}
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

      {/* Φύλλο εκτύπωσης κουπονιών (QR/ΕΟΦ) της ΤΡΕΧΟΥΣΑΣ εκτέλεσης — barcode + serial ανά τεμάχιο */}
      {couponSheet ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4 print:static print:bg-white print:p-0" onClick={() => setCouponSheet(false)}>
          <style jsx global>{`
            #coupon-print .qr-canvas { width: 84px; height: 84px; }
            #coupon-print .eof-canvas { width: 150px; height: auto; }
            @media print {
              @page { size: A4; margin: 12mm; }
              body * { visibility: hidden !important; }
              #coupon-print, #coupon-print * { visibility: visible !important; }
              #coupon-print { position: absolute; left: 0; top: 0; width: 100%; }
              #coupon-print .qr-canvas { width: 20mm !important; height: 20mm !important; }
              #coupon-print .eof-canvas { width: 40mm !important; height: auto !important; }
              .no-print { display: none !important; }
            }
          `}</style>
          <div id="coupon-print" className="mx-auto max-w-3xl rounded-2xl bg-white p-6 shadow-xl print:max-w-full print:rounded-none print:shadow-none" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">{t("Κουπόνια εκτέλεσης", "Execution coupons")}</h3>
                <div className="text-sm text-slate-500">{t("Συνταγή", "Prescription")} {d.external_id} · {dt(d.executed_at)}{d.patient?.full_name ? ` · ${d.patient.full_name}` : ""}</div>
              </div>
              <div className="no-print flex items-center gap-2">
                <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100"><Printer className="h-4 w-4" /> {t("Εκτύπωση", "Print")}</button>
                <button onClick={() => setCouponSheet(false)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <div className="space-y-5">
              {qrCoupons.length > 0 && (
                <section>
                  <h4 className="mb-2 border-b border-slate-200 pb-1 text-xs font-bold uppercase tracking-wide text-sky-700">QR · DataMatrix ({qrCoupons.length})</h4>
                  <div className="flex flex-wrap gap-2.5">
                    {qrCoupons.map((x, i) => (
                      <div key={i} className="flex w-[88px] break-inside-avoid flex-col items-center gap-0.5">
                        <CouponBarcode c={x.c} />
                        <div className="w-full truncate text-center text-[8px] leading-tight text-slate-500" title={`${x.name} · ${x.c.strip ?? ""}`}>{x.name}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {eofCoupons.length > 0 && (
                <section>
                  <h4 className="mb-2 border-b border-slate-200 pb-1 text-xs font-bold uppercase tracking-wide text-amber-700">{t("ΕΟΦ · Ταινίες γνησιότητας", "ΕΟΦ strips")} ({eofCoupons.length})</h4>
                  <div className="flex flex-wrap gap-2.5">
                    {eofCoupons.map((x, i) => (
                      <div key={i} className="flex w-[154px] break-inside-avoid flex-col items-center gap-0.5">
                        <CouponBarcode c={x.c} />
                        <div className="w-full truncate text-center text-[8px] leading-tight text-slate-500" title={x.name ?? undefined}>{x.name}</div>
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
      ) : null}
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
