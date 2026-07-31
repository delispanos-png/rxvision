"use client";

import { appConfirm } from "@/store/dialogStore";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";
import { Search, X, Users2, Building2, Wallet, type LucideIcon } from "lucide-react";

type Tenant = { id: string; name: string; afm?: string; plan: string; status: string; users: number; active_now?: number; seats?: number; mrr: number; msg_balance?: number; created_at: string };
type Package = { _id: string; name: string; price_monthly: number; price_yearly?: number; modules: string[]; seats: number; trial_days: number; sla?: string; active?: boolean; extra_user_price?: number; extra_user_price_yearly?: number };
type Sla = { _id: string; name?: string; description?: string; active?: boolean; price_monthly?: number; price_yearly?: number };
type AadeResp = { ok: boolean; name?: string; title?: string; doy?: string; address?: string; postal_code?: string; city?: string };

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "Ενεργός", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" },
  trial: { label: "Trial", cls: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300" },
  past_due: { label: "Past-due", cls: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300" },
  suspended: { label: "Σε αναστολή", cls: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300" },
};
const STATUS_FILTERS: [string, string][] = [
  ["all", "Όλες"], ["active", "Ενεργοί"], ["trial", "Trial"], ["past_due", "Past-due"], ["suspended", "Αναστολή"],
];
function Badge({ value }: { value: string }) {
  const m = STATUS_META[value];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m?.cls ?? "bg-slate-100 text-slate-600"}`}>{m?.label ?? value}</span>;
}
function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-700 dark:bg-brand-900/60 dark:text-brand-300">{initials}</span>;
}
function StatChip({ icon: Icon, label, value, accent }: { icon: LucideIcon; label: string; value: string; accent: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${accent}`}><Icon className="h-4 w-4" strokeWidth={2} /></span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
        <div className="truncate text-lg font-bold text-slate-900 dark:text-slate-100">{value}</div>
      </div>
    </div>
  );
}

