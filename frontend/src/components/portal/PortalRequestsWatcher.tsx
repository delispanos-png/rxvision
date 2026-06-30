"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Bell, Pill, CalendarClock, PackageCheck, X, ArrowRight } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Pending = { id: string; kind: "availability" | "appointment" | "pickup"; title: string; who: string; when?: string | null };
type Me = { modules?: Record<string, string> };
type Popup = Pending & { key: number };

const SEEN_KEY = "portal_seen_request_ids";
const POLL_MS = 20000;

function loadSeen(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try { return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY) || "[]")); } catch { return new Set(); }
}
function saveSeen(s: Set<string>) {
  try { window.localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500))); } catch { /* quota */ }
}

/** Polls the pharmacy's pending-request feed and pops up a card for each NEW patient request
 * (availability question or appointment booking). Mounted once in the app layout; only active
 * when the tenant has the patient_portal module. Backend enforces the module too. */
export function PortalRequestsWatcher() {
  const router = useRouter();
  const t = useT();
  const { data: me } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false });
  const enabled = me?.modules?.patient_portal === "enabled" || me?.modules?.patient_portal === "trial";

  const { data } = useQuery({
    queryKey: ["portal-pending"],
    queryFn: () => api<{ items: Pending[] }>("/portal/pending"),
    enabled,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });

  const seen = useRef<Set<string>>(loadSeen());
  const hydrated = useRef(false);
  const seq = useRef(0);
  const [popups, setPopups] = useState<Popup[]>([]);

  useEffect(() => {
    if (!data?.items) return;
    const firstEver = !hydrated.current && typeof window !== "undefined" && window.localStorage.getItem(SEEN_KEY) === null;
    hydrated.current = true;
    const fresh = data.items.filter((it) => !seen.current.has(it.id));
    if (fresh.length) { fresh.forEach((it) => seen.current.add(it.id)); saveSeen(seen.current); }
    if (firstEver || !fresh.length) return;  // on the very first run, seed silently (don't pop the backlog)
    const made = fresh.map((it) => ({ ...it, key: ++seq.current }));
    setPopups((p) => [...made, ...p].slice(0, 5));
    // ήχος: single-sourced πλέον στο NotificationBells (repeat 30s + escalation) — εδώ μόνο οι οπτικές κάρτες
    made.forEach((np) => window.setTimeout(() => setPopups((p) => p.filter((x) => x.key !== np.key)), 18000));
  }, [data]);

  if (!enabled || popups.length === 0) return null;

  const dismiss = (key: number) => setPopups((p) => p.filter((x) => x.key !== key));
  const openAdmin = () => { setPopups([]); router.push("/portal-admin"); };

  return (
    <div className="fixed bottom-4 right-4 z-[250] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
      {popups.map((p) => {
        const cfg = p.kind === "availability"
          ? { Icon: Pill, head: t("Νέα ερώτηση διαθεσιμότητας", "New availability question"), bar: "from-sky-500 to-indigo-600", chip: "bg-sky-50 text-sky-600" }
          : p.kind === "pickup"
          ? { Icon: PackageCheck, head: t("Νέα παραλαβή συνταγής", "New prescription pickup"), bar: "from-emerald-500 to-teal-600", chip: "bg-emerald-50 text-emerald-600" }
          : { Icon: CalendarClock, head: t("Νέο αίτημα ραντεβού", "New appointment request"), bar: "from-violet-500 to-fuchsia-600", chip: "bg-violet-50 text-violet-600" };
        const Icon = cfg.Icon;
        return (
          <div key={p.key}
            className="animate-in slide-in-from-bottom-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-pop">
            <div className={`flex items-center gap-2 bg-gradient-to-r px-4 py-2 text-xs font-bold text-white ${cfg.bar}`}>
              <Bell className="h-3.5 w-3.5" />
              {cfg.head}
              <button onClick={() => dismiss(p.key)} className="ml-auto opacity-80 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div className="flex items-start gap-3 p-4">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${cfg.chip}`}><Icon className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-800">{p.title}</div>
                {p.who && <div className="truncate text-xs text-slate-500">{t("από", "from")} {p.who}</div>}
              </div>
            </div>
            <button onClick={openAdmin}
              className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 bg-slate-50 py-2.5 text-sm font-semibold text-brand-700 hover:bg-slate-100">
              {t("Άνοιγμα στην Πύλη Πελατών", "Open in Customer Portal")} <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
