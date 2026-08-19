"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { appConfirm } from "@/store/dialogStore";
import { Server, Database, Scale, Globe, Cpu, MemoryStick, Activity, RefreshCw, Network, HardDrive, Trash2, Wrench, ChevronDown, ChevronRight, GitBranch } from "lucide-react";

type Srv = {
  name: string; role: "app" | "db" | "lb" | "mgmt"; status: string | null; type: string | null;
  cores: number | null; memory_gb: number | null; disk_gb: number | null;
  public_ip: string | null; private_ip: string | null; location: string | null;
  cpu: number | null; ram_pct: number | null; load: number | null;
  disk_pct: number | null; disk_total_gb: number | null; metrics_live: boolean;
};
type LB = { name: string; public_ip: string | null; private_ip: string | null; services: string[]; targets: { name: string; healthy: boolean | null }[] };
type Net = { name: string; range: string | null; members: string[] };
type Store = { configured: boolean; host: string | null; path: string | null;
  last_backup_at?: string | null; last_backup_size?: string | null;
  last_backup_location?: string | null; last_backup_ok?: boolean | null;
  backups_total?: string | null; disk_avail?: string | null; disk_total?: string | null; disk_used_pct?: string | null };
type Infra = { servers: Srv[]; load_balancers: LB[]; networks: Net[]; storage: Store | null; hetzner_ok?: boolean; fetched_at: string };

const barColor = (p: number) => (p >= 85 ? "bg-rose-500" : p >= 60 ? "bg-amber-500" : "bg-emerald-500");

// Οι διαθέσιμοι τύποι/τοποθεσίες έρχονται ΖΩΝΤΑΝΑ από το Hetzner (/cloud/server-options) —
// μόνο ό,τι παραγγέλνεται τώρα ανά τοποθεσία, με πραγματική τιμή. Καμία σταθερή λίστα εδώ.
type SrvType = { id: string; label: string; eur: number | null; category: string; arch: string };
type SrvLoc = { id: string; label: string };
type ServerOptions = { locations: SrvLoc[]; types_by_location: Record<string, SrvType[]> };
// Οι 3 κατηγορίες του Hetzner (ίδια σειρά με το panel του), με ελληνική περιγραφή.
const CATEGORIES: { id: string; label: string }[] = [
  { id: "cost_optimized", label: "Οικονομικοί — κοινόχρηστοι (περιορισμένη διαθεσιμότητα)" },
  { id: "regular_purpose", label: "Κανονικής απόδοσης — κοινόχρηστοι AMD" },
  { id: "general_purpose", label: "Γενικής χρήσης — αποκλειστικοί πόροι (dedicated)" },
];