export default function SubscribersPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [planF, setPlanF] = useState("all");

  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), retry: false });
  const rows = tenants.data?.items ?? [];

  const plans = useMemo(() => Array.from(new Set(rows.map((r) => r.plan).filter(Boolean))).sort(), [rows]);
  const stats = useMemo(() => ({
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    trial: rows.filter((r) => r.status === "trial").length,
    mrr: rows.reduce((s, r) => s + (r.mrr ?? 0), 0),
  }), [rows]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusF !== "all" && r.status !== statusF) return false;
      if (planF !== "all" && r.plan !== planF) return false;
      if (needle && !`${r.name} ${r.afm ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, q, statusF, planF]);

  async function toggleStatus(t: Tenant) {
    const next = t.status === "suspended" ? "active" : "suspended";
    if (!(await appConfirm(`Αλλαγή κατάστασης «${t.name}» σε ${next};`, { title: "Αλλαγή κατάστασης", confirmText: "Αλλαγή" }))) return;
    await adminApi(`/admin/tenants/${t.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) });
    qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
  }

  async function addAfm(t: Tenant) {
    const afm = window.prompt(`ΑΦΜ για «${t.name}» (τα στοιχεία θα συμπληρωθούν αυτόματα από ΑΑΔΕ):`)?.trim();
    if (!afm || afm.length < 9) return;
    await adminApi(`/admin/tenants/${t.id}`, { method: "PATCH", body: JSON.stringify({ afm }) });
    qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
  }

  const columns: Column<Tenant>[] = [
    { key: "name", header: "Tenant", render: (r) => (
      <div className="flex items-center gap-2.5">
        <Avatar name={r.name} />
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-800 dark:text-slate-100">{r.name}</div>
          {r.afm ? <div className="text-[11px] text-slate-400">ΑΦΜ {r.afm}</div>
                 : <button onClick={(e) => { e.stopPropagation(); addAfm(r); }} className="text-[11px] font-semibold text-amber-600 hover:underline">+ Συμπλήρωση ΑΦΜ</button>}
        </div>
      </div>
    ) },
    { key: "plan", header: "Πλάνο", render: (r) => <span className="capitalize text-slate-600 dark:text-slate-300">{r.plan}</span> },
    { key: "status", header: "Κατάσταση", render: (r) => <Badge value={r.status} /> },
    { key: "users", header: "Χρήστες", align: "right", render: (r) => fmtNum(r.users) },
    { key: "active_now", header: "Ενεργοί τώρα", align: "right", render: (r) => (
      <span className={r.active_now ? "font-semibold text-emerald-600" : "text-slate-400"}>
        {r.active_now ? "● " : ""}{r.active_now ?? 0}{r.seats ? ` / ${r.seats}` : ""}
      </span>
    ) },
    { key: "mrr", header: "MRR", align: "right", render: (r) => <span className="font-medium text-slate-800 dark:text-slate-100">{fmtEur(r.mrr)}</span> },
    { key: "msg_balance", header: "Credits", align: "right", render: (r) => <span className={(r.msg_balance ?? 0) < 200 ? "text-amber-600" : "text-slate-700 dark:text-slate-300"}>{fmtEur(r.msg_balance ?? 0)}</span> },
    { key: "created_at", header: "Εγγραφή", render: (r) => fmtDate(r.created_at) },
    {
      key: "actions", header: "", align: "right", fullWidthOnMobile: true,
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={(e) => { e.stopPropagation(); router.push(`/admin/subscribers/${encodeURIComponent(r.id)}`); }}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">Καρτέλα</button>
          <button onClick={(e) => { e.stopPropagation(); toggleStatus(r); }}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">
            {r.status === "suspended" ? "Ενεργοποίηση" : "Αναστολή"}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Συνδρομητές</h1>
          <p className="text-sm text-slate-400">Διαχείριση πελατών & συνδρομών</p>
        </div>
        <button onClick={() => setOpen(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700">
          + Άνοιγμα tenant
        </button>
      </div>

      {/* summary chips */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatChip icon={Building2} label="Σύνολο" value={fmtNum(stats.total)} accent="bg-brand-50 text-brand-600" />
        <StatChip icon={Users2} label="Ενεργοί" value={fmtNum(stats.active)} accent="bg-emerald-50 text-emerald-600" />
        <StatChip icon={Users2} label="Trial" value={fmtNum(stats.trial)} accent="bg-sky-50 text-sky-600" />
        <StatChip icon={Wallet} label="Συνολικό MRR" value={fmtEur(stats.mrr)} accent="bg-violet-50 text-violet-600" />
      </div>

      {/* filter bar */}
      <div className="mb-3 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση με όνομα ή ΑΦΜ…"
            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-8 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" />
          {q && <button onClick={() => setQ("")} aria-label="Καθάρισμα" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map(([v, l]) => (
            <button key={v} onClick={() => setStatusF(v)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${statusF === v ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"}`}>{l}</button>
          ))}
        </div>
        <select value={planF} onChange={(e) => setPlanF(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">
          <option value="all">Όλα τα πλάνα</option>
          {plans.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="mb-2 text-xs text-slate-400">{fmtNum(filtered.length)} από {fmtNum(rows.length)} πελάτες</div>

      {tenants.isLoading ? (
        <div className="text-slate-400">Φόρτωση…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400 dark:border-slate-700">
          Κανένας πελάτης δεν ταιριάζει στα φίλτρα.
        </div>
      ) : (
        <DataTable pageSize={20} columns={columns} rows={filtered} rowKey={(r) => r.id} />
      )}

      {open && <OpenTenantModal onClose={() => setOpen(false)} onDone={() => qc.invalidateQueries({ queryKey: ["admin", "tenants"] })} />}
    </div>
  );
}

const inpc = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none";
const lblc = "mb-1 block text-xs font-medium text-slate-600";

function OpenTenantModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const packages = useQuery({ queryKey: ["admin", "packages"], queryFn: () => adminApi<{ items: Package[] }>("/admin/packages"), retry: false });
  const slaQ = useQuery({ queryKey: ["admin", "sla"], queryFn: () => adminApi<{ items: Sla[] }>("/admin/sla"), retry: false });
  // Only active packages/SLA are offered when opening a new subscription.
  const pkgs = (packages.data?.items ?? []).filter((p) => p.active ?? true);
  const slaTiers = (slaQ.data?.items ?? []).filter((s) => s.active ?? true);

  const [step, setStep] = useState(0);
  const [company, setCompany] = useState({ afm: "", name: "", title: "", doy: "", address: "", postal_code: "", city: "", phone: "", email: "" });
  const [aade, setAade] = useState({ loading: false, msg: "" });
  const [pkgCode, setPkgCode] = useState("");
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");
  const [sla, setSla] = useState("");
  const [seats, setSeats] = useState(1);
  const [owner, setOwner] = useState({ full_name: "", email: "", password: "" });
  const [payMethod, setPayMethod] = useState<"card" | "bank">("card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tenant_id: string; owner_email: string; temp_password: string | null } | null>(null);

  const pkg = pkgs.find((p) => p._id === pkgCode) || pkgs[0];
  // when a package is chosen, prefill its modules + default SLA
  function choosePkg(code: string) {
    setPkgCode(code);
    const p = pkgs.find((x) => x._id === code);
    if (p) { if (p.sla) setSla(p.sla); setSeats(1); }   // ΒΑΣΗ: 1 χρήστης· έξτρα ο admin τους προσθέτει χειροκίνητα
  }
  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
    const rnd = typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(14)) : null;
    let out = ""; for (let i = 0; i < 14; i++) out += chars[(rnd ? rnd[i] : Math.floor(Math.random() * 1e9)) % chars.length];
    setOwner((o) => ({ ...o, password: out }));
  }

  async function lookupAade() {
    const afm = company.afm.trim();
    if (afm.length < 9) { setAade({ loading: false, msg: "Άκυρο ΑΦΜ." }); return; }
    setAade({ loading: true, msg: "" });
    try {
      const r = await adminApi<AadeResp>(`/admin/aade/${afm}`);
      if (r.ok) { setCompany((c) => ({ ...c, name: r.name || c.name, title: r.title || "", doy: r.doy || "", address: r.address || "", postal_code: r.postal_code || "", city: r.city || "" })); setAade({ loading: false, msg: "Συμπληρώθηκε από ΑΑΔΕ ✓" }); }
      else setAade({ loading: false, msg: "Δεν βρέθηκε / η ΑΑΔΕ δεν είναι διαθέσιμη — συμπλήρωσε χειροκίνητα." });
    } catch { setAade({ loading: false, msg: "Σφάλμα σύνδεσης ΑΑΔΕ." }); }
  }

  const step0ok = company.name.trim().length > 1;
  const step1ok = !!(pkg && pkg._id);
  const ownerOk = /.+@.+\..+/.test(owner.email);

  async function activate() {
    if (!pkg) return;
    setBusy(true); setError(null);
    try {
      const r = await adminApi<{ tenant_id: string; owner_email: string; temp_password: string | null }>(
        "/admin/tenants", { method: "POST", body: JSON.stringify({
          name: company.name, owner_email: owner.email, owner_name: owner.full_name || undefined,
          owner_password: owner.password || undefined, package_code: pkg._id,
          billing_cycle: billing, sla: sla || undefined, seats, payment_method: payMethod,
          company: { afm: company.afm, name: company.name, title: company.title, doy: company.doy, address: company.address, postal_code: company.postal_code, city: company.city, phone: company.phone, email: company.email },
        }) });
      setResult(r); onDone();
    } catch (e) {
      setError(e instanceof ApiError && (e.problem as { detail?: string })?.detail === "email_in_use" ? "Το email χρησιμοποιείται ήδη." : "Σφάλμα — δοκιμάστε ξανά.");
    } finally { setBusy(false); }
  }

  const STEPS = ["Στοιχεία Πελάτη", "Προϊόν & Πακέτο", "Τρόπος Πληρωμής", "Λογαριασμός Owner"];
  const slaObj = slaTiers.find((s) => s._id === sla);
  const yearly = billing === "yearly";
  const per = yearly ? "έτος" : "μήνα";
  const basePrice = pkg ? (yearly ? (pkg.price_yearly ?? 0) : pkg.price_monthly) : 0;
  const includedFree = 1;                             // ΒΑΣΗ: 1 δωρεάν ταυτόχρονος χρήστης σε ΚΑΘΕ πλάνο
  const maxSeats = Math.max(1, pkg?.seats ?? 1);      // ΜΕΓΙΣΤΟ όριο πλάνου («έως N»)
  const extraUsers = Math.max(0, seats - includedFree);   // έξτρα πάνω από τη βάση (1) → χρεώσιμα
  const extraRate = (yearly ? pkg?.extra_user_price_yearly : pkg?.extra_user_price) ?? 0;
  const extraTotal = extraUsers * extraRate;
  const slaPrice = (yearly ? slaObj?.price_yearly : slaObj?.price_monthly) ?? 0;
  const price = basePrice + slaPrice + extraTotal;

  return (
    <Modal open onClose={onClose} size="2xl">
      {result ? (
        <div>
          <h2 className="mb-2 text-lg font-bold text-emerald-700">✓ Ο πελάτης ενεργοποιήθηκε</h2>
          <div className="space-y-1 rounded-lg bg-slate-50 p-4 text-sm">
            <div><b>Tenant:</b> {result.tenant_id}</div>
            <div><b>Owner:</b> {result.owner_email}</div>
            {result.temp_password && <div className="text-amber-700"><b>Προσωρινός κωδικός:</b> <code>{result.temp_password}</code></div>}
          </div>
          <button onClick={onClose} className="mt-4 w-full rounded-lg bg-indigo-600 py-2 text-white">Κλείσιμο</button>
        </div>
      ) : (
        <div>
          {/* progress */}
          <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${((step + 1) / 4) * 100}%` }} /></div>
          <div className="mb-4 flex items-center justify-between text-[11px] text-slate-400"><span>Βήμα {step + 1} / 4 · {STEPS[step]}</span></div>

          {step === 0 && (
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <label className="flex-1 text-sm"><span className={lblc}>ΑΦΜ</span>
                  <input value={company.afm} onChange={(e) => setCompany({ ...company, afm: e.target.value })} placeholder="123456789" className={inpc} /></label>
                <button type="button" onClick={lookupAade} disabled={aade.loading} className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">{aade.loading ? "…" : "🔍 ΑΑΔΕ"}</button>
              </div>
              {aade.msg && <p className="text-xs text-slate-500">{aade.msg}</p>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-sm"><span className={lblc}>Επωνυμία *</span><input value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} className={inpc} /></label>
                <label className="text-sm"><span className={lblc}>Διακριτικός τίτλος</span><input value={company.title} onChange={(e) => setCompany({ ...company, title: e.target.value })} className={inpc} /></label>
                <label className="text-sm"><span className={lblc}>ΔΟΥ</span><input value={company.doy} onChange={(e) => setCompany({ ...company, doy: e.target.value })} className={inpc} /></label>
                <label className="text-sm"><span className={lblc}>Τηλέφωνο</span><input value={company.phone} onChange={(e) => setCompany({ ...company, phone: e.target.value })} className={inpc} /></label>
                <label className="text-sm sm:col-span-2"><span className={lblc}>Διεύθυνση</span><input value={company.address} onChange={(e) => setCompany({ ...company, address: e.target.value })} className={inpc} /></label>
                <label className="text-sm"><span className={lblc}>Πόλη</span><input value={company.city} onChange={(e) => setCompany({ ...company, city: e.target.value })} className={inpc} /></label>
                <label className="text-sm"><span className={lblc}>ΤΚ</span><input value={company.postal_code} onChange={(e) => setCompany({ ...company, postal_code: e.target.value })} className={inpc} /></label>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <div className={lblc}>Πακέτο Συνδρομής *</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {pkgs.map((p) => (
                    <button key={p._id} type="button" onClick={() => choosePkg(p._id)} className={`rounded-xl border-2 p-3 text-left ${(pkg?._id === p._id) ? "border-indigo-400 bg-indigo-50/50" : "border-slate-200"}`}>
                      <div className="font-semibold text-slate-900">{p.name}</div>
                      <div className="text-sm text-indigo-700">{p.price_monthly ? fmtEur(p.price_monthly) + "/μήνα" : "δωρεάν"}{p.trial_days ? ` · trial ${p.trial_days}ημ` : ""}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className={lblc}>Κύκλος Τιμολόγησης</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["monthly", "yearly"] as const).map((bc) => (
                    <button key={bc} type="button" onClick={() => setBilling(bc)} className={`rounded-xl border-2 p-2.5 text-sm ${billing === bc ? "border-indigo-400 bg-indigo-50/50" : "border-slate-200"}`}>{bc === "monthly" ? "Μηνιαία" : "Ετήσια"}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className={lblc}>SLA / Υποστήριξη</div>
                <select value={sla} onChange={(e) => setSla(e.target.value)} className={inpc}>
                  <option value="">— από το πακέτο —</option>
                  {slaTiers.map((s) => <option key={s._id} value={s._id}>{s.name || s._id}{s.description ? ` — ${s.description}` : ""}</option>)}
                </select>
              </div>
              <div>
                <div className={lblc}>Ταυτόχρονοι χρήστες</div>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => setSeats((n) => Math.max(1, n - 1))} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 text-lg text-slate-600 hover:bg-slate-50">−</button>
                  <input type="number" min={1} max={maxSeats} value={seats} onChange={(e) => setSeats(Math.min(maxSeats, Math.max(1, parseInt(e.target.value) || 1)))} className={`${inpc} w-20 text-center`} />
                  <button type="button" disabled={seats >= maxSeats} onClick={() => setSeats((n) => Math.min(maxSeats, n + 1))} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 text-lg text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">+</button>
                  <span className="text-xs text-slate-400">{extraUsers > 0 ? `1 βάση + ${extraUsers} έξτρα (έως ${maxSeats})` : `1 χρήστης (έως ${maxSeats} στο πακέτο)`}</span>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-2 text-xs font-semibold text-slate-500">Ανάλυση κόστους ({yearly ? "ετήσια" : "μηνιαία"})</div>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><dt className="text-slate-600">{pkg?.name || "Πακέτο"}</dt><dd className="font-medium text-slate-800">{fmtEur(basePrice)}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-600">SLA{slaObj?.name ? ` · ${slaObj.name}` : ""}</dt><dd className="font-medium text-slate-800">{slaPrice ? fmtEur(slaPrice) : "—"}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-600">Έξτρα χρήστες {extraUsers > 0 ? `(${extraUsers} × ${fmtEur(extraRate)})` : ""}</dt><dd className="font-medium text-slate-800">{extraTotal ? fmtEur(extraTotal) : "—"}</dd></div>
                  <div className="mt-1 flex justify-between border-t border-slate-200 pt-2 text-base"><dt className="font-semibold text-slate-900">Σύνολο</dt><dd className="font-bold text-indigo-700">{fmtEur(price)}<span className="text-xs font-normal text-slate-400">/{per}</span></dd></div>
                </dl>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className={lblc}>Τρόπος πληρωμής του πελάτη</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => setPayMethod("card")} className={`rounded-xl border-2 p-3 text-left ${payMethod === "card" ? "border-indigo-400 bg-indigo-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                  <div className="flex items-center gap-2 font-semibold text-slate-900">💳 Κάρτα {payMethod === "card" && <span className="ml-auto text-indigo-600">✓</span>}</div>
                  <div className="mt-1 text-xs text-slate-500">Ασφαλής αποθήκευση κάρτας (ενεργός πάροχος: Viva/Revolut)· αυτόματη χρέωση στη λήξη της δοκιμής.</div>
                </button>
                <button type="button" onClick={() => setPayMethod("bank")} className={`rounded-xl border-2 p-3 text-left ${payMethod === "bank" ? "border-indigo-400 bg-indigo-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                  <div className="flex items-center gap-2 font-semibold text-slate-900">🏦 Τραπεζικό έμβασμα {payMethod === "bank" && <span className="ml-auto text-indigo-600">✓</span>}</div>
                  <div className="mt-1 text-xs text-slate-500">Τιμολόγιο με IBAN στο email τιμολόγησης πριν τη λήξη της δοκιμής.</div>
                </button>
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{company.name} · {pkg?.name} · {yearly ? "ετήσια" : "μηνιαία"} · {seats} χρήστες · <b>{fmtEur(price)}/{per}</b> · SLA: {slaObj?.name || sla || pkg?.sla || "—"}</div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="rounded-xl bg-indigo-50 p-3 text-xs text-indigo-800">Στοιχεία σύνδεσης (owner) του πελάτη — με αυτά θα μπαίνει στην πλατφόρμα.</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-sm"><span className={lblc}>Ονοματεπώνυμο owner</span><input value={owner.full_name} onChange={(e) => setOwner({ ...owner, full_name: e.target.value })} className={inpc} /></label>
                <label className="text-sm"><span className={lblc}>Email / username *</span><input type="email" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} className={inpc} /></label>
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 flex items-center justify-between"><span className={lblc}>Κωδικός (κενό = αυτόματος προσωρινός)</span><button type="button" onClick={genPassword} className="text-[11px] font-medium text-indigo-600 hover:underline">Αυτόματη δημιουργία</button></span>
                  <input value={owner.password} onChange={(e) => setOwner({ ...owner, password: e.target.value })} className={inpc} />
                </label>
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{company.name} · {pkg?.name} · {yearly ? "ετήσια" : "μηνιαία"} · {seats} χρήστες · <b>{fmtEur(price)}/{per}</b> · SLA: {slaObj?.name || sla || pkg?.sla || "—"} · Πληρωμή: {payMethod === "card" ? "κάρτα" : "τράπεζα"}</div>
              {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            </div>
          )}

          {/* nav */}
          <div className="mt-5 flex items-center justify-between">
            <button type="button" onClick={() => step === 0 ? onClose() : setStep((s) => s - 1)} className="text-sm text-slate-500 hover:text-slate-700">{step === 0 ? "Άκυρο" : "← Προηγούμενο"}</button>
            {step < 3 ? (
              <button type="button" disabled={(step === 0 && !step0ok) || (step === 1 && !step1ok)} onClick={() => { if (step === 1 && !pkgCode && pkg) choosePkg(pkg._id); setStep((s) => s + 1); }} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Επόμενο →</button>
            ) : (
              <button type="button" disabled={!ownerOk || busy} onClick={activate} className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? "Ενεργοποίηση…" : "✓ Ενεργοποίηση Πελάτη"}</button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
