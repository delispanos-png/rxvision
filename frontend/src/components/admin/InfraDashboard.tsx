"use client";

import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Server, Database, Scale, Globe, Cpu, MemoryStick, Activity, RefreshCw, Network } from "lucide-react";

type Srv = {
  name: string; role: "app" | "db" | "lb"; status: string | null; type: string | null;
  cores: number | null; memory_gb: number | null; disk_gb: number | null;
  public_ip: string | null; private_ip: string | null; location: string | null;
  cpu: number | null; ram_pct: number | null; load: number | null; metrics_live: boolean;
};
type LB = { name: string; public_ip: string | null; private_ip: string | null; services: string[]; targets: { name: string; healthy: boolean | null }[] };
type Net = { name: string; range: string | null; members: string[] };
type Infra = { servers: Srv[]; load_balancers: LB[]; networks: Net[]; fetched_at: string };

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
  const Node = ({ children, tone }: { children: React.ReactNode; tone: string }) => (
    <div className={`rounded-xl border px-3 py-2 text-center text-xs ${tone}`}>{children}</div>
  );
  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white p-5 dark:border-slate-700 dark:from-slate-900 dark:to-slate-950">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Network className="h-4 w-4" /> Τοπολογία δικτύου</h3>
      <div className="flex flex-col items-center gap-2">
        <Node tone="border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"><Globe className="mx-auto mb-0.5 h-4 w-4" />Internet / Cloudflare<div className="text-[10px] opacity-70">app.rxvision.gr</div></Node>
        <div className="h-4 w-px bg-slate-300 dark:bg-slate-600" />
        {lb && <Node tone="border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"><Scale className="mx-auto mb-0.5 h-4 w-4" />{lb.name}<div className="font-mono text-[10px] opacity-70">{lb.public_ip}</div></Node>}
        <div className="h-4 w-px bg-slate-300 dark:bg-slate-600" />
        <div className="w-full rounded-lg bg-emerald-50 py-1 text-center text-[11px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Private Network {net ? `— ${net.range}` : ""}</div>
        <div className="mt-1 flex flex-wrap items-start justify-center gap-3">
          {apps.map((s) => (
            <Node key={s.name} tone="border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              <Server className="mx-auto mb-0.5 h-4 w-4 text-brand-600" />{s.name}<div className="font-mono text-[10px] opacity-70">{s.private_ip}</div>
              <span className={`mt-1 inline-block h-1.5 w-1.5 rounded-full ${s.status === "running" ? "bg-emerald-500" : "bg-rose-500"}`} />
            </Node>
          ))}
        </div>
        {dbs.length > 0 && <div className="h-4 w-px bg-slate-300 dark:bg-slate-600" />}
        <div className="flex flex-wrap justify-center gap-3">
          {dbs.map((s) => (
            <Node key={s.name} tone="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300">
              <Database className="mx-auto mb-0.5 h-4 w-4" />{s.name}<div className="font-mono text-[10px] opacity-70">{s.private_ip}</div><div className="text-[10px] opacity-70">MongoDB + Redis</div>
            </Node>
          ))}
        </div>
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
