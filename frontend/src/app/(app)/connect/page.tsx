"use client";

/** RxVision Connect — δίκτυα συνεργασίας φαρμακείων.
 *  Μία σελίδα, καρτέλες οδηγούμενες από το URL hash → κάθε καρτέλα = αυτόνομη επιλογή στο μενού.
 *  Όλα τα βοηθητικά components είναι σε ΕΠΙΠΕΔΟ ΑΡΧΕΙΟΥ: component ορισμένο μέσα σε render
 *  ξαναγεννιέται σε κάθε πληκτρολόγηση και το πεδίο χάνει το focus ανά χαρακτήρα. */

import { useCountry } from "@/lib/cy";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Handshake, Inbox, Send, ArrowRightLeft, Users, SlidersHorizontal, Clock,
  PackageCheck, RotateCcw, AlertTriangle, Trash2, Plus, Bell, QrCode,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DateInput } from "@/components/ui/DateInput";

type Member = { tenant_id: string; name: string };
type Basis = "retail" | "wholesale" | "acquisition";
type Group = { id: string; name: string; owner: boolean; members: Member[]; price_basis: Basis };
type Invite = { id: string; group: string; from: string; created_at: string };
type Offer = {
  id: string; qty: number; status: string; mode: string; from?: string;
  settle_mode: "return" | "value"; price_basis: Basis | null; unit_price_cents: number | null;
};
type Req = {
  id: string; barcode: string | null; name: string; qty: number; qty_covered: number;
  urgency: string; notes: string | null; status: string; created_at: string; mine: boolean;
  from: string; offers?: Offer[]; my_offer?: Offer | null; suggested?: number | null;
  can_return: boolean; return_by: string | null;
  price_basis?: Basis; price_hint_cents?: number | null;
};
type Ret = { id: string; qty: number; status: string; batch_id: string | null };
type Mov = {
  id: string; direction: "in" | "out"; partner: string; partner_id: string;
  barcode: string | null; name: string; qty: number; status: string; doc_ref: string | null;
  batch: string | null; expiry: string | null; created_at: string; completed_at: string | null;
  returned: number; settled: number; open_qty: number; returnable_qty: number;
  dispute: { id: string; reason: string } | null; returns: Ret[];
  settle_mode: "return" | "value"; price_basis: Basis | null; unit_price_cents: number | null;
  open_value_cents: number | null; can_return: boolean; return_by: string | null;
  scan_code: string | null;
};
type Bal = { partner: string; partner_id: string; barcode: string | null; name: string;
             qty: number; direction: "they_owe" | "i_owe"; movements: number;
             value_cents: number; in_kind_qty: number };
type Dash = {
  inbox: number; offers_waiting: number; to_deliver: number; to_receive: number;
  they_owe: number; i_owe: number; returns_todo: number; disputes: number;
  partners: number; groups: number; reservations: number;
  they_owe_cents: number; i_owe_cents: number; returns_to_hand: number; unseen: number;
};
type Ev = { id: string; kind: string; tab: string; text: string; created_at: string; seen: boolean };
type Policy = {
  global_pct: number; safety_qty: number; reservation_minutes: number;
  auto_offer: boolean; require_doc_ref: boolean; per_group: Record<string, number>;
};

