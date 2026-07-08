"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { LineChart } from "@/components/charts/LineChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { BarChart } from "@/components/charts/BarChart";
import {
  Building2, TrendingUp, UserPlus, FileText, Receipt, Activity, Users, Syringe,
  Smartphone, CalendarClock, ShoppingCart, RefreshCw, AlertTriangle, HardDrive,
  Server, Sparkles, Mail, Boxes, ShieldCheck,
} from "lucide-react";

type SyncHealth = { id: string; tenant: string; source: string; last_run: string; status: string; errors: number;
  last_fetched?: number; last_inserted?: number; last_data_at?: string | null; data_age_hours?: number | null; silent_failure?: boolean };
type SyncHealthResp = { items: SyncHealth[]; vault: { healthy: boolean }; ingest: { last_data_at: string | null; stale_hours: number | null }; alert: boolean };
type Overview = {
  business: { tenants: number; active: number; trial: number; past_due: number; suspended: number;
    mrr: number; arr: number; new_tenants_month: number; plans: { plan: string; n: number }[];
    invoices_month: number; invoices_untransmitted: number };
  volume: { executions_total: number; executions_month: number; executions_today: number; items_total: number;
    patients_total: number; vaccinations_total: number; vaccinations_month: number };
  usage: { users: number; sessions_now: number; portal_accounts: number; appointments: number; orders: number;
    modules: { module: string; n: number }[] };
  ops: { sync_today: { success: number; failed: number; partial: number; running: number }; sync_errors_today: number;
    alerts_7d: number; backup: { last_at?: string; age_h?: number | null; ok?: boolean; offsite?: boolean };
    nodes_total: number; nodes_fresh: number; llm_calls_today: number; llm_cost_today: number;
    messages_today: number; wallet_total: number };
  charts: { exec_trend: { day: string; n: number }[]; top_tenants: { tenant: string; n: number }[] };
  generated_at?: string;
};

const MODULE_LABELS: Record<string, string> = {
  loyalty: "Πιστότητα", pharmacyone: "PharmacyOne", ai_assistant: "AI Assistant",
  order_delivery: "Παραγγελίες", profitability: "Κερδοφορία", reimbursement: "Αποζημίωση ΕΟΠΥΥ",
  patient_portal: "Portal Ασθενών", pharmacat: "PharmaCat", intelligence: "Patient Intelligence",
  vaccinations: "Εμβολιασμοί", copilot: "Copilot",
};

const STATUS_STYLE: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700", failed: "bg-red-100 text-red-700", partial: "bg-amber-100 text-amber-700",
};
function Badge({ value }: { value: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-600"}`}>{value}</span>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">{children}</div>
    </div>
  );
}

const syncColumns: Column<SyncHealth>[] = [
  { key: "tenant", header: "Tenant" },
  { key: "source", header: "Πηγή" },
  { key: "last_run", header: "Τελευταία εκτέλεση", render: (r) => fmtDate(r.last_run) },
  { key: "status", header: "Κατάσταση", render: (r) => (
      r.silent_failure
        ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">⚠ σιωπηλή (0 δεδομένα)</span>
        : <Badge value={r.status} />
    ) },
  { key: "last_fetched", header: "Έφερε", align: "right", render: (r) => fmtNum(r.last_fetched ?? 0) },
  { key: "data_age_hours", header: "Δεδομένα πριν", align: "right", render: (r) => (
      r.data_age_hours == null ? "—" : <span className={r.data_age_hours > 6 ? "font-semibold text-amber-600" : "text-slate-500"}>{r.data_age_hours}h</span>
    ) },
  { key: "errors", header: "Σφάλματα", align: "right", render: (r) => <span className={r.errors > 0 ? "font-semibold text-red-600" : ""}>{fmtNum(r.errors)}</span> },
];

