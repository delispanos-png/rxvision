"use client";

import { useEffect, useRef, useState } from "react";
import { Headset, MousePointerClick } from "lucide-react";
import type { Replayer, eventWithTime } from "rrweb";
import "rrweb/dist/style.css";

import { ApiError, adminApi } from "@/lib/adminClient";
import { unpackEvents } from "@/lib/supportLiveCodec";

const KEY = "support_live_admin_sid";
const POLL_MS = 1000;
const IDLE_WARNING_S = 15;
const ONLINE_MS = 15000;

type Info = { tenant_name?: string; user_label?: string; tenant_id?: string };
type Online = { login_sid: string; tenant_name: string; user_label: string; last_active_at: string };
type Pull = { status: "live" | "ended"; batches: string[]; customer_idle: number };

const stored = (): string | null => {
  try { return window.sessionStorage.getItem(KEY); } catch { return null; }
};
const remember = (sid: string | null) => {
  try {
    if (sid) window.sessionStorage.setItem(KEY, sid);
    else window.sessionStorage.removeItem(KEY);
  } catch { /* χωρίς storage απλώς χάνεται η επανασύνδεση μετά από ανανέωση */ }
};

export default function SupportLivePage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [sid, setSid] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [idle, setIdle] = useState(0);
  const [hasScreen, setHasScreen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [online, setOnline] = useState<Online[]>([]);
  const [filter, setFilter] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer | null>(null);
  const scale = useRef(1);

  const fit = (width: number, height: number) => {
    const el = stage.current;
    if (!el || !width) return;
    const s = Math.min(1, el.clientWidth / width);
    scale.current = s;
    el.style.height = `${height * s}px`;
    const wrapper = el.querySelector<HTMLElement>(".replayer-wrapper");
    if (wrapper) { wrapper.style.transform = `scale(${s})`; wrapper.style.transformOrigin = "top left"; }
  };

  const finish = () => {
    replayer.current?.destroy();
    replayer.current = null;
    remember(null);
    setSid(null);
    setInfo(null);
    setHasScreen(false);
  };

  useEffect(() => {
    const sid0 = stored();
    if (!sid0) return;
    adminApi<Info>(`/admin/support-live/${sid0}/resume`, { method: "POST" })
      .then((i) => { setInfo(i); setSid(sid0); })
      .catch(() => remember(null));
  }, []);

  useEffect(() => {
    if (!sid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const show = async (events: eventWithTime[]) => {
      if (!events.length || !stage.current) return;
      if (!replayer.current) {
        const { Replayer: Player } = await import("rrweb");
        // ΠΟΤΕ UNSAFE_replayCanvas: ανοίγει scripts στο iframe, μέσα στο adminpanel.
        const r = new Player([], { root: stage.current, liveMode: true, mouseTail: false, showWarning: false });
        r.on("resize", (d) => { const { width, height } = d as { width: number; height: number }; fit(width, height); });
        r.startLive(events[0].timestamp - POLL_MS);
        replayer.current = r;
        setHasScreen(true);
      }
      events.forEach((e) => replayer.current?.addEvent(e));
    };
    const tick = async () => {
      try {
        const res = await adminApi<Pull>(`/admin/support-live/${sid}/events`);
        for (const b of res.batches) await show(await unpackEvents<eventWithTime>(b));
        setIdle(res.customer_idle);
        if (res.status === "ended") { setEnded(true); finish(); return; }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { setEnded(true); finish(); return; }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sid]);

  useEffect(() => {
    if (sid) return;
    const load = () => adminApi<{ items: Online[] }>("/admin/support-live/online")
      .then((r) => setOnline(r.items)).catch(() => undefined);
    load();
    const id = setInterval(load, ONLINE_MS);
    return () => clearInterval(id);
  }, [sid]);

  const connect = async (login_sid: string) => {
    setError("");
    setEnded(false);
    try {
      const res = await adminApi<Info & { sid: string }>(`/admin/support-live/connect`, {
        method: "POST", body: JSON.stringify({ login_sid }) });
      remember(res.sid);
      setInfo(res);
      setSid(res.sid);
    } catch {
      setError("Ο πελάτης δεν είναι πια συνδεδεμένος.");
    }
  };

  const join = async () => {
    setError("");
    setEnded(false);
    try {
      const res = await adminApi<Info & { sid: string }>(`/admin/support-live/join`, {
        method: "POST", body: JSON.stringify({ code }) });
      remember(res.sid);
      setInfo(res);
      setSid(res.sid);
      setCode("");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404
        ? "Ο κωδικός δεν ισχύει. Ζητήστε από τον πελάτη να ξεκινήσει ξανά."
        : "Δεν έγινε η σύνδεση. Δοκιμάστε ξανά.");
    }
  };

  const end = async () => {
    if (sid) await adminApi(`/admin/support-live/${sid}/end`, { method: "POST" }).catch(() => undefined);
    finish();
  };

  const point = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sid) return;
    const box = e.currentTarget.getBoundingClientRect();
    const body = JSON.stringify({ x: (e.clientX - box.left) / scale.current, y: (e.clientY - box.top) / scale.current });
    adminApi(`/admin/support-live/${sid}/pointer`, { method: "POST", body }).catch(() => undefined);
  };

  const needle = filter.trim().toLowerCase();
  const visible = online.filter((s) => !needle || `${s.tenant_name} ${s.user_label}`.toLowerCase().includes(needle));

  return (
    <div className="w-full">
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold text-slate-900"><Headset className="h-6 w-6" /> Ζωντανή υποστήριξη</h1>
      {!sid && (
        <div className="mt-4 max-w-md rounded-xl border border-slate-200 bg-white p-5">
          <p className="mb-3 text-sm text-slate-600">Ο πελάτης πατά <b>Βοήθεια → Ζωντανή υποστήριξη → Έναρξη</b> και σας λέει τον 6ψήφιο κωδικό.</p>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter" && code.length === 6) join(); }}
              inputMode="numeric" placeholder="000000" aria-label="Κωδικός πελάτη"
              className="w-36 rounded-lg border border-slate-300 px-3 py-2 text-center text-lg tracking-widest focus:border-brand-500 focus:outline-none" />
            <button type="button" onClick={join} disabled={code.length !== 6}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">Σύνδεση</button>
          </div>
          {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
          {ended && !error && <p className="mt-2 text-sm text-slate-500">Η συνεδρία τελείωσε.</p>}
        </div>
      )}
      {!sid && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">Συνδεδεμένοι τώρα ({online.length})</h2>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Αναζήτηση φαρμακείου ή χρήστη"
              className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <p className="mb-3 text-xs text-slate-500">Με τη σύνδεση χωρίς κωδικό, ο πελάτης βλέπει στο πάνω μέρος της οθόνης το όνομά σας και μπορεί να σας τερματίσει.</p>
          {visible.length === 0 && <p className="text-sm text-slate-500">Κανένας συνδεδεμένος.</p>}
          <ul className="divide-y divide-slate-100">
            {visible.map((s) => (
              <li key={s.login_sid} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span><b>{s.tenant_name}</b> · {s.user_label}</span>
                <button type="button" onClick={() => connect(s.login_sid)}
                  className="rounded-lg border border-brand-300 px-3 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">Σύνδεση</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sid && (
        <div className="mb-3 mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
          <span><b>{info?.tenant_name}</b> · {info?.user_label}</span>
          <span className="inline-flex items-center gap-1 text-slate-400"><MousePointerClick className="h-4 w-4" /> Κλικ στην εικόνα: δείχνει το σημείο στον πελάτη</span>
          {idle > IDLE_WARNING_S && <span className="font-medium text-amber-600">Ο πελάτης δεν ανταποκρίνεται εδώ και {idle}″</span>}
          <button type="button" onClick={end} className="ml-auto rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50">Τερματισμός</button>
        </div>
      )}
      {sid && !hasScreen && <p className="text-sm text-slate-500">Αναμονή για την οθόνη του πελάτη… Έρχεται σε 10″ αν έχει ανοιχτή την εφαρμογή μπροστά του.</p>}
      <div className={`relative w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 ${sid ? "" : "hidden"}`}>
        <div ref={stage} className="relative w-full" />
        {hasScreen && <div onClick={point} className="absolute inset-0 z-10 cursor-crosshair" />}
      </div>
    </div>
  );
}
