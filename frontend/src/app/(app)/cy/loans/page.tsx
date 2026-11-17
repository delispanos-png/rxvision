"use client";

/* RxVision Κύπρος: Προχορηγήσεις (δανεικά). Σκευάσματα που δίνεις ΠΡΙΝ εκτελεστεί η συνταγή ΓεΣΥ.
   Κανόνες ιδιοκτήτη: ο πελάτης από τη λίστα (ποτέ ελεύθερο κείμενο), μία φόρμα = πολλά σκευάσματα,
   η ξεχρέωση ΠΟΤΕ αυτόματα: προτείνουμε την εκτέλεση ΓεΣΥ που φαίνεται να την καλύπτει και λέμε γιατί. */

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ScanLine, Search, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appConfirm } from "@/store/dialogStore";
import { fmtDate, fmtDateTime } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Item = { gtin: string | null; name: string; qty: number; lot: string | null; expiry: string | null; status?: string };
type Loan = { id: string; patient_ref: string; patient_name: string | null; items: Item[]; note: string; status: string;
  created_at: string; age_days: number | null; open_items: number };
type Sugg = { loan_id: string; idx: number; patient_name: string | null; item: string; dispensing_id: string;
  dispensed_at: string; qty_disp: number; reason: "same_lot" | "same_product" };
type Pat = { patient_ref: string; full_name: string | null };

