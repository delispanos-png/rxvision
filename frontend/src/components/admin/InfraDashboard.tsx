"use client";

import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Server, Database, Scale, Globe, Cpu, MemoryStick, Activity, RefreshCw, Network, HardDrive } from "lucide-react";

type Srv = {
  name: string; role: "app" | "db" | "lb"; status: string | null; type: string | null;
  cores: number | null; memory_gb: number | null; disk_gb: number | null;
  public_ip: string | null; private_ip: string | null; location: string | null;
  cpu: number | null; ram_pct: number | null; load: number | null; metrics_live: boolean;
};
type LB = { name: string; public_ip: string | null; private_ip: string | null; services: string[]; targets: { name: string; healthy: boolean | null }[] };
type Net = { name: string; range: string | null; members: string[] };
type Store = { configured: boolean; host: string | null; path: string | null };
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
  return <Server className="h-4 w-4 text-brand-600" />;
}

function ServerCard({ s }: { s: Srv }) {
  const online = s.status === "running";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-slate-100"><RoleIcon role={s.role} />{s.name}</div>
          <div className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">{s.public_ip}{s.private_ip ? ` · ${s.private_ip}` : ""}</div>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${online ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} />{online ? "Online" : s.status || "—"}
        </span>
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
        <Metric icon={<Activity className="h-3 w-3" />} label="Load" pct={s.load == null ? null : Math.round(s.load * 100) / 100} suffix="" />
      </div>
      {!s.metrics_live && <div className="mt-2 text-[10px] text-slate-400">CPU από Hetzner · RAM/Load ζωντανά μόλις τρέξει ο agent</div>}
    </div>
  );
}

function Topology({ infra }: { infra: Infra }) {
  const lb = infra.load_balancers[0];
  const apps = infra.servers.filter((s) => s.role === "app");
  const dbs = infra.servers.filter((s) => s.role === "db");
  const net = infra.networks[0];
  const W = 720, H = 510;
  const internet = { x: 360, y: 40 };
  const lbXY = { x: 360, y: 150 };
  const appXY = apps.map((s, i) => ({ s, x: Math.round(W * (i + 1) / (apps.length + 1)), y: 290 }));
  const dbXY = { x: 250, y: 440 };
  const stXY = { x: 505, y: 440 };

  // directed edges (source → target = real data flow)
  const edges: { id: string; d: string }[] = [];
  if (lb) {
    edges.push({ id: "e0", d: `M${internet.x},${internet.y + 26} L${lbXY.x},${lbXY.y - 26}` });
    appXY.forEach((a, i) => edges.push({ id: `la${i}`, d: `M${lbXY.x},${lbXY.y + 26} C${lbXY.x},${lbXY.y + 78} ${a.x},${a.y - 62} ${a.x},${a.y - 28}` }));
  }
  if (dbs.length) appXY.forEach((a, i) => edges.push({ id: `ad${i}`, d: `M${a.x},${a.y + 28} C${a.x},${a.y + 86} ${dbXY.x},${dbXY.y - 62} ${dbXY.x},${dbXY.y - 28}` }));
  if (infra.storage && dbs.length) edges.push({ id: "ds", d: `M${dbXY.x + 58},${dbXY.y} L${stXY.x - 60},${stXY.y}` });

  const pct = (v: number, t: number) => `${(v / t) * 100}%`;
  const Card = ({ x, y, tone, children }: { x: number; y: number; tone: string; children: React.ReactNode }) => (
    <div className={`absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-xl border px-3 py-1.5 text-center text-xs shadow-sm ${tone}`}
      style={{ left: pct(x, W), top: pct(y, H), minWidth: 112 }}>{children}</div>
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white p-4 dark:border-slate-700 dark:from-slate-900 dark:to-slate-950">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Network className="h-4 w-4" /> Τοπολογία δικτύου — ροή δεδομένων</h3>
      <div className="relative mx-auto w-full" style={{ aspectRatio: `${W} / ${H}`, maxWidth: 680 }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="rxglow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            {edges.map((e) => <path key={e.id} id={e.id} d={e.d} fill="none" />)}
          </defs>
          <rect x="0" y="214" width={W} height="26" rx="7" className="fill-emerald-50 dark:fill-emerald-950" />
          <text x={W / 2} y="231" textAnchor="middle" className="fill-emerald-700 dark:fill-emerald-300" fontSize="11" fontWeight="600">Private Network{net?.range ? ` — ${net.range}` : ""}</text>
          {edges.map((e) => <use key={`l${e.id}`} href={`#${e.id}`} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="2" fill="none" />)}
          {edges.flatMap((e) => [0, 1.1].map((delay) => (
            <circle key={`${e.id}-${delay}`} r="3.6" className="fill-brand-500" filter="url(#rxglow)">
              <animateMotion dur="2.2s" begin={`${delay}s`} repeatCount="indefinite"><mpath href={`#${e.id}`} /></animateMotion>
            </circle>
          )))}
        </svg>

        <Card x={internet.x} y={internet.y} tone="border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"><Globe className="mx-auto mb-0.5 h-3.5 w-3.5" />Internet / Cloudflare<div className="text-[9px] opacity-70">app.rxvision.gr</div></Card>
        {lb && <Card x={lbXY.x} y={lbXY.y} tone="border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"><Scale className="mx-auto mb-0.5 h-3.5 w-3.5" />{lb.name}<div className="font-mono text-[9px] opacity-70">{lb.public_ip}</div></Card>}
        {appXY.map((a) => (
          <Card key={a.s.name} x={a.x} y={a.y} tone="border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <Server className="mx-auto mb-0.5 h-3.5 w-3.5 text-brand-600" />{a.s.name}<div className="font-mono text-[9px] opacity-70">{a.s.private_ip}</div>
            <span className={`mt-0.5 inline-block h-1.5 w-1.5 rounded-full ${a.s.status === "running" ? "bg-emerald-500" : "bg-rose-500"}`} />
          </Card>
        ))}
        {dbs.map((s) => (
          <Card key={s.name} x={dbXY.x} y={dbXY.y} tone="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"><Database className="mx-auto mb-0.5 h-3.5 w-3.5" />{s.name}<div className="font-mono text-[9px] opacity-70">{s.private_ip}</div><div className="text-[9px] opacity-70">MongoDB + Redis</div></Card>
        ))}
        {infra.storage && (
          <Card x={stXY.x} y={stXY.y} tone="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"><HardDrive className="mx-auto mb-0.5 h-3.5 w-3.5" />Backup Storage<div className="font-mono text-[9px] opacity-70">{infra.storage.host || "—"}</div><div className="text-[9px] opacity-70">customer data backup</div></Card>
        )}
      </div>
    </div>
  );
}

export function InfraDashboard() {
  const q = useQuery({ queryKey: ["infra"], queryFn: () => adminApi<Infra>("/platform/cloud/infra"), refetchInterval: 12000, retry: false });

  if (q.isLoading) return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900">Φόρτωση υποδομής…</div>;
  if (q.error) return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">Δεν φορτώθηκε η υποδομή (έλεγξε ότι έχει αποθηκευτεί Hetzner token).</div>;
  const infra = q.data!;
  const lb = infra.load_balancers[0];

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
        {infra.servers.map((s) => <ServerCard key={s.name} s={s} />)}
      </div>

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

      <Topology infra={infra} />
    </div>
  );
}
