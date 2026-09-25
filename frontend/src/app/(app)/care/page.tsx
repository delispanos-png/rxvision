"use client";

/* Δομές Φροντίδας — κύκλος ετοιμασίας & λογαριασμός.

   Η ΔΟΜΗ ΧΡΩΣΤΑ ΜΟΝΟ ΤΗ ΣΥΜΜΕΤΟΧΗ. Ό,τι καλύπτει το ταμείο τρέχει στο κύκλωμα Αποζημίωσης και
   δεν εμφανίζεται εδώ καθόλου — αλλιώς ο φαρμακοποιός θα νόμιζε ότι του χρωστά και εκείνα.

   ΔΕΝ ΞΕΡΟΥΜΕ ΠΟΙΕΣ ΣΥΝΤΑΓΕΣ ΕΞΟΦΛΗΘΗΚΑΝ: η δομή φέρνει ένα ποσό, όχι εξόφληση συγκεκριμένης
   συνταγής. Γι' αυτό ο λογαριασμός διαβάζεται σαν εκκαθαριστικό — υπόλοιπο από προηγούμενο,
   χρεώσεις, εισπράξεις, νέο υπόλοιπο — και καμία γραμμή δεν μαρκάρεται «πληρωμένη».

   «Δομή» δεν σημαίνει κτίριο: ο ίδιος μηχανισμός καλύπτει γηροκομείο, ξενώνα, κατ' οίκον
   φροντίδα, ακόμη και ιδιώτη φροντιστή. */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Home, Plus, Search, Trash2, UserRound, Wallet, CalendarClock, PackageSearch,
         AlertTriangle, HandCoins, Settings2, Receipt, Building2, Pencil, Send } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Row = { id: string; name: string; care_type?: string | null; members: number;
             balance: number; last_receipt_at?: string | null; last_receipt?: number | null };
type Portfolio = { items: Row[]; total_open: number };
type Member = { pseudo_id: string; patient_id: string | null; name: string; amka: string | null;
                pending: boolean; deceased: boolean; executions: number; patient_share: number;
                unexec_value: number; loans: number; next_open: string | null };
type Billing = { afm?: string; address?: string; phone?: string; email?: string;
                 contact_name?: string; contact_phone?: string; hours?: string;
                 authorization?: string; authorized_at?: string; notes?: string };
type Detail = { id: string; name: string; members: Member[]; balance: number;
                care_type?: string | null; billing?: Billing; charges_from?: string | null };
type Entry = { _id: string; kind: string; amount_cents: number; at: string; note?: string };
type Statement = { month: string; opening: number; charges: number; receipts: number;
                   closing: number; by_member: { name: string; amount: number; deceased: boolean }[];
                   entries: Entry[] };
type Cycle = {
  horizon_days: number;
  opening: { name: string; barcode: string; opens_at: string; items: string[] }[];
  order: { name: string; qty: number; people: number }[];
  pending: { name: string; barcode: string; valid_until: string | null; value: number;
             items: { name: string | null; left: number }[] }[];
  loans: { name: string; created_at: string; items: string[] }[];
};
type OwedRx = { barcode: string; opens_at: string | null; intangible: boolean; items: string[] };
type Owed = { days: number; people: { patient_id: string; name: string; rx: OwedRx[] }[];
              email?: string | null; contact?: string | null; html: string };
type Instr = { people: { patient_id: string; name: string;
                         meds: { name: string; dosage: string }[] }[];
               email?: string | null; html: string };
type Hit = { patient_id: string; name: string | null; amka: string | null };

const eur = (c?: number | null) =>
  ((c ?? 0) / 100).toLocaleString("el-GR", { style: "currency", currency: "EUR" });
