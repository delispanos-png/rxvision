"use client";

import { appConfirm } from "@/store/dialogStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { DateInput } from "@/components/ui/DateInput";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtEur, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";
import { Receipt, Send, CheckCircle2, Clock, AlertTriangle, Ban, Plus, Trash2 } from "lucide-react";

type Invoice = {
  id: string; tenant_id: string; tenant_name: string | null; doc_type: string; series: string;
  number: number; full_number: string; issue_date: string; description: string;
  net_amount: number; vat_rate: number; vat_amount: number; total: number;
  aade_status: "transmitted" | "not_transmitted"; aade_mark: string | null; aade_transmitted_at: string | null;
  // Φάση 3 — αυτόματο κύκλωμα SoftOne → myDATA
  status?: "pending" | "blocked" | "issued" | "failed"; blocked_reason?: string | null;
  softone_findoc?: string | null; mydata_aa?: string | null;
  attempts?: number; last_error?: string | null; auto?: boolean; kind?: string | null;
  customer?: InvCustomer | null; lines?: InvLine[] | null; mtrl?: string | null;
  subtotal_net?: number | null; discount?: InvDiscount | null;
};
type InvLine = { description: string; item_key?: string | null; mtrl?: string | null; qty: number; unit_net: number; vat_rate: number; disc_kind?: string; disc_value?: number; gross?: number; discount?: number; net: number; vat: number; total: number };
type SoftoneItem = { key: string; group: string; name: string; mtrl: string; price?: number; price_yearly?: number };
type InvDiscount = { kind: "pct" | "amount"; value: number; amount: number };
type InvCustomer = { afm?: string; name?: string; doy?: string; address?: string; city?: string; zip?: string; country?: string; email?: string; phone?: string };
type Tenant = { id: string; name: string };

/** Είναι ενημερωμένο το SoftOne; (findoc ή διαβίβαση ΑΑΔΕ ολοκληρωμένη) */
const isSynced = (i: Invoice) => i.aade_status === "transmitted" || !!i.softone_findoc;

/** Ένδειξη ενημέρωσης SoftOne — το κύριο χαρακτηριστικό «τι έχει περάσει στο SoftOne». */
function SoftoneBadge({ inv }: { inv: Invoice }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";
  if (isSynced(inv))
    return (
      <span className={`${base} bg-emerald-100 text-emerald-700`} title={inv.softone_findoc ? `findoc ${inv.softone_findoc}` : ""}>
        <CheckCircle2 className="h-3.5 w-3.5" /> Ενημερωμένο{inv.softone_findoc ? ` · ${inv.softone_findoc}` : ""}
      </span>
    );
  if (inv.status === "failed")
    return (
      <Tooltip label={inv.last_error || "Αποτυχία διαβίβασης"}>
        <span className={`${base} bg-rose-100 text-rose-700`}><AlertTriangle className="h-3.5 w-3.5" /> Απέτυχε{inv.attempts ? ` (×${inv.attempts})` : ""}</span>
      </Tooltip>
    );
  if (inv.status === "blocked")
    return (
      <Tooltip label={inv.blocked_reason || "Λείπουν προαπαιτούμενα (π.χ. ΑΦΜ/MTRL)"}>
        <span className={`${base} bg-slate-200 text-slate-600`}><Ban className="h-3.5 w-3.5" /> Μπλοκαρισμένο</span>
      </Tooltip>
    );
  return <span className={`${base} bg-amber-100 text-amber-700`}><Clock className="h-3.5 w-3.5" /> Εκκρεμεί</span>;
}

