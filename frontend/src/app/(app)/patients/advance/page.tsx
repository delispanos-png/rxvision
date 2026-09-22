"use client";

/* Προχορηγήσεις σκευασμάτων («δανεικά»).

   ΔΕΝ είναι λογιστική αποθήκης. Ο φαρμακοποιός θέλει να θυμάται ποιος του χρωστά κουτί και να
   το σβήνει όταν έρθει η συνταγή — τίποτα παραπάνω.

   Η ΤΑΥΤΙΣΗ ΕΙΝΑΙ ΠΡΟΤΑΣΗ, ΟΧΙ ΠΡΑΞΗ: η ταινία γνησιότητας δεν είναι μοναδική (μετρημένο: 15%
   επαναλαμβάνονται), οπότε το τελικό «ναι» το δίνει πάντα ο άνθρωπος. */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HandCoins, ScanLine, Check, X, Clock, AlertTriangle, Plus, Trash2, Search, UserRound } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Item = { name?: string; gtin?: string; batch?: string; strip?: string; lot?: string;
              expiry?: string; qty?: number; has_qr?: boolean; hmvo_uploaded?: boolean;
              raw?: string };
type Loan = { _id: string; patient_name: string; items: Item[]; status: string;
              created_at: string; note?: string };
type Hit = { patient_id: string; name: string | null; amka: string | null; last_seen?: string | null };
type Match = { loan_id: string; patient_name: string; created_at: string; items: string[];
               execution: { external_id: string | null; executed_at: string | null };
               matched_on: string; same_patient: boolean };

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const daysAgo = (s?: string) => (s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : 0);

/** GS1 DataMatrix → πεδία. Ο φαρμακοποιός σαρώνει ΜΙΑ φορά αντί να πληκτρολογεί τέσσερα πεδία.
 *  Μορφή: 01<14 GTIN> 17<YYMMDD λήξη> 10<παρτίδα> 21<σειριακό>, με προαιρετικό διαχωριστικό. */
function parseGs1(raw: string): Item | null {
  const s = raw.replace(/[\u001d␝]/g, "\u001d").trim();
  if (!s || !/^01\d{14}/.test(s)) return null;
  const out: Item = { gtin: s.slice(2, 16) };
  let rest = s.slice(16);
  const take = (ai: string, len?: number) => {
    const i = rest.indexOf(ai);
    if (i < 0) return undefined;
    const after = rest.slice(i + ai.length);
    const val = len ? after.slice(0, len) : after.split("\u001d")[0];
    rest = rest.slice(0, i) + (len ? after.slice(len) : after.slice(val.length + 1));
    return val;
  };
  out.expiry = take("17", 6);
  out.batch = take("10");
  out.strip = take("21");
  // Μετρημένο σε 6.000/6.000 είδη: το `details.lot` της εκτέλεσης ΕΙΝΑΙ η ταινία του κουπονιού
  // — όχι η παρτίδα παραγωγής. Γράφουμε τον ίδιο κωδικό και στα δύο πεδία ώστε η ταύτιση να
  // τον βρίσκει από όποιο μονοπάτι κι αν ψάξει.
  out.lot = out.strip;
  return out;
}

