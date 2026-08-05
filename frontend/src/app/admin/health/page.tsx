"use client";

import { Tooltip } from "@/components/ui/Tooltip";
import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Day = { date: string; ratio: number | null };
type Service = { source: string; runs: number; failed: number; uptime_pct: number; status: string; daily: Day[] };
type Failure = { tenant: string; source: string; error: string; at: string };
type Transfer = { external_id: string; from: string; to: string; patient_removed: boolean; at: string };
type CrossTenant = { transfers_30d: number; recent_transfers: Transfer[]; pending_leaks: number; last_scan_at: string | null };
type Health = {
  summary: { syncs_30d: number; failed_30d: number; active_tenants: number; success_rate: number };
  services: Service[];
  recent_failures: Failure[];
  vault?: { healthy: boolean };
  ingest?: { last_data_at: string | null; stale_hours: number | null };
  alert?: boolean;
  cross_tenant?: CrossTenant;
};

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  operational: { text: "Λειτουργικό", cls: "text-emerald-600" },
  degraded: { text: "Υποβαθμισμένο", cls: "text-amber-600" },
  partial_outage: { text: "Μερική διακοπή", cls: "text-red-600" },
};

function barColor(r: number | null) {
  if (r === null) return "bg-slate-200";
  if (r >= 1) return "bg-emerald-500";
  if (r > 0) return "bg-amber-400";
  return "bg-red-500";
}

function ServiceRow({ s }: { s: Service }) {
  const st = STATUS_LABEL[s.status] ?? STATUS_LABEL.operational;
  return (
    <div className="border-t border-slate-100 py-4 first:border-t-0">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-slate-800">{s.source}</span>
        <span className={`text-sm font-medium ${st.cls}`}>{st.text}</span>
      </div>
      <Tooltip label="30 ημέρες"><div className="flex gap-[2px]">
        {s.daily.map((d) => (
          <Tooltip key={d.date} label={`${d.date}: ${d.ratio === null ? "—" : Math.round(d.ratio * 100) + "% ok"}`}><div className={`h-8 flex-1 rounded-sm ${barColor(d.ratio)}`} /></Tooltip>
        ))}
      </div></Tooltip>
      <div className="mt-1 flex justify-between text-xs text-slate-400">
        <span>30 ημέρες πριν</span>
        <span>{s.uptime_pct}% uptime · {fmtNum(s.runs)} syncs · {fmtNum(s.failed)} σφάλματα</span>
        <span>Σήμερα</span>
      </div>
    </div>
  );
}

const failColumns: Column<Failure>[] = [
  { key: "at", header: "Ημ/νία", render: (r) => fmtDate(r.at) },
  { key: "tenant", header: "Tenant" },
  { key: "source", header: "Πηγή" },
  { key: "error", header: "Σφάλμα", render: (r) => <span className="text-red-600">{r.error}</span> },
];

const xferColumns: Column<Transfer>[] = [
  { key: "at", header: "Ημ/νία", render: (r) => fmtDate(r.at) },
  { key: "external_id", header: "Barcode", render: (r) => <span className="font-mono text-xs">{r.external_id}</span> },
  { key: "from", header: "Από (λάθος)", render: (r) => <span className="text-red-600">{r.from}</span> },
  { key: "to", header: "Προς (σωστό)", render: (r) => <span className="text-emerald-700">{r.to}</span> },
  { key: "patient_removed", header: "ΑΜΚΑ", render: (r) => r.patient_removed ? <span className="text-emerald-700">αφαιρέθηκε ✓</span> : <span className="text-slate-400">—</span> },
];