export default function AdminDashboardPage() {
  const ov = useQuery({ queryKey: ["admin", "overview"], queryFn: () => adminApi<Overview>("/admin/overview"), retry: false, refetchInterval: 30000 });
  const sync = useQuery({ queryKey: ["admin", "sync-health"], queryFn: () => adminApi<SyncHealthResp>("/admin/sync-health"), retry: false, refetchInterval: 60000 });

  const b = ov.data?.business, v = ov.data?.volume, u = ov.data?.usage, o = ov.data?.ops;
  const dash = (n?: number) => (n === undefined ? "…" : fmtNum(n));

  return (
    <div>
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Πίνακας</h1>
        {ov.data?.generated_at && <span className="text-xs text-slate-400">ενημ. {fmtDate(ov.data.generated_at)} · auto 30s</span>}
      </div>

      {/* 1 — Επιχείρηση & Έσοδα */}
      <Section title="Επιχείρηση & Έσοδα">
        <KpiCard label="Tenants" value={dash(b?.tenants)} icon={Building2} accent="indigo"
          sub={b ? `ενεργοί ${b.active} · trial ${b.trial} · past-due ${b.past_due}` : undefined} />
        <KpiCard label="Συνολικό MRR" value={b ? fmtEur(b.mrr) : "…"} icon={TrendingUp} accent="violet"
          sub={b ? `ARR ${fmtEur(b.arr)}` : undefined} help="Μηνιαίο επαναλαμβανόμενο έσοδο από όλες τις ενεργές συνδρομές." />
        <KpiCard label="Νέες εγγραφές (μήνα)" value={dash(b?.new_tenants_month)} icon={UserPlus} accent="green" />
        <KpiCard label="Τιμολόγια (μήνα)" value={dash(b?.invoices_month)} icon={FileText} accent="sky"
          sub={b ? `${b.invoices_untransmitted} μη διαβιβασμένα` : undefined} />
      </Section>

      {/* 2 — Όγκος & Δραστηριότητα */}
      <Section title="Όγκος & Δραστηριότητα">
        <KpiCard label="Συνταγές (σύνολο)" value={dash(v?.executions_total)} icon={Receipt} accent="indigo"
          sub={v ? `μήνα ${fmtNum(v.executions_month)}` : undefined} />
        <KpiCard label="Συνταγές σήμερα" value={dash(v?.executions_today)} icon={Activity} accent="green"
          help="Εκτελέσεις συνταγών που καταχωρήθηκαν σήμερα σε όλη την πλατφόρμα." />
        <KpiCard label="Ασθενείς" value={dash(v?.patients_total)} icon={Users} accent="sky" />
        <KpiCard label="Εμβόλια" value={dash(v?.vaccinations_total)} icon={Syringe} accent="violet"
          sub={v ? `μήνα ${fmtNum(v.vaccinations_month)}` : undefined} />
      </Section>

      {/* 3 — Χρήση & Modules */}
      <Section title="Χρήση & Υιοθέτηση">
        <KpiCard label="Χρήστες" value={dash(u?.users)} icon={Users} accent="indigo"
          sub={u ? `ενεργές συνεδρίες: ${u.sessions_now}` : undefined} help="Λογαριασμοί προσωπικού· «ενεργές συνεδρίες» = ταυτόχρονες συνδέσεις τώρα (= seats)." />
        <KpiCard label="Portal ασθενών" value={dash(u?.portal_accounts)} icon={Smartphone} accent="green" />
        <KpiCard label="Ραντεβού" value={dash(u?.appointments)} icon={CalendarClock} accent="sky" />
        <KpiCard label="Παραγγελίες" value={dash(u?.orders)} icon={ShoppingCart} accent="amber" />
      </Section>
      {u && u.modules.length > 0 && (
        <div className="rx-card mb-8 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300"><Boxes className="h-4 w-4" /> Υιοθέτηση modules (πόσα φαρμακεία το έχουν ενεργό)</div>
          <div className="flex flex-wrap gap-2">
            {u.modules.map((m) => (
              <span key={m.module} className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {MODULE_LABELS[m.module] ?? m.module} <b className="text-brand-600 dark:text-brand-400">{m.n}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 4 — Λειτουργία, AI & Comms */}
      <Section title="Λειτουργία, AI & Επικοινωνία">
        <KpiCard label="Sync σήμερα" value={o ? `${o.sync_today.success} ok` : "…"} icon={RefreshCw}
          accent={o && o.sync_today.failed > 0 ? "rose" : "green"}
          sub={o ? `fail ${o.sync_today.failed} · ${o.sync_errors_today} σφάλματα` : undefined} />
        <KpiCard label="Ειδοποιήσεις (7ημ)" value={dash(o?.alerts_7d)} icon={AlertTriangle}
          accent={o && o.alerts_7d > 0 ? "rose" : "amber"} help="Ειδοποιήσεις ingestion (π.χ. cross-tenant barcode) των τελευταίων 7 ημερών." />
        <KpiCard label="Backup" value={o?.backup.age_h != null ? `${o.backup.age_h}h` : (o ? "—" : "…")} icon={HardDrive}
          accent={o && o.backup.ok ? "green" : "rose"}
          sub={o ? `${o.backup.ok ? "✓ επιτυχές" : "✗ πρόβλημα"} · ${o.backup.offsite ? "offsite" : "τοπικό"}` : undefined} />
        <KpiCard label="Servers" value={o ? `${o.nodes_fresh}/${o.nodes_total}` : "…"} icon={Server}
          accent={o && o.nodes_fresh === o.nodes_total ? "green" : "rose"} sub="ζωντανά (live metrics)" />
        <KpiCard label="AI κλήσεις σήμερα" value={dash(o?.llm_calls_today)} icon={Sparkles} accent="violet"
          sub={o ? `κόστος ${fmtEur(o.llm_cost_today)}` : undefined} help="PharmaCat / Copilot / Autoscription — κλήσεις & κόστος σήμερα." />
        <KpiCard label="Μηνύματα σήμερα" value={dash(o?.messages_today)} icon={Mail} accent="sky"
          sub={o ? `wallet ${fmtEur(o.wallet_total)}` : undefined} help="Email/SMS/Viber που στάλθηκαν σήμερα + συνολικό υπόλοιπο credit wallets." />
      </Section>

      {/* Γραφήματα */}
      {ov.data && (
        <div className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Γραφήματα</h2>
          <div className="rx-card mb-4 p-5">
            <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Συνταγές / ημέρα (14 ημέρες)</div>
            <LineChart
              labels={ov.data.charts.exec_trend.map((d) => `${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`)}
              data={ov.data.charts.exec_trend.map((d) => d.n)}
              name="Συνταγές" height={240} area />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rx-card p-5">
              <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Tenants ανά κατάσταση</div>
              <DonutChart height={240} data={[
                { name: "Ενεργοί", value: ov.data.business.active },
                { name: "Trial", value: ov.data.business.trial },
                { name: "Past-due", value: ov.data.business.past_due },
                { name: "Suspended", value: ov.data.business.suspended },
              ].filter((d) => d.value > 0)} />
            </div>
            <div className="rx-card p-5">
              <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Top φαρμακεία (όγκος συνταγών)</div>
              <BarChart height={240} horizontal
                labels={ov.data.charts.top_tenants.map((t) => t.tenant)}
                data={ov.data.charts.top_tenants.map((t) => t.n)}
                name="Συνταγές" />
            </div>
          </div>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Υγεία συγχρονισμών ΗΔΥΚΑ</h2>

      {/* Vault + silent-failure banner — «φωνάζει» όταν οι syncs σταματούν σιωπηλά (incident 2026-07-08) */}
      {sync.data && (() => {
        const s = sync.data;
        if (s.alert) {
          const reason = !s.vault.healthy
            ? "🔒 Το Vault δεν είναι προσβάσιμο (ληγμένο token ή sealed) — ΟΛΟΙ οι συγχρονισμοί σταματούν σιωπηλά."
            : s.ingest.last_data_at == null
              ? "Κανένας συγχρονισμός δεν έχει φέρει ποτέ δεδομένα."
              : `Κανένα νέο δεδομένο ΗΔΥΚΑ εδώ και ~${s.ingest.stale_hours}h — πιθανή σιωπηλή αποτυχία (Vault/creds/δίκτυο).`;
          return (
            <div className="mb-3 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
              <div><b>Προσοχή — συγχρονισμοί σε κίνδυνο.</b> {reason}</div>
            </div>
          );
        }
        return (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Vault OK · τελευταία δεδομένα {s.ingest.stale_hours != null ? `πριν ${s.ingest.stale_hours}h` : "—"}.
          </div>
        );
      })()}

      {sync.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable pageSize={20} columns={syncColumns} rows={sync.data?.items ?? []} rowKey={(r) => r.id} />}
    </div>
  );
}