function Metric({ icon, label, pct, suffix }: { icon: React.ReactNode; label: string; pct: number | null; suffix?: string }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1">{icon}{label}</span>
        <span className="font-semibold text-slate-700 dark:text-slate-200">{pct == null ? "—" : `${pct}${suffix ?? "%"}`}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        {pct != null && <div className={`h-full rounded-full ${barColor(pct)} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />}
      </div>
    </div>
  );
}

function RoleIcon({ role }: { role: string }) {
  if (role === "db") return <Database className="h-4 w-4 text-violet-600" />;
  if (role === "lb") return <Scale className="h-4 w-4 text-sky-600" />;
  if (role === "mgmt") return <Wrench className="h-4 w-4 text-amber-600" />;
  return <Server className="h-4 w-4 text-brand-600" />;
}

function ServerCard({ s, onPrune, pruning }: { s: Srv; onPrune?: (node: string) => void; pruning?: boolean }) {
  const online = s.status === "running";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-slate-100"><RoleIcon role={s.role} />{s.name}</div>
          <div className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">{s.public_ip}{s.private_ip ? ` · ${s.private_ip}` : ""}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${online ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} />{online ? "Online" : s.status || "—"}
          </span>
          {(s.role === "app" || s.role === "mgmt") && onPrune && (
            <button onClick={() => onPrune(s.name)} disabled={pruning} title="Καθαρισμός Docker build cache + αχρησιμοποίητων images"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300">
              <Trash2 className="h-3 w-3" /> {pruning ? "…" : "Cache"}
            </button>
          )}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5 text-[10px]">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{s.type}</span>
        {s.cores != null && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{s.cores} vCPU</span>}
        {s.memory_gb != null && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{s.memory_gb} GB</span>}
        {s.disk_gb != null && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{s.disk_gb} GB δίσκος</span>}
        {s.location && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{s.location}</span>}
      </div>
      <div className="space-y-2">
        <Metric icon={<Cpu className="h-3 w-3" />} label="CPU" pct={s.cpu} />
        <Metric icon={<MemoryStick className="h-3 w-3" />} label="RAM" pct={s.ram_pct} />
        <Metric icon={<HardDrive className="h-3 w-3" />} label={`Δίσκος${s.disk_total_gb ? ` (${s.disk_total_gb} GB)` : ""}`} pct={s.disk_pct} />
        <Metric icon={<Activity className="h-3 w-3" />} label="Load" pct={s.load == null ? null : Math.round(s.load * 100) / 100} suffix="" />
      </div>
      {!s.metrics_live && <div className="mt-2 text-[10px] text-slate-400">CPU από Hetzner · RAM/Δίσκος/Load ζωντανά μόλις τρέξει ο agent</div>}
    </div>
  );
}

function Topology({ infra, tenantsByNode }: { infra: Infra; tenantsByNode: Record<string, number> }) {
  const lb = infra.load_balancers[0];
  const apps = infra.servers.filter((s) => s.role === "app");
  const mgmt = infra.servers.find((s) => s.role === "mgmt");
  const dbs = infra.servers.filter((s) => s.role === "db");
  const net = infra.networks[0];
  const onlineCount = infra.servers.filter((s) => s.status === "running").length;
  const totalTenants = Object.values(tenantsByNode).reduce((a, b) => a + b, 0);
  const C = { public: "#f59e0b", private: "#10b981" };

  const Bar = ({ v, c }: { v: number | null; c: string }) => (
    <span className="inline-block h-1.5 w-10 overflow-hidden rounded-full bg-slate-200 align-middle dark:bg-slate-700">
      <span className="block h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(3, v ?? 0))}%`, background: c }} />
    </span>
  );

  const Node = ({ icon, accent, name, ip, tag, online, wide, children }: {
    icon: React.ReactNode; accent: string; name: string; ip?: string | null; tag?: string;
    online?: boolean; wide?: boolean; children?: React.ReactNode;
  }) => (
    <div className={`relative rounded-xl border border-l-4 bg-white p-2.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-slate-900 ${accent}`}
      style={{ minWidth: wide ? 210 : 150, maxWidth: 250 }}>
      {online !== undefined && (
        <span className="absolute right-2 top-2 flex h-2.5 w-2.5">
          {online && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} />
        </span>
      )}
      <div className="flex items-center gap-1.5 pr-3"><span className="shrink-0">{icon}</span><span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{name}</span></div>
      {ip && <div className="mt-0.5 font-mono text-[10px] text-slate-400">{ip}</div>}
      {tag && <div className="text-[10px] text-slate-500 dark:text-slate-400">{tag}</div>}
      {children}
    </div>
  );

  // Κατακόρυφος connector ροής μεταξύ επιπέδων (κινούμενη τελεία + προαιρετική ετικέτα).
  const Flow = ({ label, c }: { label?: string; c: string }) => (
    <div className="relative flex h-8 items-center justify-center">
      <svg width="16" height="34" className="overflow-visible" aria-hidden>
        <line x1="8" y1="0" x2="8" y2="34" stroke={c} strokeWidth="2" strokeDasharray="2 5" strokeLinecap="round">
          <animate attributeName="stroke-dashoffset" from="7" to="0" dur="0.6s" repeatCount="indefinite" />
        </line>
        <circle r="3" fill={c}><animateMotion dur="1.5s" repeatCount="indefinite" path="M8 0 V34" /></circle>
      </svg>
      {label && <span className="absolute left-[calc(50%+18px)] whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">{label}</span>}
    </div>
  );

  const Tier = ({ step, icon, title, note, children }: {
    step: number; icon: React.ReactNode; title: string; note?: string; children: React.ReactNode;
  }) => (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-slate-800 text-[10px] font-bold text-white dark:bg-slate-200 dark:text-slate-900">{step}</span>
        <span className="text-slate-500 dark:text-slate-400">{icon}</span>
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">{title}</h4>
        {note && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">🔒 {note}</span>}
      </div>
      <div className="flex flex-wrap items-stretch justify-center gap-3">{children}</div>
    </div>
  );

  // Fan-out connector: ο LB μοιράζει σε N app servers (διακλάδωση με κινούμενα πακέτα).
  const FanOut = ({ n, c }: { n: number; c: string }) => {
    const xs = Array.from({ length: Math.max(1, n) }, (_, i) => 14 + (i + 0.5) * (172 / Math.max(1, n)));
    return (
      <div className="relative flex h-11 items-center justify-center">
        <span className="absolute -top-0.5 z-10 rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">κατανομή σε {n} servers</span>
        <svg viewBox="0 0 200 44" width="100%" height="44" preserveAspectRatio="none" className="max-w-lg" aria-hidden>
          {xs.map((x, i) => (
            <g key={i}>
              <path id={`fan${i}`} d={`M100 8 C100 26 ${x} 24 ${x} 44`} fill="none" stroke={c} strokeWidth="1.4" strokeDasharray="2 5" strokeLinecap="round" opacity="0.7">
                <animate attributeName="stroke-dashoffset" from="7" to="0" dur="0.6s" repeatCount="indefinite" />
              </path>
              <circle r="2.6" fill={c}><animateMotion dur="1.4s" begin={`${i * 0.22}s`} repeatCount="indefinite"><mpath href={`#fan${i}`} /></animateMotion></circle>
            </g>
          ))}
        </svg>
      </div>
    );
  };

  const withM = infra.servers.filter((s) => s.cpu != null);
  const avg = (f: (s: Srv) => number | null) => withM.length ? Math.round(withM.reduce((a, s) => a + (f(s) || 0), 0) / withM.length) : null;
  const kpis = [
    { label: "Servers online", value: `${onlineCount}/${infra.servers.length}`, c: "text-emerald-600 dark:text-emerald-400" },
    { label: "Ενεργά φαρμακεία", value: totalTenants, c: "text-sky-600 dark:text-sky-400" },
    { label: "Μ.Ο. CPU", value: avg((s) => s.cpu) != null ? `${avg((s) => s.cpu)}%` : "—", c: "text-slate-700 dark:text-slate-200" },
    { label: "Μ.Ο. RAM", value: avg((s) => s.ram_pct) != null ? `${avg((s) => s.ram_pct)}%` : "—", c: "text-slate-700 dark:text-slate-200" },
    { label: "Μ.Ο. δίσκος", value: avg((s) => s.disk_pct) != null ? `${avg((s) => s.disk_pct)}%` : "—", c: "text-violet-600 dark:text-violet-400" },
  ];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100"><span className="grid h-6 w-6 place-items-center rounded-lg bg-gradient-to-br from-emerald-500 to-sky-500 text-white"><Network className="h-3.5 w-3.5" /></span> Αρχιτεκτονική υποδομής</h3>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />{onlineCount} online</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">👥 {totalTenants} tenants</span>
          <span className="text-slate-400">· live 15s</span>
        </div>
      </div>

      {/* KPI strip — «control-room» σύνοψη */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white px-3 py-2 dark:border-slate-700 dark:from-slate-800/60 dark:to-slate-900">
            <div className={`text-lg font-extrabold leading-none ${k.c}`}>{k.value}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="mx-auto max-w-2xl">
        <Tier step={1} icon={<Globe className="h-4 w-4" />} title="Είσοδος & Deploy">
          <Node icon={<Globe className="h-4 w-4 text-sky-500" />} accent="border-l-sky-400 border-slate-200 dark:border-slate-700" name="Internet / Cloudflare" tag="app.rxvision.gr · TLS + WAF" />
          <Node icon={<GitBranch className="h-4 w-4 text-violet-500" />} accent="border-l-violet-400 border-slate-200 dark:border-slate-700" name="Git / Deploy" tag="build → ship" />
        </Tier>

        <Flow label="HTTPS · δημόσιο" c={C.public} />

        <Tier step={2} icon={<Scale className="h-4 w-4" />} title="Edge · Κατανομή φόρτου">
          {lb && <Node wide icon={<Scale className="h-4 w-4 text-brand-500" />} accent="border-l-brand-400 border-slate-200 dark:border-slate-700" name={lb.name} ip={lb.public_ip} tag="αυτόματη κατανομή + health checks" online={(lb.targets ?? []).some((t) => t.healthy)} />}
        </Tier>

        {apps.length > 1 ? <FanOut n={apps.length} c={C.private} /> : <Flow label={net?.range ? `ιδιωτικό ${net.range}` : "ιδιωτικό"} c={C.private} />}

        <Tier step={3} icon={<Server className="h-4 w-4" />} title="Εφαρμογή" note={net?.range ?? "10.0.0.0/16"}>
          {apps.map((s) => (
            <Node key={s.name} icon={<Server className="h-4 w-4 text-brand-500" />} accent="border-l-brand-400 border-slate-200 dark:border-slate-700" name={s.name} ip={s.private_ip} tag={s.location ? `📍 ${s.location}` : undefined} online={s.status === "running"}>
              <div className="mt-1.5 space-y-1 text-[9px] text-slate-500 dark:text-slate-400">
                <div className="flex items-center gap-1"><Cpu className="h-3 w-3 shrink-0" /><Bar v={s.cpu} c={C.private} /><span className="tabular-nums">{s.cpu != null ? `${Math.round(s.cpu)}%` : "—"}</span></div>
                <div className="flex items-center gap-1"><MemoryStick className="h-3 w-3 shrink-0" /><Bar v={s.ram_pct} c="#3b82f6" /><span className="tabular-nums">{s.ram_pct != null ? `${Math.round(s.ram_pct)}%` : "—"}</span></div>
                <div className="mt-0.5 inline-block rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">👥 {tenantsByNode[s.name] ?? 0} tenants</div>
              </div>
            </Node>
          ))}
          {mgmt && <Node icon={<Wrench className="h-4 w-4 text-amber-500" />} accent="border-l-amber-400 border-slate-200 dark:border-slate-700" name={mgmt.name} ip={mgmt.private_ip} tag="management · builds · backups" online={mgmt.status === "running"} />}
        </Tier>

        <Flow c={C.private} />

        <Tier step={4} icon={<Database className="h-4 w-4" />} title="Δεδομένα · Replica Set">
          {dbs.map((s) => (
            <Node key={s.name} wide icon={<Database className="h-4 w-4 text-violet-500" />} accent="border-l-violet-400 border-slate-200 dark:border-slate-700" name={s.name} ip={s.private_ip} tag="MongoDB + Redis" online={s.status === "running"}>
              <div className="mt-1.5 flex items-center gap-1.5 text-[9px] text-slate-400"><HardDrive className="h-3 w-3" /><Bar v={s.disk_pct} c="#8b5cf6" /><span>{s.disk_pct != null ? `${Math.round(s.disk_pct)}% δίσκος` : ""}</span></div>
            </Node>
          ))}
        </Tier>

        <Flow label="offsite" c={C.public} />

        <Tier step={5} icon={<HardDrive className="h-4 w-4" />} title="Αντίγραφα ασφαλείας">
          {infra.storage && <Node wide icon={<HardDrive className="h-4 w-4 text-amber-500" />} accent="border-l-amber-400 border-slate-200 dark:border-slate-700" name="Backup Storage" tag="offsite · κρυπτογραφημένα δεδομένα πελατών" />}
        </Tier>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded" style={{ background: C.private }} /> Ιδιωτικό δίκτυο</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded" style={{ background: C.public }} /> Δημόσιο / Internet</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> ζωντανά metrics ανά 15s</span>
      </div>
    </div>
  );
}