export default function InvoicesPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ mode: "create" | "edit" | "view"; inv?: Invoice } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "synced" | "unsynced">("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const invoices = useQuery({ queryKey: ["admin", "invoices"], queryFn: () => adminApi<{ items: Invoice[] }>("/admin/invoices"), retry: false });
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), retry: false });
  const all = invoices.data?.items ?? [];
  const rows = filter === "all" ? all : all.filter((i) => (filter === "synced" ? isSynced(i) : !isSynced(i)));
  const unsyncedCount = all.filter((i) => !isSynced(i)).length;
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "invoices"] });

  function errMsg(e: unknown): string {
    if (e instanceof ApiError) {
      const d = (e.problem as { detail?: { message?: string; error?: string } })?.detail;
      return d?.message || d?.error || "Σφάλμα.";
    }
    return "Σφάλμα.";
  }
  async function act(fn: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try { await fn(); setNotice(ok); refresh(); }
    catch (e) { setNotice(`Σφάλμα: ${errMsg(e)}`); }
  }

  // Αποστολή / επαναποστολή στο SoftOne (→ myDATA/ΑΑΔΕ). Idempotent: αν έχει ήδη διαβιβαστεί, δεν ξαναστέλνει.
  const send = async (i: Invoice) => {
    const again = i.status === "failed" || (i.attempts ?? 0) > 0;
    const ok = await appConfirm(
      `${again ? "Επαναποστολή" : "Αποστολή"} του ${i.doc_type} ${i.full_number} στο SoftOne → myDATA/ΑΑΔΕ;\nΜετά την επιτυχή διαβίβαση κλειδώνει (δεν τροποποιείται/διαγράφεται).`,
      { title: again ? "Επαναποστολή στο SoftOne" : "Αποστολή στο SoftOne", confirmText: again ? "Επαναποστολή" : "Αποστολή" });
    if (!ok) return;
    setBusyId(i.id);
    try { await act(() => adminApi(`/admin/invoices/${i.id}/transmit`, { method: "POST" }), "Ενημερώθηκε το SoftOne ✓"); }
    finally { setBusyId(null); }
  };
  const del = async (i: Invoice) => { if (await appConfirm(`Διαγραφή του παραστατικού ${i.full_number};`, { title: "Διαγραφή παραστατικού", danger: true, confirmText: "Διαγραφή" })) act(() => adminApi(`/admin/invoices/${i.id}`, { method: "DELETE" }), "Διαγράφηκε."); };

  const columns: Column<Invoice>[] = [
    { key: "full_number", header: "Αρ.", render: (r) => <span className="font-medium">{r.doc_type} {r.full_number}</span> },
    { key: "tenant_name", header: "Πελάτης", render: (r) => r.tenant_name ?? r.tenant_id },
    { key: "issue_date", header: "Ημ/νία", render: (r) => fmtDate(r.issue_date) },
    { key: "total", header: "Σύνολο", align: "right", render: (r) => fmtEur(r.total) },
    { key: "softone", header: "SoftOne", render: (r) => <SoftoneBadge inv={r} /> },
    { key: "aade_mark", header: "ΑΑΔΕ MARK", render: (r) => r.aade_mark ? <code className="text-xs text-slate-600">{r.aade_mark}</code> : <span className="text-slate-300">—</span> },
    {
      key: "actions", header: "", align: "right",
      render: (r) => {
        const locked = isSynced(r);
        const busy = busyId === r.id;
        return (
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setModal({ mode: "view", inv: r })} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Προβολή</button>
            <Tooltip label={locked ? "Ενημερωμένο SoftOne — κλειδωμένο" : ""}><button onClick={() => setModal({ mode: "edit", inv: r })} disabled={locked}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Edit</button></Tooltip>
            <button onClick={() => del(r)} disabled={locked}
              className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">Διαγραφή</button>
            {!locked && (
              <button onClick={() => send(r)} disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" /> {busy ? "Αποστολή…" : (r.status === "failed" || (r.attempts ?? 0) > 0) ? "Επαναποστολή" : "Αποστολή SoftOne"}
              </button>
            )}
          </div>
        );
      },
    },
  ];

  const fBtn = (v: typeof filter, label: string, n?: number) => (
    <button onClick={() => setFilter(v)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${filter === v ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
      {label}{n !== undefined && n > 0 ? ` (${n})` : ""}
    </button>
  );

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-2"><Receipt className="h-6 w-6 text-brand-600" /><h1 className="text-xl font-bold text-slate-900">Παραστατικά</h1></div>
      <p className="mb-5 text-sm text-slate-500">Όλα τα παραστατικά που δημιουργήθηκαν (αυτόματα από χρεώσεις ή χειροκίνητα). Η στήλη <b>SoftOne</b> δείχνει ποια έχουν ενημερώσει το SoftOne → myDATA· για όσα δεν έχουν, μπορείς να τα <b>ξαναστείλεις</b>.</p>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {fBtn("all", "Όλα", all.length)}
          {fBtn("unsynced", "Μη ενημερωμένα", unsyncedCount)}
          {fBtn("synced", "Ενημερωμένα")}
        </div>
        <button onClick={() => setModal({ mode: "create" })} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">+ Νέο παραστατικό</button>
      </div>
      {notice && <div className="mb-3 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}
      {invoices.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable pageSize={20} columns={columns} rows={rows} rowKey={(r) => r.id} empty="Δεν υπάρχουν παραστατικά." />}

      {modal && <InvoiceModal modal={modal} tenants={tenants.data?.items ?? []} onClose={() => setModal(null)} onDone={(m) => { setNotice(m); refresh(); setModal(null); }} />}
    </div>
  );
}

type DraftLine = { item_key: string; description: string; mtrl: string; qty: string; unit_eur: string; vat_rate: string; disc_kind: "pct" | "amount"; disc_value: string; period: "month" | "year" };
const emptyLine = (): DraftLine => ({ item_key: "", description: "", mtrl: "", qty: "1", unit_eur: "", vat_rate: "24", disc_kind: "pct", disc_value: "", period: "month" });
// καθαρή τιμή μονάδας (€) από την τιμή ΜΕ ΦΠΑ του είδους, για τη ζητούμενη περίοδο
const unitEurFor = (it: SoftoneItem | undefined, period: "month" | "year", rate: number) => {
  // ετήσια: ρητή τιμή έτους· αν λείπει → 12× μηνιαία (ώστε να συμπληρώνεται πάντα)
  const gross = it ? (period === "year" ? (it.price_yearly || (it.price || 0) * 12) : (it.price || 0)) : 0;
  return gross ? eurInput(Math.round(gross / (1 + rate / 100))) : "";
};
const eur = (c: number) => fmtEur(c);
const num = (s: string) => parseFloat(s || "0") || 0;
// cents → τιμή για <input type="number"> (dot-decimal, ΧΩΡΙΣ διαχωριστικά χιλιάδων — αλλιώς το input μένει κενό)
const eurInput = (cents?: number | null) => (Math.round(cents || 0) / 100).toFixed(2);
// έκπτωση σε cents (δεν ξεπερνά τη βάση). pct=ποσοστό· amount=€ (→cents)
const discCents = (base: number, kind: "pct" | "amount", value: number) => {
  if (value <= 0 || base <= 0) return 0;
  const d = kind === "pct" ? Math.round(base * value / 100) : Math.round(value * 100);
  return Math.max(0, Math.min(d, base));
};
// καθαρή γραμμής (μετά την έκπτωση γραμμής, ΠΡΙΝ την έκπτωση συνόλου)
const lineNet = (l: DraftLine) => {
  const gross = Math.round((num(l.qty) || 1) * Math.round(num(l.unit_eur) * 100));
  return { gross, net: gross - discCents(gross, l.disc_kind, num(l.disc_value)) };
};

function InvoiceModal({ modal, tenants, onClose, onDone }:
  { modal: { mode: "create" | "edit" | "view"; inv?: Invoice }; tenants: Tenant[]; onClose: () => void; onDone: (msg: string) => void }) {
  const { mode, inv } = modal;
  const view = mode === "view";
  const [form, setForm] = useState({
    tenant_id: inv?.tenant_id ?? tenants[0]?.id ?? "",
    doc_type: inv?.doc_type ?? "ΤΠΥ", series: inv?.series ?? "Α",
    issue_date: inv?.issue_date ?? new Date().toISOString().slice(0, 10),
  });
  // κεντρική λίστα τιμολογήσιμων ειδών → dropdown (όχι ελεύθερο κείμενο, ώστε το MTRL να έχει νόημα)
  const itemsQ = useQuery({ queryKey: ["admin", "softone-items"], queryFn: () => adminApi<{ items: SoftoneItem[]; default_mtrl: string }>("/admin/softone/items"), retry: false, staleTime: 60000 });
  const catalog = itemsQ.data?.items ?? [];
  const defaultMtrl = itemsQ.data?.default_mtrl ?? "";
  const groups = Array.from(new Set(catalog.map((i) => i.group)));

  // γραμμές: από inv.lines → αλλιώς (legacy μονή αξία) μία γραμμή → αλλιώς (create) μία κενή
  const [lines, setLines] = useState<DraftLine[]>(() => {
    if (inv?.lines?.length) return inv.lines.map((l) => ({ item_key: l.item_key || "", description: l.description || "", mtrl: l.mtrl || "", qty: String(l.qty ?? 1), unit_eur: eurInput(l.unit_net), vat_rate: String(l.vat_rate ?? 24), disc_kind: (l.disc_kind === "amount" ? "amount" : "pct") as "pct" | "amount", disc_value: l.disc_value ? (l.disc_kind === "amount" ? eurInput(l.disc_value) : String(l.disc_value)) : "", period: "month" as const }));
    if (inv) return [{ item_key: "", description: inv.description || "", mtrl: inv.mtrl || "", qty: "1", unit_eur: eurInput(inv.net_amount), vat_rate: String(inv.vat_rate ?? 24), disc_kind: "pct" as const, disc_value: "", period: "month" as const }];
    return [emptyLine()];
  });
  // παλιές γραμμές χωρίς item_key → match με βάση MTRL ή όνομα (μία φορά, όταν φορτώσει η λίστα)
  useEffect(() => {
    if (!catalog.length) return;
    setLines((ls) => ls.map((l) => {
      if (l.item_key || (!l.mtrl && !l.description)) return l;
      const m = catalog.find((c) => (l.mtrl && c.mtrl === l.mtrl) || c.name === l.description);
      return m ? { ...l, item_key: m.key, description: m.name, mtrl: m.mtrl } : l;
    }));
  }, [catalog.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const pickItem = (i: number, key: string) => {
    const it = catalog.find((c) => c.key === key);
    setLines((ls) => ls.map((l, j) => {
      if (j !== i) return l;
      // αυτόματη καθαρή τιμή μονάδας από την τιμή (ΜΕ ΦΠΑ) του είδους → Σύνολο = τιμή πακέτου
      const rate = num(l.vat_rate) || 24;
      const unit_eur = it?.price ? unitEurFor(it, "month", rate) : l.unit_eur;
      return { ...l, item_key: key, description: it?.name || "", mtrl: it?.mtrl || "", period: "month", unit_eur };
    }));
  };
  // αλλαγή περιόδου (μηνιαία/ετήσια) → ξαναγεμίζει την τιμή μονάδας
  const setPeriod = (i: number, period: "month" | "year") => {
    setLines((ls) => ls.map((l, j) => {
      if (j !== i) return l;
      const it = catalog.find((c) => c.key === l.item_key);
      const rate = num(l.vat_rate) || 24;
      return { ...l, period, unit_eur: it ? unitEurFor(it, period, rate) : l.unit_eur };
    }));
  };
  // έκπτωση συνόλου
  const [hdiscKind, setHdiscKind] = useState<"pct" | "amount">(inv?.discount?.kind === "amount" ? "amount" : "pct");
  const [hdiscValue, setHdiscValue] = useState<string>(inv?.discount?.value ? (inv.discount.kind === "amount" ? eurInput(inv.discount.value) : String(inv.discount.value)) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Header: εκδότης (από ρυθμίσεις SoftOne) + λήπτης (snapshot του παραστατικού ή στοιχεία πελάτη)
  const issuerQ = useQuery({ queryKey: ["admin", "integrations", "issuer"], queryFn: () => adminApi<{ softone?: { issuer_afm?: string; issuer_name?: string; issuer_doy?: string; issuer_activity?: string; issuer_address?: string; issuer_postal_code?: string; issuer_city?: string; issuer_region?: string; issuer_phone?: string; issuer_email?: string } }>("/admin/integrations"), retry: false, staleTime: 60000 });
  const issuer = issuerQ.data?.softone;
  const tenantDetailQ = useQuery({
    queryKey: ["admin", "tenant", form.tenant_id, "billing"],
    queryFn: () => adminApi<{ tenant?: { name?: string; billing_profile?: InvCustomer & { postal_code?: string }; company?: InvCustomer & { postal_code?: string } } }>(`/admin/tenants/${encodeURIComponent(form.tenant_id)}`),
    enabled: !inv?.customer && !!form.tenant_id, retry: false,
  });
  const fetched = tenantDetailQ.data?.tenant;
  const cust: InvCustomer = inv?.customer ?? (fetched ? {
    name: fetched.billing_profile?.name || fetched.company?.name || fetched.name,
    afm: fetched.billing_profile?.afm || fetched.company?.afm,
    doy: fetched.billing_profile?.doy || fetched.company?.doy,
    address: fetched.billing_profile?.address || fetched.company?.address,
    city: fetched.billing_profile?.city || fetched.company?.city,
    zip: fetched.billing_profile?.postal_code || fetched.company?.postal_code,
  } : { name: tenants.find((t) => t.id === form.tenant_id)?.name });

  // σύνολα (live): μερικό σύνολο γραμμών → έκπτωση συνόλου (κατανεμημένη για σωστό ΦΠΑ) → καθαρή/ΦΠΑ/σύνολο
  const totals = (() => {
    if (view && inv && !inv.lines) return { subtotal: inv.net_amount, hdisc: 0, net: inv.net_amount, vat: inv.vat_amount, total: inv.total };
    const nets = lines.map((l) => lineNet(l).net);
    const subtotal = nets.reduce((a, b) => a + b, 0);
    const hdisc = discCents(subtotal, hdiscKind, num(hdiscValue));
    let vat = 0, remaining = hdisc;
    nets.forEach((n, i) => {
      const share = (subtotal && hdisc) ? (i < nets.length - 1 ? Math.round(n * hdisc / subtotal) : remaining) : 0;
      remaining -= share;
      vat += Math.round((n - share) * (num(lines[i].vat_rate) / 100));
    });
    const net = subtotal - hdisc;
    return { subtotal, hdisc, net, vat, total: net + vat };
  })();

  const setLine = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const rmLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const chosen = lines.filter((l) => l.item_key);   // μόνο γραμμές με επιλεγμένο είδος
    if (!chosen.length) { setError("Επίλεξε είδος σε τουλάχιστον μία γραμμή."); return; }
    if (!chosen.some((l) => num(l.unit_eur) > 0)) { setError("Δώσε τιμή σε τουλάχιστον μία γραμμή."); return; }
    setBusy(true); setError(null);
    try {
      const payloadLines = chosen.map((l) => ({
        description: l.description.trim(), item_key: l.item_key || null, mtrl: l.mtrl.trim() || null,
        qty: num(l.qty) || 1, unit_net: Math.round(num(l.unit_eur) * 100),
        vat_rate: num(l.vat_rate),
        disc_kind: l.disc_kind, disc_value: l.disc_kind === "amount" ? Math.round(num(l.disc_value) * 100) : num(l.disc_value),
      }));
      const payload = {
        doc_type: form.doc_type, series: form.series, issue_date: form.issue_date, lines: payloadLines,
        discount_kind: hdiscKind, discount_value: hdiscKind === "amount" ? Math.round(num(hdiscValue) * 100) : num(hdiscValue),
      };
      if (mode === "create") await adminApi("/admin/invoices", { method: "POST", body: JSON.stringify({ tenant_id: form.tenant_id, ...payload }) });
      else await adminApi(`/admin/invoices/${inv!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      onDone(mode === "create" ? "Δημιουργήθηκε παραστατικό ✓" : "Αποθηκεύτηκε ✓");
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: { message?: string; error?: string } })?.detail : null;
      setError(d?.message || d?.error || "Σφάλμα.");
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50";
  const cell = "rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500";
  return (
    <Modal open onClose={onClose} size="4xl"
      title={mode === "create" ? "Νέο παραστατικό" : mode === "edit" ? `Επεξεργασία ${inv?.doc_type} ${inv?.full_number}` : `Παραστατικό ${inv?.doc_type} ${inv?.full_number}`}>
      <form onSubmit={submit} className="space-y-4">
        {view && inv && isSynced(inv) && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Ενημερωμένο SoftOne{inv.softone_findoc ? <> · findoc: <code>{inv.softone_findoc}</code></> : null}
            {inv.aade_mark ? <> · ΑΑΔΕ MARK: <code>{inv.aade_mark}</code></> : null}
          </div>
        )}
        {view && inv && !isSynced(inv) && inv.last_error && (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Τελευταίο σφάλμα SoftOne: {inv.last_error}</div>
        )}

        {/* ── HEADER: εκδότης / λήπτης ── */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Εκδότης</div>
            <div className="font-medium text-slate-800">{issuer?.issuer_name || "—"}</div>
            {issuer?.issuer_activity && <div className="text-slate-500">{issuer.issuer_activity}</div>}
            <div className="text-slate-500">ΑΦΜ: {issuer?.issuer_afm || "—"}{issuer?.issuer_doy ? ` · ΔΟΥ: ${issuer.issuer_doy}` : ""}</div>
            {(issuer?.issuer_address || issuer?.issuer_city) && <div className="text-slate-500">{[issuer?.issuer_address, issuer?.issuer_city, issuer?.issuer_postal_code].filter(Boolean).join(", ")}</div>}
            {(issuer?.issuer_phone || issuer?.issuer_email) && <div className="text-slate-500">{[issuer?.issuer_phone, issuer?.issuer_email].filter(Boolean).join(" · ")}</div>}
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Λήπτης (πελάτης)</div>
            {!view && mode === "create" ? (
              <select value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })} className={`${inp} mb-1`}>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : <div className="font-medium text-slate-800">{cust.name || inv?.tenant_name || "—"}</div>}
            <div className="text-slate-500">ΑΦΜ: {cust.afm || <span className="text-rose-600">— (χωρίς ΑΦΜ δεν διαβιβάζεται)</span>}{cust.doy ? ` · ΔΟΥ: ${cust.doy}` : ""}</div>
            {(cust.address || cust.city) && <div className="text-slate-500">{[cust.address, cust.city, cust.zip].filter(Boolean).join(", ")}</div>}
          </div>
        </div>

        {/* ── HEADER: στοιχεία παραστατικού ── */}
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Τύπος</span>
            <input disabled={view} value={form.doc_type} onChange={(e) => setForm({ ...form, doc_type: e.target.value })} className={inp} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Σειρά</span>
            <input disabled={view} value={form.series} onChange={(e) => setForm({ ...form, series: e.target.value })} className={inp} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Αριθμός</span>
            <input disabled value={inv?.number != null ? `${inv.series}-${inv.number}` : "αυτόματος"} className={`${inp} font-medium text-slate-700`} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Ημ/νία</span>
            <DateInput disabled={view} value={form.issue_date} onChange={(v) => setForm({ ...form, issue_date: v })} /></label>
        </div>

        {/* ── ΓΡΑΜΜΕΣ ΕΙΔΩΝ ── */}
        <div className="rounded-xl border border-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-2 py-2 font-medium">Είδος / Περιγραφή</th>
                  <th className="w-20 px-2 py-2 font-medium">MTRL</th>
                  <th className="w-20 px-2 py-2 text-right font-medium">Ποσ.</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Τιμή μον. €</th>
                  <th className="w-32 px-2 py-2 text-right font-medium">Έκπτωση</th>
                  <th className="w-16 px-2 py-2 text-right font-medium">ΦΠΑ %</th>
                  <th className="w-24 px-2 py-2 text-right font-medium">Καθαρή</th>
                  {!view && <th className="w-8 px-2 py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {lines.map((l, i) => {
                  const c = lineNet(l);
                  const selItem = catalog.find((x) => x.key === l.item_key);
                  const hasYearly = !!(selItem?.price_yearly);
                  return (
                    <tr key={i} className="align-top">
                      <td className="px-2 py-1.5">
                        {view ? <span className="block px-1 py-1.5 text-slate-700">{l.description || "—"}</span> : (
                          <>
                            <select value={l.item_key} onChange={(e) => pickItem(i, e.target.value)} className={`${cell} w-full`}>
                              <option value="">— επίλεξε είδος —</option>
                              {groups.map((g) => (
                                <optgroup key={g} label={g}>
                                  {catalog.filter((c) => c.group === g).map((c) => <option key={c.key} value={c.key}>{c.name}{c.mtrl ? "" : " (χωρίς MTRL)"}</option>)}
                                </optgroup>
                              ))}
                            </select>
                            {hasYearly && (
                              <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                                <span>Χρέωση:</span>
                                <select value={l.period} onChange={(e) => setPeriod(i, e.target.value as "month" | "year")} className={`${cell} px-1 py-1`}>
                                  <option value="month">Μηνιαία</option>
                                  <option value="year">Ετήσια</option>
                                </select>
                                <span className="text-slate-400">× ποσότητα {l.period === "month" ? "(μήνες)" : "(έτη)"}</span>
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-1.5"><span className="block px-1 py-1.5 text-right font-mono text-xs text-slate-500" title={l.mtrl ? "" : `Χωρίς ειδικό MTRL → default (${defaultMtrl || "—"})`}>{l.mtrl || (defaultMtrl ? "default" : "—")}</span></td>
                      <td className="px-2 py-1.5"><input disabled={view} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} type="number" step="any" className={`${cell} w-full text-right`} /></td>
                      <td className="px-2 py-1.5"><input disabled={view} value={l.unit_eur} onChange={(e) => setLine(i, { unit_eur: e.target.value })} type="number" step="0.01" placeholder="0.00" className={`${cell} w-full text-right`} /></td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1">
                          <input disabled={view} value={l.disc_value} onChange={(e) => setLine(i, { disc_value: e.target.value })} type="number" step="any" placeholder="0" className={`${cell} w-full text-right`} />
                          <select disabled={view} value={l.disc_kind} onChange={(e) => setLine(i, { disc_kind: e.target.value as "pct" | "amount" })} className={`${cell} px-1`}><option value="pct">%</option><option value="amount">€</option></select>
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <select disabled={view} value={l.vat_rate} onChange={(e) => setLine(i, { vat_rate: e.target.value })} className={`${cell} w-full text-right`}>
                          {Array.from(new Set(["24", "13", "6", "0", l.vat_rate])).map((r) => <option key={r} value={r}>{r}%</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium text-slate-700">{eur(c.net)}</td>
                      {!view && <td className="px-2 py-1.5 text-center"><button type="button" onClick={() => rmLine(i)} className="text-slate-400 hover:text-rose-600" aria-label="Διαγραφή γραμμής"><Trash2 className="h-4 w-4" /></button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!view && (
            <div className="border-t border-slate-100 p-2">
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" /> Προσθήκη γραμμής</button>
            </div>
          )}
        </div>

        {/* ── FOOTER: σύνολα (με έκπτωση συνόλου) ── */}
        <div className="flex justify-end">
          <div className="w-full max-w-sm space-y-1.5 text-sm">
            <div className="flex items-center justify-between text-slate-600"><span>Μερικό σύνολο</span><span>{eur(totals.subtotal)}</span></div>
            <div className="flex items-center justify-between gap-2 text-slate-600">
              <span className="shrink-0">Έκπτωση συνόλου</span>
              {view ? <span>−{eur(totals.hdisc)}</span> : (
                <div className="flex items-center gap-1">
                  <input value={hdiscValue} onChange={(e) => setHdiscValue(e.target.value)} type="number" step="any" placeholder="0" className={`${cell} w-20 text-right`} />
                  <select value={hdiscKind} onChange={(e) => setHdiscKind(e.target.value as "pct" | "amount")} className={`${cell} px-1`}><option value="pct">%</option><option value="amount">€</option></select>
                  <span className="w-20 text-right text-rose-600">−{eur(totals.hdisc)}</span>
                </div>
              )}
            </div>
            <div className="flex justify-between text-slate-600"><span>Καθαρή αξία</span><span>{eur(totals.net)}</span></div>
            <div className="flex justify-between text-slate-600"><span>ΦΠΑ</span><span>{eur(totals.vat)}</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-bold text-slate-900"><span>Σύνολο</span><span>{eur(totals.total)}</span></div>
          </div>
        </div>

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">{view ? "Κλείσιμο" : "Άκυρο"}</button>
          {!view && <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? "…" : "Αποθήκευση"}</button>}
        </div>
      </form>
    </Modal>
  );
}
