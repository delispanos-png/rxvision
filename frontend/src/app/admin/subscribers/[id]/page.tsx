"use client";

import { appConfirm } from "@/store/dialogStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type User = { external_user_id: string; email: string; first_name: string; last_name: string; role: string; is_active: boolean; last_login_at: string | null };
type Detail = {
  tenant: { id: string; name: string; status: string; country: string; opened_via: string; external_ref: string; created_at: string; contact_email?: string; contact_phone?: string; company?: { name?: string; legal_name?: string; tax_id?: string; tax_office?: string; address?: string; city?: string; postal_code?: string }; store?: { name?: string; code?: string }; demo?: boolean };
  subscription: { plan: string; plan_name: string; status: string; product_code: string; features: Record<string, unknown>; limits: Record<string, unknown>; billing_cycle: string; seats: number; mrr: number; trial_ends_at: string | null; current_period_end: string | null; source: string };
  modules?: Record<string, "enabled" | "trial" | "locked">;
  users: User[];
  active_now?: number;
  sync: { source: string; status: string; started_at: string; stats: Record<string, number> }[];
};

const MODULE_LABELS: [string, string][] = [
  ["dashboard", "Πίνακας Ελέγχου"],
  ["prescription_analytics", "Συνταγές"],
  ["doctor_analytics", "Ιατροί"],
  ["patient_analytics", "Ασθενείς / Patient Intelligence"],
  ["icd10_analytics", "ICD-10"],
  ["profitability", "Κερδοφορία"],
  ["future_prescriptions", "Μελλοντικές συνταγές"],
  ["order_suggestions", "Σύμβουλος Παραγγελιών"],
  ["monthly_closing", "Αποζημίωση / Κλείσιμο"],
  ["pharmacyone", "PharmacyOne"],
  ["ai_assistant", "✨ AI Βοηθός (Prescriptor/PharmaCat/Copilot)"],
  ["pharmacat", "🤖 PharmaCat (κλινικός βοηθός)"],
  ["patient_portal", "👥 Πύλη Πελατών (ραντεβού/διαθεσιμότητα)"],
  ["loyalty", "🎁 Πιστότητα (επιβράβευση πελατών)"],
  ["order_delivery", "🚚 Παραγγελίες & Αποστολή (κατάλογος + κύκλωμα)"],
];
type Creds = {
  users: User[];
  hdika: { configured: boolean; username: string | null; pharmacy_id: string | null; pharmacy_name: string | null; environment: string | null; base_url: string | null; has_password: boolean; has_api_key: boolean };
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700", trial: "bg-sky-100 text-sky-700",
  past_due: "bg-red-100 text-red-700", suspended: "bg-slate-200 text-slate-600", cancelled: "bg-red-100 text-red-700",
};
const SYNC_STAT_LABELS: Record<string, string> = {
  fetched: "ελήφθησαν", inserted: "νέες", updated: "ενημερώσεις",
  duplicates: "αμετάβλητες", invalid: "άκυρες", cancelled: "ακυρώσεις", deleted: "διαγραφές",
};

function SyncStats({ stats }: { stats: Record<string, number> }) {
  const entries = Object.entries(stats || {});
  if (!entries.length) return <span className="text-xs text-slate-300">—</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <span key={k} className={`rounded-full px-1.5 py-0.5 text-[11px] ${v > 0 ? "bg-slate-100 text-slate-600" : "text-slate-300"}`}>
          <b>{fmtNum(v)}</b> {SYNC_STAT_LABELS[k] ?? k}
        </span>
      ))}
    </span>
  );
}