const TABS = ["dashboard", "inbox", "requests", "movements", "networks", "settings"] as const;
const TAB_LABEL: Record<string, string> = {
  dashboard: "Πίνακας", inbox: "Αιτήματα δικτύου", requests: "Τα αιτήματά μου",
  movements: "Κινήσεις & υπόλοιπα", networks: "Τα δίκτυά μου", settings: "Πόσο διαθέτω",
};
const URGENCY: Record<string, { label: string; cls: string }> = {
  normal: { label: "Κανονικό", cls: "bg-slate-100 text-slate-600" },
  today: { label: "Σήμερα", cls: "bg-amber-100 text-amber-700" },
  urgent: { label: "Επείγον", cls: "bg-rose-100 text-rose-700" },
};
const MOV_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Εκκρεμεί παράδοση", cls: "bg-amber-100 text-amber-700" },
  completed: { label: "Ολοκληρωμένη", cls: "bg-emerald-100 text-emerald-700" },
  cancelled: { label: "Ακυρώθηκε", cls: "bg-slate-100 text-slate-500" },
  under_review: { label: "Σε έλεγχο", cls: "bg-rose-100 text-rose-700" },
};
const BASIS: Record<Basis, string> = { retail: "Λιανικής", wholesale: "Χονδρικής", acquisition: "Κτήσης" };
const BASIS_HINT: Record<Basis, string> = {
  retail: "προσυμπληρώνεται από το Δελτίο Τιμών, αλλάζει",
  wholesale: "προσυμπληρώνεται από το Δελτίο Τιμών, αλλάζει",
  acquisition: "τη γράφει ο φαρμακοποιός που δίνει",
};
const eur = (c?: number | null) =>
  c == null ? "—" : (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const toCents = (v: string) => {
  const n = Number(String(v).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
/** Οι όροι μιας προσφοράς/κίνησης σε μία φράση — ίδια διατύπωση σε όλες τις καρτέλες. */
function termsText(t: { settle_mode: string; unit_price_cents: number | null; price_basis: Basis | null }, qty: number) {
  if (t.settle_mode === "value") {
    if (!t.unit_price_cents) return "Χρέωση με τιμή — δεν έχει οριστεί ακόμη τιμή";
    return `Χρέωση ${eur(t.unit_price_cents)}/τεμ. (τιμή ${(BASIS[t.price_basis || "wholesale"] || "").toLowerCase()}) — σύνολο ${eur(t.unit_price_cents * qty)}`;
  }
  return "Το θέλει πίσω σε είδος (ίδιο σκεύασμα)";
}
const dt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

function Kpi({ icon: Icon, label, value, tint, onClick }: {
  icon: typeof Handshake; label: string; value: number | string; tint: string; onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className="rx-card flex items-center gap-3 p-4 text-left disabled:cursor-default">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tint}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs text-slate-500">{label}</div>
        <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
      </div>
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rx-card p-8 text-center text-sm text-slate-500">{text}</div>;
}

function Pill({ label, cls }: { label: string; cls: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export default function ConnectPage() {
  const cy = useCountry() === "CY";   // κείμενα ανά χώρα (Κύπρος: χωρίς ΑΜΚΑ/ΗΔΥΚΑ/ΕΟΠΥΥ)
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>("dashboard");
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1);
      if ((TABS as readonly string[]).includes(h)) setTab(h);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const dash = useQuery({ queryKey: ["connect", "dash"], queryFn: () => api<Dash>("/connect/dashboard") });
  const nets = useQuery({
    queryKey: ["connect", "groups"],
    queryFn: () => api<{ groups: Group[]; invites: Invite[] }>("/connect/groups"),
  });
  const inbox = useQuery({ queryKey: ["connect", "inbox"], queryFn: () => api<Req[]>("/connect/inbox") });
  const mine = useQuery({ queryKey: ["connect", "requests"], queryFn: () => api<Req[]>("/connect/requests") });
  const movs = useQuery({ queryKey: ["connect", "movements"], queryFn: () => api<Mov[]>("/connect/movements") });
  const bals = useQuery({ queryKey: ["connect", "balances"], queryFn: () => api<Bal[]>("/connect/balances") });
  const pol = useQuery({ queryKey: ["connect", "policy"], queryFn: () => api<Policy>("/connect/policy") });
  const evs = useQuery({ queryKey: ["connect", "events"], queryFn: () => api<Ev[]>("/connect/events") });

  // Μόλις ανοίξει η σελίδα, οι αλλαγές θεωρούνται «ειδωμένες» (σβήνει η ειδοποίηση πάνω δεξιά).
  // Η λίστα κρατά την επισήμανση «νέο» μέχρι την επόμενη ανανέωση, για να τη διαβάσει.
  const unseenCount = (evs.data || []).filter((e) => !e.seen).length;
  useEffect(() => {
    if (!unseenCount) return;
    api("/connect/events/seen", { method: "POST" })
      .then(() => qc.invalidateQueries({ queryKey: ["connect", "topbar"] }))
      .catch(() => {});
  }, [unseenCount, qc]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["connect"] });
  const [offerMode, setOfferMode] = useState<Record<string, "return" | "value">>({});
  const [offerPrice, setOfferPrice] = useState<Record<string, string>>({});
  const [scan, setScan] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [gName, setGName] = useState("");
  const [gBasis, setGBasis] = useState<Basis>("wholesale");

  /** Κάθε ενέργεια περνά από εδώ: ο server απαντά πάντα {ok, message} — αν δεν είναι ok, ο
   *  λόγος λέγεται στον άνθρωπο αντί να «μη γίνεται τίποτα». */
  const act = useMutation({
    mutationFn: (v: { path: string; body?: unknown; method?: string }) =>
      api<{ ok?: boolean; message?: string; error?: string }>(v.path, {
        method: v.method || "POST", ...(v.body ? { body: JSON.stringify(v.body) } : {}),
      }),
    onSuccess: async (r) => {
      if (r && r.ok === false) await appAlert(r.message || "Η ενέργεια δεν ολοκληρώθηκε.");
      refresh();
    },
    onError: () => appAlert("Κάτι πήγε στραβά. Δοκίμασε ξανά."),
  });
  const run = (path: string, body?: unknown, method?: string) => act.mutate({ path, body, method });

  // ── νέο αίτημα ─────────────────────────────────────────────────────────────────────────
  const [nBarcode, setNBarcode] = useState("");
  const [nName, setNName] = useState("");
  const [nQty, setNQty] = useState(1);
  const [nUrg, setNUrg] = useState("normal");
  const [nGroups, setNGroups] = useState<string[]>([]);
  const [nNotes, setNNotes] = useState("");
  const [nCanReturn, setNCanReturn] = useState(false);
  const [nReturnBy, setNReturnBy] = useState("");

  const submitRequest = async () => {
    if (!nName.trim() && !nBarcode.trim()) { await appAlert("Γράψε τουλάχιστον όνομα ή barcode."); return; }
    if (!nGroups.length) { await appAlert("Διάλεξε τουλάχιστον ένα δίκτυο."); return; }
    const r = await api<{ ok: boolean; auto_offers?: number; message?: string }>("/connect/requests", {
      method: "POST",
      body: JSON.stringify({ barcode: nBarcode.trim(), name: nName.trim(), qty: nQty,
                             group_ids: nGroups, urgency: nUrg, notes: nNotes.trim(),
                             can_return: nCanReturn, return_by: nCanReturn ? nReturnBy : "" }),
    });
    if (!r.ok) { await appAlert(r.message || "Το αίτημα δεν στάλθηκε."); return; }
    setNBarcode(""); setNName(""); setNQty(1); setNNotes(""); setNCanReturn(false); setNReturnBy("");
    if (r.auto_offers) {
      await appAlert(`Το αίτημα στάλθηκε — ${r.auto_offers} ${r.auto_offers === 1 ? "φαρμακείο απάντησε" : "φαρμακεία απάντησαν"} ήδη από το απόθεμά τους.`);
    }
    refresh();
  };

  const invite = async (groupId: string) => {
    const afm = await appPrompt("ΑΦΜ του φαρμακείου που θέλεις να προσκαλέσεις:");
    if (!afm) return;
    const r = await api<{ ok: boolean; message?: string; invited?: string }>("/connect/invites", {
      method: "POST", body: JSON.stringify({ group_id: groupId, afm }),
    });
    await appAlert(r.ok ? `Η πρόσκληση στάλθηκε στο «${r.invited}».` : (r.message || "Δεν στάλθηκε."));
    refresh();
  };

  const newGroup = async () => {
    if (!gName.trim()) { await appAlert("Γράψε ένα όνομα για το δίκτυο."); return; }
    run("/connect/groups", { name: gName.trim(), price_basis: gBasis });
    setGName("");
  };

  const sendOffer = async (r: Req) => {
    const max = r.qty - r.qty_covered;
    const qty = offerQty[r.id] ?? Math.min(r.suggested || 1, max);
    const mode = offerMode[r.id] ?? (r.can_return ? "return" : "value");
    let price: number | null = null;
    if (mode === "value") {
      const typed = offerPrice[r.id];
      price = typed != null && typed !== "" ? toCents(typed) : (r.price_hint_cents ?? null);
      if (!price) {
        await appAlert(`Γράψε την τιμή ${(BASIS[r.price_basis || "wholesale"]).toLowerCase()} ανά τεμάχιο.`);
        return;
      }
    }
    run(`/connect/requests/${r.id}/offer`, { qty, settle_mode: mode, unit_price_cents: price });
  };

  const returnPicked = async (ids: string[], partner?: Bal) => {
    const yes = await appConfirm(partner
      ? `Επιστροφή ΟΛΩΝ των ανοιχτών ειδών στο «${partner.partner}»; Ο συνεργάτης απαντά μία φορά για όλα.`
      : `Επιστροφή ${ids.length} ${ids.length === 1 ? "είδους" : "ειδών"}; Ο συνεργάτης απαντά μία φορά για όλα.`);
    if (!yes) return;
    run("/connect/returns/bulk", partner ? { partner_id: partner.partner_id } : { movement_ids: ids });
    setPicked([]);
  };

  const removeGroup = async (g: Group) => {
    const others = g.members.length - 1;
    const yes = await appConfirm(
      `Διαγραφή του δικτύου «${g.name}»;` +
      (others > 0 ? ` ${others} ${others === 1 ? "φαρμακείο χάνει" : "φαρμακεία χάνουν"} την πρόσβαση.` : "")
    );
    if (yes) run(`/connect/groups/${g.id}`, undefined, "DELETE");
  };

  const deliver = async (m: Mov) => {
    const doc = await appPrompt(`Παράδοση ${m.qty} τεμ. «${m.name}» στο «${m.partner}». Αριθμός παραστατικού διακίνησης (προαιρετικό):`);
    if (doc === null) return;
    run(`/connect/movements/${m.id}/deliver`, { doc_ref: doc, batch: batch[m.id] || "",
                                                expiry: expiry[m.id] || "", scan_code: scan[m.id] || "" });
  };

  const askReturn = async (m: Mov) => {
    const q = await appPrompt(`Πόσα τεμάχια επιστρέφεις στο «${m.partner}»; (ανοιχτά: ${m.returnable_qty})`,
      { defaultValue: String(m.returnable_qty) });
    if (!q) return;
    run(`/connect/movements/${m.id}/return`, { qty: Math.min(Number(q) || 1, m.returnable_qty) });
  };

  const askSettle = async (m: Mov) => {
    const amount = await appPrompt(`Τακτοποίηση αξίας για ${m.open_qty} τεμ. «${m.name}». Ποσό σε ευρώ:`,
      { defaultValue: m.open_value_cents ? (m.open_value_cents / 100).toFixed(2).replace(".", ",") : "" });
    if (amount === null) return;
    run(`/connect/movements/${m.id}/settle`, { qty: m.open_qty, amount_cents: toCents(amount) ?? 0 });
  };

  const askDispute = async (m: Mov) => {
    const note = await appPrompt(`Τι δεν πήγε καλά με την κίνηση «${m.name}» (${m.partner});`);
    if (!note) return;
    run(`/connect/movements/${m.id}/dispute`, { reason: "other", note });
  };

  const [batch, setBatch] = useState<Record<string, string>>({});
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [offerQty, setOfferQty] = useState<Record<string, number>>({});
  const [pct, setPct] = useState<Record<string, number>>({});

  const d = dash.data;
  const groups = nets.data?.groups || [];
  const invites = nets.data?.invites || [];
  const go = (t: string) => { window.location.hash = t; setTab(t); };

  return (
    <ModuleGuard module="connect">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-800 dark:text-slate-100">
            <Handshake className="h-6 w-6 text-indigo-600" /> RxVision Connect
          </h1>
          {invites.length > 0 && (
            <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-700">
              {invites.length} {invites.length === 1 ? "πρόσκληση" : "προσκλήσεις"} σε αναμονή
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2 dark:border-slate-700">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => go(k)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300"}`}>
              {TAB_LABEL[k]}
              {k === "inbox" && d?.inbox ? ` (${d.inbox})` : ""}
            </button>
          ))}
        </div>

        {tab === "dashboard" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => go("requests")} disabled={!groups.length}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                <Plus className="h-4 w-4" /> Νέο αίτημα
              </button>
            </div>
            {(evs.data || []).length > 0 && (
              <div className="rx-card space-y-2 p-4">
                <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                  <Bell className="h-4 w-4 text-indigo-600" /> Τι άλλαξε
                </h2>
                {(evs.data || []).slice(0, 8).map((e) => (
                  <button key={e.id} type="button" onClick={() => go(e.tab)}
                    className={`flex w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                      e.seen ? "bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"
                             : "bg-indigo-50 font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-200"}`}>
                    {!e.seen && <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] text-white">νέο</span>}
                    <span className="min-w-0 flex-1">{e.text}</span>
                    <span className="text-xs text-slate-400">{dt(e.created_at)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi icon={Inbox} label="Αιτήματα δικτύου" value={d?.inbox ?? 0}
                tint="bg-indigo-100 text-indigo-700" onClick={() => go("inbox")} />
              <Kpi icon={Send} label="Περιμένουν απάντησή μου" value={d?.offers_waiting ?? 0}
                tint="bg-amber-100 text-amber-700" onClick={() => go("requests")} />
              <Kpi icon={PackageCheck} label="Να παραδώσω" value={d?.to_deliver ?? 0}
                tint="bg-sky-100 text-sky-700" onClick={() => go("movements")} />
              <Kpi icon={ArrowRightLeft} label="Να παραλάβω" value={d?.to_receive ?? 0}
                tint="bg-sky-100 text-sky-700" onClick={() => go("movements")} />
              <Kpi icon={Handshake} label="Μου οφείλουν (τεμ.)"
                value={d?.they_owe_cents ? `${d.they_owe} · ${eur(d.they_owe_cents)}` : (d?.they_owe ?? 0)}
                tint="bg-emerald-100 text-emerald-700" onClick={() => go("movements")} />
              <Kpi icon={Handshake} label="Οφείλω (τεμ.)"
                value={d?.i_owe_cents ? `${d.i_owe} · ${eur(d.i_owe_cents)}` : (d?.i_owe ?? 0)}
                tint="bg-rose-100 text-rose-700" onClick={() => go("movements")} />
              <Kpi icon={RotateCcw} label="Προς επιστροφή" value={(d?.returns_todo ?? 0) + (d?.returns_to_hand ?? 0)}
                tint="bg-amber-100 text-amber-700" onClick={() => go("movements")} />
              <Kpi icon={Clock} label="Προσωρινές κρατήσεις" value={d?.reservations ?? 0}
                tint="bg-slate-100 text-slate-600" />
              <Kpi icon={AlertTriangle} label="Σε έλεγχο" value={d?.disputes ?? 0}
                tint="bg-rose-100 text-rose-700" onClick={() => go("movements")} />
              <Kpi icon={Users} label="Συνεργάτες" value={d?.partners ?? 0}
                tint="bg-slate-100 text-slate-600" onClick={() => go("networks")} />
              <Kpi icon={Users} label="Δίκτυά μου" value={d?.groups ?? 0}
                tint="bg-slate-100 text-slate-600" onClick={() => go("networks")} />
            </div>
            {!groups.length && (
              <div className="rx-card p-6 text-sm text-slate-600 dark:text-slate-300">
                Δεν έχεις ακόμη δίκτυο. Φτιάξε ένα και κάλεσε τα συνεργαζόμενα φαρμακεία σου με
                το ΑΦΜ τους — μόλις αποδεχθούν, μπορείτε να ζητάτε σκευάσματα μεταξύ σας.
                <button type="button" onClick={() => go("networks")}
                  className="ml-2 font-semibold text-indigo-600 hover:underline">Ξεκίνα εδώ</button>
              </div>
            )}
          </div>
        )}

        {tab === "inbox" && (
          <div className="space-y-3">
            {!inbox.data?.length && <Empty text="Κανένα αίτημα από τα δίκτυά σου αυτή τη στιγμή." />}
            {(inbox.data || []).map((r) => (
              <div key={r.id} className="rx-card space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{r.name}</span>
                  <Pill {...URGENCY[r.urgency] || URGENCY.normal} />
                  <span className="text-sm text-slate-500">
                    {r.from} · ζητά {r.qty} τεμ. · καλυμμένα {r.qty_covered}/{r.qty}
                  </span>
                </div>
                {r.barcode && <div className="font-mono text-xs text-slate-400">{r.barcode}</div>}
                {r.notes && <div className="text-sm text-slate-600 dark:text-slate-300">{r.notes}</div>}
                <div className={`text-sm ${r.can_return ? "text-emerald-700" : "text-slate-500"}`}>
                  {r.can_return
                    ? `↩ Μπορεί να το επιστρέψει${r.return_by ? ` έως ${dt(r.return_by)}` : ""}`
                    : "Δεν δήλωσε ότι μπορεί να το επιστρέψει"}
                </div>
                {r.my_offer && r.my_offer.status !== "withdrawn" ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-slate-600 dark:text-slate-300">
                      {r.my_offer.status === "rejected" && !r.my_offer.qty
                        ? "Απάντησες ότι δεν μπορείς να καλύψεις."
                        : `Προσφέρεις ${r.my_offer.qty} τεμ.${r.my_offer.mode === "auto" ? " (αυτόματα, από το απόθεμά σου)" : ""} · ${termsText(r.my_offer, r.my_offer.qty)}`}
                    </span>
                    {r.my_offer.status === "pending" && (
                      <button type="button" onClick={() => run(`/connect/offers/${r.my_offer!.id}/withdraw`)}
                        className="rounded-lg border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">
                        Ανάκληση
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-slate-500">Πώς θα τακτοποιηθεί:</span>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`mode-${r.id}`}
                        checked={(offerMode[r.id] ?? (r.can_return ? "return" : "value")) === "return"}
                        onChange={() => setOfferMode({ ...offerMode, [r.id]: "return" })} />
                      Το θέλω πίσω (ίδιο σκεύασμα)
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`mode-${r.id}`}
                        checked={(offerMode[r.id] ?? (r.can_return ? "return" : "value")) === "value"}
                        onChange={() => setOfferMode({ ...offerMode, [r.id]: "value" })} />
                      Με τιμή {BASIS[r.price_basis || "wholesale"].toLowerCase()} (ή είδος με είδος αυτής της αξίας)
                    </label>
                    {(offerMode[r.id] ?? (r.can_return ? "return" : "value")) === "value" && (
                      <span className="flex items-center gap-1.5">
                        <input inputMode="decimal"
                          value={offerPrice[r.id] ?? (r.price_hint_cents ? (r.price_hint_cents / 100).toFixed(2).replace(".", ",") : "")}
                          onChange={(e) => setOfferPrice({ ...offerPrice, [r.id]: e.target.value })}
                          placeholder={r.price_basis === "acquisition" ? "τιμή κτήσης" : "τιμή"}
                          className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-right text-sm dark:bg-slate-800" />
                        <span className="text-xs text-slate-500">€/τεμ. · {cy ? BASIS_HINT[r.price_basis || "wholesale"].replace("το Δελτίο Τιμών", "τον κατάλογό σου") : BASIS_HINT[r.price_basis || "wholesale"]}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.suggested ? (
                      <span className="rounded-lg bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                        Μπορείς να διαθέσεις έως {r.suggested} από το απόθεμά σου
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">Δεν ξέρουμε το απόθεμά σου — πες μας εσύ.</span>
                    )}
                    <input type="number" min={1} max={r.qty - r.qty_covered}
                      value={offerQty[r.id] ?? Math.min(r.suggested || 1, r.qty - r.qty_covered)}
                      onChange={(e) => setOfferQty({ ...offerQty, [r.id]: Number(e.target.value) })}
                      className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:bg-slate-800" />
                    <button type="button" onClick={() => sendOffer(r)}
                      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
                      Μπορώ να καλύψω
                    </button>
                    <button type="button" onClick={() => run(`/connect/requests/${r.id}/decline`)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                      Δεν μπορώ
                    </button>
                  </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "requests" && (
          <div className="space-y-4">
            <div className="rx-card space-y-3 p-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                <Plus className="h-4 w-4" /> Νέο αίτημα
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <input value={nName} onChange={(e) => setNName(e.target.value)}
                  placeholder="Σκεύασμα" className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:bg-slate-800" />
                <input value={nBarcode} onChange={(e) => setNBarcode(e.target.value)}
                  placeholder="Barcode (βοηθά να απαντήσουν αυτόματα)"
                  className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm dark:bg-slate-800" />
                <input type="number" min={1} value={nQty} onChange={(e) => setNQty(Number(e.target.value))}
                  placeholder="Τεμάχια" className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:bg-slate-800" />
                <select value={nUrg} onChange={(e) => setNUrg(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:bg-slate-800">
                  {Object.entries(URGENCY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <input value={nNotes} onChange={(e) => setNNotes(e.target.value)}
                placeholder="Σημείωση (προαιρετικά)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:bg-slate-800" />
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={nCanReturn} onChange={(e) => setNCanReturn(e.target.checked)} />
                  <span className="text-slate-700 dark:text-slate-200">Μπορώ να το επιστρέψω</span>
                </label>
                {nCanReturn && (
                  <span className="flex items-center gap-2">
                    <span className="text-slate-500">Ημερομηνία επιστροφής (προαιρετικά):</span>
                    <DateInput value={nReturnBy} onChange={setNReturnBy} />
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-500">Σε ποια δίκτυα:</span>
                {groups.map((g) => (
                  <button key={g.id} type="button"
                    onClick={() => setNGroups(nGroups.includes(g.id)
                      ? nGroups.filter((x) => x !== g.id) : [...nGroups, g.id])}
                    className={`rounded-full px-3 py-1 text-sm ${nGroups.includes(g.id)
                      ? "bg-indigo-600 text-white" : "border border-slate-300 text-slate-600"}`}>
                    {g.name}
                  </button>
                ))}
                {!groups.length && <span className="text-sm text-slate-500">Δεν έχεις δίκτυο ακόμη.</span>}
              </div>
              <button type="button" onClick={submitRequest} disabled={!groups.length}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                Στείλε στο δίκτυο
              </button>
            </div>

            {!mine.data?.length && <Empty text="Δεν έχεις στείλει ακόμη κανένα αίτημα." />}
            {(mine.data || []).map((r) => (
              <div key={r.id} className="rx-card space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{r.name}</span>
                  <Pill {...URGENCY[r.urgency] || URGENCY.normal} />
                  <span className="text-sm text-slate-500">
                    {r.qty_covered}/{r.qty} καλυμμένα · {dt(r.created_at)}
                    {r.can_return ? ` · μπορώ να το επιστρέψω${r.return_by ? ` έως ${dt(r.return_by)}` : ""}` : ""}
                  </span>
                  {r.status === "open" && (
                    <button type="button" onClick={() => run(`/connect/requests/${r.id}`, undefined, "DELETE")}
                      className="ml-auto text-xs text-slate-500 hover:text-rose-600">Ακύρωση</button>
                  )}
                </div>
                <div className="space-y-1">
                  {(r.offers || []).filter((o) => o.status !== "withdrawn").map((o) => (
                    <div key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
                      <span className="font-medium">{o.from}</span>
                      <span className="text-slate-600 dark:text-slate-300">
                        {o.qty ? `${o.qty} τεμ.` : "δεν μπορεί να καλύψει"}
                        {o.mode === "auto" && o.qty ? " (αυτόματα)" : ""}
                      </span>
                      {o.qty > 0 && (
                        <span className={`w-full text-xs ${o.settle_mode === "value" ? "text-indigo-700" : "text-emerald-700"}`}>
                          {termsText(o, o.qty)}
                        </span>
                      )}
                      {o.status === "pending" && o.qty > 0 && (
                        <span className="ml-auto flex gap-2">
                          <button type="button" onClick={() => run(`/connect/offers/${o.id}/accept`)}
                            className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700">
                            Δέχομαι
                          </button>
                          <button type="button" onClick={() => run(`/connect/offers/${o.id}/reject`)}
                            className="rounded-lg border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">
                            Όχι
                          </button>
                        </span>
                      )}
                      {o.status === "accepted" && (
                        <span className="ml-auto text-xs text-emerald-700">Δεκτή</span>
                      )}
                    </div>
                  ))}
                  {!(r.offers || []).filter((o) => o.status !== "withdrawn").length && (
                    <div className="text-sm text-slate-500">Καμία απάντηση ακόμη.</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "movements" && (
          <div className="space-y-4">
            <div className="rx-card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="font-semibold text-slate-800 dark:text-slate-100">Ανοιχτά υπόλοιπα</h2>
                {picked.length > 0 && (
                  <button type="button" onClick={() => returnPicked(picked)}
                    className="ml-auto flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
                    <RotateCcw className="h-4 w-4" /> Επιστροφή επιλεγμένων ({picked.length})
                  </button>
                )}
              </div>
              {Array.from(new Map((bals.data || []).filter((b) => b.direction === "i_owe")
                .map((b) => [b.partner_id, b])).values()).map((b) => (
                <button key={`all-${b.partner_id}`} type="button" onClick={() => returnPicked([], b)}
                  className="mb-2 mr-2 inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
                  <RotateCcw className="h-3.5 w-3.5" /> Επιστροφή όλων στο {b.partner}
                </button>
              ))}
              {!bals.data?.length && <div className="text-sm text-slate-500">Κανένα ανοιχτό υπόλοιπο.</div>}
              <div className="space-y-2">
                {(bals.data || []).map((b, i) => (
                  <div key={`${b.partner_id}-${b.barcode}-${i}`}
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
                    <span className="font-medium">{b.partner}</span>
                    <span className="text-slate-600 dark:text-slate-300">{b.name}</span>
                    <span className={`ml-auto font-semibold ${b.direction === "they_owe" ? "text-emerald-700" : "text-rose-700"}`}>
                      {b.direction === "they_owe" ? `Μου οφείλουν ${b.qty}` : `Οφείλω ${b.qty}`} τεμ.
                      {b.value_cents ? ` · ${eur(b.value_cents)}` : ""}
                      {b.value_cents && b.in_kind_qty ? ` + ${b.in_kind_qty} σε είδος` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {!movs.data?.length && <Empty text="Καμία κίνηση ακόμη." />}
            {(movs.data || []).map((m) => (
              <div key={m.id} className="rx-card space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {m.direction === "in" && m.status === "completed" && m.returnable_qty > 0 && (
                    <input type="checkbox" aria-label="Επιλογή για επιστροφή" checked={picked.includes(m.id)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
                  )}
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{m.name}</span>
                  <span className="text-sm text-slate-600 dark:text-slate-300">
                    {m.direction === "out" ? `Διέθεσα σε ${m.partner}` : `Έλαβα από ${m.partner}`} · {m.qty} τεμ.
                  </span>
                  <Pill {...MOV_STATUS[m.status] || MOV_STATUS.pending} />
                  <span className="ml-auto text-xs text-slate-400">{dt(m.completed_at || m.created_at)}</span>
                </div>
                <div className={`text-sm ${m.settle_mode === "value" ? "text-indigo-700" : "text-emerald-700"}`}>
                  {termsText(m, m.qty)}
                  {m.status === "completed" && m.open_value_cents ? ` · ανοιχτά ${eur(m.open_value_cents)}` : ""}
                  {m.can_return && m.return_by ? ` · επιστροφή έως ${dt(m.return_by)}` : ""}
                </div>
                {(m.doc_ref || m.batch || m.expiry || m.scan_code) && (
                  <div className="text-xs text-slate-500">
                    {m.doc_ref && <>Παραστατικό {m.doc_ref} · </>}
                    {m.batch && <>Παρτίδα {m.batch} · </>}
                    {m.expiry && <>Λήξη {m.expiry} · </>}
                    {m.scan_code && <>Σάρωση <span className="font-mono">{m.scan_code}</span></>}
                  </div>
                )}
                {m.status === "pending" && m.direction === "out" && (
                  <div className="flex flex-wrap items-end gap-2">
                    <input value={batch[m.id] || ""} onChange={(e) => setBatch({ ...batch, [m.id]: e.target.value })}
                      placeholder="Παρτίδα" className="w-32 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:bg-slate-800" />
                    <DateInput value={expiry[m.id] || ""} onChange={(v) => setExpiry({ ...expiry, [m.id]: v })} />
                    <span className="flex items-center gap-1">
                      <QrCode className="h-4 w-4 text-slate-400" />
                      <input value={scan[m.id] || ""} onChange={(e) => setScan({ ...scan, [m.id]: e.target.value })}
                        placeholder="Σάρωση QR (προαιρετικά)"
                        className="w-48 rounded-lg border border-slate-300 px-2 py-1 font-mono text-sm dark:bg-slate-800" />
                    </span>
                    <button type="button" onClick={() => deliver(m)}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
                      Παρέδωσα
                    </button>
                    <button type="button" onClick={() => run(`/connect/movements/${m.id}/cancel`)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                      Ακύρωση
                    </button>
                  </div>
                )}
                {m.status === "pending" && m.direction === "in" && (
                  <div className="text-sm text-slate-500">
                    Περιμένεις παράδοση από το {m.partner}. Η κράτηση λήγει μόνη της αν δεν ολοκληρωθεί.
                  </div>
                )}
                {m.status === "completed" && m.open_qty > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-slate-600 dark:text-slate-300">
                      Ανοιχτά {m.open_qty} τεμ.
                    </span>
                    {m.direction === "in" && m.returnable_qty > 0 && (
                      <button type="button" onClick={() => askReturn(m)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                        Επιστροφή σε είδος
                      </button>
                    )}
                    <button type="button" onClick={() => askSettle(m)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                      Τακτοποίηση αξίας
                    </button>
                    <button type="button" onClick={() => askDispute(m)}
                      className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50">
                      Υπάρχει πρόβλημα
                    </button>
                  </div>
                )}
                {m.returns.filter((r) => r.status !== "completed").map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <RotateCcw className="h-4 w-4" />
                    Επιστροφή {r.qty} τεμ.{r.batch_id ? " (μαζί με άλλα είδη)" : ""} — {r.status === "requested" ? "περιμένει απάντηση" : "εγκρίθηκε"}
                    {r.status === "requested" && m.direction === "out" && (
                      <span className="ml-auto flex gap-2">
                        <button type="button" onClick={() => run(`/connect/returns/${r.id}/respond`, { accept: true })}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs text-white">{r.batch_id ? "Δέχομαι όλα" : "Δέχομαι"}</button>
                        <button type="button" onClick={() => run(`/connect/returns/${r.id}/respond`, { accept: false })}
                          className="rounded-lg border border-slate-300 px-3 py-1 text-xs">Όχι</button>
                      </span>
                    )}
                    {r.status === "accepted" && m.direction === "in" && (
                      <button type="button" onClick={() => run(`/connect/returns/${r.id}/complete`)}
                        className="ml-auto rounded-lg bg-emerald-600 px-3 py-1 text-xs text-white">
                        {r.batch_id ? "Τα επέστρεψα όλα" : "Το επέστρεψα"}
                      </button>
                    )}
                  </div>
                ))}
                {m.dispute && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    <AlertTriangle className="h-4 w-4" /> Σε έλεγχο
                    <button type="button" onClick={() => run(`/connect/disputes/${m.dispute!.id}/resolve`, { note: "" })}
                      className="ml-auto rounded-lg border border-rose-300 px-3 py-1 text-xs">Λύθηκε</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "networks" && (
          <div className="space-y-4">
            {invites.length > 0 && (
              <div className="rx-card space-y-2 p-4">
                <h2 className="font-semibold text-slate-800 dark:text-slate-100">Προσκλήσεις προς εσένα</h2>
                {invites.map((i) => (
                  <div key={i.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
                    <span>Το «{i.from}» σε καλεί στο δίκτυο «{i.group}»</span>
                    <span className="ml-auto flex gap-2">
                      <button type="button" onClick={() => run(`/connect/invites/${i.id}`, { accept: true })}
                        className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white">Αποδοχή</button>
                      <button type="button" onClick={() => run(`/connect/invites/${i.id}`, { accept: false })}
                        className="rounded-lg border border-slate-300 px-3 py-1 text-xs">Απόρριψη</button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="rx-card space-y-3 p-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                <Plus className="h-4 w-4" /> Νέο δίκτυο
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <input value={gName} onChange={(e) => setGName(e.target.value)}
                  placeholder="π.χ. Συνεργαζόμενα Φαρμακεία Παπάγου"
                  className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:bg-slate-800" />
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-slate-500">Καταγραφή σε τιμές</span>
                  <select value={gBasis} onChange={(e) => setGBasis(e.target.value as Basis)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:bg-slate-800">
                    {(Object.keys(BASIS) as Basis[]).map((k) => <option key={k} value={k}>{BASIS[k]}</option>)}
                  </select>
                </label>
                <button type="button" onClick={newGroup}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
                  Δημιουργία
                </button>
              </div>
              <p className="text-xs text-slate-500">
                Λιανικής και χονδρικής: η τιμή προσυμπληρώνεται από {cy ? "τον κατάλογο του φαρμακείου (Αποθήκη)" : "το Δελτίο Τιμών"} και ο φαρμακοποιός
                μπορεί να την αλλάξει. Κτήσης: τη γράφει ο φαρμακοποιός που δίνει το είδος.
              </p>
            </div>

            {!groups.length && <Empty text="Δεν ανήκεις σε κανένα δίκτυο ακόμη." />}
            {groups.map((g) => (
              <div key={g.id} className="rx-card space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Users className="h-4 w-4 text-indigo-600" />
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{g.name}</span>
                  <span className="text-sm text-slate-500">
                    {g.members.length} {g.members.length === 1 ? "φαρμακείο" : "φαρμακεία"}
                    {g.owner ? " · το δημιούργησες εσύ" : ""}
                  </span>
                  {g.owner ? (
                    <select value={g.price_basis} aria-label="Τιμές καταγραφής"
                      onChange={(e) => run(`/connect/groups/${g.id}/price-basis`, { price_basis: e.target.value }, "PUT")}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:bg-slate-800">
                      {(Object.keys(BASIS) as Basis[]).map((k) => <option key={k} value={k}>Τιμές {BASIS[k].toLowerCase()}</option>)}
                    </select>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      Τιμές {BASIS[g.price_basis].toLowerCase()}
                    </span>
                  )}
                  <span className="ml-auto flex gap-2">
                    {g.owner ? (
                      <>
                        <button type="button" onClick={() => invite(g.id)}
                          className="rounded-lg border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">
                          Πρόσκληση με ΑΦΜ
                        </button>
                        <button type="button" onClick={() => removeGroup(g)}
                          className="rounded-lg border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => run(`/connect/groups/${g.id}/leave`)}
                        className="rounded-lg border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">
                        Αποχώρηση
                      </button>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {g.members.map((m) => (
                    <span key={m.tenant_id} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {m.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "settings" && pol.data && (
          <div className="space-y-4">
            <div className="rx-card space-y-4 p-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                <SlidersHorizontal className="h-4 w-4" /> Πόσο από το απόθεμά σου διαθέτεις
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Τα όρια ισχύουν μόνο για είδη που έχουν καταχωρημένο απόθεμα στο RxVision. Για τα
                υπόλοιπα, το αίτημα έρχεται σε εσένα και απαντάς εσύ.
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600 dark:text-slate-300">Καθολικό όριο (%)</span>
                  <input type="number" min={0} max={100} defaultValue={pol.data.global_pct}
                    onBlur={(e) => run("/connect/policy", { global_pct: Number(e.target.value) }, "PUT")}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:bg-slate-800" />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600 dark:text-slate-300">Απόθεμα ασφαλείας (τεμ.)</span>
                  <input type="number" min={0} defaultValue={pol.data.safety_qty}
                    onBlur={(e) => run("/connect/policy", { safety_qty: Number(e.target.value) }, "PUT")}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:bg-slate-800" />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600 dark:text-slate-300">Διάρκεια κράτησης (λεπτά)</span>
                  <input type="number" min={5} max={1440} defaultValue={pol.data.reservation_minutes}
                    onBlur={(e) => run("/connect/policy", { reservation_minutes: Number(e.target.value) }, "PUT")}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:bg-slate-800" />
                </label>
                <div className="space-y-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" defaultChecked={pol.data.auto_offer}
                      onChange={(e) => run("/connect/policy", { auto_offer: e.target.checked }, "PUT")} />
                    <span className="text-slate-600 dark:text-slate-300">Αυτόματη απάντηση</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" defaultChecked={pol.data.require_doc_ref}
                      onChange={(e) => run("/connect/policy", { require_doc_ref: e.target.checked }, "PUT")} />
                    <span className="text-slate-600 dark:text-slate-300">Απαίτηση παραστατικού</span>
                  </label>
                </div>
              </div>
            </div>

            {groups.length > 0 && (
              <div className="rx-card space-y-3 p-4">
                <h2 className="font-semibold text-slate-800 dark:text-slate-100">Όριο ανά δίκτυο</h2>
                <p className="text-sm text-slate-500">
                  Το καθολικό όριο υπερισχύει πάντα: αν εδώ βάλεις 90% και το καθολικό είναι 40%,
                  ισχύει το 40%.
                </p>
                {groups.map((g) => (
                  <div key={g.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="min-w-[10rem] font-medium">{g.name}</span>
                    <input type="number" min={0} max={100}
                      defaultValue={pol.data!.per_group?.[g.id] ?? pol.data!.global_pct}
                      onChange={(e) => setPct({ ...pct, [g.id]: Number(e.target.value) })}
                      onBlur={() => run("/connect/policy", {
                        per_group: { ...pol.data!.per_group, [g.id]: pct[g.id] ?? pol.data!.global_pct } }, "PUT")}
                      className="w-24 rounded-lg border border-slate-300 px-3 py-2 dark:bg-slate-800" />
                    <span className="text-slate-500">%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </ModuleGuard>
  );
}
