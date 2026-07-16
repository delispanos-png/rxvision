"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Trash2, Plus, Save, Info, Send, Loader2, Check, KeyRound,
  Smartphone, MessageCircle, Mail, Package, BarChart3, Wallet, RefreshCw,
} from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Pkg = { _id: string; name?: string; price_cents?: number; credits_cents?: number; active?: boolean };
type PriceMap = { email: number; sms: number; viber: number };
type Comms = { apifon_token_set: boolean; apifon_secret_set: boolean; apifon_token_tail?: string; apifon_secret_tail?: string; updated_at?: string; sms_sender: string; viber_sender: string; prices: PriceMap; cost: PriceMap; margin: PriceMap };
type Integr = { comms?: Comms };
type Tenant = { id: string; name: string; afm?: string | null; msg_balance?: number };
type Smtp = { host?: string; port?: number; username?: string; from_email?: string; from_name?: string; use_tls?: boolean; insecure_tls?: boolean; has_password?: boolean };
type ChUsage = { count: number; spent_cents: number };
type UsageRow = { tenant_id: string; name: string; by_channel: Record<string, ChUsage>; total_count: number; total_spent_cents: number; balance_cents: number };
type Usage = { days: number; prices: Record<string, number>; items: UsageRow[] };
type ApifonBal = { balance?: string; reserved?: string; plafon?: string; subscriptions?: unknown[] };

const eur = (c?: number) => ((c ?? 0) / 100).toString();
const cents = (e: string) => Math.round((parseFloat(e) || 0) * 100);
const money = (c?: number) => ((c ?? 0) / 100).toLocaleString("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
// τιμή πελάτη (cents) = κόστος(€) × (1 + κέρδος%/100) · null αν λείπει κόστος/κέρδος
const computedPrice = (costStr: string, marginStr: string): number | null => {
  const co = parseFloat(costStr), m = parseFloat(marginStr);
  if (!co || isNaN(m)) return null;
  return Math.round(co * 100 * (1 + m / 100));
};
const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";
const CH_LABEL: Record<string, string> = { sms: "SMS", viber: "Viber", email: "Email" };

const TABS = [
  { id: "sms", label: "SMS", Icon: Smartphone },
  { id: "viber", label: "Viber", Icon: MessageCircle },
  { id: "email", label: "Email", Icon: Mail },
  { id: "packages", label: "Πακέτα", Icon: Package },
  { id: "usage", label: "Κατανάλωση ανά πελάτη", Icon: BarChart3 },
  { id: "apifon", label: "Πορτοφόλι Apifon", Icon: Wallet },
] as const;
type TabId = (typeof TABS)[number]["id"];

// ── Δοκιμαστική αποστολή (αυτόνομο ανά κανάλι) ──
function TestSend({ channel }: { channel: "sms" | "viber" | "email" }) {
  const [to, setTo] = useState("");
  const [text, setText] = useState("RxVision — δοκιμαστικό μήνυμα ✓");
  const [msg, setMsg] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => adminApi("/admin/comms/test-send", { method: "POST", body: JSON.stringify({ channel, to, text }) }),
    onSuccess: () => setMsg("Στάλθηκε ✓ (η παράδοση εξαρτάται από τον λογαριασμό/sender)"),
    onError: (e: Error) => setMsg("Αποτυχία: " + e.message),
  });
  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="mb-2 text-xs font-semibold text-slate-600">Δοκιμαστική αποστολή</div>
      <div className="flex flex-wrap items-center gap-2">
        <input type={channel === "email" ? "email" : "tel"} value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === "email" ? "email παραλήπτη" : "κινητό 30XXXXXXXXXX"} className={`${inp} w-52`} />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="κείμενο" className={`${inp} min-w-[12rem] flex-1`} />
        <button onClick={() => { setMsg(null); m.mutate(); }} disabled={m.isPending || !to} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{m.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Δοκιμή {CH_LABEL[channel]}</button>
      </div>
      {msg && <div className="mt-2 text-xs text-slate-500">{msg}</div>}
    </div>
  );
}

