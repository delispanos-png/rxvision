"use client";

/* Προχορηγήσεις σκευασμάτων («δανεικά»).

   ΔΕΝ είναι λογιστική αποθήκης. Ο φαρμακοποιός θέλει να θυμάται ποιος του χρωστά κουτί και να
   το σβήνει όταν έρθει η συνταγή — τίποτα παραπάνω.

   Η ΤΑΥΤΙΣΗ ΕΙΝΑΙ ΠΡΟΤΑΣΗ, ΟΧΙ ΠΡΑΞΗ: η ταινία γνησιότητας δεν είναι μοναδική (μετρημένο: 15%
   επαναλαμβάνονται), οπότε το τελικό «ναι» το δίνει πάντα ο άνθρωπος. */

import { useEffect, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HandCoins, ScanLine, Check, X, Clock, AlertTriangle, Plus, Trash2, Search, UserRound, Copy, QrCode, CalendarClock } from "lucide-react";
import { api } from "@/lib/apiClient";
import { CouponBarcode, couponScanString } from "@/components/barcode/CouponBarcode";
import { DateInput } from "@/components/ui/DateInput";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";
import { Modal } from "@/components/ui/Modal";

type Item = { name?: string; gtin?: string; batch?: string; strip?: string; lot?: string;
              expiry?: string; qty?: number; raw?: string; eof_code?: string | null;
              status?: string };   // ξεχρέωση ΑΝΑ σκεύασμα: open | cleared
// YYMMDD → ΗΗ/ΜΜ/ΕΕΕΕ· άκυρη ημερομηνία (π.χ. «073453» από λάθος ανάγνωση) → null
const fmtExpiry = (e?: string) => (e && /^\d{6}$/.test(e) && +e.slice(2, 4) >= 1 && +e.slice(2, 4) <= 12 && +e.slice(4, 6) <= 31)
  ? `${e.slice(4, 6) === "00" ? "" : e.slice(4, 6) + "/"}${e.slice(2, 4)}/20${e.slice(0, 2)}` : null;
type Loan = { _id: string; patient_name: string; patient_ref?: string; items: Item[]; status: string;
              created_at: string; note?: string; expected_at?: string | null };
type Hit = { patient_id: string; name: string | null; amka: string | null; last_seen?: string | null };
type Match = { loan_id: string; patient_name: string; created_at: string; items: string[]; item_idxs?: number[];
               execution: { id?: string; external_id: string | null; executed_at: string | null };
               matched_on: string; same_patient: boolean };

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const daysAgo = (s?: string) => (s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : 0);

/* ΣΑΡΩΤΗΣ = «ΕΠΙΚΟΛΛΗΣΗ», ΟΧΙ ΠΛΗΚΤΡΟΛΟΓΗΣΗ (15/10/2026, Μπινίκος, Zebra DS2208).
   Στο Notepad το QR έφτανε ολόκληρο, στη σελίδα έλειπαν χαρακτήρες σε ζευγάρια από τη μέση· με
   αντιγραφή-επικόλληση δούλευε. Άρα τα πλήκτρα φτάνουν στη σελίδα αλλά χάνονται στη διαδρομή μέχρι το
   κουτάκι κειμένου. Εδώ τα πιάνουμε στο ΠΡΩΤΟ σημείο (keydown, φάση capture, πριν από πρόσθετα/
   ορθογραφικό/πεδίο), μαζεύουμε όλο το QR και το δίνουμε ΜΙΑ φορά — σαν επικόλληση. Σαρωτής/εμπορικό
   δεν αλλάζουν.
   • Γράμματα από τη ΦΥΣΙΚΗ θέση του πλήκτρου (e.code): ελληνικό ή αγγλικό πληκτρολόγιο, ίδιο αποτέλεσμα.
   • Ριπή (σαρωτής) → κρατάμε ό,τι πιάσαμε. Άνθρωπος που γράφει αργά → ό,τι γράφει το πεδίο (διορθώσεις κ.λπ.).
   • Τέλος: Enter/Tab του σαρωτή, ή 400ms ησυχία. */
type ScanResult = { value: string; typed: string; burst: boolean };
function keyChar(e: KeyboardEvent): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const c = e.code || "";
  if (/^Key[A-Z]$/.test(c)) {
    const caps = e.getModifierState ? e.getModifierState("CapsLock") : false;
    return e.shiftKey !== caps ? c[3] : c[3].toLowerCase();
  }
  if (!e.shiftKey && /^(Digit|Numpad)[0-9]$/.test(c)) return c.slice(-1);
  return e.key && e.key.length === 1 ? e.key : null;
}
function useScanCapture(ref: RefObject<HTMLInputElement>, onScan: (r: ScanResult) => void) {
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    let buf = "", last = 0, burst = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const el = ref.current;
      const typed = el?.value ?? "";
      const wasBurst = burst && buf.trim().length >= 6;
      const value = wasBurst ? buf : typed;
      buf = ""; burst = true;
      if (el) el.value = "";
      if (value.trim()) cb.current({ value, typed, burst: wasBurst });
    };
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || document.activeElement !== el) return;
      if (e.key === "Enter" || e.key === "Tab") {
        if (buf || el.value) { e.preventDefault(); finish(); }
        return;
      }
      if (e.key === "Backspace") { buf = buf.slice(0, -1); burst = false; return; }
      const ch = keyChar(e);
      if (ch === null) return;
      const now = performance.now();
      if (now - last > 1000) buf = "";              // παύση >1s = νέο σκανάρισμα (π.χ. μετά από «+»)
      if (!buf) burst = true;                       // νέα σάρωση
      else if (now - last > 60) burst = false;      // τόσο αργά γράφει μόνο άνθρωπος
      last = now;
      buf += ch;
      if (timer) clearTimeout(timer);
      if (burst && buf.trim().length >= 6) timer = setTimeout(finish, 400);
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (timer) clearTimeout(timer); };
  }, [ref]);
}

/** «Έλεγχος σαρωτή»: σκανάρεις ΕΝΑ κουτί και βλέπεις τι κατάλαβε η εφαρμογή + τι στέλνει ο σαρωτής.
 *  Ο τεχνικός που ρύθμισε τον σαρωτή δεν ενημερώνει κανέναν· έτσι το βλέπει ο ίδιος ο φαρμακοποιός. */
type ScanCheck = { ok: boolean; kind: string; complete?: boolean; item?: Item;
                   scanner?: { separator: string; greek_layout: boolean } };