type Op = { _id?: string; type: string; node: string; status: string; result?: string; requested_at?: string; finished_at?: string };

export function InfraDashboard() {
  const qc = useQueryClient();
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [servingOpen, setServingOpen] = useState(false);
  const [newType, setNewType] = useState("");   // επιλογή τύπου/τοποθεσίας νέου server (live)
  const [newLoc, setNewLoc] = useState("");
  const q = useQuery({ queryKey: ["infra"], queryFn: () => adminApi<Infra>("/platform/cloud/infra"), refetchInterval: 12000, retry: false });
  const optQ = useQuery({ queryKey: ["server-options"], queryFn: () => adminApi<ServerOptions>("/platform/cloud/server-options"), staleTime: 300_000, retry: false });
  const opsQ = useQuery({ queryKey: ["ops"], queryFn: () => adminApi<{ items: Op[] }>("/platform/cloud/ops"), refetchInterval: 5000, retry: false });
  const op = useMutation({
    mutationFn: (b: { type: string; target: string; file?: string; server_type?: string; location?: string }) => adminApi("/platform/cloud/ops", { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ops"] }),
  });
  const backupsQ = useQuery({ queryKey: ["backups"], queryFn: () => adminApi<{ items: { file: string; size?: string; ts?: string; ok?: boolean }[] }>("/platform/cloud/backups"), refetchInterval: 15000, retry: false });
  const servingQ = useQuery({ queryKey: ["serving"], queryFn: () => adminApi<{ distribution: { node: string; tenants: number }[]; tenants: { tenant_id: string; tenant: string; node: string; last_at?: string; hits?: number }[] }>("/platform/cloud/serving"), refetchInterval: 15000, retry: false });
  const pruning = (node: string) => op.isPending || (opsQ.data?.items ?? []).some((o) => o.type === "prune" && o.node === node && o.status !== "done");
  const backingUp = op.isPending || (opsQ.data?.items ?? []).some((o) => o.type === "backup" && o.status !== "done");
  const restoring = op.isPending || (opsQ.data?.items ?? []).some((o) => o.type === "restore" && o.status !== "done");
  async function restore(file: string, label: string) {
    if (!(await appConfirm(`Η ΕΠΑΝΑΦΟΡΑ θα ΑΝΤΙΚΑΤΑΣΤΗΣΕΙ ΟΛΑ τα τρέχοντα δεδομένα της βάσης με το backup της ${label}. Μη αναστρέψιμο! Σίγουρα;`, { title: "Επαναφορά Backup", danger: true, confirmText: "Επαναφορά τώρα" }))) return;
    op.mutate({ type: "restore", target: "all", file });
  }

  if (q.isLoading) return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900">Φόρτωση υποδομής…</div>;
  if (q.error) return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">Δεν φορτώθηκε η υποδομή (έλεγξε ότι έχει αποθηκευτεί Hetzner token).</div>;
  const infra = q.data!;
  const lb = infra.load_balancers[0];
  const recentOps = (opsQ.data?.items ?? []).slice(0, 4);
  const tenantsByNode: Record<string, number> = Object.fromEntries((servingQ.data?.distribution ?? []).map((d) => [d.node, d.tenants]));
  const OP_LABEL: Record<string, string> = { prune: "Καθάρισμα cache", backup: "Backup", restore: "Επαναφορά", add_node: "Νέος app server" };
  const loadedNodes = infra.servers.filter((s) => s.role === "app" && Math.max(s.cpu ?? 0, s.ram_pct ?? 0, s.disk_pct ?? 0) >= 80);
  const addingNode = op.isPending || (opsQ.data?.items ?? []).some((o) => o.type === "add_node" && o.status !== "done");
  // Διαθέσιμα (ζωντανά από Hetzner). effLoc/effType = η επιλογή του χρήστη ΑΝ ισχύει, αλλιώς το 1ο διαθέσιμο.
  const availLocs = optQ.data?.locations ?? [];
  const effLoc = availLocs.some((l) => l.id === newLoc) ? newLoc : (availLocs[0]?.id ?? "");
  const availTypes = optQ.data?.types_by_location?.[effLoc] ?? [];
  const effType = availTypes.some((t) => t.id === newType) ? newType : (availTypes[0]?.id ?? "");
  const optsLoading = optQ.isLoading;
  const noOpts = !optsLoading && availLocs.length === 0;
  async function addNode() {
    const st = availTypes.find((t) => t.id === effType);
    const lc = availLocs.find((l) => l.id === effLoc);
    if (!effType || !effLoc) return;
    if (!(await appConfirm(`Θα δημιουργηθεί ΝΕΟΣ Hetzner server (${st?.label ?? effType} · ~${st?.eur ?? "?"}€/μήνα · ${lc?.label ?? effLoc}), θα στηθεί αυτόματα και θα μπει στον Load Balancer (~3–5 λεπτά). Συνέχεια;`, { title: "Προσθήκη app server", confirmText: "Δημιουργία" }))) return;
    op.mutate({ type: "add_node", target: "all", server_type: effType, location: effLoc });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100"><Server className="h-5 w-5 text-brand-600" /> Servers</h2>
        <span className="inline-flex items-center gap-1 text-xs text-slate-400"><RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} /> live · κάθε 12s</span>
      </div>

      {infra.hetzner_ok === false && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          ⚠️ Το <b>Hetzner token</b> λείπει ή είναι άκυρο — δείχνω μόνο τους κόμβους που στέλνουν live metrics. Βάλε έγκυρο token (64 χαρακτήρων) στο πεδίο πάνω για να δεις servers, specs, Load Balancer & δίκτυο.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {infra.servers.map((s) => <ServerCard key={s.name} s={s} onPrune={(n) => op.mutate({ type: "prune", target: n })} pruning={pruning(s.name)} />)}
      </div>

      {/* maintenance — docker cache + backup actions (run by per-node host ops-agent) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><Wrench className="h-4 w-4 text-slate-500" /> Συντήρηση</div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => op.mutate({ type: "prune", target: "all" })} disabled={op.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"><Trash2 className="h-4 w-4" /> Καθάρισε Docker cache (όλοι)</button>
            <button onClick={() => op.mutate({ type: "backup", target: "all" })} disabled={backingUp}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"><HardDrive className="h-4 w-4" /> {backingUp ? "Backup…" : "Backup τώρα"}</button>
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50/60 p-1.5 dark:border-emerald-800 dark:bg-emerald-950/40">
              {/* Τοποθεσία ΠΡΩΤΑ — καθορίζει ποιοι τύποι είναι διαθέσιμοι εκεί */}
              <select value={effLoc} onChange={(e) => { setNewLoc(e.target.value); setNewType(""); }} disabled={addingNode || noOpts}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800" title="Τοποθεσία">
                {availLocs.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <select value={effType} onChange={(e) => setNewType(e.target.value)} disabled={addingNode || noOpts}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800" title="Τύπος server">
                {/* ομαδοποίηση στις 3 κατηγορίες του Hetzner (+ τυχόν άγνωστες στο τέλος) */}
                {[...CATEGORIES, { id: "other", label: "Λοιποί" }].map((c) => {
                  const items = availTypes.filter((t) => t.category === c.id);
                  return items.length ? (
                    <optgroup key={c.id} label={c.label}>
                      {items.map((t) => <option key={t.id} value={t.id}>{t.label}{t.eur != null ? ` · ~${t.eur}€/μ` : ""}</option>)}
                    </optgroup>
                  ) : null;
                })}
              </select>
              <button onClick={addNode} disabled={addingNode || noOpts || !effType}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"><Server className="h-4 w-4" /> {addingNode ? "Δημιουργία…" : optsLoading ? "Φόρτωση…" : "➕ Νέος app server"}</button>
            </div>
            {noOpts && <p className="mt-1 text-[11px] text-amber-600">Δεν φορτώθηκαν διαθέσιμοι τύποι — έλεγξε το Hetzner token.</p>}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">💡 Έχεις ήδη αγοράσει server; Ένταξέ τον χωρίς νέα αγορά: <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">bash infra/scaling/adopt-node.sh &lt;server-id&gt;</code> στο MGMT.</p>
        </div>
        {loadedNodes.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            ⚠️ {loadedNodes.map((s) => s.name).join(", ")} {loadedNodes.length > 1 ? "είναι" : "είναι"} ≥80% — πρόσθεσε νέο app server για να μοιραστεί το φορτίο (ο LB θα τον χρησιμοποιήσει αυτόματα).
          </div>
        )}
        {recentOps.length > 0 && (
          <div className="mt-3 space-y-1 text-xs">
            {recentOps.map((o, i) => (
              <div key={o._id || i} className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${o.status === "done" ? "bg-emerald-100 text-emerald-700" : o.status === "running" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{o.status === "done" ? "✓" : o.status === "running" ? "…" : "⏳"}</span>
                <span className="font-medium">{OP_LABEL[o.type] || o.type}</span>
                <span className="text-slate-400">· {o.node}</span>
                {o.result && <span className="truncate text-slate-500">— {o.result}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {infra.storage && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><HardDrive className="h-4 w-4 text-amber-600" /> Offsite Backup</div>
            {infra.storage.last_backup_at ? (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${infra.storage.last_backup_ok ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${infra.storage.last_backup_ok ? "bg-emerald-500" : "bg-amber-500"}`} />
                {infra.storage.last_backup_ok ? "offsite ✓" : "τοπικό μόνο (το offsite απέτυχε)"}
              </span>
            ) : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">καμία εγγραφή ακόμη</span>}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-3">
            <div><span className="text-slate-400">Τελευταίο backup:</span> {infra.storage.last_backup_at ? new Date(infra.storage.last_backup_at).toLocaleString("el-GR") : "—"}</div>
            <div><span className="text-slate-400">Μέγεθος:</span> {infra.storage.last_backup_size || "—"}</div>
            <div className="truncate"><span className="text-slate-400">Προορισμός:</span> {infra.storage.last_backup_ok ? `${infra.storage.host || ""}${infra.storage.path || ""}` : "τοπικός δίσκος (backups/)"}</div>
          </div>
          {/* storage footprint + available space */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
            <span><span className="text-slate-400">{infra.storage.last_backup_ok ? "Χώρος στο Storage Box:" : "Χώρος backups (τοπικά):"}</span> <b>{infra.storage.backups_total || "—"}</b></span>
            <span><span className="text-slate-400">{infra.storage.last_backup_ok ? "Quota:" : "Διαθέσιμος δίσκος:"}</span> <b>{infra.storage.disk_avail || "—"}</b> / {infra.storage.disk_total || "—"}</span>
            {infra.storage.disk_used_pct && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><span className={`block h-full ${parseInt(infra.storage.disk_used_pct) >= 85 ? "bg-rose-500" : parseInt(infra.storage.disk_used_pct) >= 60 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: infra.storage.disk_used_pct }} /></span>
                <span className="text-slate-400">{infra.storage.disk_used_pct} σε χρήση</span>
              </span>
            )}
          </div>
        </div>
      )}

      {(backupsQ.data?.items?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <button onClick={() => setBackupsOpen((v) => !v)} className="flex w-full items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
            {backupsOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
            <HardDrive className="h-4 w-4 text-amber-600" /> Αντίγραφα ασφαλείας
            <span className="text-xs font-normal text-slate-400">({backupsQ.data?.items?.length ?? 0} αρχεία · διατήρηση ~1 εβδομάδα)</span>
          </button>
          {backupsOpen && (<>
          <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"><tr>
                <th className="px-3 py-2 text-left">Ημ/νία</th><th className="px-3 py-2 text-left">Αρχείο</th><th className="px-3 py-2 text-left">Κατάσταση</th><th className="px-3 py-2 text-right">Μέγεθος</th><th className="px-3 py-2 text-right">Ενέργεια</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(backupsQ.data?.items ?? []).map((b) => {
                  const label = b.ts ? new Date(b.ts).toLocaleString("el-GR") : b.file;
                  return (
                    <tr key={b.file}>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{label}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{b.file}</td>
                      <td className="px-3 py-2">
                        {b.ok === false
                          ? <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> Πρόβλημα</span>
                          : <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Ολοκληρώθηκε ✓</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600 dark:text-slate-300">{b.size || "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => restore(b.file, label)} disabled={restoring}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
                          <RefreshCw className="h-3 w-3" /> Επαναφορά
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">⚠️ Η επαναφορά αντικαθιστά όλα τα τρέχοντα δεδομένα με το επιλεγμένο backup.</p>
          </>)}
        </div>
      )}

      {(servingQ.data?.tenants?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <button onClick={() => setServingOpen((v) => !v)} className="flex w-full items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
            {servingOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
            <Scale className="h-4 w-4 text-sky-600" /> Κατανομή φόρτου ανά server
            <span className="ml-1 flex flex-wrap gap-1.5">
              {(servingQ.data?.distribution ?? []).map((d) => (
                <span key={d.node} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">{d.node}: <b>{d.tenants}</b></span>
              ))}
            </span>
          </button>
          {servingOpen && (
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"><tr>
                  <th className="px-3 py-2 text-left">Πελάτης</th><th className="px-3 py-2 text-left">Τελευταία εξυπηρέτηση από</th><th className="px-3 py-2 text-left">Πότε</th><th className="px-3 py-2 text-right">Requests</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(servingQ.data?.tenants ?? []).map((t) => (
                    <tr key={t.tenant_id}>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{t.tenant}</td>
                      <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><Server className="h-3.5 w-3.5 text-brand-600" />{t.node}</span></td>
                      <td className="px-3 py-2 text-slate-500">{t.last_at ? new Date(t.last_at).toLocaleString("el-GR") : "—"}</td>
                      <td className="px-3 py-2 text-right text-slate-600 dark:text-slate-300">{t.hits ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-400">ℹ️ Ενημερωτικό — οι tenants ΔΕΝ είναι κλειδωμένοι σε server· δείχνει πού έπεσε το τελευταίο αίτημα (ο LB μοιράζει αυτόματα).</p>
        </div>
      )}

      {lb && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-2 flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><Scale className="h-4 w-4 text-sky-600" />{lb.name} <span className="font-mono text-xs font-normal text-slate-500">{lb.public_ip}</span></div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {lb.services.map((s, i) => <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{s}</span>)}
            <span className="text-slate-400">→</span>
            {lb.targets.map((t) => (
              <span key={t.name} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${t.healthy ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${t.healthy ? "bg-emerald-500" : "bg-rose-500"}`} />{t.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <Topology infra={infra} tenantsByNode={tenantsByNode} />
    </div>
  );
}