function Badge({ value }: { value: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-600"}`}>{value}</span>;
}

const userColumns: Column<User>[] = [
  { key: "email", header: "Email" },
  { key: "name", header: "Όνομα", render: (r) => `${r.first_name} ${r.last_name}`.trim() || "—" },
  { key: "role", header: "Ρόλος" },
  { key: "is_active", header: "Ενεργός", render: (r) => (r.is_active ? "✓" : "—") },
  { key: "last_login_at", header: "Τελ. login", render: (r) => (r.last_login_at ? fmtDate(r.last_login_at) : "—") },
];

export default function TenantCardPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentCreds, setSentCreds] = useState<{ email: string; temp_password: string; emailed: boolean } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["admin", "tenant", id], queryFn: () => adminApi<Detail>(`/admin/tenants/${encodeURIComponent(id)}`), retry: false });
  const creds = useQuery({ queryKey: ["admin", "tenant", id, "creds"], queryFn: () => adminApi<Creds>(`/admin/tenants/${encodeURIComponent(id)}/credentials`), retry: false });
  const pkgsQ = useQuery({ queryKey: ["admin", "packages"], queryFn: () => adminApi<{ items: { _id: string; name?: string }[] }>("/admin/packages") });
  useEffect(() => { if (data?.tenant?.name) setName(data.tenant.name); }, [data]);

  async function impersonate() {
    setBusy(true); setNotice(null);
    try {
      const r = await adminApi<{ access_token: string; refresh_token: string; app_url: string; as_email: string }>(
        `/admin/tenants/${encodeURIComponent(id)}/impersonate`, { method: "POST" });
      const url = `${r.app_url}/login#imp=${encodeURIComponent(`${r.access_token}~${r.refresh_token}`)}`;
      window.open(url, "_blank", "noopener");
      setNotice(`Άνοιξε νέα καρτέλα συνδεδεμένη ως ${r.as_email}.`);
    } catch { setNotice("Σφάλμα — η ενέργεια απέτυχε. Δοκιμάστε ξανά."); }
    finally { setBusy(false); }
  }

  async function sendCreds(email: string) {
    if (!(await appConfirm(`Δημιουργία ΝΕΟΥ προσωρινού κωδικού για ${email} και αποστολή στον πελάτη;\n(Ο προηγούμενος κωδικός παύει να ισχύει.)`, { title: "Νέος κωδικός πελάτη", confirmText: "Δημιουργία & αποστολή" }))) return;
    setBusy(true); setNotice(null); setSentCreds(null);
    try {
      const r = await adminApi<{ email: string; temp_password: string; emailed: boolean }>(
        `/admin/tenants/${encodeURIComponent(id)}/users/send-credentials`,
        { method: "POST", body: JSON.stringify({ email }) });
      setSentCreds(r);
      setNotice(r.emailed ? `Στάλθηκε email στον ${email}.`
        : `Δημιουργήθηκε κωδικός — το email ΔΕΝ στάλθηκε (έλεγξε SMTP). Δώσ' τον χειροκίνητα.`);
    } catch { setNotice("Σφάλμα — η ενέργεια απέτυχε. Δοκιμάστε ξανά."); }
    finally { setBusy(false); }
  }

  const refresh = () => { qc.invalidateQueries({ queryKey: ["admin", "tenant", id] }); qc.invalidateQueries({ queryKey: ["admin", "tenants"] }); };
  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setNotice(null);
    try { await fn(); setNotice(ok); refresh(); }
    catch { setNotice("Σφάλμα — η ενέργεια απέτυχε. Δοκιμάστε ξανά."); }
    finally { setBusy(false); }
  }
  async function assignPackage(code: string) {
    if (!code) return;
    if (!(await appConfirm(`Ένταξη του πελάτη στο πακέτο «${code}»; Οι δυνατότητες θα προσαρμοστούν ΑΚΡΙΒΩΣ στο πακέτο (τιμή, θέσεις, κύκλος, SLA) — κρατώντας μόνο τα add-ons που έχει αγοράσει.`, { title: "Αλλαγή πακέτου", confirmText: "Εφαρμογή πακέτου" }))) return;
    act(() => adminApi(`/admin/tenants/${encodeURIComponent(id)}/package`, { method: "POST", body: JSON.stringify({ package_code: code }) }), "Το πακέτο εφαρμόστηκε ✓ (ισχύει στο επόμενο login του πελάτη)");
  }

  if (isLoading || !data) return <div className="text-slate-400">Φόρτωση…</div>;
  const t = data.tenant, s = data.subscription;

  return (
    <div className="max-w-4xl">
      <Link href="/admin/subscribers" className="mb-4 inline-block text-sm text-indigo-700 hover:underline">← Πίσω στους συνδρομητές</Link>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">{t.name}</h1>
        <Badge value={t.status} />
      </div>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Πλάνο" value={s.plan_name || s.plan?.split("-").pop() || "—"} />
        <KpiCard label="Κατάσταση συνδρομής" value={s.status ?? "—"} />
        <KpiCard label="MRR" value={fmtEur(s.mrr)} accent="violet" />
        <KpiCard label="Χρήστες" value={`${data.active_now ?? 0} / ${fmtNum(data.users.length)}`} sub={`${data.active_now ?? 0} ενεργοί τώρα · ${s.seats ?? "—"} θέσεις`} accent="sky" />
      </div>

      {/* Edit + στοιχεία */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-3 text-sm font-semibold text-slate-700">Στοιχεία πελάτη</div>
        <label className="mb-3 block max-w-md text-sm"><span className="mb-1 block text-slate-600">Επωνυμία</span>
          <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button disabled={busy || name === t.name} onClick={() => act(() => adminApi(`/admin/tenants/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }), "Αποθηκεύτηκε ✓")}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Αποθήκευση</button>
        <label className="mt-4 flex max-w-md items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
          <input type="checkbox" disabled={busy} checked={!!t.demo}
            onChange={(e) => { const v = e.target.checked; act(() => adminApi(`/admin/tenants/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ demo: v }) }), v ? "Λειτουργία παρουσίασης ΟΝ ✓" : "Λειτουργία παρουσίασης OFF ✓"); }}
            className="mt-0.5 rounded border-slate-300 text-amber-600 focus:ring-amber-400" />
          <span>
            <span className="font-medium text-slate-800">Πελάτης παρουσίασης</span>
            <span className="mt-0.5 block text-xs text-slate-500">Κρύβει ευαίσθητα στοιχεία ασθενών (επίθετο, μέρος ΑΜΚΑ, τηλέφωνο/email) σε όλη την εφαρμογή — για επιδείξεις χωρίς έκθεση πραγματικών δεδομένων (GDPR). Ισχύει στο επόμενο login του χρήστη.</span>
          </span>
        </label>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-600 md:grid-cols-3">
          <div>Tenant id: <code className="text-xs">{t.id}</code></div>
          <div>Προέλευση: {t.opened_via ?? "—"}</div>
          <div>Προϊόν: {s.product_code ?? "—"}</div>
          <div>Λήξη: {s.current_period_end ? fmtDate(s.current_period_end) : "—"}</div>
          <div>Χρέωση: {s.billing_cycle ?? "—"}</div>
          <div>Εγγραφή: {fmtDate(t.created_at)}</div>
        </div>
      </div>

      {/* Δυνατότητες / Modules — enable per pharmacist; locked ⇒ hidden from their panel */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-1 text-sm font-semibold text-slate-700">Δυνατότητες (ανά φαρμακείο)</div>
        {/* package assignment → tenant inherits the package's capabilities */}
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50/60 p-3">
          <span className="text-sm font-medium text-slate-700">📦 Πακέτο πελάτη:</span>
          <select value={s.plan ?? ""} disabled={busy} onChange={(e) => assignPackage(e.target.value)} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none">
            <option value="">— επίλεξε πακέτο —</option>
            {(pkgsQ.data?.items ?? []).map((p) => <option key={p._id} value={p._id}>{p.name || p._id}</option>)}
          </select>
          <span className="text-xs text-slate-500">Με την επιλογή πακέτου, τα παρακάτω προσαρμόζονται στο πακέτο. Μετά μπορείς να κάνεις μεμονωμένες εξαιρέσεις.</span>
        </div>
        <p className="mb-3 text-xs text-slate-400">Ό,τι είναι κλειστό δεν εμφανίζεται καθόλου στο πάνελ του φαρμακοποιού. Οι αλλαγές ισχύουν μετά την επόμενη σύνδεσή του.</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MODULE_LABELS.map(([key, label]) => {
            const on = data.modules?.[key] === "enabled" || data.modules?.[key] === "trial";
            return (
              <label key={key} className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                <span className="text-slate-700">{label}</span>
                <input type="checkbox" checked={on} disabled={busy}
                  onChange={(e) => { const v = e.target.checked; act(() => adminApi(`/admin/tenants/${encodeURIComponent(id)}/modules`, { method: "PUT", body: JSON.stringify({ modules: { [key]: v ? "enabled" : "locked" } }) }), v ? "Ενεργοποιήθηκε ✓" : "Απενεργοποιήθηκε ✓"); }}
                  className="h-4 w-4 accent-indigo-600" />
              </label>
            );
          })}
        </div>
      </div>

      {/* Στοιχεία Τιμολόγησης */}
      {t.company && t.company.tax_id && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
          <div className="mb-3 text-sm font-semibold text-slate-700">Στοιχεία Τιμολόγησης</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-slate-600 md:grid-cols-3">
            <div><span className="text-slate-400">ΑΦΜ:</span> <code className="font-mono text-xs">{t.company.tax_id}</code></div>
            <div><span className="text-slate-400">ΔΟΥ:</span> {t.company.tax_office || "—"}</div>
            <div><span className="text-slate-400">Νομ. Επωνυμία:</span> {t.company.legal_name || "—"}</div>
            {t.company.address && <div><span className="text-slate-400">Διεύθυνση:</span> {t.company.address}</div>}
            {t.company.city && <div><span className="text-slate-400">Πόλη:</span> {t.company.city} {t.company.postal_code || ""}</div>}
          </div>
          {(t.contact_email || t.contact_phone) && (
            <div className="mt-3 grid grid-cols-2 gap-x-6 text-sm text-slate-600 md:grid-cols-3">
              {t.contact_email && <div><span className="text-slate-400">Email:</span> {t.contact_email}</div>}
              {t.contact_phone && <div><span className="text-slate-400">Τηλ:</span> {t.contact_phone}</div>}
            </div>
          )}
        </div>
      )}

      {/* Χρήστες */}
      <h2 className="mb-3 text-sm font-semibold text-slate-700">Χρήστες</h2>
      <div className="mb-6"><DataTable pageSize={20} columns={userColumns} rows={data.users} rowKey={(r) => r.external_user_id} empty="Κανένας χρήστης." /></div>

      {/* Sync */}
      {data.sync.length > 0 && (
        <>
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Πρόσφατα sync</h2>
          <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 text-sm">
            {data.sync.map((j, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-slate-100 py-2 last:border-0">
                <span className="w-16 font-medium">{j.source}</span><Badge value={j.status} />
                <span className="shrink-0 text-slate-400">{fmtDate(j.started_at)}</span>
                <SyncStats stats={j.stats} />
              </div>
            ))}
          </div>
        </>
      )}

      {/* Credentials & πρόσβαση */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-1 text-sm font-semibold text-slate-700">Credentials & πρόσβαση</div>
        <p className="mb-3 text-xs text-slate-500">Σύνδεση ως πελάτης (για υποστήριξη) — δεν δεσμεύει άδεια, δεν χρειάζεται κωδικός.</p>
        <button onClick={impersonate} disabled={busy}
          className="mb-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          🔑 Σύνδεση ως πελάτης
        </button>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="mb-1 font-medium text-slate-700">Λογαριασμοί σύνδεσης</div>
            {(creds.data?.users ?? data.users).map((u) => (
              <div key={u.external_user_id} className="flex items-center justify-between gap-2 py-0.5">
                <div className="text-slate-600">{u.email} <span className="text-xs text-slate-400">({u.role})</span></div>
                <Tooltip label="Δημιουργία & αποστολή νέου προσωρινού κωδικού"><button disabled={busy} onClick={() => sendCreds(u.email)}
                  className="shrink-0 rounded-md border border-brand-300 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-40">
                  Νέος κωδικός
                </button></Tooltip>
              </div>
            ))}
            {sentCreds && (
              <div className="mt-2 rounded-md bg-emerald-50 p-2 text-xs text-emerald-800">
                Νέος κωδικός για <b>{sentCreds.email}</b>:{" "}
                <code className="select-all rounded bg-white px-1 py-0.5 font-mono text-emerald-900">{sentCreds.temp_password}</code>
                <div className="mt-0.5 text-emerald-700">
                  {sentCreds.emailed ? "Στάλθηκε στο email του πελάτη." : "⚠ Δεν στάλθηκε email (SMTP) — δώσ' τον χειροκίνητα."} Εμφανίζεται μία φορά.
                </div>
              </div>
            )}
          </div>
          <div className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="mb-1 font-medium text-slate-700">Διασύνδεση ΗΔΥΚΑ</div>
            {creds.data?.hdika?.configured ? (
              <div className="space-y-0.5 text-slate-600">
                <div>Χρήστης: <code className="text-xs">{creds.data.hdika.username ?? "—"}</code></div>
                <div>Φαρμακείο: {creds.data.hdika.pharmacy_name ?? "—"} {creds.data.hdika.pharmacy_id ? `(#${creds.data.hdika.pharmacy_id})` : ""}</div>
                <div>Περιβάλλον: {creds.data.hdika.environment ?? "—"}</div>
                <div className="text-xs text-slate-400">Κωδικός: {creds.data.hdika.has_password ? "✓ ορισμένος" : "—"} · API key: {creds.data.hdika.has_api_key ? "✓" : "—"}</div>
              </div>
            ) : <div className="text-slate-400">Δεν έχει ρυθμιστεί.</div>}
          </div>
        </div>
      </div>

      {/* Ενέργειες */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-3 text-sm font-semibold text-slate-700">Ενέργειες</div>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => act(() => adminApi(`/admin/tenants/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status: t.status === "suspended" ? "active" : "suspended" }) }), "Έγινε ✓")}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">{t.status === "suspended" ? "Ενεργοποίηση" : "Αναστολή"}</button>
          <button disabled={busy || s.status === "cancelled"} onClick={async () => { if (await appConfirm("Ακύρωση συνδρομής; Ο πελάτης δεν θα μπορεί να μπει.", { title: "Ακύρωση συνδρομής", danger: true, confirmText: "Ακύρωση συνδρομής" })) act(() => adminApi(`/admin/tenants/${encodeURIComponent(id)}/cancel`, { method: "POST" }), "Συνδρομή ακυρώθηκε."); }}
            className="rounded-lg border border-amber-300 px-4 py-2 text-sm text-amber-700 hover:bg-amber-50 disabled:opacity-50">Ακύρωση συνδρομής</button>
          <button disabled={busy} onClick={async () => { if (await appConfirm(`ΟΡΙΣΤΙΚΗ ΔΙΑΓΡΑΦΗ του «${t.name}» και ΟΛΩΝ των δεδομένων του. Δεν αναιρείται. Συνέχεια;`, { title: "Οριστική διαγραφή πελάτη", danger: true, confirmText: "Διαγραφή πελάτη" })) act(async () => { await adminApi(`/admin/tenants/${encodeURIComponent(id)}`, { method: "DELETE" }); router.push("/admin/subscribers"); }, "Διαγράφηκε."); }}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50">Διαγραφή πελάτη</button>
        </div>
      </div>
    </div>
  );
}