export default function AdvanceDispensingsPage() {
  return (
    <ModuleGuard module="advance_dispensing">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const t = useT();
  const qc = useQueryClient();
  const [patient, setPatient] = useState<Hit | null>(null);
  const [term, setTerm] = useState("");
  const [openList, setOpenList] = useState(false);
  const [scan, setScan] = useState("");
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
  const late = useQuery({ queryKey: ["adv", "overdue"], queryFn: () => api<{ qr_over_10d: Loan[]; over_30d: Loan[]; counts: Record<string, number> }>("/advance-dispensings/overdue") });
  const sugg = useQuery({ queryKey: ["adv", "matches"], queryFn: () => api<{ items: Match[] }>("/advance-dispensings/matches") });

  /* ΓΡΗΓΟΡΗ ΣΑΡΩΣΗ — ο φαρμακοποιός δεν πατάει τίποτα.

     Ο σαρωτής συμπεριφέρεται σαν πληκτρολόγιο που γράφει ασύλληπτα γρήγορα (λίγα ms ανά
     χαρακτήρα) και συνήθως — όχι πάντα — τελειώνει με Enter. Στηριζόμαστε ΚΑΙ στα δύο:
     Enter/Tab καταχωρεί αμέσως, αλλιώς η «ριπή» χαρακτήρων καταχωρείται μόλις σταματήσει.
     Έτσι δουλεύει και το QR (2D) και ο γραμμικός των παλιών κουπονιών, χωρίς ρύθμιση. */
  const lastKeyAt = useRef(0);
  const isBurst = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dup, setDup] = useState("");
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function addScan(value?: string) {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const v = (value ?? scan).trim();
    if (!v) return;
    const key = v.toUpperCase();
    // Διπλό πέρασμα του ΙΔΙΟΥ κουτιού: ο κωδικός είναι μοναδικός ανά κουτί, οπότε ίδιος
    // κωδικός = ξανασαρώθηκε το ίδιο. Δύο κουτιά → «τεμ.», όχι δεύτερη γραμμή.
    if (items.some((i) => i.raw === key)) {
      setScan(""); setDup(key);
      setTimeout(() => setDup(""), 1600);
      scanRef.current?.focus();
      return;
    }
    const parsed = parseGs1(v);
    // Μη-GS1 = γραμμικός παλιού κουπονιού → είναι ΤΑΙΝΙΑ, όχι παρτίδα. Στα δύο πεδία.
    setItems((x) => [...x, { ...(parsed ?? { strip: key, lot: key, name: "" }), raw: key }]);
    setScan("");
    scanRef.current?.focus();
  }

  function onScanChange(v: string) {
    const now = Date.now();
    const gap = now - lastKeyAt.current;
    lastKeyAt.current = now;
    if (v.length <= 1) isBurst.current = true;      // νέα σάρωση ξεκινά
    else if (gap > 60) isBurst.current = false;     // τόσο αργά γράφει μόνο άνθρωπος
    setScan(v);
    if (timer.current) clearTimeout(timer.current);
    if (isBurst.current && v.trim().length >= 6) {
      // η ριπή τελείωσε → καταχώρησε. Το Enter του σαρωτή απλώς προλαβαίνει.
      timer.current = setTimeout(() => addScan(v), 140);
    }
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
        amka: patient.amka, items: items.map(({ raw: _r, ...i }) => i) }) });
      setPatient(null); setTerm(""); setItems([]);
      qc.invalidateQueries({ queryKey: ["adv"] });
    } catch (e) {
      const msg = (e as { problem?: { detail?: { message?: string } } })?.problem?.detail?.message;
      appAlert(msg || t("Δεν αποθηκεύτηκε.", "Not saved."));
    }
    finally { setBusy(false); }
  }

  async function setStatus(id: string, status: string) {
    let reason = "";
    if (status === "written_off") {
      reason = (await appPrompt(t("Γιατί διαγράφεται το χρέος;", "Why write it off?")))?.trim() || "";
      if (!reason) return;
    } else if (!(await appConfirm(t("Να ξεχρεωθεί;", "Clear this loan?")))) return;
    await api(`/advance-dispensings/${id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) });
    qc.invalidateQueries({ queryKey: ["adv"] });
  }

  const Row = ({ l }: { l: Loan }) => {
    const d = daysAgo(l.created_at);
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-900">
        <span className="font-medium text-slate-800 dark:text-slate-100">{l.patient_name}</span>
        <span className="text-slate-500">
          {(l.items || []).map((i) => i.name || i.gtin || i.lot).filter(Boolean).join(", ")}
        </span>
        <span className={`text-xs ${d >= 30 ? "text-rose-600" : d >= 10 ? "text-amber-600" : "text-slate-400"}`}>
          {fmt(l.created_at)} · {t(`${d} ημέρες`, `${d} days`)}
        </span>
        {(l.items || []).some((i) => i.has_qr && !i.hmvo_uploaded) && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            {t("δεν ανέβηκε στον HMVO", "not on HMVO")}
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          <button onClick={() => setStatus(l._id, "cleared")} className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">
            <Check className="h-3.5 w-3.5" />{t("Ξεχρεώθηκε", "Cleared")}
          </button>
          <button onClick={() => setStatus(l._id, "written_off")} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
            <Trash2 className="h-3.5 w-3.5" />{t("Διαγραφή χρέους", "Write off")}
          </button>
        </span>
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

      {/* ΠΡΟΤΑΣΕΙΣ ΞΕΧΡΕΩΣΗΣ — μπαίνουν ΠΑΝΩ, γιατί είναι το μόνο που απαιτεί απόφαση σήμερα. */}
      {!!sugg.data?.items?.length && (
        <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-900/50 dark:bg-sky-950/20">
          <h2 className="mb-2 text-sm font-semibold text-sky-900 dark:text-sky-200">
            {t("Βρέθηκαν συνταγές που μπορεί να ξεχρεώνουν δανεικά", "Prescriptions that may clear loans")}
          </h2>
          <div className="space-y-2">
            {sugg.data.items.map((m) => (
              <div key={m.loan_id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm dark:bg-slate-900">
                <span className="font-medium">{m.patient_name}</span>
                <span className="text-slate-500">{m.items.filter(Boolean).join(", ")}</span>
                <span className="text-xs text-slate-400">
                  {t("ταιριάζει με", "matches")} {m.execution.external_id} · {fmt(m.execution.executed_at)} · {m.matched_on}
                  {m.same_patient ? t(" · ίδιος πελάτης", " · same patient") : ""}
                </span>
                <span className="ml-auto flex gap-1.5">
                  <button onClick={() => setStatus(m.loan_id, "cleared")} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">
                    <Check className="h-3.5 w-3.5" />{t("Ναι, ξεχρέωσέ το", "Yes, clear it")}
                  </button>
                  <button onClick={() => qc.setQueryData(["adv", "matches"], (old: { items: Match[] } | undefined) =>
                      ({ items: (old?.items || []).filter((x) => x.loan_id !== m.loan_id) }))}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
                    <X className="h-3.5 w-3.5" />{t("Όχι", "No")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

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
              <input ref={scanRef} value={scan} autoComplete="off"
                onChange={(e) => onScanChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); addScan(); } }}
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

        <button onClick={save} disabled={busy || !patient || !items.length}
          className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {items.length > 1
            ? t(`Καταχώρηση ${items.length} σκευασμάτων`, `Record ${items.length} products`)
            : t("Καταχώρηση", "Record")}
        </button>
      </section>

      {/* ΤΙ ΑΡΓΕΙ */}
      {!!(late.data?.counts?.qr_over_10d || late.data?.counts?.over_30d) && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <AlertTriangle className="h-4 w-4 text-amber-500" />{t("Αργούν", "Overdue")}
          </h2>
          {(late.data?.qr_over_10d || []).map((l) => <Row key={l._id} l={l} />)}
          {(late.data?.over_30d || []).map((l) => <Row key={l._id} l={l} />)}
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
