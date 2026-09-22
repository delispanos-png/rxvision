"use client";

/* Προχορηγήσεις σκευασμάτων («δανεικά»).

   ΔΕΝ είναι λογιστική αποθήκης. Ο φαρμακοποιός θέλει να θυμάται ποιος του χρωστά κουτί και να
   το σβήνει όταν έρθει η συνταγή — τίποτα παραπάνω.

   Η ΤΑΥΤΙΣΗ ΕΙΝΑΙ ΠΡΟΤΑΣΗ, ΟΧΙ ΠΡΑΞΗ: η ταινία γνησιότητας δεν είναι μοναδική (μετρημένο: 15%
   επαναλαμβάνονται), οπότε το τελικό «ναι» το δίνει πάντα ο άνθρωπος. */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HandCoins, ScanLine, Check, X, Clock, AlertTriangle, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Item = { name?: string; gtin?: string; batch?: string; strip?: string; lot?: string;
              expiry?: string; qty?: number; has_qr?: boolean; hmvo_uploaded?: boolean };
type Loan = { _id: string; patient_name: string; items: Item[]; status: string;
              created_at: string; note?: string };
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
  const [name, setName] = useState("");
  const [scan, setScan] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);

  const open = useQuery({ queryKey: ["adv", "open"], queryFn: () => api<{ items: Loan[] }>("/advance-dispensings?status=open") });
  const late = useQuery({ queryKey: ["adv", "overdue"], queryFn: () => api<{ qr_over_10d: Loan[]; over_30d: Loan[]; counts: Record<string, number> }>("/advance-dispensings/overdue") });
  const sugg = useQuery({ queryKey: ["adv", "matches"], queryFn: () => api<{ items: Match[] }>("/advance-dispensings/matches") });

  function addScan() {
    const v = scan.trim();
    if (!v) return;
    const parsed = parseGs1(v);
    setItems((x) => [...x, parsed ?? { lot: v.toUpperCase(), name: "" }]);
    setScan("");
  }

  async function save() {
    if (!name.trim()) { appAlert(t("Γράψε όνομα πελάτη.", "Enter a customer name.")); return; }
    if (!items.length) { appAlert(t("Σάρωσε ή γράψε τουλάχιστον ένα σκεύασμα.", "Add at least one product.")); return; }
    setBusy(true);
    try {
      await api("/advance-dispensings", { method: "POST", body: JSON.stringify({ patient_name: name.trim(), items }) });
      setName(""); setItems([]);
      qc.invalidateQueries({ queryKey: ["adv"] });
    } catch { appAlert(t("Δεν αποθηκεύτηκε.", "Not saved.")); }
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

      {/* ΚΑΤΑΓΡΑΦΗ */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t("Νέο δανεικό", "New loan")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-slate-500">
            {t("Πελάτης", "Customer")}
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder={t("ονοματεπώνυμο", "full name")}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </label>
          <label className="block text-xs font-medium text-slate-500">
            {t("Σάρωση κουτιού ή παρτίδα", "Scan box or batch")}
            <div className="mt-1 flex gap-2">
              <input value={scan} onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScan(); } }}
                placeholder={t("σάρωσε το 2D — ή γράψε LOT", "scan the 2D — or type LOT")}
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
              <button onClick={addScan} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50">
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </label>
        </div>
        {!!items.length && (
          <ul className="mt-3 space-y-1.5">
            {items.map((i, n) => (
              <li key={n} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs dark:bg-slate-800">
                <ScanLine className="h-3.5 w-3.5 text-slate-400" />
                <input value={i.name || ""} onChange={(e) => setItems((x) => x.map((y, k) => k === n ? { ...y, name: e.target.value } : y))}
                  placeholder={t("όνομα σκευάσματος (προαιρετικό)", "product name (optional)")}
                  className="w-56 rounded border border-slate-200 px-2 py-1 dark:border-slate-600 dark:bg-slate-900" />
                <span className="text-slate-500">
                  {i.gtin ? `GTIN ${i.gtin}` : ""} {i.batch ? `· ${t("παρτ.", "batch")} ${i.batch}` : ""}
                  {i.strip ? ` · ${t("ταινία", "strip")} ${i.strip}` : ""} {i.lot && !i.gtin ? `LOT ${i.lot}` : ""}
                </span>
                <button onClick={() => setItems((x) => x.filter((_, k) => k !== n))} className="ml-auto text-slate-400 hover:text-rose-600">
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={save} disabled={busy}
          className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {t("Καταχώρηση δανεικού", "Record loan")}
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