export default function HealthPage() {
  const { data, isLoading } = useQuery({ queryKey: ["admin", "health"], queryFn: () => adminApi<Health>("/admin/health"), retry: false });
  const s = data?.summary;
  const services = data?.services ?? [];
  const anyDegraded = services.some((x) => x.status !== "operational");

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">Κατάσταση πλατφόρμας</h1>

      {/* Vault + σιωπηλή αποτυχία — «φωνάζει» όταν οι ΗΔΥΚΑ syncs σταματούν χωρίς να φαίνεται (incident 2026-07-08) */}
      {data && (data.alert ? (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div className="font-bold">🔴 Προσοχή — συγχρονισμοί ΗΔΥΚΑ σε κίνδυνο</div>
          <div className="mt-0.5">
            {data.vault && !data.vault.healthy
              ? "Το Vault δεν είναι προσβάσιμο (ληγμένο token ή sealed) — ΟΛΟΙ οι συγχρονισμοί σταματούν ΣΙΩΠΗΛΑ (φαίνονται «success» με 0 εγγραφές)."
              : data.ingest?.last_data_at == null
                ? "Κανένας συγχρονισμός δεν έχει φέρει δεδομένα (30 ημέρες)."
                : `Κανένα νέο δεδομένο ΗΔΥΚΑ εδώ και ~${data.ingest?.stale_hours}h — πιθανή σιωπηλή αποτυχία (Vault/creds/δίκτυο).`}
          </div>
        </div>
      ) : (
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <span className="font-semibold">🟢 Ροή δεδομένων ΗΔΥΚΑ OK</span>
          <span>Vault: {data.vault?.healthy ? "προσβάσιμο ✓" : "—"}</span>
          <span>Τελευταία δεδομένα: {data.ingest?.stale_hours != null ? `πριν ${data.ingest.stale_hours}h` : "—"}</span>
        </div>
      ))}

      {anyDegraded && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          Κάποιες υπηρεσίες είναι υποβαθμισμένες — δες παρακάτω.
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Επιτυχία sync (30ημ)" value={`${s?.success_rate ?? 100}%`} accent={(s?.success_rate ?? 100) >= 99 ? "green" : "amber"} />
        <KpiCard label="Syncs (30ημ)" value={fmtNum(s?.syncs_30d ?? 0)} />
        <KpiCard label="Σφάλματα (30ημ)" value={fmtNum(s?.failed_30d ?? 0)} accent="rose" />
        <KpiCard label="Ενεργοί tenants" value={fmtNum(s?.active_tenants ?? 0)} accent="sky" />
      </div>

      <div className="mb-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 text-sm font-semibold text-slate-700">Υπηρεσίες συγχρονισμού — uptime 90/30 ημερών</div>
        {isLoading ? <div className="text-slate-400">Φόρτωση…</div> : services.length === 0 ? (
          <div className="py-6 text-center text-slate-400">Δεν υπάρχουν δεδομένα sync.</div>
        ) : services.map((x) => <ServiceRow key={x.source} s={x} />)}
      </div>

      {/* GDPR: cross-tenant διαρροές — αυτόματος έλεγχος & μεταφορά στο σωστό φαρμακείο */}
      {data?.cross_tenant && (
        <div className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
            🔀 Διαρροές μεταξύ φαρμακείων (GDPR)
            {data.cross_tenant.pending_leaks > 0 ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">{data.cross_tenant.pending_leaks} εκκρεμείς — μεταφέρονται</span>
            ) : (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">καμία εκκρεμής ✓</span>
            )}
          </h2>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-600">
            <span>Αυτόματος ημερήσιος έλεγχος: κάθε εκτέλεση που βρεθεί σε λάθος φαρμακείο <b>μεταφέρεται</b> στον σωστό (και το ΑΜΚΑ φεύγει από το λάθος).</span>
            <span className="text-slate-400">Μεταφορές 30ημ: <b className="text-slate-700">{fmtNum(data.cross_tenant.transfers_30d)}</b></span>
            {data.cross_tenant.last_scan_at && <span className="text-slate-400">Τελευταία σάρωση: {fmtDate(data.cross_tenant.last_scan_at)}</span>}
          </div>
          <DataTable pageSize={10} columns={xferColumns} rows={data.cross_tenant.recent_transfers ?? []} rowKey={(r, i) => `${r.external_id}-${i}`} empty="Καμία μεταφορά διαρροής — τα δεδομένα είναι καθαρά 🎉" />
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-slate-700">Πρόσφατες αποτυχίες</h2>
      <DataTable pageSize={20} columns={failColumns} rows={data?.recent_failures ?? []} rowKey={(r, i) => `${r.tenant}-${i}`} empty="Καμία αποτυχία 🎉" />
    </div>
  );
}