export default function CyLoansPage() {
  const t = useT();
  const qc = useQueryClient();
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const loans = useQuery({ queryKey: ["cy", "loans", state], queryFn: () => api<{ items: Loan[] }>(`/cy/loans?state=${state}`) });
  const sugg = useQuery({ queryKey: ["cy", "loans", "sugg"], queryFn: () => api<{ items: Sugg[] }>("/cy/loans/suggestions") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["cy", "loans"] });

  async function clearItem(loan: string, idx: number, dispensing_id: string | null) {
    await api(`/cy/loans/${loan}/items/${idx}`, { method: "POST", body: JSON.stringify({ cleared: true, dispensing_id }) });
    refresh();
  }
  async function cancel(l: Loan) {
    if (!(await appConfirm(t("Ακύρωση αυτής της προχορήγησης; Χρησιμοποίησέ το μόνο αν καταχωρήθηκε κατά λάθος.", "Cancel this advance? Use only if it was entered by mistake."),
      { title: t("Ακύρωση", "Cancel"), confirmText: t("Ακύρωση προχορήγησης", "Cancel advance"), cancelText: t("Πίσω", "Back"), danger: true }))) return;
    await api(`/cy/loans/${l.id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <ModuleGuard module="advance_dispensing">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Προχορηγήσεις", "Advance dispensings")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Σκευάσματα που έδωσες πριν εκτελεστεί η συνταγή ΓεΣΥ. Όταν εκτελεστεί, σου προτείνουμε να τα ξεχρεώσεις.", "Products you gave before the GHS prescription was dispensed. Once it is, we suggest clearing them.")}</p>
        </div>

        {(sugg.data?.items.length ?? 0) > 0 && (
          <PanelCard title={t("Φαίνεται να καλύφθηκαν: επιβεβαίωσε", "Looks covered: confirm")}>
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {sugg.data!.items.map((s) => (
                <li key={`${s.loan_id}-${s.idx}-${s.dispensing_id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="font-medium">{s.patient_name || "—"} · {s.item}</div>
                    <div className="text-xs text-slate-500">
                      <Link href={`/cy/dispensings/${encodeURIComponent(s.dispensing_id)}`} className="text-brand-600 hover:underline">{t("εκτέλεση", "dispensing")} {fmtDateTime(s.dispensed_at)}</Link>
                      {" · "}{s.reason === "same_lot" ? t("ίδια παρτίδα με το δανεικό", "same batch as the advance") : t("ίδιο σκεύασμα, ίδιος πελάτης", "same product, same customer")}
                    </div>
                  </div>
                  <button onClick={() => clearItem(s.loan_id, s.idx, s.dispensing_id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700">{t("Ναι, ξεχρέωσε", "Yes, clear it")}</button>
                </li>
              ))}
            </ul>
          </PanelCard>
        )}

        <NewLoan onDone={refresh} />

        <PanelCard title={t("Προχορηγήσεις", "Advances")}>
          <div className="mb-3 flex gap-2">
            {(["open", "closed", "all"] as const).map((s) => (
              <button key={s} onClick={() => setState(s)}
                className={`rounded-full border px-3 py-1 text-sm ${state === s ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>
                {s === "open" ? t("Ανοιχτές", "Open") : s === "closed" ? t("Ξεχρεωμένες", "Cleared") : t("Όλες", "All")}
              </button>
            ))}
          </div>
          {loans.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {(loans.data?.items ?? []).map((l) => (
              <li key={l.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/cy/patients/${encodeURIComponent(l.patient_ref)}`} className="font-medium text-brand-600 hover:underline">{l.patient_name || "—"}</Link>
                  <span className={`text-xs ${(l.age_days ?? 0) > 30 && l.status === "open" ? "font-semibold text-rose-600" : "text-slate-500"}`}>
                    {fmtDate(l.created_at)} · {l.age_days ?? 0} {t("ημ.", "d")}{l.status === "cancelled" ? ` · ${t("ακυρώθηκε", "cancelled")}` : ""}
                  </span>
                </div>
                <ul className="mt-1 space-y-1">
                  {l.items.map((it, i) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className={it.status === "cleared" ? "text-slate-400 line-through" : ""}>{it.qty}× {it.name}{it.lot ? ` · ${t("παρτίδα", "lot")} ${it.lot}` : ""}</span>
                      {it.status === "open" && l.status === "open" && (
                        <button onClick={async () => {
                          if (await appConfirm(t("Ξεχρέωση χωρίς εκτέλεση ΓεΣΥ (π.χ. το επέστρεψε ή το πλήρωσε);", "Clear without a GHS dispensing (e.g. returned or paid)?"),
                            { title: t("Ξεχρέωση", "Clear"), confirmText: t("Ξεχρέωση", "Clear"), cancelText: t("Πίσω", "Back") })) clearItem(l.id, i, null);
                        }} className="text-slate-500 hover:text-emerald-700">{t("ξεχρέωση", "clear")}</button>
                      )}
                    </li>
                  ))}
                </ul>
                {l.note && <p className="mt-1 text-xs italic text-slate-500">{l.note}</p>}
                {l.status === "open" && (
                  <button onClick={() => cancel(l)} className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-600"><Trash2 className="h-3 w-3" /> {t("ακύρωση (λάθος καταχώρηση)", "cancel (wrong entry)")}</button>
                )}
              </li>
            ))}
            {loans.data && loans.data.items.length === 0 && <li className="py-6 text-center text-sm text-slate-400">{t("Καμία.", "None.")}</li>}
          </ul>
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}

const ERR: Record<string, [string, string]> = {
  patient_not_found: ["Διάλεξε πελάτη από τη λίστα.", "Pick a customer from the list."],
  no_items: ["Πρόσθεσε τουλάχιστον ένα σκεύασμα.", "Add at least one product."],
  item_needs_code_or_name: ["Κάθε σκεύασμα θέλει σάρωση ή όνομα.", "Each product needs a scan or a name."],
};