function ScannerCheck() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<ScanCheck | null>(null);
  const [got, setGot] = useState<ScanResult | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useScanCapture(ref, async (r) => {
    setGot(r);
    try {
      setRes(await api<ScanCheck>("/advance-dispensings/parse-scan",
        { method: "POST", body: JSON.stringify({ raw: r.value, typed: r.typed, check: true }) }));
    } catch { setRes({ ok: false, kind: "error" }); }
  });
  const sepEl: Record<string, string> = { gs: t("σωστός (GS)", "proper GS"), space: t("κενό", "space"),
    text_gs: t("το κείμενο «<GS>»", "the text <GS>"), none: t("κανένας", "none") };
  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[11px] text-slate-400 hover:text-slate-600 hover:underline">
      {t("🔍 Έλεγχος σαρωτή", "🔍 Scanner check")}
    </button>
  );
  const it = res?.item;
  return (
    <div className="mt-2 rounded-lg border border-slate-200 p-2.5 text-xs dark:border-slate-700">
      <div className="mb-1.5 font-semibold text-slate-700 dark:text-slate-200">{t("Έλεγχος σαρωτή — σκάναρε ένα κουτί φαρμάκου (QR)", "Scanner check — scan one medicine box (QR)")}</div>
      <input ref={ref} autoFocus defaultValue="" autoComplete="off" autoCorrect="off" spellCheck={false}
        className="block w-full rounded border border-slate-300 px-2 py-1.5 font-mono dark:border-slate-600 dark:bg-slate-800" />
      {got && (
        <div className="mt-1.5 break-all font-mono text-[11px] text-slate-500">
          {got.value}
          {got.typed && got.typed !== got.value && (
            <div className="mt-0.5 font-sans text-amber-700">
              {t(`Η σελίδα έπιασε ${got.value.length} χαρακτήρες· στο πεδίο έφτασαν μόνο ${got.typed.length} — η εφαρμογή κράτησε τους σωστούς.`,
                 `Captured ${got.value.length} chars; only ${got.typed.length} reached the field — the app kept the full scan.`)}
            </div>
          )}
        </div>
      )}
      {res && (res.ok && it ? (
        <div className="mt-2 space-y-0.5">
          <div className={res.complete ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
            {res.complete ? t("✓ Διαβάστηκε σωστά", "✓ Read correctly") : t("⚠ Διαβάστηκε μερικώς", "⚠ Partially read")}
          </div>
          <div>{t("Φάρμακο", "Product")}: <b>{it.name || "—"}</b> · GTIN {it.gtin}</div>
          <div>{t("Λήξη", "Expiry")}: {fmtExpiry(it.expiry) || "—"} · {t("Παρτίδα", "Batch")}: {it.batch || "—"} · {t("Σειριακός", "Serial")}: {it.strip || "—"}</div>
          <div className="text-slate-500">
            {t("Διαχωριστής σαρωτή", "Scanner separator")}: {sepEl[res.scanner?.separator || "none"] || res.scanner?.separator}
            {res.scanner?.greek_layout ? ` · ${t("πληκτρολογεί σε ΕΛΛΗΝΙΚΑ (διορθώνεται αυτόματα)", "types in GREEK layout (auto-corrected)")}` : ""}
          </div>
        </div>
      ) : res.kind === "corrupt"
        ? <div className="mt-2 font-semibold text-rose-700">{t("✗ Ήρθε κομμένο — χάθηκαν χαρακτήρες στη διαδρομή. Αν συμβαίνει συχνά: καλώδιο/USB θύρα ή ταχύτητα σαρωτή.", "✗ Truncated — characters were lost.")}</div>
        : <div className="mt-2 text-amber-700">{t("Δεν είναι QR φαρμάκου (GS1) — ταινία ΕΟΦ ή άλλος κωδικός.", "Not a medicine QR (GS1).")}</div>)}
      <button type="button" onClick={() => { setOpen(false); setGot(null); setRes(null); }} className="mt-2 text-slate-500 hover:underline">{t("Κλείσιμο", "Close")}</button>
    </div>
  );
}