// Κόστος μας × (1+κέρδος%) = τιμή πελάτη (χρέωση wallet)
function PriceCalc({ cost, setCost, margin, setMargin, current }: { cost: string; setCost: (v: string) => void; margin: string; setMargin: (v: string) => void; current?: number }) {
  const p = computedPrice(cost, margin);
  return (
    <div className="mt-2 grid items-end gap-3 sm:grid-cols-3">
      <label className="text-xs text-slate-500">Κόστος μας ανά μήνυμα (€)<input type="number" step="0.001" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="π.χ. 0.04" className={inp} /></label>
      <label className="text-xs text-slate-500">% Κέρδος<input type="number" step="1" value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="π.χ. 50" className={inp} /></label>
      <div className="text-xs text-slate-500">Τιμή πελάτη (χρέωση wallet)<div className="mt-1 rounded-lg bg-indigo-50 px-3 py-2 text-sm font-bold text-indigo-700">{money(p ?? current)}{p == null && <span className="ml-1 text-[10px] font-normal text-slate-400">(τρέχουσα)</span>}</div></div>
    </div>
  );
}

export default function MessagesCreditsAdminPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>("sms");
  const [notice, setNotice] = useState<string | null>(null);

  const status = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integr>("/admin/integrations") });
  const c = status.data?.comms;
  const configured = !!(c?.apifon_token_set && c?.apifon_secret_set);

  const saveIntegr = useMutation({
    mutationFn: (body: Record<string, unknown>) => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => { setNotice("Αποθηκεύτηκε ✓"); qc.invalidateQueries({ queryKey: ["integrations"] }); },
    onError: (e: Error) => setNotice("Σφάλμα: " + e.message),
  });

  // per-channel senders + κόστος/κέρδος (→ τιμή πελάτη)
  const [smsSender, setSmsSender] = useState("");
  const [viberSender, setViberSender] = useState("");
  const [costSms, setCostSms] = useState(""); const [marginSms, setMarginSms] = useState("");
  const [costViber, setCostViber] = useState(""); const [marginViber, setMarginViber] = useState("");
  const [costEmail, setCostEmail] = useState(""); const [marginEmail, setMarginEmail] = useState("");
  useEffect(() => { if (c) {
    setSmsSender(c.sms_sender || ""); setViberSender(c.viber_sender || "");
    setCostSms(c.cost.sms ? String(c.cost.sms / 100) : ""); setMarginSms(c.margin.sms ? String(c.margin.sms) : "");
    setCostViber(c.cost.viber ? String(c.cost.viber / 100) : ""); setMarginViber(c.margin.viber ? String(c.margin.viber) : "");
    setCostEmail(c.cost.email ? String(c.cost.email / 100) : ""); setMarginEmail(c.margin.email ? String(c.margin.email) : "");
  } }, [c]);
  // αποθήκευση ρυθμίσεων καναλιού (sender + κόστος/κέρδος → τιμή πελάτη)
  const saveChannel = (ch: "sms" | "viber" | "email", sender: string | null, costStr: string, marginStr: string) => {
    const price = computedPrice(costStr, marginStr);
    const body: Record<string, unknown> = {
      [`cost_${ch}`]: costStr ? cents(costStr) : null,
      [`margin_${ch}`]: marginStr !== "" ? parseFloat(marginStr) : null,
    };
    if (ch !== "email") body[`${ch}_sender`] = sender || null;
    if (price != null) body[`price_${ch}`] = price;
    saveIntegr.mutate(body);
  };

  // Apifon account creds
  const [cid, setCid] = useState(""); const [csec, setCsec] = useState("");

  // central email (SMTP)
  const smtpQ = useQuery({ queryKey: ["admin", "smtp"], queryFn: () => adminApi<Smtp>("/admin/smtp"), retry: false });
  const [smtp, setSmtp] = useState<Smtp>({ port: 587, use_tls: true, from_name: "RxVision" });
  const [smtpPw, setSmtpPw] = useState("");
  useEffect(() => { if (smtpQ.data && smtpQ.data.host) setSmtp(smtpQ.data); }, [smtpQ.data]);
  const saveSmtp = useMutation({
    mutationFn: () => adminApi("/admin/smtp", { method: "PUT", body: JSON.stringify({ ...smtp, ...(smtpPw ? { password: smtpPw } : {}) }) }),
    onSuccess: () => { setSmtpPw(""); setNotice("Αποθηκεύτηκε το κεντρικό email (SMTP) ✓"); qc.invalidateQueries({ queryKey: ["admin", "smtp"] }); },
  });

  // credit packages
  const q = useQuery({ queryKey: ["admin", "credit-packages"], queryFn: () => adminApi<{ items: Pkg[] }>("/admin/credit-packages") });
  const [drafts, setDrafts] = useState<Record<string, Pkg>>({});
  useEffect(() => { if (q.data) setDrafts(Object.fromEntries(q.data.items.map((p) => [p._id, { ...p }]))); }, [q.data]);
  const refreshPkg = () => qc.invalidateQueries({ queryKey: ["admin", "credit-packages"] });
  const setPk = (id: string, patch: Partial<Pkg>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  async function savePkg(id: string) {
    const p = drafts[id];
    await adminApi(`/admin/credit-packages/${id}`, { method: "PUT", body: JSON.stringify({ name: p.name, price_cents: p.price_cents, credits_cents: p.credits_cents, active: p.active }) });
    setNotice(`Αποθηκεύτηκε: ${p.name || id}`); refreshPkg();
  }
  async function delPkg(id: string) { if (confirm(`Διαγραφή πακέτου «${id}»;`)) { await adminApi(`/admin/credit-packages/${id}`, { method: "DELETE" }); refreshPkg(); } }
  async function createPkg() {
    const id = prompt("Κωδικός νέου πακέτου (π.χ. c200):")?.trim();
    if (!id) return;
    await adminApi(`/admin/credit-packages/${id}`, { method: "PUT", body: JSON.stringify({ name: id, price_cents: 0, credits_cents: 0, active: true }) });
    refreshPkg();
  }
  const pkgItems = Object.values(drafts).sort((a, b) => (a.price_cents ?? 0) - (b.price_cents ?? 0));

  // usage per tenant
  const [usageDays, setUsageDays] = useState(30);
  const usageQ = useQuery({ queryKey: ["admin", "usage", usageDays], queryFn: () => adminApi<Usage>(`/admin/comms/usage-by-tenant?days=${usageDays}`), enabled: tab === "usage" });
  async function topUp(row: UsageRow) {
    const v = prompt(`Προσθήκη credits (€) στο «${row.name}»:`)?.trim();
    const amt = cents(v || "");
    if (!amt) return;
    await adminApi(`/admin/tenants/${row.tenant_id}/wallet/credit`, { method: "POST", body: JSON.stringify({ amount_cents: amt, reason: "admin_grant" }) });
    setNotice(`+${money(amt)} στο ${row.name} ✓`); qc.invalidateQueries({ queryKey: ["admin", "usage"] });
  }

  // Χορήγηση credits με αναζήτηση πελάτη (ΑΦΜ ή επωνυμία)
  const tenantsQ = useQuery({ queryKey: ["admin", "tenants-lite"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), enabled: tab === "usage" });
  const [grantSearch, setGrantSearch] = useState(""); const [grantSel, setGrantSel] = useState(""); const [grantAmt, setGrantAmt] = useState("");
  const tenantOpts = (tenantsQ.data?.items || []).filter((x) => { const s = grantSearch.trim().toLowerCase(); return !s || (x.name || "").toLowerCase().includes(s) || (x.afm || "").includes(grantSearch.trim()); });
  async function grant() {
    if (!grantSel || !grantAmt) return;
    const amt = cents(grantAmt);
    if (!amt) return;
    const t = tenantOpts.find((x) => x.id === grantSel);
    await adminApi(`/admin/tenants/${grantSel}/wallet/credit`, { method: "POST", body: JSON.stringify({ amount_cents: amt, reason: "purchase" }) });
    setNotice(`+${money(amt)} credits στο ${t?.name || grantSel} ✓`); setGrantAmt("");
    qc.invalidateQueries({ queryKey: ["admin", "usage"] }); qc.invalidateQueries({ queryKey: ["admin", "tenants-lite"] });
  }

  // apifon own balance
  const balQ = useQuery({ queryKey: ["admin", "apifon-balance"], queryFn: () => adminApi<ApifonBal>("/admin/comms/apifon-balance"), enabled: tab === "apifon" && configured, retry: false });

  const badge = (ok: boolean) => ok
    ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">ρυθμισμένο</span>
    : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">εκκρεμεί</span>;
  const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
  const saveBtn = (fn: () => void, pending: boolean, label: string) => (
    <button onClick={fn} disabled={pending} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {label}
    </button>
  );

  return (
    <div className="max-w-6xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900"><MessageSquare className="h-5 w-5 text-indigo-600" /> Μηνύματα & Credits</h1>
        <p className="text-sm text-slate-500">Ρυθμίσεις ανά υπηρεσία, κατανάλωση ανά φαρμακείο και το δικό μας υπόλοιπο στην Apifon.</p>
      </div>
      {notice && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setTab(id)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${tab === id ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {/* ── SMS ── */}
      {tab === "sms" && (
        <div className={card}>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Smartphone className="h-4 w-4 text-indigo-600" /> SMS (Apifon) {badge(configured)}</h3>
          {!configured && <p className="mb-3 text-xs text-amber-600">Ο λογαριασμός Apifon δεν έχει ρυθμιστεί — δες το tab «Πορτοφόλι Apifon».</p>}
          <label className="block text-xs text-slate-500 sm:w-96">Sender ID (όνομα αποστολέα SMS · ≤11 χαρ.)<input value={smsSender} onChange={(e) => setSmsSender(e.target.value)} maxLength={11} placeholder="RxVision" className={inp} /><span className="mt-0.5 block text-[11px] text-slate-400">Το όνομα που βλέπει ο παραλήπτης — πρέπει να είναι εγκεκριμένο στην Apifon (μέγ. 11 χαρ.).</span></label>
          <PriceCalc cost={costSms} setCost={setCostSms} margin={marginSms} setMargin={setMarginSms} current={c?.prices.sms} />
          {saveBtn(() => saveChannel("sms", smsSender, costSms, marginSms), saveIntegr.isPending, "Αποθήκευση SMS")}
          <TestSend channel="sms" />
        </div>
      )}

      {/* ── Viber ── */}
      {tab === "viber" && (
        <div className={card}>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><MessageCircle className="h-4 w-4 text-indigo-600" /> Viber (Apifon IM) {badge(configured)}</h3>
          {!configured && <p className="mb-3 text-xs text-amber-600">Ο λογαριασμός Apifon δεν έχει ρυθμιστεί — δες το tab «Πορτοφόλι Apifon».</p>}
          <label className="block text-xs text-slate-500 sm:w-96">Viber Sender (εγκεκριμένος Business sender)<input value={viberSender} onChange={(e) => setViberSender(e.target.value)} placeholder="RxVision The Intelligent Pharmacy Platform" className={inp} /><span className="mt-0.5 block text-[11px] text-slate-400">Το Viber απαιτεί ξεχωριστό εγκεκριμένο sender (μπορεί να είναι μεγαλύτερο από 11 χαρ.).</span></label>
          <PriceCalc cost={costViber} setCost={setCostViber} margin={marginViber} setMargin={setMarginViber} current={c?.prices.viber} />
          {saveBtn(() => saveChannel("viber", viberSender, costViber, marginViber), saveIntegr.isPending, "Αποθήκευση Viber")}
          <TestSend channel="viber" />
        </div>
      )}

      {/* ── Email ── */}
      {tab === "email" && (
        <div className={card}>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Mail className="h-4 w-4 text-indigo-600" /> Email (κεντρικό SMTP) {badge(!!smtpQ.data?.host)}</h3>
          <p className="mb-3 text-[11px] text-slate-400">Ο κεντρικός λογαριασμός από όπου φεύγουν ΟΛΑ τα emails προς πελάτες (με εμφανιζόμενο όνομα το κάθε φαρμακείο).</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-slate-500">SMTP host<input value={smtp.host ?? ""} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.gmail.com" className={inp} /></label>
            <label className="text-xs text-slate-500">Θύρα<input type="number" value={smtp.port ?? 587} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} className={inp} /></label>
            <label className="text-xs text-slate-500">Username<input value={smtp.username ?? ""} onChange={(e) => setSmtp({ ...smtp, username: e.target.value })} className={inp} /></label>
            <label className="text-xs text-slate-500">Password {smtp.has_password && <span className="text-emerald-600">✓ αποθηκευμένος</span>}<input type="password" value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} placeholder={smtp.has_password ? "•••• (κενό = αμετάβλητο)" : "app-password"} className={inp} /></label>
            <label className="text-xs text-slate-500">From email<input value={smtp.from_email ?? ""} onChange={(e) => setSmtp({ ...smtp, from_email: e.target.value })} placeholder="noreply@rxvision.gr" className={inp} /></label>
            <label className="text-xs text-slate-500">From name (default)<input value={smtp.from_name ?? ""} onChange={(e) => setSmtp({ ...smtp, from_name: e.target.value })} placeholder="RxVision" className={inp} /></label>
            <label className="inline-flex items-center gap-2 pb-2 text-xs text-slate-600"><input type="checkbox" checked={smtp.use_tls ?? true} onChange={(e) => setSmtp({ ...smtp, use_tls: e.target.checked })} className="h-4 w-4 accent-indigo-600" /> STARTTLS (θύρα 587· η 465 = SSL αυτόματα)</label>
            <label className="inline-flex items-center gap-2 pb-2 text-xs text-slate-600"><input type="checkbox" checked={smtp.insecure_tls ?? false} onChange={(e) => setSmtp({ ...smtp, insecure_tls: e.target.checked })} className="h-4 w-4 accent-amber-600" /> Αποδοχή μη-έγκυρου πιστοποιητικού</label>
          </div>
          <div className="mt-3 border-t border-slate-100 pt-3"><PriceCalc cost={costEmail} setCost={setCostEmail} margin={marginEmail} setMargin={setMarginEmail} current={c?.prices.email} /></div>
          {saveBtn(() => { saveSmtp.mutate(); saveChannel("email", null, costEmail, marginEmail); }, saveSmtp.isPending, "Αποθήκευση Email")}
          <TestSend channel="email" />
        </div>
      )}

      {/* ── Πακέτα ── */}
      {tab === "packages" && (
        <div className={card}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">Πακέτα credits (αγορά από φαρμακεία)</h3>
            <button onClick={createPkg} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"><Plus className="h-3.5 w-3.5" /> Νέο</button>
          </div>
          <p className="mb-3 flex items-start gap-1.5 text-xs text-slate-400"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> «Πληρωμή» = τι χρεώνεται ο πελάτης · «Credits» = τι μπαίνει στο wallet (≥ πληρωμή για δώρο).</p>
          <div className="space-y-2">
            {pkgItems.map((p) => (
              <div key={p._id} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 p-3">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{p._id}</code>
                <label className="text-xs font-medium text-slate-500">Όνομα<input className={`mt-1 ${inp} w-36`} value={p.name ?? ""} onChange={(e) => setPk(p._id, { name: e.target.value })} /></label>
                <label className="text-xs font-medium text-slate-500">Πληρωμή (€)<input type="number" className={`mt-1 ${inp} w-24`} value={eur(p.price_cents)} onChange={(e) => setPk(p._id, { price_cents: cents(e.target.value) })} /></label>
                <label className="text-xs font-medium text-slate-500">Credits (€)<input type="number" className={`mt-1 ${inp} w-24`} value={eur(p.credits_cents)} onChange={(e) => setPk(p._id, { credits_cents: cents(e.target.value) })} /></label>
                <label className="inline-flex items-center gap-1.5 pb-2 text-xs text-slate-600"><input type="checkbox" checked={p.active ?? true} onChange={(e) => setPk(p._id, { active: e.target.checked })} className="h-4 w-4 accent-indigo-600" /> Ενεργό</label>
                <div className="ml-auto flex gap-2 pb-1">
                  <button onClick={() => delPkg(p._id)} className="rounded-lg border border-rose-200 px-2 py-1.5 text-xs text-rose-600 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button>
                  <button onClick={() => savePkg(p._id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"><Save className="h-3.5 w-3.5" /> Αποθήκευση</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Κατανάλωση ανά πελάτη ── */}
      {tab === "usage" && (
        <div className="space-y-4">
        <div className={card}>
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Plus className="h-4 w-4 text-indigo-600" /> Χορήγηση credits σε πελάτη</h3>
          <p className="mb-3 text-[11px] text-slate-400">Διάλεξε πελάτη (ΑΦΜ ή επωνυμία) και το ποσό αγοράς σε € — δημιουργούνται τα αντίστοιχα credits στο wallet του.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">Αναζήτηση (ΑΦΜ ή επωνυμία)<input value={grantSearch} onChange={(e) => { setGrantSearch(e.target.value); setGrantSel(""); }} placeholder="π.χ. 099… ή ΠΑΠΑΓΙΑΝ…" className={`mt-1 ${inp} w-56`} /></label>
            <label className="text-xs text-slate-500">Πελάτης<select value={grantSel} onChange={(e) => setGrantSel(e.target.value)} className={`mt-1 ${inp} w-64`}><option value="">— επίλεξε ({tenantOpts.length}) —</option>{tenantOpts.slice(0, 50).map((x) => <option key={x.id} value={x.id}>{x.name}{x.afm ? ` · ΑΦΜ ${x.afm}` : ""} · {money(x.msg_balance)}</option>)}</select></label>
            <label className="text-xs text-slate-500">Ποσό αγοράς (€)<input type="number" step="0.01" value={grantAmt} onChange={(e) => setGrantAmt(e.target.value)} placeholder="π.χ. 25" className={`mt-1 ${inp} w-28`} /></label>
            <button onClick={grant} disabled={!grantSel || !grantAmt} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"><Plus className="h-4 w-4" /> Χορήγηση credits</button>
          </div>
        </div>
        <div className={card}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-700">Κατανάλωση ανά φαρμακείο</h3>
            <div className="flex overflow-hidden rounded-lg border border-slate-300 text-xs">
              {[30, 90, 365].map((d) => <button key={d} onClick={() => setUsageDays(d)} className={`px-3 py-1.5 ${usageDays === d ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{d === 365 ? "1 έτος" : `${d} ημ.`}</button>)}
            </div>
          </div>
          {usageQ.isLoading ? <div className="py-8 text-center text-sm text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
            : !usageQ.data?.items.length ? <p className="py-8 text-center text-sm text-slate-400">Καμία κατανάλωση στην περίοδο.</p>
            : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                  <th className="py-2 pr-3">Φαρμακείο</th><th className="px-2 text-right">SMS</th><th className="px-2 text-right">Viber</th><th className="px-2 text-right">Email</th>
                  <th className="px-2 text-right">Κατανάλωση</th><th className="px-2 text-right">Wallet</th><th className="pl-2"></th>
                </tr></thead>
                <tbody>
                  {usageQ.data.items.map((r) => (
                    <tr key={r.tenant_id} className="border-b border-slate-100">
                      <td className="py-2 pr-3 font-medium text-slate-700">{r.name}</td>
                      <td className="px-2 text-right tabular-nums">{r.by_channel.sms?.count ?? 0}</td>
                      <td className="px-2 text-right tabular-nums">{r.by_channel.viber?.count ?? 0}</td>
                      <td className="px-2 text-right tabular-nums">{r.by_channel.email?.count ?? 0}</td>
                      <td className="px-2 text-right font-medium tabular-nums text-slate-700">{money(r.total_spent_cents)}</td>
                      <td className={`px-2 text-right font-semibold tabular-nums ${r.balance_cents <= 0 ? "text-rose-600" : "text-emerald-600"}`}>{money(r.balance_cents)}</td>
                      <td className="pl-2 text-right"><button onClick={() => topUp(r)} className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"><Plus className="h-3 w-3" /> credits</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-slate-400">«Κατανάλωση» = αξία μηνυμάτων που χρεώθηκαν στην περίοδο · «Wallet» = τρέχον υπόλοιπο προπληρωμένων credits.</p>
            </div>
          )}
        </div>
        </div>
      )}

      {/* ── Πορτοφόλι Apifon (δικό μας) ── */}
      {tab === "apifon" && (
        <div className="space-y-4">
          <div className={card}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Wallet className="h-4 w-4 text-indigo-600" /> Το δικό μας υπόλοιπο στην Apifon</h3>
              <button onClick={() => balQ.refetch()} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"><RefreshCw className={`h-3.5 w-3.5 ${balQ.isFetching ? "animate-spin" : ""}`} /> Ανανέωση</button>
            </div>
            {!configured ? <p className="text-sm text-amber-600">Ρύθμισε πρώτα τα credentials Apifon παρακάτω.</p>
              : balQ.isLoading ? <div className="py-4 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
              : balQ.isError ? <p className="text-sm text-rose-600">Αποτυχία ανάγνωσης υπολοίπου Apifon.</p>
              : (
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl bg-emerald-50 p-3"><div className="text-[11px] uppercase text-emerald-600">Διαθέσιμο</div><div className="text-2xl font-extrabold text-emerald-700">€ {balQ.data?.balance ?? "—"}</div></div>
                <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] uppercase text-slate-400">Δεσμευμένο</div><div className="text-lg font-bold text-slate-700">€ {balQ.data?.reserved ?? "—"}</div></div>
                <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] uppercase text-slate-400">Πλαφόν</div><div className="text-lg font-bold text-slate-700">{balQ.data?.plafon ?? "—"}</div></div>
              </div>
            )}
            <p className="mt-3 text-[11px] text-slate-400">Αυτό είναι το υπόλοιπο του ΚΕΝΤΡΙΚΟΥ λογαριασμού μας στην Apifon (SMS/Viber). Όταν πέφτει, γεμίζουμε τον λογαριασμό Apifon — ανεξάρτητο από τα credits των φαρμακείων.</p>
          </div>

          <div className={card}>
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><KeyRound className="h-4 w-4 text-indigo-600" /> Credentials Apifon (κοινά SMS + Viber) {badge(configured)}</h3>
            <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">⚠️ Αυτά είναι το <b>OAuth2 client_id / client_secret</b> από το Apifon panel (API/Applications) — <b>ΟΧΙ</b> το email &amp; password που κάνεις login. Το client_id είναι μεγάλο αλφαριθμητικό (π.χ. vmd6Jy2Dw3…), όχι email.</div>
            {c?.apifon_token_set && <div className="mb-3 text-[11px] text-slate-500">Ενεργά τώρα: client_id …<b>{c.apifon_token_tail}</b> · secret …<b>{c.apifon_secret_tail}</b>{c.updated_at ? ` · αποθηκεύτηκε ${new Date(c.updated_at).toLocaleString("el-GR")}` : ""}</div>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-500">Client ID<input value={cid} onChange={(e) => setCid(e.target.value)} name="rxv-apifon-id" autoComplete="off" spellCheck={false} data-lpignore="true" data-form-type="other" placeholder={c?.apifon_token_set ? `•••• …${c.apifon_token_tail} (αποθηκευμένο)` : "π.χ. vmd6Jy2Dw3FGQOL…"} className={inp} /><span className="mt-0.5 block text-[11px] text-slate-400">OAuth2 client_id — ΟΧΙ email. Κενό = αμετάβλητο.</span></label>
              <label className="text-xs text-slate-500">Client Secret<input type="password" value={csec} onChange={(e) => setCsec(e.target.value)} name="rxv-apifon-secret" autoComplete="new-password" data-lpignore="true" data-form-type="other" placeholder={c?.apifon_secret_set ? `•••• …${c.apifon_secret_tail} (αποθηκευμένο)` : "π.χ. c9Cr55Eyac8…"} className={inp} /><span className="mt-0.5 block text-[11px] text-slate-400">OAuth2 client_secret. Κενό = αμετάβλητο.</span></label>
            </div>
            {saveBtn(() => { saveIntegr.mutate({ apifon_token: cid || null, apifon_secret: csec || null }); setCid(""); setCsec(""); }, saveIntegr.isPending, "Αποθήκευση credentials")}
          </div>
        </div>
      )}
    </div>
  );
}