function NewLoan({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [pat, setPat] = useState<Pat | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [scanRaw, setScanRaw] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const found = useQuery({ queryKey: ["cy", "loans", "pat", term], enabled: term.length >= 2 && !pat,
    queryFn: () => api<{ items: Pat[] }>(`/cy/patients?q=${encodeURIComponent(term)}&limit=10`) });

  async function scan() {
    const raw = scanRaw.trim();
    if (!raw) return;
    setScanRaw("");
    const r = await api<{ ok: boolean; kind?: string; item?: Item }>("/cy/loans/scan", { method: "POST", body: JSON.stringify({ raw }) });
    if (!r.ok || !r.item) { setMsg({ ok: false, text: r.kind === "corrupt" ? t("Το σκανάρισμα κόπηκε. Σκάναρε ξανά.", "The scan was cut. Scan again.") : t("Δεν αναγνωρίστηκε. Σκάναρε τον κωδικό του κουτιού.", "Not recognised. Scan the box code.") }); return; }
    setMsg(null);
    const it = r.item;
    setItems((cur) => {
      const same = cur.findIndex((x) => x.gtin === it.gtin && (x.lot || "") === (it.lot || ""));
      if (same >= 0) return cur.map((x, i) => (i === same ? { ...x, qty: Math.min(20, x.qty + 1) } : x));
      return [...cur, { ...it, qty: 1, name: it.name || "" }];
    });
  }
  async function save() {
    if (!pat) return;
    setBusy(true); setMsg(null);
    try {
      await api("/cy/loans", { method: "POST", body: JSON.stringify({ patient_ref: pat.patient_ref, items, note }) });
      setMsg({ ok: true, text: t("Καταχωρήθηκε.", "Saved.") });
      setPat(null); setItems([]); setNote(""); setQ(""); setTerm("");
      onDone();
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: string })?.detail : "";
      const m = ERR[d || ""];
      setMsg({ ok: false, text: m ? t(m[0], m[1]) : t("Δεν αποθηκεύτηκε.", "Not saved.") });
    } finally { setBusy(false); }
  }
  const inp = "rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900";
  return (
    <PanelCard title={t("Νέα προχορήγηση", "New advance")}>
      <div className="space-y-3">
        {!pat ? (
          <div>
            <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="flex gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Πελάτης: όνομα ή κωδικός ΟΑΥ", "Customer: name or HIO code")} className={`${inp} w-72 pl-8`} />
              </div>
              <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">{t("Βρες", "Find")}</button>
            </form>
            <ul className="mt-2 space-y-1">
              {(found.data?.items ?? []).map((p) => (
                <li key={p.patient_ref}><button onClick={() => setPat(p)} className="text-sm text-brand-600 hover:underline">{p.full_name || "—"}</button></li>
              ))}
              {found.data && found.data.items.length === 0 && <li className="text-xs text-slate-400">{t("Κανένας πελάτης ΓεΣΥ με αυτό το όνομα.", "No GHS customer with that name.")}</li>}
            </ul>
          </div>
        ) : (
          <p className="text-sm">👤 <b>{pat.full_name}</b> <button onClick={() => setPat(null)} className="ml-2 text-xs text-slate-500">{t("αλλαγή", "change")}</button></p>
        )}
        <form onSubmit={(e) => { e.preventDefault(); scan(); }} className="flex gap-2">
          <div className="relative">
            <ScanLine className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input value={scanRaw} onChange={(e) => setScanRaw(e.target.value)} placeholder={t("Σάρωση κουτιού (DataMatrix ή barcode)", "Scan box (DataMatrix or barcode)")} className={`${inp} w-80 pl-8`} />
          </div>
          <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">{t("Προσθήκη", "Add")}</button>
        </form>
        {items.length > 0 && (
          <ul className="space-y-1">
            {items.map((it, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <input type="number" min={1} max={20} value={it.qty} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Math.min(20, parseInt(e.target.value || "1", 10))) } : x)))} className="w-14 rounded border border-slate-300 px-2 py-1 text-right dark:border-slate-700 dark:bg-slate-900" />
                <input value={it.name} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={t("όνομα σκευάσματος", "product name")} className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
                <span className="text-xs text-slate-400">{it.gtin}{it.lot ? ` · ${it.lot}` : ""}</span>
                <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="text-slate-400 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={t("Σημείωση (προαιρετική)", "Note (optional)")} className={`${inp} w-full`} />
        <button disabled={busy || !pat || items.length === 0} onClick={save} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{t("Καταχώρηση", "Save")}</button>
        {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
      </div>
    </PanelCard>
  );
}