export default function AdvanceDispensingsPage() {
  const t = useT();
  const [tab, setTab] = useState<"open" | "history">("open");
  return (
    <ModuleGuard module="advance_dispensing">
      {/* ίδιο στυλ με τα κουμπιά επιλογής της υπόλοιπης εφαρμογής (ενεργό = γεμάτο χρώμα) */}
      <div className="mb-4 flex flex-wrap gap-2">
        {([["open", t("Ανοιχτά δανεικά", "Open loans"), Clock], ["history", t("Ξεχρεωμένα", "Settled"), Check]] as const).map(([k, lab, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition ${tab === k
              ? "bg-indigo-600 text-white shadow-sm"
              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"}`}>
            <Icon className="h-4 w-4" />{lab}
          </button>
        ))}
      </div>
      {tab === "open" ? <Inner /> : <SettledHistory />}
    </ModuleGuard>
  );
}

/* Η συνταγή σε POPUP (επίσημο έντυπο ΗΔΥΚΑ, PDF) — χωρίς να φύγεις από τα Δανεικά. */
function RxPopup({ barcode, onClose }: { barcode: string | null; onClose: () => void }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!barcode) return;
    let objUrl: string | null = null;
    setUrl(null); setErr("");
    const base = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";
    const token = typeof window !== "undefined" ? window.localStorage.getItem("access_token") : null;
    fetch(`${base}/prescriptions/idika-print/${encodeURIComponent(barcode)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); objUrl = URL.createObjectURL(await r.blob()); setUrl(objUrl); })
      .catch(() => setErr("unavailable"));
    return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
    // ΜΟΝΟ το barcode: το `t` αλλάζει σε κάθε render → η φόρτωση ξεκινούσε ξανά & ξανά (popup «αναβόσβηνε»)
  }, [barcode]);
  return (
    <Modal open={!!barcode} onClose={onClose} title={`${t("Συνταγή", "Prescription")} ${barcode ?? ""}`} size="2xl">
      {err ? <p className="text-sm text-amber-700">{t("Το έντυπο ΗΔΥΚΑ δεν είναι διαθέσιμο αυτή τη στιγμή.", "ΗΔΥΚΑ printout unavailable.")}</p>
        : url ? <iframe src={url} title="ΗΔΥΚΑ" className="h-[75vh] w-full rounded border border-slate-200" />
        : <p className="text-sm text-slate-400">{t("Φόρτωση εντύπου ΗΔΥΚΑ…", "Loading ΗΔΥΚΑ printout…")}</p>}
    </Modal>
  );
}

/* ΙΣΤΟΡΙΚΟ ΞΕΧΡΕΩΣΕΩΝ — μία γραμμή ανά σκεύασμα που έκλεισε (ξεχρέωση ή διαγραφή χρέους), με φίλτρα
   για να βρεις γρήγορα «πότε & ποιος ξεχρέωσε το DOSTINEX του Χ». Εξαγωγή σε Excel. */
type HistRow = { loan_id: string; idx: number; status: string; patient_name: string; amka?: string | null;
  name: string; gtin?: string | null; serial?: string | null; batch?: string | null; qty: number;
  given_at?: string | null; closed_at?: string | null; days?: number | null; closed_by_name?: string; reason?: string | null;
  via: "prescription" | "manual" | "write_off"; rx?: string | null };
function SettledHistory() {
  const t = useT();
  const [q, setQ] = useState(""); const [product, setProduct] = useState(""); const [code, setCode] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [by, setBy] = useState("");
  const [via, setVia] = useState("");
  const params = new URLSearchParams({ ...(q.trim() && { q: q.trim() }), ...(product.trim() && { product: product.trim() }),
    ...(code.trim() && { code: code.trim() }), ...(from && { date_from: from }), ...(to && { date_to: to }), ...(by && { by }), ...(via && { via }) });
  const h = useQuery({ queryKey: ["adv", "history", params.toString()],
    queryFn: () => api<{ items: HistRow[]; total: number; counts: { cleared: number; written_off: number; prescription: number; manual: number }; users: { id: string; name: string }[] }>(
      `/advance-dispensings/history?${params.toString()}`) });
  const rows = h.data?.items ?? [];
  // ΤΡΟΠΟΣ: από συνταγή (με τον αριθμό της) / με το χέρι / διαγραφή χρέους
  const viaLabel = (r: HistRow) => r.via === "write_off" ? t("Διαγραφή χρέους", "Written off")
    : r.via === "prescription" ? t("Από συνταγή", "From prescription") : t("Με το χέρι", "Manual");
  const inp = "rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800";
  const cols: Column<HistRow>[] = [
    { key: "closed_at", header: t("Κλείσιμο", "Closed"), sortValue: (r) => r.closed_at || "", render: (r) => fmt(r.closed_at) },
    { key: "patient_name", header: t("Πελάτης", "Customer"), render: (r) => <span>{r.patient_name}{r.amka ? <span className="block text-[11px] text-slate-400">ΑΜΚΑ {r.amka}</span> : null}</span> },
    { key: "name", header: t("Σκεύασμα", "Product"), render: (r) => <span>{r.name || "—"}{r.qty > 1 ? ` ×${r.qty}` : ""}<span className="block font-mono text-[11px] text-slate-400">{[r.serial, r.gtin && `GTIN ${r.gtin}`].filter(Boolean).join(" · ")}</span></span> },
    { key: "given_at", header: t("Δόθηκε", "Given"), hideOnMobile: true, sortValue: (r) => r.given_at || "", render: (r) => fmt(r.given_at) },
    { key: "days", header: t("Ημέρες", "Days"), align: "right", sortValue: (r) => r.days ?? -1, render: (r) => r.days ?? "—" },
    { key: "via", header: t("Τρόπος", "How"), render: (r) => (
      <span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.via === "write_off" ? "bg-slate-100 text-slate-600" : r.via === "prescription" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-800"}`} title={r.reason || ""}>{viaLabel(r)}</span>
        {r.rx && <span className="block font-mono text-[11px] text-slate-400">{r.rx}</span>}
        {r.via === "write_off" && r.reason && <span className="block text-[11px] text-slate-400">{r.reason}</span>}
      </span>) },
    { key: "closed_by_name", header: t("Από", "By"), hideOnMobile: true, render: (r) => r.closed_by_name || "—" },
  ];
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {t("Ξεχρεωμένα σκευάσματα", "Settled items")}
          {h.data && <span className="ml-2 font-normal text-slate-400">{h.data.total} · {t("από συνταγή", "from Rx")} {h.data.counts.prescription} · {t("με το χέρι", "manual")} {h.data.counts.manual} · {t("διαγραφή", "written off")} {h.data.counts.written_off}</span>}
        </h2>
        <ExportMenu filename="xechreomena-daneika" title={t("Ξεχρεωμένα δανεικά", "Settled loans")} rows={rows} columns={[
          { key: "closed_at", header: t("Κλείσιμο", "Closed"), value: (r) => fmt(r.closed_at) },
          { key: "patient_name", header: t("Πελάτης", "Customer") },
          { key: "amka", header: "ΑΜΚΑ", value: (r) => r.amka || "" },
          { key: "name", header: t("Σκεύασμα", "Product") },
          { key: "qty", header: t("Τεμ.", "Qty"), value: (r) => String(r.qty) },
          { key: "serial", header: t("Σειριακός/ταινία", "Serial"), value: (r) => r.serial || "" },
          { key: "gtin", header: "GTIN", value: (r) => r.gtin || "" },
          { key: "given_at", header: t("Δόθηκε", "Given"), value: (r) => fmt(r.given_at) },
          { key: "days", header: t("Ημέρες", "Days"), value: (r) => r.days == null ? "" : String(r.days) },
          { key: "via", header: t("Τρόπος", "How"), value: (r) => viaLabel(r) },
          { key: "rx", header: t("Συνταγή", "Prescription"), value: (r) => r.rx || "" },
          { key: "reason", header: t("Αιτιολογία", "Reason"), value: (r) => r.reason || "" },
          { key: "closed_by_name", header: t("Από", "By"), value: (r) => r.closed_by_name || "" },
        ]} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Πελάτης ή ΑΜΚΑ", "Customer or AMKA")} className={`${inp} w-44`} />
        <input value={product} onChange={(e) => setProduct(e.target.value)} placeholder={t("Σκεύασμα (π.χ. DOSTINEX)", "Product")} className={`${inp} w-44`} />
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("Κωδικός QR / ταινίας", "QR / strip code")} className={`${inp} w-40`} />
        <select value={via} onChange={(e) => setVia(e.target.value)} className={inp}>
          <option value="">{t("Κάθε τρόπος", "Any method")}</option>
          <option value="prescription">{t("Από συνταγή", "From prescription")}</option>
          <option value="manual">{t("Με το χέρι", "Manual")}</option>
          <option value="write_off">{t("Διαγραφή χρέους", "Written off")}</option>
        </select>
        <label className="text-xs text-slate-500">{t("Από", "From")}<DateInput value={from} onChange={setFrom} className="mt-0.5 w-32" /></label>
        <label className="text-xs text-slate-500">{t("Έως", "To")}<DateInput value={to} onChange={setTo} className="mt-0.5 w-32" /></label>
        <select value={by} onChange={(e) => setBy(e.target.value)} className={inp}>
          <option value="">{t("Όλοι οι χρήστες", "All users")}</option>
          {(h.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {(q || product || code || from || to || by || via) && (
          <button type="button" onClick={() => { setQ(""); setProduct(""); setCode(""); setFrom(""); setTo(""); setBy(""); setVia(""); }}
            className="text-xs text-slate-500 hover:underline">{t("Καθαρισμός φίλτρων", "Clear filters")}</button>
        )}
      </div>
      <DataTable pageSize={25} columns={cols} rows={rows} rowKey={(r) => `${r.loan_id}:${r.idx}`}
        empty={h.isLoading ? t("Φόρτωση…", "Loading…") : t("Κανένα ξεχρεωμένο σκεύασμα με αυτά τα φίλτρα.", "Nothing settled with these filters.")} />
    </section>
  );
}