const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function CarePage() {
  return (
    <ModuleGuard module="care_homes">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const t = useT();
  const qc = useQueryClient();
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<"info" | "account" | "cycle" | "people">("account");
  // Ο κύκλος είναι ΤΡΙΑ ΦΥΛΛΑ ΕΡΓΑΣΙΑΣ, όχι τρία πανάκια στη σειρά: το καθένα απαντά σε άλλη
  // ερώτηση και διαβάζεται μόνο του («τι ανοίγει», «τι παραγγέλνω», «τι χρωστάω σε ποιον»).
  const [cyTab, setCyTab] = useState<"opening" | "order" | "pending" | "owed" | "instr">("opening");
  // ΜΗΝΑΣ εξ ορισμού: ο κύκλος της δομής είναι μηνιαίος. Οι «45 ημέρες» ήταν αυθαίρετες.
  const [days, setDays] = useState(30);
  const [month, setMonth] = useState(thisMonth());
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);

  const pf = useQuery({ queryKey: ["care-portfolio"],
    queryFn: () => api<Portfolio>("/care-structures/portfolio") });
  const detail = useQuery({ queryKey: ["care", sel],
    queryFn: () => api<Detail>(`/care-structures/${sel}`), enabled: !!sel });
  const st = useQuery({ queryKey: ["care-st", sel, month],
    queryFn: () => api<Statement>(`/care-structures/${sel}/statement?month=${month}`),
    enabled: !!sel && tab === "account" });
  const owed = useQuery({ queryKey: ["care-owed", sel, days],
    queryFn: () => api<Owed>(`/care-structures/${sel}/owed?days=${days}`),
    enabled: !!sel && tab === "cycle" });
  const instr = useQuery({ queryKey: ["care-instr", sel],
    queryFn: () => api<Instr>(`/care-structures/${sel}/instructions`),
    enabled: !!sel && tab === "cycle" && cyTab === "instr" });
  const cy = useQuery({ queryKey: ["care-cycle", sel, days],
    queryFn: () => api<Cycle>(`/care-structures/${sel}/cycle?days=${days}`),
    enabled: !!sel && tab === "cycle" });

  useEffect(() => {
    if (term.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(() => {
      api<{ items: Hit[] }>(`/care-structures/patients?q=${encodeURIComponent(term.trim())}`)
        .then((r) => setHits(r.items)).catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(id);
  }, [term]);

  const reload = () => {
    ["care-portfolio", "care", "care-st", "care-cycle"].forEach((k) =>
      qc.invalidateQueries({ queryKey: [k] }));
  };

  async function createStructure() {
    const name = await appPrompt(t("Όνομα δομής", "Structure name"));
    if (!name?.trim()) return;
    const r = await api<{ ok: boolean; id?: string }>("/care-structures",
      { method: "POST", body: JSON.stringify({ name }) });
    if (r.ok && r.id) { setSel(r.id); setTab("people"); }
    reload();
  }

  async function chargesFrom() {
    if (!sel) return;
    const d = await appPrompt(
      t("Από ποια ημερομηνία χρεώνουμε αυτή τη δομή; (ΗΗ/ΜΜ/ΕΕΕΕ) — ισχύει για όλους τους τροφίμους που είναι ήδη μέσα.",
        "Charge this structure from which date? (DD/MM/YYYY) — applies to everyone already in it."),
      { placeholder: "01/01/2026" });
    if (!d?.trim()) return;
    const m = d.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) { await appAlert(t("Μορφή ΗΗ/ΜΜ/ΕΕΕΕ.", "Format DD/MM/YYYY.")); return; }
    await api(`/care-structures/${sel}/settings`, { method: "PATCH",
      body: JSON.stringify({ charges_from: `${m[3]}-${m[2]}-${m[1]}` }) });
    reload();
  }

  async function addReceipt() {
    if (!sel) return;
    const v = await appPrompt(t("Ποσό είσπραξης σε ευρώ", "Receipt amount in euro"),
      { placeholder: "1000,00" });
    if (!v?.trim()) return;
    const cents = Math.round(parseFloat(v.replace(/\./g, "").replace(",", ".")) * 100);
    if (!cents || Number.isNaN(cents) || cents <= 0) {
      await appAlert(t("Δώσε θετικό ποσό.", "Enter a positive amount.")); return;
    }
    const note = await appPrompt(t("Σημείωση (προαιρετικό)", "Note (optional)"));
    const r = await api<{ ok: boolean }>(`/care-structures/${sel}/entries`, { method: "POST",
      body: JSON.stringify({ kind: "receipt", amount_cents: cents, note: note || "" }) });
    if (!r.ok) await appAlert(t("Δεν καταχωρήθηκε.", "Not saved."));
    reload();
  }

  async function addCharge() {
    if (!sel) return;
    const v = await appPrompt(
      t("Χειροκίνητη χρέωση σε ευρώ (παραφάρμακα κ.λπ.) — οι συμμετοχές μπαίνουν μόνες τους.",
        "Manual charge in euro (OTC etc.) — co-payments are added automatically."));
    if (!v?.trim()) return;
    const cents = Math.round(parseFloat(v.replace(/\./g, "").replace(",", ".")) * 100);
    if (!cents || Number.isNaN(cents)) { await appAlert(t("Άκυρο ποσό.", "Invalid amount.")); return; }
    const note = await appPrompt(t("Τι αφορά;", "What is it for?"));
    await api(`/care-structures/${sel}/entries`, { method: "POST",
      body: JSON.stringify({ kind: "manual", amount_cents: cents, note: note || "" }) });
    reload();
  }

  async function delEntry(e: Entry) {
    if (!sel) return;
    if (!(await appConfirm(t(`Διαγραφή γραμμής ${eur(e.amount_cents)};`,
      `Delete entry ${eur(e.amount_cents)}?`), { danger: true }))) return;
    await api(`/care-structures/${sel}/entries/${e._id}`, { method: "DELETE" });
    reload();
  }

  async function addMember(body: Record<string, unknown>) {
    if (!sel) return;
    const r = await api<{ ok: boolean; error?: string }>(`/care-structures/${sel}/members`,
      { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) {
      await appAlert(
        r.error === "deceased" ? t("Ο ασφαλισμένος είναι καταγεγραμμένος ως θανών — δεν προστίθεται.",
                                   "This person is recorded as deceased — cannot be added.")
        : r.error === "already_member" ? t("Είναι ήδη τρόφιμος.", "Already a resident.")
        : r.error === "bad_amka" ? t("Το ΑΜΚΑ πρέπει να είναι 11 ψηφία.", "AMKA must be 11 digits.")
        : t("Δεν προστέθηκε.", "Could not add."));
      return;
    }
    setTerm(""); setHits([]);
    reload();
  }

  async function saveSettings(body: Record<string, unknown>) {
    if (!sel) return;
    await api(`/care-structures/${sel}/settings`, { method: "PATCH", body: JSON.stringify(body) });
    reload();
  }
  async function editField(key: string, label: string, cur?: string | null) {
    const v = await appPrompt(label, { defaultValue: cur || "" });
    if (v === null) return;
    await saveSettings({ [key]: v });
  }
  /** Τα στοιχεία επικοινωνίας ζουν όλα μαζί σε ένα αντικείμενο — στέλνουμε το ΣΥΝΟΛΟ,
   *  αλλιώς κάθε αποθήκευση θα έσβηνε τα υπόλοιπα πεδία. */
  async function editBilling(key: string, label: string) {
    if (!d) return;
    const cur = (d.billing ?? {}) as Record<string, string | undefined>;
    const v = await appPrompt(label, { defaultValue: cur[key] || "" });
    if (v === null) return;
    await saveSettings({ billing: { ...cur, [key]: v } });
  }

  /** Εκτύπωση: ανοίγει το ΙΔΙΟ κείμενο που φεύγει και με email — μία πηγή αλήθειας. */
  function printHtml(html?: string) {
    if (!html) return;
    const w = window.open("", "_blank", "width=780,height=900");
    if (!w) { appAlert(t("Ο browser απέκλεισε το παράθυρο εκτύπωσης.", "The browser blocked the print window.")); return; }
    w.document.write(`<html><head><title>RxVision</title></head><body>${html}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  async function sendInstr() {
    if (!sel) return;
    const to = await appPrompt(t("Σε ποιο email να σταλεί;", "Send to which email?"),
                               { defaultValue: instr.data?.email || "" });
    if (!to?.trim()) return;
    const r = await api<{ ok: boolean; error?: string; people?: number }>(
      `/care-structures/${sel}/instructions/send?to=${encodeURIComponent(to.trim())}`,
      { method: "POST" });
    await appAlert(r.ok ? t(`Στάλθηκε — ${r.people} τρόφιμοι.`, `Sent — ${r.people} residents.`)
                        : t("Η αποστολή απέτυχε.", "Sending failed."));
  }

  async function sendOwed() {
    if (!sel) return;
    const to = await appPrompt(
      t("Σε ποιο email να σταλεί;", "Send to which email?"),
      { defaultValue: owed.data?.email || "" });
    if (!to?.trim()) return;
    const r = await api<{ ok: boolean; error?: string; people?: number }>(
      `/care-structures/${sel}/owed/send?days=${days}&to=${encodeURIComponent(to.trim())}`,
      { method: "POST" });
    await appAlert(
      r.ok ? t(`Στάλθηκε — ${r.people} τρόφιμοι.`, `Sent — ${r.people} residents.`)
      : r.error === "no_email" ? t("Δεν υπάρχει email. Συμπλήρωσέ το στα Στοιχεία.", "No email on file.")
      : r.error === "empty" ? t("Δεν υπάρχει τίποτα να σταλεί.", "Nothing to send.")
      : t("Η αποστολή απέτυχε.", "Sending failed."));
  }

  async function removeMember(m: Member) {
    if (!sel) return;
    if (!(await appConfirm(
      t(`Αφαίρεση του τροφίμου «${m.name}» από τη δομή; Οι χρεώσεις που έχουν ήδη γίνει μένουν στον λογαριασμό.`,
        `Remove ${m.name} from this structure? Charges already made stay on the account.`),
      { danger: true }))) return;
    await api(`/care-structures/${sel}/members/${m.pseudo_id}`, { method: "DELETE" });
    reload();
  }

  async function removeStructure() {
    if (!detail.data) return;
    if (!(await appConfirm(t(`Να διαγραφεί η «${detail.data.name}»; Το ιστορικό των τροφίμων δεν θίγεται.`,
      `Delete ${detail.data.name}? Resident history is untouched.`), { danger: true }))) return;
    await api(`/care-structures/${detail.data.id}`, { method: "DELETE" });
    setSel(null); reload();
  }

  const d = detail.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800 dark:text-slate-100">
            <Home className="h-5 w-5 text-rose-500" /> {t("Δομές Φροντίδας", "Care structures")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("Τι ανοίγει τον επόμενο κύκλο, τι να παραγγείλεις, και τι σου χρωστά η κάθε δομή.",
               "What opens next cycle, what to order, and what each structure owes you.")}
          </p>
        </div>
        <button onClick={createStructure}
          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700">
          <Plus className="h-4 w-4" /> {t("Νέα δομή", "New structure")}
        </button>
      </div>

      {/* ── πορτφόλιο ── */}
      {!sel && (
        <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-100 p-4 dark:border-slate-800">
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              <Wallet className="h-4 w-4 text-slate-400" /> {t("Ανοιχτά υπόλοιπα", "Open balances")}
            </span>
            <span className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              {eur(pf.data?.total_open)}
            </span>
          </div>
          {!pf.data?.items.length ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {t("Καμία δομή ακόμη. Γηροκομείο, ξενώνας, κατ' οίκον φροντίδα — ξεκίνα με το κουμπί πάνω δεξιά.",
                 "No structures yet. Start with the button above.")}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {pf.data.items.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setSel(r.id)}
                    className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
                    {r.care_type && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{r.care_type}</span>}
                    <span className="text-xs text-slate-400">{r.members} {t("τρόφιμοι", "residents")}</span>
                    <span className="ml-auto text-right">
                      <span className={`block font-semibold ${r.balance > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                        {eur(r.balance)}
                      </span>
                      <span className="block text-[11px] text-slate-400">
                        {r.last_receipt_at
                          ? t(`τελευταία είσπραξη ${fmt(r.last_receipt_at)}`, `last receipt ${fmt(r.last_receipt_at)}`)
                          : t("καμία είσπραξη ακόμη", "no receipt yet")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── λεπτομέρεια δομής ── */}
      {sel && d && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setSel(null)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700">
                ← {t("Όλες οι δομές", "All structures")}
              </button>
              <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{d.name}</h2>
              <span className={`ml-auto text-lg font-semibold ${d.balance > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                {eur(d.balance)}
              </span>
              <button onClick={chargesFrom} title={t("Από πότε χρεώνουμε", "Charge from")}
                className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 dark:border-slate-700">
                <Settings2 className="h-4 w-4" />
              </button>
              <button onClick={removeStructure}
                className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 flex gap-1 border-b border-slate-100 dark:border-slate-800">
              {([["info", t("Στοιχεία", "Details")],
                 ["account", t("Λογαριασμός", "Account")],
                 ["cycle", t("Κύκλος ετοιμασίας", "Preparation cycle")],
                 ["people", t("Τρόφιμοι", "Residents")]] as const).map(([k, lbl]) => (
                <button key={k} onClick={() => setTab(k as typeof tab)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                    tab === k ? "border-rose-500 font-semibold text-rose-600"
                              : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* ── ΣΤΟΙΧΕΙΑ ΔΟΜΗΣ ── Η δομή είναι ΠΕΛΑΤΗΣ: ποιον παίρνω τηλέφωνο, πού παραδίδω,
              ποιος υπογράφει. Έτσι δουλεύουν και τα αντίστοιχα συστήματα στο εξωτερικό. */}
          {tab === "info" && (
            <div className="space-y-3">
              <Panel title={t("Στοιχεία δομής", "Structure details")}
                     icon={<Building2 className="h-4 w-4 text-slate-400" />}>
                <li className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
                  <Field label={t("Τύπος φορέα", "Type")} value={d.care_type}
                         onEdit={() => editField("care_type", t("Τύπος φορέα", "Type"), d.care_type)} />
                  <Field label={t("ΑΦΜ", "VAT no.")} value={d.billing?.afm}
                         onEdit={() => editBilling("afm", t("ΑΦΜ", "VAT no."))} />
                  <Field label={t("Διεύθυνση", "Address")} value={d.billing?.address}
                         onEdit={() => editBilling("address", t("Διεύθυνση", "Address"))} />
                  <Field label={t("Τηλέφωνο δομής", "Structure phone")} value={d.billing?.phone}
                         onEdit={() => editBilling("phone", t("Τηλέφωνο δομής", "Structure phone"))} />
                  <Field label={t("Email", "Email")} value={d.billing?.email}
                         onEdit={() => editBilling("email", "Email")} />
                  <Field label={t("Ώρες επικοινωνίας", "Contact hours")} value={d.billing?.hours}
                         onEdit={() => editBilling("hours", t("Ώρες επικοινωνίας", "Contact hours"))} />
                </li>
              </Panel>

              <Panel title={t("Με ποιον μιλάω", "Who I talk to")}
                     icon={<UserRound className="h-4 w-4 text-slate-400" />}>
                <li className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
                  <Field label={t("Υπεύθυνος", "Responsible person")} value={d.billing?.contact_name}
                         onEdit={() => editBilling("contact_name", t("Υπεύθυνος", "Responsible person"))} />
                  <Field label={t("Τηλέφωνο υπευθύνου", "Their phone")} value={d.billing?.contact_phone}
                         onEdit={() => editBilling("contact_phone", t("Τηλέφωνο υπευθύνου", "Their phone"))} />
                </li>
              </Panel>

              <Panel title={t("Χρέωση & εξουσιοδότηση", "Billing & authorisation")}
                     icon={<Settings2 className="h-4 w-4 text-slate-400" />}>
                <li className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
                  <Field label={t("Χρεώσεις από", "Charge from")} value={fmt(d.charges_from)}
                         onEdit={chargesFrom} />
                  <Field label={t("Εξουσιοδότηση", "Authorisation")} value={d.billing?.authorization}
                         onEdit={() => editBilling("authorization", t("Εξουσιοδότηση (αρ. πρωτ. / περιγραφή)", "Authorisation"))} />
                  <Field label={t("Σημειώσεις", "Notes")} value={d.billing?.notes}
                         onEdit={() => editBilling("notes", t("Σημειώσεις", "Notes"))} />
                </li>
                <li className="px-4 pb-4 text-xs text-slate-400">
                  {t("Η δομή επεξεργάζεται δεδομένα υγείας τρίτων. Κράτα εδώ την εξουσιοδότηση που σου έδωσε.",
                     "The structure handles third-party health data. Keep their authorisation on file here.")}
                </li>
              </Panel>
            </div>
          )}

          {tab === "account" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
                <button onClick={addReceipt}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
                  <Receipt className="h-4 w-4" /> {t("Είσπραξη", "Receipt")}
                </button>
                <button onClick={addCharge}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
                  <Plus className="h-4 w-4" /> {t("Χειροκίνητη χρέωση", "Manual charge")}
                </button>
              </div>

              {st.data && (
                <>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                    <Line label={t("Υπόλοιπο από προηγούμενο", "Brought forward")} value={eur(st.data.opening)} />
                    <Line label={t("Χρεώσεις μήνα (συμμετοχές)", "Charges (co-payments)")} value={eur(st.data.charges)} />
                    <Line label={t("Εισπράξεις", "Receipts")} value={`− ${eur(st.data.receipts)}`} tone="good" />
                    <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 dark:border-slate-700">
                      <span className="font-semibold text-slate-800 dark:text-slate-100">{t("ΥΠΟΛΟΙΠΟ", "BALANCE")}</span>
                      <span className={`text-lg font-semibold ${st.data.closing > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                        {eur(st.data.closing)}
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-400">
                      {t("Η δομή χρωστά μόνο τη συμμετοχή των ασφαλισμένων. Ό,τι καλύπτει το ταμείο δεν εμφανίζεται εδώ.",
                         "The structure owes only the insured co-payment. Fund-covered amounts are not shown here.")}
                    </p>
                  </div>

                  <Panel title={t("Χρεώσεις ανά τρόφιμο", "Charges per resident")}>
                    {st.data.by_member.filter((m) => m.amount > 0).length === 0 ? (
                      <Empty text={t("Καμία χρέωση αυτόν τον μήνα.", "No charges this month.")} />
                    ) : st.data.by_member.filter((m) => m.amount > 0).map((m, i) => (
                      <li key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                        <span className="text-slate-700 dark:text-slate-200">
                          {m.name}{m.deceased ? ` · ${t("θανών", "deceased")}` : ""}
                        </span>
                        <span className="font-medium">{eur(m.amount)}</span>
                      </li>
                    ))}
                  </Panel>

                  <Panel title={t("Κινήσεις μήνα", "Entries this month")}>
                    {!st.data.entries.length ? (
                      <Empty text={t("Καμία είσπραξη ή χειροκίνητη χρέωση.", "No receipts or manual charges.")} />
                    ) : st.data.entries.map((e) => (
                      <li key={e._id} className="flex items-center gap-3 px-4 py-2 text-sm">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          e.kind === "receipt" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                          {e.kind === "receipt" ? t("είσπραξη", "receipt") : t("χρέωση", "charge")}
                        </span>
                        <span className="text-slate-500">{fmt(e.at)}</span>
                        <span className="truncate text-slate-600 dark:text-slate-300">{e.note}</span>
                        <span className="ml-auto font-medium">{eur(e.amount_cents)}</span>
                        <button onClick={() => delEntry(e)} className="text-slate-300 hover:text-rose-500">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </Panel>
                </>
              )}
            </div>
          )}

          {tab === "cycle" && cy.data && (() => {
            // ΑΜΥΝΤΙΚΑ: αν λείψει κλειδί από το φορτίο (π.χ. δομή χωρίς μέλη), η οθόνη δείχνει
            // άδεια λίστα — δεν σκάει. Ένα `undefined.length` έριχνε ΟΛΗ τη σελίδα.
            const C = { opening: cy.data.opening ?? [], order: cy.data.order ?? [],
                        pending: cy.data.pending ?? [], loans: cy.data.loans ?? [],
                        horizon_days: cy.data.horizon_days ?? 45 };
            const SHEETS = [
              ["opening", t(`Ανοίγουν τις επόμενες ${C.horizon_days} ημέρες`,
                            `Opening in the next ${C.horizon_days} days`), C.opening.length],
              ["order", t("Να έχεις έτοιμα", "Have ready"), C.order.length],
              ["pending", t("Εκκρεμούν — μπορούν ακόμη να δοθούν", "Pending — can still be dispensed"),
               C.pending.length],
              ["owed", t("Λίστα προς τη δομή", "List for the structure"),
               owed.data?.people.length ?? 0],
              ["instr", t("Οδηγίες λήψης", "Medication instructions"),
               instr.data?.people.length ?? 0],
            ] as const;
            return (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <select value={[30, 60, 90].includes(days) ? String(days) : "custom"}
                  onChange={async (e) => {
                    if (e.target.value !== "custom") { setDays(Number(e.target.value)); return; }
                    const v = await appPrompt(t("Σε πόσες ημέρες μπροστά;", "How many days ahead?"),
                                              { defaultValue: String(days) });
                    const n = Number(v);
                    if (n >= 1 && n <= 365) setDays(n);
                  }}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
                  <option value="30">{t("Επόμενος μήνας", "Next month")}</option>
                  <option value="60">{t("2 μήνες", "2 months")}</option>
                  <option value="90">{t("3 μήνες", "3 months")}</option>
                  <option value="custom">{t(`Δικό μου διάστημα (${days} ημ.)`, `Custom (${days}d)`)}</option>
                </select>
                {SHEETS.map(([k, lbl, n]) => (
                  <button key={k} onClick={() => setCyTab(k as typeof cyTab)}
                    className={`rounded-xl border px-3 py-2 text-sm ${
                      cyTab === k ? "border-rose-400 bg-rose-50 font-semibold text-rose-700 dark:bg-rose-950/30"
                                  : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"}`}>
                    {lbl} <span className="ml-1 text-xs opacity-60">{n}</span>
                  </button>
                ))}
              </div>

              {/* ── ΦΥΛΛΟ 1: ΤΙ ΑΝΟΙΓΕΙ ── ένα σκεύασμα ανά ετικέτα, όχι όλα σε μία γραμμή */}
              {cyTab === "opening" && (
                <Sheet empty={!C.opening.length}
                       emptyText={t("Τίποτα δεν ανοίγει σε αυτό το διάστημα.", "Nothing opens in this window.")}>
                  {C.opening.map((o, i) => (
                    <li key={i} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">{o.name}</span>
                        <span className="text-[11px] text-slate-400">{o.barcode}</span>
                        <span className="ml-auto whitespace-nowrap rounded-lg bg-rose-50 px-2 py-0.5 text-sm font-semibold text-rose-700 dark:bg-rose-950/30">
                          {fmt(o.opens_at)}
                        </span>
                      </div>
                      {o.items.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {o.items.map((n, j) => (
                            <li key={j} className="text-[13px] text-slate-600 dark:text-slate-300">· {n}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </Sheet>
              )}

              {/* ── ΦΥΛΛΟ 2: ΤΙ ΝΑ ΕΧΩ ΕΤΟΙΜΟ ── η λίστα παραγγελίας */}
              {cyTab === "order" && (
                <Sheet empty={!C.order.length}
                       emptyText={t("Τίποτα προς ετοιμασία.", "Nothing to prepare.")}>
                  {C.order.map((o, i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="w-10 shrink-0 text-right text-base font-bold text-slate-800 dark:text-slate-100">
                        ×{o.qty}
                      </span>
                      <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">{o.name}</span>
                      <span className="shrink-0 whitespace-nowrap text-xs text-slate-400">
                        {o.people} {o.people === 1 ? t("άτομο", "person") : t("άτομα", "people")}
                      </span>
                    </li>
                  ))}
                </Sheet>
              )}

              {/* ── ΦΥΛΛΟ 3: ΤΙ ΕΚΚΡΕΜΕΙ ── ποιος · ποια συνταγή · τι σκευάσματα · πόσα */}
              {cyTab === "pending" && (
                <Sheet empty={!C.pending.length}
                       emptyText={t("Καμία εκκρεμότητα.", "Nothing pending.")}>
                  {C.pending.map((p, i) => (
                    <li key={i} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">{p.name}</span>
                        <a href={`/prescriptions/${encodeURIComponent(p.barcode)}`}
                           className="text-[11px] text-rose-600 hover:underline">{p.barcode}</a>
                        <span className="ml-auto text-xs text-slate-500">
                          {t("έως", "until")} {fmt(p.valid_until)}
                        </span>
                        <span className="w-20 shrink-0 text-right font-semibold text-amber-600">{eur(p.value)}</span>
                      </div>
                      <ul className="mt-1.5 space-y-0.5">
                        {(p.items ?? []).map((x, j) => (
                          <li key={j} className="flex gap-2 text-[13px] text-slate-600 dark:text-slate-300">
                            <span className="w-8 shrink-0 text-right font-semibold text-amber-600">×{x.left}</span>
                            <span>{x.name ?? "—"}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </Sheet>
              )}

              {/* ── ΦΥΛΛΟ 4: ΤΙ ΜΑΣ ΟΦΕΙΛΕΙ Η ΔΟΜΗ ── ανά τρόφιμο, με το barcode.
                  Αυτό φεύγει προς τα έξω: εκτυπώνεται ή στέλνεται με email. */}
              {cyTab === "owed" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
                    <span className="text-slate-600 dark:text-slate-300">
                      {t("Στείλε στη δομή ποια barcode πρέπει να φτάσουν σε εμάς.",
                         "Send the structure which barcodes must reach you.")}
                    </span>
                    <button onClick={() => printHtml(owed.data?.html)} disabled={!owed.data?.people.length}
                      className="ml-auto rounded-xl border border-slate-200 px-3 py-1.5 font-medium text-slate-700 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
                      {t("Εκτύπωση", "Print")}
                    </button>
                    <button onClick={sendOwed} disabled={!owed.data?.people.length}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 font-semibold text-white disabled:opacity-40 hover:bg-rose-700">
                      <Send className="h-4 w-4" /> {t("Αποστολή email", "Send email")}
                    </button>
                  </div>
                  <Sheet empty={!owed.data?.people.length}
                         emptyText={t("Καμία αγωγή δεν ανανεώνεται στο διάστημα.", "Nothing renewing in this window.")}>
                    {(owed.data?.people ?? []).map((b) => (
                      <li key={b.patient_id} className="px-4 py-3">
                        <div className="font-semibold text-slate-800 dark:text-slate-100">{b.name}</div>
                        <ul className="mt-1.5 space-y-1.5">
                          {b.rx.map((r, j) => (
                            <li key={j} className="text-[13px]">
                              <div className="flex flex-wrap items-baseline gap-2">
                                <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">{r.barcode}</span>
                                <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${
                                  r.intangible ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                                  {r.intangible ? t("άυλη — χωρίς χαρτί", "intangible — no paper")
                                                : t("έντυπη", "printed")}
                                </span>
                                <span className="ml-auto text-xs text-slate-500">
                                  {t("ανοίγει", "opens")} {fmt(r.opens_at)}
                                </span>
                              </div>
                              {r.items.length > 0 && (
                                <div className="mt-0.5 text-xs text-slate-500">{r.items.join(" · ")}</div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </Sheet>
                </div>
              )}

              {/* ── ΦΥΛΛΟ 5: ΟΔΗΓΙΕΣ ΛΗΨΗΣ ── τι παίρνει ο καθένας και ΠΩΣ.
                  Το προσωπικό της δομής δεν ήταν στο ταμείο όταν εξηγήθηκε η δοσολογία. */}
              {cyTab === "instr" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
                    <span className="text-slate-600 dark:text-slate-300">
                      {t("Η αγωγή κάθε τροφίμου, όπως την όρισε ο ιατρός.",
                         "Each resident's regimen, as prescribed.")}
                    </span>
                    <button onClick={() => printHtml(instr.data?.html)}
                      disabled={!instr.data?.people.length}
                      className="ml-auto rounded-xl border border-slate-200 px-3 py-1.5 font-medium text-slate-700 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
                      {t("Εκτύπωση", "Print")}
                    </button>
                    <button onClick={sendInstr} disabled={!instr.data?.people.length}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 font-semibold text-white disabled:opacity-40 hover:bg-rose-700">
                      <Send className="h-4 w-4" /> {t("Αποστολή email", "Send email")}
                    </button>
                  </div>
                  <Sheet empty={!instr.data?.people.length}
                         emptyText={t("Καμία αγωγή καταγεγραμμένη.", "No regimen on record.")}>
                    {(instr.data?.people ?? []).map((b) => (
                      <li key={b.patient_id} className="px-4 py-3">
                        <div className="font-semibold text-slate-800 dark:text-slate-100">{b.name}</div>
                        <ul className="mt-1.5 space-y-1">
                          {b.meds.map((m, j) => (
                            <li key={j} className="flex flex-wrap gap-x-3 text-[13px]">
                              <span className="min-w-[200px] flex-1 text-slate-700 dark:text-slate-200">{m.name}</span>
                              <span className="text-slate-500">{m.dosage || "—"}</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </Sheet>
                  <p className="px-1 text-xs text-slate-400">
                    {t("Σε κάθε αλλαγή αγωγής από τον ιατρό, το φύλλο πρέπει να αντικατασταθεί. Δεν υποκαθιστά ιατρική οδηγία.",
                       "Replace the sheet whenever the doctor changes the regimen. It does not replace medical advice.")}
                  </p>
                </div>
              )}

              {C.loans.length > 0 && (
                <Panel title={t("Ανοιχτά δανεικά", "Open loans")}
                       icon={<HandCoins className="h-4 w-4 text-slate-400" />}>
                  {C.loans.map((l, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                      <span className="font-medium text-slate-700 dark:text-slate-200">{l.name}</span>
                      <span className="truncate text-slate-500">{l.items.join(" · ")}</span>
                      <span className="ml-auto text-xs text-slate-400">{fmt(l.created_at)}</span>
                    </li>
                  ))}
                </Panel>
              )}
            </div>
            );
          })()}

          {tab === "people" && (
            <div className="space-y-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input value={term} onChange={(e) => setTerm(e.target.value)}
                    placeholder={t("Πρόσθεσε τρόφιμο — όνομα ή ΑΜΚΑ…", "Add resident — name or AMKA…")}
                    className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-800" />
                </div>
                {hits.length > 0 && (
                  <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                    {hits.map((h) => (
                      <li key={h.patient_id}>
                        <button onClick={() => addMember({ patient_id: h.patient_id })}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                          <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
                          <span className="truncate">{h.name || "—"}</span>
                          <span className="ml-auto shrink-0 text-xs text-slate-400">{h.amka || ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Panel title={t(`Τρόφιμοι (${d.members.length})`, `Residents (${d.members.length})`)}>
                {!d.members.length ? <Empty text={t("Κανένας τρόφιμος ακόμη.", "No residents yet.")} />
                 : d.members.map((m) => (
                  <li key={m.pseudo_id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{m.name}</span>
                    {m.amka && <span className="text-[11px] text-slate-400">{m.amka}</span>}
                    {m.deceased && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-600">{t("θανών", "deceased")}</span>}
                    {m.pending && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{t("σε αναμονή", "pending")}</span>}
                    <span className="ml-auto text-xs text-slate-400">
                      {m.executions} {t("εκτ.", "exec.")} · {eur(m.patient_share)}
                    </span>
                    <button onClick={() => removeMember(m)} title={t("Αφαίρεση τροφίμου", "Remove resident")}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </Panel>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Line({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <span className={tone === "good" ? "text-emerald-600" : "text-slate-800 dark:text-slate-100"}>{value}</span>
    </div>
  );
}

function Sheet({ empty, emptyText, children }: {
  empty: boolean; emptyText: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      {empty ? <div className="px-4 py-8 text-center text-sm text-slate-400">{emptyText}</div>
             : <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>}
    </div>
  );
}

function Field({ label, value, onEdit }: {
  label: string; value?: string | null; onEdit: () => void;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <button onClick={onEdit}
        className="mt-0.5 flex w-full items-center gap-2 text-left text-sm text-slate-700 hover:text-rose-600 dark:text-slate-200">
        <span className={value ? "" : "italic text-slate-400"}>{value || "— προσθήκη —"}</span>
        <Pencil className="h-3 w-3 shrink-0 opacity-40" />
      </button>
    </div>
  );
}

function Panel({ title, icon, children }: {
  title: string; icon?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-200">
        {icon}{title}
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <li className="px-4 py-6 text-center text-sm text-slate-400">{text}</li>;
}
