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
         AlertTriangle, HandCoins, Settings2, Receipt } from "lucide-react";
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
type Detail = { id: string; name: string; members: Member[]; balance: number };
type Entry = { _id: string; kind: string; amount_cents: number; at: string; note?: string };
type Statement = { month: string; opening: number; charges: number; receipts: number;
                   closing: number; by_member: { name: string; amount: number; deceased: boolean }[];
                   entries: Entry[] };
type Cycle = {
  horizon_days: number;
  opening: { name: string; barcode: string; opens_at: string; items: string[] }[];
  order: { name: string; qty: number; people: number }[];
  pending: { name: string; barcode: string; valid_until: string | null; value: number }[];
  loans: { name: string; created_at: string; items: string[] }[];
};
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
  const [tab, setTab] = useState<"account" | "cycle" | "people">("account");
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
  const cy = useQuery({ queryKey: ["care-cycle", sel],
    queryFn: () => api<Cycle>(`/care-structures/${sel}/cycle?days=45`),
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
              {([["account", t("Λογαριασμός", "Account")],
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

          {tab === "cycle" && cy.data && (
            <div className="space-y-3">
              <Panel title={t(`Ανοίγουν τις επόμενες ${cy.data.horizon_days} ημέρες`,
                              `Opening in the next ${cy.data.horizon_days} days`)}
                     icon={<CalendarClock className="h-4 w-4 text-slate-400" />}>
                {!cy.data.opening.length ? <Empty text={t("Τίποτα δεν ανοίγει σε αυτό το διάστημα.", "Nothing opens in this window.")} />
                 : cy.data.opening.map((o, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{o.name}</span>
                    <span className="text-xs text-slate-400">{o.barcode}</span>
                    <span className="truncate text-slate-500">{o.items.join(" · ")}</span>
                    <span className="ml-auto whitespace-nowrap font-medium text-rose-600">{fmt(o.opens_at)}</span>
                  </li>
                ))}
              </Panel>

              <Panel title={t("Να έχεις έτοιμα", "Have ready")}
                     icon={<PackageSearch className="h-4 w-4 text-slate-400" />}>
                {!cy.data.order.length ? <Empty text={t("Τίποτα προς ετοιμασία.", "Nothing to prepare.")} />
                 : cy.data.order.map((o, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="truncate text-slate-700 dark:text-slate-200">{o.name}</span>
                    <span className="ml-auto whitespace-nowrap text-xs text-slate-400">
                      {o.people} {t("άτομα", "people")}
                    </span>
                    <span className="w-12 text-right font-semibold">×{o.qty}</span>
                  </li>
                ))}
              </Panel>

              <Panel title={t("Εκκρεμούν — μπορούν ακόμη να δοθούν", "Pending — can still be dispensed")}
                     icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}>
                {!cy.data.pending.length ? <Empty text={t("Καμία εκκρεμότητα.", "Nothing pending.")} />
                 : cy.data.pending.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{p.name}</span>
                    <span className="text-xs text-slate-400">{p.barcode}</span>
                    <span className="ml-auto text-xs text-slate-500">
                      {t("έως", "until")} {fmt(p.valid_until)}
                    </span>
                    <span className="w-20 text-right font-medium text-amber-600">{eur(p.value)}</span>
                  </li>
                ))}
              </Panel>

              {cy.data.loans.length > 0 && (
                <Panel title={t("Ανοιχτά δανεικά", "Open loans")}
                       icon={<HandCoins className="h-4 w-4 text-slate-400" />}>
                  {cy.data.loans.map((l, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                      <span className="font-medium text-slate-700 dark:text-slate-200">{l.name}</span>
                      <span className="truncate text-slate-500">{l.items.join(" · ")}</span>
                      <span className="ml-auto text-xs text-slate-400">{fmt(l.created_at)}</span>
                    </li>
                  ))}
                </Panel>
              )}
            </div>
          )}

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
                    {m.deceased && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-600">{t("θανών", "deceased")}</span>}
                    {m.pending && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{t("σε αναμονή", "pending")}</span>}
                    <span className="ml-auto text-xs text-slate-400">
                      {m.executions} {t("εκτ.", "exec.")} · {eur(m.patient_share)}
                    </span>
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
