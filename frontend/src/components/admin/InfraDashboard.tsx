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
  const W = 860, H = 580;
  const internet = { x: 510, y: 46 };
  const lbXY = { x: 510, y: 158 };
  const gitXY = { x: 150, y: 70 };
  const mgmtXY = { x: 150, y: 280 };
  const appXY = apps.map((s, i) => ({ s, x: Math.round(510 + (i - (apps.length - 1) / 2) * 180), y: 330 }));
  const dbXY = { x: 410, y: 490 };
  const stXY = { x: 730, y: 470 };

  type E = { id: string; d: string; kind: "public" | "private" | "deploy" };
  const edges: E[] = [];
  if (lb) {
    edges.push({ id: "pub_il", kind: "public", d: `M${internet.x},${internet.y + 24} L${lbXY.x},${lbXY.y - 28}` });
    appXY.forEach((a, i) => edges.push({ id: `prv_la${i}`, kind: "private", d: `M${lbXY.x},${lbXY.y + 28} C${lbXY.x},245 ${a.x},262 ${a.x},${a.y - 30}` }));
  }
  appXY.forEach((a, i) => { if (dbs.length) edges.push({ id: `prv_ad${i}`, kind: "private", d: `M${a.x},${a.y + 30} C${a.x},425 ${dbXY.x},435 ${dbXY.x},${dbXY.y - 28}` }); });
  if (mgmt) {
    edges.push({ id: "pub_im", kind: "public", d: `M${internet.x - 58},${internet.y + 10} C320,72 ${mgmtXY.x + 36},150 ${mgmtXY.x},${mgmtXY.y - 30}` });
    edges.push({ id: "dep_gm", kind: "deploy", d: `M${gitXY.x},${gitXY.y + 24} L${mgmtXY.x},${mgmtXY.y - 30}` });
    appXY.forEach((a, i) => edges.push({ id: `dep_ma${i}`, kind: "deploy", d: `M${mgmtXY.x + 52},${mgmtXY.y} C320,${mgmtXY.y} ${a.x - 90},${a.y} ${a.x - 34},${a.y}` }));
    if (dbs.length) edges.push({ id: "prv_md", kind: "private", d: `M${mgmtXY.x},${mgmtXY.y + 30} C${mgmtXY.x},440 ${dbXY.x - 95},${dbXY.y} ${dbXY.x - 34},${dbXY.y}` });
    if (infra.storage) edges.push({ id: "pub_ms", kind: "public", d: `M${mgmtXY.x + 14},${mgmtXY.y + 30} C170,500 ${stXY.x - 130},${stXY.y + 70} ${stXY.x - 32},${stXY.y + 28}` });
  }

  const STROKE = { public: "stroke-amber-400 dark:stroke-amber-600", private: "stroke-emerald-400 dark:stroke-emerald-600", deploy: "stroke-violet-300 dark:stroke-violet-700" };
  const DOT = { public: "fill-amber-500", private: "fill-emerald-500", deploy: "fill-violet-400" };
  const pct = (v: number, t: number) => `${(v / t) * 100}%`;
  const Card = ({ x, y, tone, children }: { x: number; y: number; tone: string; children: React.ReactNode }) => (
    <div className={`absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-xl border px-3 py-1.5 text-center text-xs shadow-sm ${tone}`}
      style={{ left: pct(x, W), top: pct(y, H), minWidth: 108 }}>{children}</div>
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white p-4 dark:border-slate-700 dark:from-slate-900 dark:to-slate-950">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Network className="h-4 w-4" /> Τοπολογία δικτύου</h3>
      <div className="relative mx-auto w-full" style={{ aspectRatio: `${W} / ${H}`, maxWidth: 820 }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="rxglow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            {edges.map((e) => <path key={e.id} id={e.id} d={e.d} fill="none" />)}
          </defs>
          {/* private-network zone — everything inside is 10.0.0.0/16; edges crossing the border are public */}
          <rect x="64" y="220" width="566" height="332" rx="18" className="fill-emerald-50/60 stroke-emerald-300 dark:fill-emerald-950/30 dark:stroke-emerald-800" strokeWidth="1.5" strokeDasharray="7 6" />
          <text x="80" y="240" className="fill-emerald-600 dark:fill-emerald-400" fontSize="11.5" fontWeight="700">🔒 Ιδιωτικό δίκτυο{net?.range ? ` ${net.range}` : " 10.0.0.0/16"}</text>
          {edges.map((e) => <use key={`l${e.id}`} href={`#${e.id}`} className={STROKE[e.kind]} strokeWidth={e.kind === "deploy" ? 1.6 : 2.2} strokeDasharray={e.kind === "deploy" ? "5 5" : undefined} fill="none" />)}
          {edges.filter((e) => e.kind !== "deploy").flatMap((e) => [0, 1.2].map((delay) => (
            <circle key={`${e.id}-${delay}`} r="3.4" className={DOT[e.kind]} filter="url(#rxglow)">
              <animateMotion dur="2.4s" begin={`${delay}s`} repeatCount="indefinite"><mpath href={`#${e.id}`} /></animateMotion>
            </circle>
          )))}
        </svg>

        <Card x={internet.x} y={internet.y} tone="border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"><Globe className="mx-auto mb-0.5 h-3.5 w-3.5" />Internet / Cloudflare<div className="text-[9px] opacity-70">app.rxvision.gr</div></Card>
        <Card x={gitXY.x} y={gitXY.y} tone="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"><GitBranch className="mx-auto mb-0.5 h-3.5 w-3.5" />Git / Deploy<div className="text-[9px] opacity-70">build → ship</div></Card>
        {lb && <Card x={lbXY.x} y={lbXY.y} tone="border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"><Scale className="mx-auto mb-0.5 h-3.5 w-3.5" />{lb.name}<div className="font-mono text-[9px] opacity-70">{lb.public_ip}</div></Card>}
        {mgmt && <Card x={mgmtXY.x} y={mgmtXY.y} tone="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"><Wrench className="mx-auto mb-0.5 h-3.5 w-3.5" />{mgmt.name}<div className="font-mono text-[9px] opacity-70">{mgmt.private_ip}</div><div className="text-[9px] opacity-70">management · backups</div></Card>}
        {appXY.map((a) => (
          <Card key={a.s.name} x={a.x} y={a.y} tone="border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <Server className="mx-auto mb-0.5 h-3.5 w-3.5 text-brand-600" />{a.s.name}<div className="font-mono text-[9px] opacity-70">{a.s.private_ip}</div>
            <div className="mt-1 rounded-full bg-brand-100 px-1.5 py-0.5 text-[9px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-300">👥 {tenantsByNode[a.s.name] ?? 0} tenants</div>
          </Card>
        ))}
        {dbs.map((s) => (
          <Card key={s.name} x={dbXY.x} y={dbXY.y} tone="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"><Database className="mx-auto mb-0.5 h-3.5 w-3.5" />{s.name}<div className="font-mono text-[9px] opacity-70">{s.private_ip}</div><div className="text-[9px] opacity-70">MongoDB + Redis</div></Card>
        ))}
        {infra.storage && (
          <Card x={stXY.x} y={stXY.y} tone="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"><HardDrive className="mx-auto mb-0.5 h-3.5 w-3.5" />Backup Storage<div className="font-mono text-[9px] opacity-70">offsite</div><div className="text-[9px] opacity-70">customer data backup</div></Card>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-4 rounded bg-emerald-400" /> Ιδιωτικό (10.0.0.0/16)</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-4 rounded bg-amber-400" /> Δημόσιο / Internet</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-violet-400" /> Deploy</span>
      </div>
    </div>
  );
}

type Op = { _id?: string; type: string; node: string; status: string; result?: string; requested_at?: string; finished_at?: string };

export function InfraDashboard() {
  const qc = useQueryClient();
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [servingOpen, setServingOpen] = useState(false);
  const q = useQuery({ queryKey: ["infra"], queryFn: () => adminApi<Infra>("/platform/cloud/infra"), refetchInterval: 12000, retry: false });
  const opsQ = useQuery({ queryKey: ["ops"], queryFn: () => adminApi<{ items: Op[] }>("/platform/cloud/ops"), refetchInterval: 5000, retry: false });
  const op = useMutation({
    mutationFn: (b: { type: string; target: string; file?: string }) => adminApi("/platform/cloud/ops", { method: "POST", body: JSON.stringify(b) }),
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
  async function addNode() {
    if (!(await appConfirm("Θα δημιουργηθεί ΝΕΟΣ Hetzner server (ccx13 · χρέωση/μήνα), θα στηθεί αυτόματα και θα μπει στον Load Balancer (~3–5 λεπτά). Συνέχεια;", { title: "Προσθήκη app server", confirmText: "Δημιουργία" }))) return;
    op.mutate({ type: "add_node", target: "all" });
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
            <button onClick={addNode} disabled={addingNode}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"><Server className="h-4 w-4" /> {addingNode ? "Δημιουργία…" : "➕ Προσθήκη app server"}</button>
          </div>
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