function Inner() {
  const t = useT();
  const qc = useQueryClient();
  const [patient, setPatient] = useState<Hit | null>(null);
  const [term, setTerm] = useState("");
  const [openList, setOpenList] = useState(false);
  const [badScan, setBadScan] = useState(false);   // κομμένο σκανάρισμα → «σκάναρε ξανά»
  const scanRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);

  // Ο πελάτης ΕΠΙΛΕΓΕΤΑΙ — δεν γράφεται. Ελεύθερο κείμενο σήμαινε ότι «Κυρία Μαρία» και
  // «ΜΑΡΙΑ Κ.» γίνονταν δύο οφειλέτες, το χρέος δεν φαινόταν ποτέ στην καρτέλα του πελάτη και
  // καμία συνταγή δεν μπορούσε να το ξεχρεώσει αυτόματα.
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const h = setTimeout(() => setDebounced(term.trim()), 250); return () => clearTimeout(h); }, [term]);
  const hits = useQuery({
    queryKey: ["adv", "patients", debounced],
    queryFn: () => api<{ items: Hit[] }>(`/advance-dispensings/patients?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2 && !patient,
    staleTime: 60_000,
  });

  const open = useQuery({ queryKey: ["adv", "open"], queryFn: () => api<{ items: Loan[] }>("/advance-dispensings?status=open") });
  // ΑΜΕΣΟΣ ΣΥΝΔΕΣΜΟΣ: `?loan=<id>` (π.χ. από την Εικόνα Πελάτη → «Κλείσ' το δανεικό»). Πάμε ΚΑΤΕΥΘΕΙΑΝ
  // στη γραμμή του και την τονίζουμε — αλλιώς ο φαρμακοποιός ψάχνει σε λίστα ενώ ο πελάτης περιμένει.
  // (window.location και όχι useSearchParams: αυτό θα απαιτούσε όριο Suspense στο build.)
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("loan");
    if (id) setTarget(id);
  }, []);
  useEffect(() => {
    if (!target || !open.data) return;
    const tm = window.setTimeout(() => {
      document.querySelector(`[data-loan="${CSS.escape(target)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    const off = window.setTimeout(() => setTarget(null), 4000);
    return () => { window.clearTimeout(tm); window.clearTimeout(off); };
  }, [target, open.data]);
  const due = useQuery({ queryKey: ["adv", "due"], queryFn: () => api<{ items: Loan[]; count: number }>("/advance-dispensings/due-today") });
  const late = useQuery({ queryKey: ["adv", "overdue"], queryFn: () => api<{ items: Loan[]; counts: Record<string, number> }>("/advance-dispensings/overdue") });
  const sugg = useQuery({ queryKey: ["adv", "matches"], queryFn: () => api<{ items: Match[] }>("/advance-dispensings/matches") });
  const [rxView, setRxView] = useState<string | null>(null);   // συνταγή σε popup
  const mkey = (m: Match) => `${m.loan_id}:${m.execution.id || m.execution.external_id}`;
  /* Επιβεβαίωση πρότασης → popup «όλα ή μέρος»: η συνταγή μπορεί να ταιριάζει με όλα τα δανεικά, αλλά ο
     φαρμακοποιός να εκτέλεσε μόνο μερικά. Ξεχρεώνονται ΜΟΝΟ τα επιλεγμένα («από συνταγή»)· τα άλλα μένουν χρέος. */
  const [clearDlg, setClearDlg] = useState<Match | null>(null);
  const [clearSel, setClearSel] = useState<number[]>([]);
  function clearFromRx(m: Match) { setClearDlg(m); setClearSel(m.item_idxs ?? []); }
  async function doClear(idxs: number[]) {
    const m = clearDlg;
    if (!m || !idxs.length) return;
    await api(`/advance-dispensings/${m.loan_id}/items/clear-from-prescription`, { method: "POST", body: JSON.stringify({
      idxs, execution_id: m.execution.id || null, external_id: m.execution.external_id }) });
    setClearDlg(null);
    qc.invalidateQueries({ queryKey: ["adv"] });
  }

  /* ΓΡΗΓΟΡΗ ΣΑΡΩΣΗ — ο φαρμακοποιός δεν πατάει τίποτα.

     Ο σαρωτής συμπεριφέρεται σαν πληκτρολόγιο που γράφει ασύλληπτα γρήγορα (λίγα ms ανά
     χαρακτήρα) και συνήθως — όχι πάντα — τελειώνει με Enter. Στηριζόμαστε ΚΑΙ στα δύο:
     Enter/Tab καταχωρεί αμέσως, αλλιώς η «ριπή» χαρακτήρων καταχωρείται μόλις σταματήσει.
     Έτσι δουλεύει και το QR (2D) και ο γραμμικός των παλιών κουπονιών, χωρίς ρύθμιση. */
  const [dup, setDup] = useState("");
  const [copied, setCopied] = useState("");
  const [expected, setExpected] = useState("");   // πότε θα φέρει τη συνταγή (προαιρετικό)

  useScanCapture(scanRef, (r) => addScan(r.value, r.typed));

  async function addScan(value?: string, typed?: string) {
    const v = (value ?? scanRef.current?.value ?? "").trim();
    if (scanRef.current) scanRef.current.value = "";   // καθάρισμα ΧΩΡΙΣ re-render
    if (!v) return;
    const key = v.toUpperCase();
    // Διπλό πέρασμα του ΙΔΙΟΥ κουτιού: ο κωδικός είναι μοναδικός ανά κουτί, οπότε ίδιος
    // κωδικός = ξανασαρώθηκε το ίδιο. Δύο κουτιά → «τεμ.», όχι δεύτερη γραμμή.
    if (items.some((i) => i.raw === key)) {
      setDup(key);
      setTimeout(() => setDup(""), 1600);
      scanRef.current?.focus();
      return;
    }
    scanRef.current?.focus();
    // ΕΝΑΣ αναγνώστης στον server (services/gs1_scan): αναγνωρίζει διαχωριστή (κενό/<GS>/κανένας) και
    // ελληνικό πληκτρολόγιο, βρίσκει το όνομα από το GTIN και «μαθαίνει» τον σαρωτή του φαρμακείου.
    let item: Item = { strip: key, lot: key, name: "", raw: key };
    try {
      const r = await api<{ ok: boolean; kind?: string; item?: Item }>("/advance-dispensings/parse-scan",
        { method: "POST", body: JSON.stringify({ raw: v, typed: typed ?? null }) });
      // ΚΟΜΜΕΝΟ σκανάρισμα (χάθηκαν χαρακτήρες — ψηφίο ελέγχου GTIN λάθος): ΔΕΝ μπαίνει, ζητάμε ξανά
      if (!r.ok && r.kind === "corrupt") {
        setBadScan(true); setTimeout(() => setBadScan(false), 3500);
        return;
      }
      // Μη-GS1 = γραμμικός παλιού κουπονιού → είναι ΤΑΙΝΙΑ, όχι παρτίδα. Στα δύο πεδία.
      if (r.ok && r.item) item = { ...r.item, raw: key };
    } catch { /* εκτός σύνδεσης → κρατάμε το σκανάρισμα ως κωδικό· ο server το ξαναδιαβάζει στην αποθήκευση */ }
    setItems((x) => [...x, item]);
  }

  async function save() {
    if (!patient) { appAlert(t("Διάλεξε πελάτη από τη λίστα.", "Pick a customer from the list.")); return; }
    if (!items.length) { appAlert(t("Σάρωσε ή γράψε τουλάχιστον ένα σκεύασμα.", "Add at least one product.")); return; }
    setBusy(true);
    try {
      // ΜΙΑ κίνηση = ένας πελάτης + ΟΛΑ όσα του δόθηκαν τώρα. Ο φαρμακοποιός δεν καταχωρεί
      // γραμμή-γραμμή· σαρώνει τα κουτιά στη σειρά και πατάει μία φορά «Καταχώρηση».
      await api("/advance-dispensings", { method: "POST", body: JSON.stringify({
        patient_name: patient.name || patient.amka || "—", patient_ref: patient.patient_id,
        amka: patient.amka, expected_at: expected || null,
        items }) });   // μαζί με το raw: ο server το ξαναδιαβάζει & το κρατά
      setPatient(null); setTerm(""); setItems([]); setExpected("");
      qc.invalidateQueries({ queryKey: ["adv"] });
    } catch (e) {
      const msg = (e as { problem?: { detail?: { message?: string } } })?.problem?.detail?.message;
      appAlert(msg || t("Δεν αποθηκεύτηκε.", "Not saved."));
    }
    finally { setBusy(false); }
  }

  /* Η ημερομηνία που συμφώνησε ο πελάτης. Χωρίς αυτήν ο φαρμακοποιός δεν έχει τι να περιμένει
     — μόνο «κάποτε» — και το δανεικό ξεχνιέται μέχρι να γίνει αργοπορημένο. */
  async function askExpected(l: Loan) {
    const cur = l.expected_at ? l.expected_at.split("-").reverse().join("/") : "";
    const v = (await appPrompt(
      t("Πότε θα φέρει τη συνταγή; (ΗΗ/ΜΜ/ΕΕΕΕ — κενό για καθαρισμό)",
        "When will they bring the prescription? (DD/MM/YYYY — empty to clear)"), { defaultValue: cur }))?.trim();
    if (v === undefined || v === null) return;
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (v && !m) { appAlert(t("Γράψε ημερομηνία σε μορφή ΗΗ/ΜΜ/ΕΕΕΕ.", "Use DD/MM/YYYY.")); return; }
    const iso = m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
    await api(`/advance-dispensings/${l._id}/expected`, { method: "POST", body: JSON.stringify({ expected_at: iso }) });
    qc.invalidateQueries({ queryKey: ["adv"] });
  }

  /* Ξεχρέωση ΑΝΑ ΣΚΕΥΑΣΜΑ: όταν ξεχρεωθούν όλα, κλείνει μόνο του και το δανεικό. */
  async function itemStatus(l: Loan, idx: number, status: string) {
    if (status === "cleared" && !(await appConfirm(t(`Να ξεχρεωθεί το ${l.items[idx]?.name || "σκεύασμα"};`, "Clear this item?")))) return;
    await api(`/advance-dispensings/${l._id}/items/${idx}/status`, { method: "POST", body: JSON.stringify({ status }) });
    qc.invalidateQueries({ queryKey: ["adv"] });
  }

  /* Ξανασκανάρισμα κουτιού με ελλιπή ανάγνωση: το δανεικό μένει ίδιο, διορθώνονται ΜΟΝΟ τα στοιχεία του
     κουτιού. Δεκτό μόνο το ΙΔΙΟ φάρμακο (ίδιο GTIN) — λάθος κουτί απορρίπτεται. */
  async function rescanItem(l: Loan, idx: number, i: Item) {
    const raw = (await appPrompt(
      t(`Σκάναρε ξανά το QR του ${i.name || "κουτιού"} (ο κέρσορας είναι ήδη στο πεδίο).`, `Scan the QR of ${i.name || "the box"} again.`),
      { defaultValue: "" }))?.trim();
    if (!raw) return;
    const r = await api<{ ok: boolean; error?: string }>(`/advance-dispensings/${l._id}/items/${idx}/rescan`,
      { method: "POST", body: JSON.stringify({ raw }) });
    if (r.ok) { qc.invalidateQueries({ queryKey: ["adv"] }); return; }
    appAlert(r.error === "other_product"
      ? t("Αυτό είναι ΑΛΛΟ φάρμακο (διαφορετικό GTIN). Σκάναρε το ίδιο κουτί που δόθηκε.", "This is a DIFFERENT product.")
      : r.error === "corrupt_scan"
        ? t("Το σκανάρισμα ήρθε κομμένο (χάθηκαν χαρακτήρες). Σκάναρε ξανά.", "The scan arrived truncated. Scan again.")
      : r.error === "still_incomplete"
        ? t("Ο σαρωτής πάλι δεν έστειλε όλα τα στοιχεία του QR. Δοκίμασε ξανά ή άνοιξε «🔍 Έλεγχος σαρωτή».", "The scan is still incomplete.")
        : t("Δεν είναι QR φαρμάκου.", "Not a medicine QR."));
  }

  /* Ταινία ΕΟΦ: δεν περιέχει κωδικό φαρμάκου — το όνομα το γράφει ο φαρμακοποιός. */
  async function nameItem(l: Loan, idx: number, i: Item) {
    const v = (await appPrompt(t("Ποιο σκεύασμα είναι;", "Which product is it?"), { defaultValue: i.name || "" }))?.trim();
    if (!v) return;
    await api(`/advance-dispensings/${l._id}/items/${idx}/name`, { method: "POST", body: JSON.stringify({ name: v }) });
    qc.invalidateQueries({ queryKey: ["adv"] });
  }

  async function setStatus(id: string, status: string, fromRx?: { execution_id?: string; external_id?: string | null }) {
    let reason = "";
    if (status === "written_off") {
      reason = (await appPrompt(t("Γιατί διαγράφεται το χρέος;", "Why write it off?")))?.trim() || "";
      if (!reason) return;
    } else if (!(await appConfirm(t("Να ξεχρεωθεί;", "Clear this loan?")))) return;
    // από ΠΡΟΤΑΣΗ συνταγής → καταγράφεται η συνταγή (ιστορικό: «Από συνταγή» αντί «Με το χέρι»)
    await api(`/advance-dispensings/${id}/status`, { method: "POST", body: JSON.stringify({ status, reason,
      execution_id: fromRx?.execution_id || null, external_id: fromRx?.external_id || null }) });
    qc.invalidateQueries({ queryKey: ["adv"] });
  }

  /* Κάθε σκεύασμα σε ΔΙΚΗ ΤΟΥ γραμμή, με τον κωδικό που σαρώθηκε.
     ΓΙΑΤΙ: όταν ο φαρμακοποιός ψάχνει «ποιο κουτί έδωσα», ένα όνομα σκευάσματος δεν αρκεί —
     μπορεί να έχει δώσει δύο κουτιά του ίδιου φαρμάκου. Ο κωδικός είναι το μόνο που ξεχωρίζει
     το συγκεκριμένο κουτί, και είναι αυτός που θα εμφανιστεί και στη συνταγή όταν έρθει. */
  const ItemLine = ({ i, loan, idx }: { i: Item; loan?: Loan; idx?: number }) => {
    const code = i.strip || i.lot;
    const cleared = (i.status || "open") !== "open";
    const exp = fmtExpiry(i.expiry);
    const incomplete = !!i.gtin && (!code || (!!i.expiry && !exp));   // λάθος/ελλιπής ανάγνωση QR
    /* Το κουπόνι όπως θα το έβγαζε ο σκάνερ. Η αντιγραφή ΜΟΝΟ του σειριακού ήταν άχρηστη για
       επικόλληση: το εμπορικό πρόγραμμα περιμένει ολόκληρο το GS1 (GTIN + λήξη + παρτίδα +
       σειριακό), ακριβώς όπως θα ερχόταν από το σκανάρισμα. */
    const coupon = { qr_product_code: i.gtin || null, qr_batch: i.batch || null,
                     qr_expiry: i.expiry || null, strip: code };
    const scanText = couponScanString(coupon);
    // Ο σαρώσιμος κωδικός μένει ΚΛΕΙΣΤΟΣ. Ανοιχτός σε κάθε γραμμή, μια λίστα με δέκα δανεικά
    // γίνεται σεντόνι και χάνεται ακριβώς αυτό που ψάχνει ο φαρμακοποιός.
    const [showCode, setShowCode] = useState(false);
    return (
      <div className="py-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${i.gtin ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}>
          {i.gtin ? "QR (HMVS)" : t("Ταινία ΕΟΦ", "ΕΟΦ strip")}
        </span>
        <span className={`font-medium ${cleared ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-200"}`}>
          {i.name || t("(χωρίς όνομα)", "(no name)")}
        </span>
        {loan && idx !== undefined && !i.name && (
          <button onClick={() => nameItem(loan, idx, i)} className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-slate-500 hover:bg-slate-50">
            ✎ {t("όνομα", "name")}
          </button>
        )}
        {(i.qty ?? 1) > 1 && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800">
            ×{i.qty}
          </span>
        )}
        {code && (
          <button onClick={() => { navigator.clipboard?.writeText(scanText); setCopied(code);
                                   setTimeout(() => setCopied(""), 1200); }}
            title={i.gtin
              ? t("Αντιγραφή ολόκληρου του QR (GS1), για επικόλληση στο εμπορικό πρόγραμμα",
                   "Copy the full GS1 QR content, to paste into your POS software")
              : t("Αντιγραφή κωδικού ταινίας", "Copy strip code")}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 font-mono text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300">
            <Copy className="h-3 w-3" />{code}
            {copied === code && <span className="text-emerald-600">{t("αντιγράφηκε", "copied")}</span>}
          </button>
        )}
        {i.gtin && <span className="text-slate-400">GTIN {i.gtin}</span>}
        {i.batch && <span className="text-slate-400">{t("παρτ.", "batch")} {i.batch}</span>}
        {exp && <span className="text-slate-400">{t("λήξη", "exp")} {exp}</span>}
        {incomplete && (
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700" title={t("Ο σαρωτής δεν έστειλε σωστά όλα τα πεδία του QR — δεν θα ταιριάξει αυτόματα με τη συνταγή.", "Scanner did not send all QR fields correctly.")}>
            ⚠ {t("ελλιπής σάρωση", "incomplete scan")}
          </span>
        )}
        {incomplete && loan && idx !== undefined && !cleared && (
          <button onClick={() => rescanItem(loan, idx, i)}
            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-50">
            <ScanLine className="h-3 w-3" />{t("Ξανασκάναρε", "Rescan")}
          </button>
        )}
        {loan && idx !== undefined && loan.status === "open" && (
          cleared
            ? <button onClick={() => itemStatus(loan, idx, "open")} className="ml-auto rounded border border-slate-200 px-1.5 py-0.5 text-slate-500 hover:bg-slate-50">↺ {t("άνοιγμα", "reopen")}</button>
            : <button onClick={() => itemStatus(loan, idx, "cleared")} className="ml-auto inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700 hover:bg-emerald-100">
                <Check className="h-3 w-3" />{t("Ξεχρεώθηκε αυτό", "Clear this one")}
              </button>
        )}
        {code && (
          <button onClick={() => setShowCode((v) => !v)}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${showCode
              ? "border-brand-400 bg-brand-50 text-brand-700"
              : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700"}`}>
            <QrCode className="h-3 w-3" />
            {showCode ? t("Κλείσιμο", "Close") : t("Σάρωση", "Scan")}
          </button>
        )}
      </div>
      {showCode && code && (
        <div className="mt-1.5 w-fit rounded-lg bg-white p-2 ring-1 ring-slate-200">
          <CouponBarcode c={coupon} size={i.gtin ? 150 : 230} />
        </div>
      )}
      </div>
    );
  };

  const Row = ({ l }: { l: Loan }) => {
    const d = daysAgo(l.created_at);
    return (
      <div data-loan={l._id}
        className={`rounded-xl border bg-white px-4 py-2.5 text-sm transition-shadow dark:bg-slate-900 ${
          target === l._id ? "border-orange-400 ring-4 ring-orange-200 dark:ring-orange-900/60"
                           : "border-slate-200 dark:border-slate-700"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800 dark:text-slate-100">{l.patient_name}</span>
          <span className={`text-xs ${d >= 30 ? "text-rose-600" : "text-slate-400"}`}>
            {t("Δόθηκε", "Given")} {fmt(l.created_at)} · {t(`${d} ημέρες`, `${d} days`)}
          </span>
          <button onClick={() => askExpected(l)}
            className={`rounded border px-1.5 py-0.5 text-xs ${l.expected_at
              ? "border-sky-300 bg-sky-50 font-medium text-sky-700"
              : "border-dashed border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
            {l.expected_at
              ? `${t("Θα φέρει συνταγή", "Rx expected")} ${fmt(l.expected_at)}`
              : t("+ ημερομηνία συνταγής", "+ expected date")}
          </button>
          <span className="ml-auto flex gap-1.5">
            <button onClick={() => setStatus(l._id, "cleared")} className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">
              <Check className="h-3.5 w-3.5" />{(l.items || []).length > 1 ? t("Ξεχρεώθηκαν όλα", "All cleared") : t("Ξεχρεώθηκε", "Cleared")}
            </button>
            <button onClick={() => setStatus(l._id, "written_off")} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
              <Trash2 className="h-3.5 w-3.5" />{t("Διαγραφή χρέους", "Write off")}
            </button>
          </span>
        </div>
        <div className="mt-1.5 divide-y divide-slate-100 border-t border-slate-100 pt-1 dark:divide-slate-800 dark:border-slate-800">
          {(l.items || []).map((i, n) => <ItemLine key={n} i={i} loan={l} idx={n} />)}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-teal-600 to-emerald-600 text-white shadow-lg">
          <HandCoins className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t("Προχορηγήσεις σκευασμάτων", "Advance dispensings")}
          </h1>
          <p className="text-sm text-slate-500">
            {t("Τι έδωσες χωρίς συνταγή, σε ποιον, και τι εκκρεμεί ακόμη.",
               "What you gave without a prescription, to whom, and what is still open.")}
          </p>
        </div>
      </header>

      {/* ΣΗΜΕΡΑ ΠΕΡΙΜΕΝΕΙΣ — μπαίνει πρώτο: είναι η δουλειά της ημέρας. */}
      {!!due.data?.count && (
        <section className="rounded-2xl border border-sky-300 bg-sky-50/70 p-4 dark:border-sky-900/50 dark:bg-sky-950/20">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-sky-900 dark:text-sky-200">
            <CalendarClock className="h-4 w-4" />
            {(() => {
              // ΠΕΛΑΤΕΣ, όχι δάνεια: ένας πελάτης με δύο δάνεια δεν είναι «2 πελάτες»
              const loans = due.data.count;
              const people = new Set(due.data.items.map((l) => l.patient_ref || l.patient_name)).size;
              return t(`Σήμερα περιμένεις συνταγή από ${people} ${people === 1 ? "πελάτη" : "πελάτες"}${loans > people ? ` (${loans} δανεικά)` : ""}`,
                       `Prescriptions expected today from ${people} ${people === 1 ? "customer" : "customers"}${loans > people ? ` (${loans} loans)` : ""}`);
            })()}
          </h2>
          <div className="space-y-1.5">
            {due.data.items.map((l) => {
              const late = (l.expected_at || "") < new Date().toISOString().slice(0, 10);
              return (
                <div key={l._id} data-loan={l._id}
                  className={`flex flex-wrap items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm dark:bg-slate-900 ${
                    target === l._id ? "ring-4 ring-orange-300 dark:ring-orange-900/60" : ""}`}>
                  <span className="font-medium text-slate-800 dark:text-slate-100">{l.patient_name}</span>
                  <span className="text-slate-500">
                    {(l.items || []).map((i) => i.name || i.strip || i.lot).filter(Boolean).join(", ")}
                  </span>
                  <span className={`text-xs ${late ? "font-medium text-rose-600" : "text-sky-700"}`}>
                    {late ? t("είχε πει", "was due") : t("σήμερα", "today")} {fmt(l.expected_at)}
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    <button onClick={() => setStatus(l._id, "cleared")} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">
                      <Check className="h-3.5 w-3.5" />{t("Ήρθε — ξεχρέωσέ το", "Cleared")}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ΠΡΟΤΑΣΕΙΣ ΞΕΧΡΕΩΣΗΣ — μπαίνουν ΠΑΝΩ, γιατί είναι το μόνο που απαιτεί απόφαση σήμερα. */}
      {!!sugg.data?.items?.length && (
        <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-900/50 dark:bg-sky-950/20">
          <h2 className="mb-2 text-sm font-semibold text-sky-900 dark:text-sky-200">
            {t("Βρέθηκαν συνταγές που μπορεί να ξεχρεώνουν δανεικά", "Prescriptions that may clear loans")}
          </h2>
          <div className="space-y-2">
            {sugg.data.items.map((m) => (
              <div key={mkey(m)} className="flex flex-wrap items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm dark:bg-slate-900">
                <span className="font-medium">{m.patient_name}</span>
                <span className="text-slate-500">{m.items.filter(Boolean).join(", ")}</span>
                <span className="text-xs text-slate-400">
                  {t("ταιριάζει με", "matches")} {m.execution.external_id} · {fmt(m.execution.executed_at)} · {m.matched_on}
                  {m.same_patient ? t(" · ίδιος πελάτης", " · same patient") : ""}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {m.execution.external_id && (
                    <button onClick={() => setRxView((m.execution.external_id || "").split(":")[0])}
                      className="inline-flex items-center gap-1 rounded-lg border border-sky-300 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50">
                      <Search className="h-3.5 w-3.5" />{t("Δες τη συνταγή", "View prescription")}
                    </button>
                  )}
                  <button onClick={() => clearFromRx(m)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">
                    <Check className="h-3.5 w-3.5" />{t("Ναι, ξεχρέωσέ το", "Yes, clear it")}
                  </button>
                  <button onClick={() => qc.setQueryData(["adv", "matches"], (old: { items: Match[] } | undefined) =>
                      ({ items: (old?.items || []).filter((x) => mkey(x) !== mkey(m)) }))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
                    <X className="h-3.5 w-3.5" />{t("Όχι", "No")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <RxPopup barcode={rxView} onClose={() => setRxView(null)} />
      <Modal open={!!clearDlg} onClose={() => setClearDlg(null)}
        title={t("Ποια σκευάσματα ξεχρεώνει αυτή η συνταγή;", "Which items does this prescription clear?")}
        footer={clearDlg && (
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setClearDlg(null)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">{t("Άκυρο", "Cancel")}</button>
            <button type="button" disabled={!clearSel.length || clearSel.length === (clearDlg.item_idxs ?? []).length}
              onClick={() => doClear(clearSel)}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40">
              {t(`Ξεχρέωση επιλεγμένων (${clearSel.length})`, `Clear selected (${clearSel.length})`)}
            </button>
            <button type="button" onClick={() => doClear(clearDlg.item_idxs ?? [])}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700">
              {t("Ξεχρέωση όλων", "Clear all")}
            </button>
          </div>
        )}>
        {clearDlg && (
          <div className="space-y-2 text-sm">
            <p className="text-slate-600 dark:text-slate-300">
              {clearDlg.patient_name} · {t("συνταγή", "prescription")} <b>{clearDlg.execution.external_id}</b> ({fmt(clearDlg.execution.executed_at)}).
              {" "}{t("Αν εκτελέστηκαν μόνο μερικά, ξετσέκαρε όσα ΔΕΝ δόθηκαν με αυτή — θα μείνουν ανοιχτό χρέος.", "Untick the ones NOT dispensed with it — they stay open.")}
            </p>
            {(clearDlg.item_idxs ?? []).map((ix, k) => (
              <label key={ix} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                <input type="checkbox" checked={clearSel.includes(ix)}
                  onChange={(e) => setClearSel((cur) => e.target.checked ? [...cur, ix] : cur.filter((x) => x !== ix))} />
                <span className="font-medium">{clearDlg.items[k] || "—"}</span>
              </label>
            ))}
          </div>
        )}
      </Modal>

      {/* ΚΑΤΑΓΡΑΦΗ — ΕΝΑΣ πελάτης επάνω, ΟΣΑ σκευάσματα θέλει από κάτω, μία αποθήκευση. */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Νέα προχορήγηση", "New advance dispensing")}</h2>

        {/* 1. ΠΕΛΑΤΗΣ */}
        <div className="relative">
          <span className="mb-1 block text-xs font-medium text-slate-500">{t("1. Πελάτης", "1. Customer")}</span>
          {patient ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-950/30">
              <UserRound className="h-4 w-4 text-emerald-600" />
              <span className="font-medium text-emerald-900 dark:text-emerald-200">{patient.name || "—"}</span>
              {patient.amka && <span className="text-xs text-emerald-700/70 dark:text-emerald-300/60">ΑΜΚΑ {patient.amka}</span>}
              <button onClick={() => { setPatient(null); setTerm(""); }} className="ml-auto text-emerald-700 hover:text-rose-600">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-600 dark:bg-slate-800">
                <Search className="h-4 w-4 shrink-0 text-slate-400" />
                <input value={term} autoComplete="off"
                  onChange={(e) => { setTerm(e.target.value); setOpenList(true); }}
                  onFocus={() => setOpenList(true)}
                  placeholder={t("όνομα, ΑΜΚΑ ή τηλέφωνο — τουλάχιστον 2 χαρακτήρες", "name, ΑΜΚΑ or phone — at least 2 characters")}
                  className="w-full bg-transparent text-sm outline-none" />
                {hits.isFetching && <span className="text-xs text-slate-400">…</span>}
              </div>
              {openList && debounced.length >= 2 && (
                <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
                  {!hits.isFetching && !hits.data?.items?.length && (
                    <p className="px-3 py-2.5 text-sm text-slate-400">
                      {t("Κανένας πελάτης. Φτιάξε πρώτα καρτέλα στους Ασφαλισμένους.",
                         "No customer found. Create the card first.")}
                    </p>
                  )}
                  {(hits.data?.items || []).map((h) => (
                    <button key={h.patient_id} onClick={() => { setPatient(h); setOpenList(false); setTimeout(() => scanRef.current?.focus(), 30); }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                      <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="font-medium text-slate-800 dark:text-slate-100">{h.name || "—"}</span>
                      {h.amka && <span className="text-xs text-slate-400">ΑΜΚΑ {h.amka}</span>}
                      {h.last_seen && <span className="ml-auto text-xs text-slate-400">{fmt(h.last_seen)}</span>}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 2. ΣΚΕΥΑΣΜΑΤΑ — όσα θέλει, με τη σειρά */}
        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            {t("2. Σκευάσματα που δόθηκαν — σάρωσε το ένα μετά το άλλο", "2. Products given — scan them one after another")}
            {!!items.length && (
              <span className="ml-2 rounded-full bg-teal-600 px-2 py-0.5 text-[11px] font-bold text-white">
                {items.length}
              </span>
            )}
          </span>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-teal-500" />
              <input ref={scanRef} defaultValue="" autoComplete="off" autoCorrect="off" spellCheck={false}
                placeholder={t("σάρωσε QR ή ταινία ΕΟΦ — το ένα μετά το άλλο, δεν πατάς τίποτα",
                               "scan QR or ΕΟΦ strip — one after another, press nothing")}
                className="block w-full rounded-lg border-2 border-teal-300 bg-teal-50/40 py-2 pl-9 pr-3 text-sm outline-none focus:border-teal-500 dark:border-teal-800 dark:bg-slate-800" />
            </div>
            {/* Μόνο για χειροκίνητη πληκτρολόγηση — η σάρωση δεν το χρειάζεται ποτέ. */}
            <button onClick={() => addScan()} title={t("για χειροκίνητη πληκτρολόγηση", "for manual typing")}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 text-sm text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <ScannerCheck />
          {badScan && (
            <p className="mt-1.5 text-xs font-medium text-rose-600">
              {t("Το σκανάρισμα ήρθε κομμένο (χάθηκαν χαρακτήρες) — σκάναρε ξανά το ίδιο κουτί.",
                 "The scan arrived truncated — scan the same box again.")}
            </p>
          )}
          {dup && (
            <p className="mt-1.5 text-xs font-medium text-amber-600">
              {t("Αυτό το κουτί σαρώθηκε ήδη — άλλαξε τα «τεμ.» αν έδωσες δεύτερο.",
                 "This box was already scanned — change the qty if you gave a second one.")}
            </p>
          )}
        </div>

        {!!items.length && (
          <ul className="mt-3 space-y-1.5">
            {items.map((i, n) => (
              <li key={n} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs dark:bg-slate-800">
                <ScanLine className="h-3.5 w-3.5 text-slate-400" />
                <input value={i.name || ""} onChange={(e) => setItems((x) => x.map((y, k) => k === n ? { ...y, name: e.target.value } : y))}
                  placeholder={t("όνομα σκευάσματος (προαιρετικό)", "product name (optional)")}
                  className="w-56 rounded border border-slate-200 px-2 py-1 dark:border-slate-600 dark:bg-slate-900" />
                <label className="flex items-center gap-1 text-slate-500">
                  {t("τεμ.", "qty")}
                  <input type="number" min={1} value={i.qty ?? 1}
                    onChange={(e) => setItems((x) => x.map((y, k) => k === n ? { ...y, qty: Math.max(1, Number(e.target.value) || 1) } : y))}
                    className="w-14 rounded border border-slate-200 px-2 py-1 dark:border-slate-600 dark:bg-slate-900" />
                </label>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${i.gtin ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}>
                  {i.gtin ? "QR (HMVS)" : t("Ταινία ΕΟΦ", "ΕΟΦ strip")}
                </span>
                <span className="font-mono text-slate-500">
                  {i.strip || i.lot}
                  {i.gtin ? ` · GTIN ${i.gtin}` : ""}
                </span>
                <button onClick={() => setItems((x) => x.filter((_, k) => k !== n))} className="ml-auto text-slate-400 hover:text-rose-600">
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Προαιρετικό, αλλά είναι αυτό που μετατρέπει το δανεικό από «κάποτε» σε ραντεβού. */}
        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            {t("3. Πότε θα φέρει τη συνταγή (προαιρετικό)", "3. When will they bring the prescription (optional)")}
          </span>
          <div className="max-w-xs">
            <DateInput value={expected} onChange={setExpected} />
          </div>
        </div>

        <button onClick={save} disabled={busy || !patient || !items.length}
          className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {items.length > 1
            ? t(`Καταχώρηση ${items.length} σκευασμάτων`, `Record ${items.length} products`)
            : t("Καταχώρηση", "Record")}
        </button>
      </section>

      {/* ΤΙ ΑΡΓΕΙ */}
      {!!late.data?.counts?.overdue && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <AlertTriangle className="h-4 w-4 text-amber-500" />{t("Ανοιχτά πάνω από 30 ημέρες", "Open over 30 days")}
          </h2>
          {(late.data?.items || []).map((l) => <Row key={l._id} l={l} />)}
        </section>
      )}

      {/* ΟΛΑ ΤΑ ΑΝΟΙΧΤΑ */}
      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Clock className="h-4 w-4 text-slate-400" />{t("Ανοιχτά δανεικά", "Open loans")}
        </h2>
        {open.isLoading && <p className="text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</p>}
        {!open.isLoading && !open.data?.items?.length && (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
            {t("Κανένα ανοιχτό δανεικό.", "No open loans.")}
          </p>
        )}
        {(open.data?.items || []).map((l) => <Row key={l._id} l={l} />)}
      </section>
    </div>
  );
}
