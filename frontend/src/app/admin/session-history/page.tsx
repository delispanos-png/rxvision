"use client";

/* Ιστορικό συνδέσεων — ποιος μπήκε, πότε, από πού και πόση ώρα έμεινε.

   Η σελίδα «Συνδεδεμένοι» απαντά «ποιος είναι ΤΩΡΑ μέσα» και σβήνεται από TTL 15′ μετά την
   τελευταία κίνηση. Αυτή απαντά «ποιος ήταν μέσα χθες» — και επειδή οι περισσότερες συνεδρίες
   τελειώνουν με κλείσιμο του browser (χωρίς αποσύνδεση), η διάρκεια μετριέται από την
   ΤΕΛΕΥΤΑΙΑ ΚΙΝΗΣΗ, όχι από τη στιγμή που το πρόσεξε το σύστημα. */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { History, Users2, Clock, Timer, Search, X, Monitor } from "lucide-react";

type Row = {
  sid: string; tenant_id?: string; tenant?: string; username?: string; full_name?: string;
  ip?: string; ua?: string; impersonation?: boolean;
  started_at?: string; ended_at?: string | null; last_seen_at?: string | null;
  ended_reason?: string | null; duration_seconds?: number | null; live?: boolean;
};
type Res = {
  items: Row[];
  summary: { sessions: number; people: number; total_seconds: number; avg_seconds: number | null; open_now: number };
};

const REASON: Record<string, string> = {
  logout: "αποσυνδέθηκε", expired: "έκλεισε τον browser", revoked: "αποσυνδέθηκε από διαχειριστή",
};
const dt = (s?: string | null) => (s ? new Date(s).toLocaleString("el-GR",
  { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Athens" }) : "—");

/** Διάρκεια σε ανθρώπινη γλώσσα: «2 ώρες 14′», όχι 8040 δευτερόλεπτα. */
function dur(sec?: number | null) {
  if (sec === null || sec === undefined) return null;
  if (sec < 60) return `${sec}″`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (!h) return `${m}′`;
  return m ? `${h}ω ${m}′` : `${h}ω`;
}

/** Συσκευή από το user-agent — αρκετό για να αναγνωρίσεις «ήταν από το κινητό του». */
function device(ua?: string) {
  const s = (ua || "").toLowerCase();
  if (!s) return "—";
  if (/iphone|ipad|ipod/.test(s)) return "iPhone/iPad";
  if (/android/.test(s)) return "Android";
  if (/edg\//.test(s)) return "Edge";
  if (/chrome/.test(s)) return "Chrome";
  if (/firefox/.test(s)) return "Firefox";
  if (/safari/.test(s)) return "Safari";
  return "άλλο";
}

export default function SessionHistoryPage() {
  const [days, setDays] = useState(30);
  const [q, setQ] = useState("");
  const [imp, setImp] = useState(false);
  const res = useQuery({
    queryKey: ["admin", "session-history", days, imp],
    queryFn: () => adminApi<Res>(`/admin/session-history?days=${days}&include_impersonation=${imp}`),
  });

  const all = res.data?.items ?? [];
  const rows = q.trim()
    ? all.filter((r) => [r.username, r.full_name, r.tenant, r.ip].some((v) => (v || "").toLowerCase().includes(q.trim().toLowerCase())))
    : all;
  const s = res.data?.summary;

  return (
    <div className="w-full space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <History className="h-6 w-6 text-brand-600" />
          <h1 className="text-xl font-bold text-slate-900">Ιστορικό συνδέσεων</h1>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Ποιος συνδέθηκε, πότε, από ποια συσκευή και πόση ώρα έμεινε. Κάθε συνεδρία χωριστά.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { icon: Monitor, label: "Συνεδρίες", v: s ? s.sessions.toLocaleString("el-GR") : "—" },
          { icon: Users2, label: "Διαφορετικοί χρήστες", v: s ? s.people : "—" },
          { icon: Timer, label: "Μέση διάρκεια", v: s?.avg_seconds != null ? dur(s.avg_seconds) : "δεν μετριέται" },
          { icon: Clock, label: "Συνολικός χρόνος", v: s ? dur(s.total_seconds) : "—" },
        ].map((c) => (
          <div key={c.label} className="rounded-2xl border border-slate-200 bg-white p-3.5">
            <c.icon className="h-4 w-4 text-slate-400" />
            <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">{c.v}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{c.label}</div>
          </div>
        ))}
      </section>

      <section className="flex flex-wrap items-center gap-2">
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${days === d ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
            {d} ημέρες
          </button>
        ))}
        <label className="inline-flex items-center gap-1.5 px-2 text-sm text-slate-600">
          <input type="checkbox" checked={imp} onChange={(e) => setImp(e.target.checked)} className="h-4 w-4" />
          + συνδέσεις υποστήριξης
        </label>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Χρήστης, φαρμακείο, IP…"
            className="w-64 rounded-lg border border-slate-300 py-2 pl-8 pr-8 text-sm focus:border-brand-500 focus:outline-none" />
          {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>}
        </div>
      </section>

      <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 text-left font-semibold">Χρήστης</th>
              <th className="px-3 py-2.5 text-left font-semibold">Φαρμακείο</th>
              <th className="px-3 py-2.5 text-left font-semibold">Συνδέθηκε</th>
              <th className="px-3 py-2.5 text-left font-semibold">Αποσυνδέθηκε</th>
              <th className="px-3 py-2.5 text-right font-semibold">Διάρκεια</th>
              <th className="px-3 py-2.5 text-left font-semibold">Συσκευή / IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {res.isLoading && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Φόρτωση…</td></tr>}
            {!res.isLoading && !rows.length && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-400">
                Καμία σύνδεση σε αυτό το διάστημα. Το ιστορικό ξεκινά από τη στιγμή που ενεργοποιήθηκε η καταγραφή.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.sid} className={r.live ? "bg-emerald-50/40" : ""}>
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-800">{r.full_name || r.username}</div>
                  {r.full_name && <div className="text-[11px] text-slate-400">{r.username}</div>}
                  {r.impersonation && <span className="text-[10px] font-bold text-violet-600">υποστήριξη</span>}
                </td>
                <td className="px-3 py-2 text-slate-600">{r.tenant || "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{dt(r.started_at)}</td>
                <td className="px-3 py-2 text-xs">
                  {r.live
                    ? <span className="font-semibold text-emerald-600">● συνδεδεμένος τώρα</span>
                    : <span className="text-slate-600">{dt(r.ended_at)}<span className="ml-1 text-slate-400">({REASON[r.ended_reason || ""] ?? r.ended_reason})</span></span>}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">
                  {r.live
                    ? <span className="text-xs font-normal text-slate-400">σε εξέλιξη</span>
                    : dur(r.duration_seconds) ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{device(r.ua)} · {r.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-[11px] text-slate-400">
        Οι περισσότερες συνεδρίες τελειώνουν με κλείσιμο του browser, όχι με αποσύνδεση. Σε αυτές
        η διάρκεια μετριέται μέχρι την τελευταία κίνηση του χρήστη — όχι μέχρι τη στιγμή που το
        αντιλήφθηκε το σύστημα.
      </p>
    </div>
  );
}
