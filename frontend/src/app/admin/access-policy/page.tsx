"use client";

/* Πρόσβαση & αυτοματισμοί — πολιτική κατά AI browsers / μαζικής άντλησης (οδηγία 25/11/2026).

   Φάση 0 = ΜΟΝΟ ΜΕΤΡΗΣΗ. Απαντά σε δύο ερωτήσεις πριν μπει οποιοδήποτε όριο:
   1) «Πόσα αιτήματα το λεπτό κάνει ένας άνθρωπος που δουλεύει κανονικά;» (p99 → από εκεί τα όρια)
   2) «Μπήκε ποτέ κάποιος με AI browser ή script;» (user agent σε συνεδρία χρήστη) */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appPrompt } from "@/store/dialogStore";
import { AccessPolicyPhase2, type AccessSettings, type ExportRow, type OverRow } from "@/components/admin/AccessPolicyPhase2";
import { ShieldAlert, Gauge, Bot, Lock, ShieldCheck } from "lucide-react";

type Pct = { minutes: number; p50: number; p95: number; p99: number; max: number };
type Top = { day: string; kind: string; user: string; tenant?: string | null; tenant_id?: string | null;
  max_per_min: number; total: number; minutes: number; big_limit: number };
type Ev = { at: string; type: string; kind: string; signature?: string; user: string; tenant?: string | null;
  ip?: string; ua?: string; path?: string };
type Sess = { surface: string; tenant_id?: string; ua?: string; ip?: string; at?: string };
type LockRow = { id: string; kind: string; user: string; tenant?: string | null; tenant_id?: string | null;
  reason?: string; at: string; until: string; ip?: string; ua?: string; active: boolean;
  released_at?: string | null; release_reason?: string | null };
type Res = { days: number; kinds: Record<string, Pct>; top_users: Top[]; events: Ev[];
  suspicious_sessions: Sess[]; sessions_without_ua_30d: number; locks: LockRow[]; mode: string;
  settings?: AccessSettings; exports?: ExportRow[]; over_limit?: OverRow[] };
const EV: Record<string, string> = {
  agent_blocked: "Μπλοκαρίστηκε", automation_flagged: "Εντοπίστηκε αυτοματισμός", account_locked: "Κλείδωμα",
  unlocked: "Ξεκλείδωμα", agent_seen: "Εντοπίστηκε",
};

const KIND: Record<string, string> = { tenant: "Εφαρμογή φαρμακείου", patient: "Πύλη πελάτη", admin: "Adminpanel" };
const dt = (s?: string | null) => (s ? new Date(s).toLocaleString("el-GR",
  { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Athens" }) : "—");
const POLICY_LIMIT = 25;   // όριο της οδηγίας (αιτήματα/λεπτό) — ΔΕΝ εφαρμόζεται ακόμη

export default function AccessPolicyPage() {
  const [days, setDays] = useState(7);
  const res = useQuery({
    queryKey: ["admin", "access-policy", days],
    queryFn: () => adminApi<Res>(`/admin/access-policy?days=${days}`),
    refetchInterval: 60000,
  });
  const qc = useQueryClient();
  const d = res.data;
  const kinds = Object.entries(d?.kinds ?? {});
  const activeLocks = (d?.locks ?? []).filter((l) => l.active);

  async function unlock(l: LockRow) {
    const reason = (await appPrompt(
      `Ξεκλείδωμα «${l.user}»${l.tenant ? ` (${l.tenant})` : ""}. Γράψε την αιτιολογία — π.χ. «μίλησα με τον φαρμακοποιό».`,
      { title: "Ξεκλείδωμα λογαριασμού", placeholder: "Αιτιολογία (τουλάχιστον 5 χαρακτήρες)", confirmText: "Ξεκλείδωμα" }))?.trim();
    if (!reason) return;
    if (reason.length < 5) { await appAlert("Η αιτιολογία χρειάζεται τουλάχιστον 5 χαρακτήρες."); return; }
    try {
      await adminApi(`/admin/access-policy/locks/${l.id}/unlock`, { method: "POST", body: JSON.stringify({ reason }) });
      await qc.invalidateQueries({ queryKey: ["admin", "access-policy"] });
    } catch {
      await appAlert("Το ξεκλείδωμα απέτυχε.");
    }
  }

  return (
    <div className="w-full space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-6 w-6 text-brand-600" />
          <h1 className="text-xl font-bold text-slate-900">Πρόσβαση & αυτοματισμοί</h1>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Μπαίνει κανείς με AI browser ή script; Πόσο γρήγορα δουλεύει ένας κανονικός χρήστης; Από εδώ θα βγουν
          τα όρια της πολιτικής πρόσβασης.
        </p>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
          <ShieldCheck className="h-3.5 w-3.5" /> AI browsers & αυτοματισμοί: μπλοκάρονται · όρια ρυθμού & εξαγωγών: {d?.mode === "enforce" ? "επιβολή" : "μέτρηση"}
        </div>
      </header>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"><Lock className="h-4 w-4" /> Κλειδωμένοι λογαριασμοί</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Χρήστης / φαρμακείο</th>
                <th className="px-3 py-2.5 text-left font-semibold">Αιτία</th>
                <th className="px-3 py-2.5 text-left font-semibold">Κλειδώθηκε</th>
                <th className="px-3 py-2.5 text-left font-semibold">Έως</th>
                <th className="px-3 py-2.5 text-left font-semibold">IP</th>
                <th className="px-3 py-2.5 text-right font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!d?.locks?.length && <tr><td colSpan={6} className="p-6 text-center text-emerald-700">Κανένας κλειδωμένος λογαριασμός.</td></tr>}
              {d?.locks?.map((l) => (
                <tr key={l.id} className={l.active ? "bg-rose-50/40" : ""}>
                  <td className="px-4 py-2"><div className="font-medium text-slate-800">{l.user}</div>
                    <div className="text-[11px] text-slate-400">{KIND[l.kind] ?? l.kind}{l.tenant ? ` · ${l.tenant}` : ""}</div></td>
                  <td className="px-3 py-2 text-xs text-slate-600">{l.reason}</td>
                  <td className="px-3 py-2 text-slate-600">{dt(l.at)}</td>
                  <td className="px-3 py-2 text-slate-600">{l.active ? dt(l.until) : (l.released_at ? `ξεκλειδώθηκε ${dt(l.released_at)}` : "έληξε")}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{l.ip || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {l.active
                      ? <button onClick={() => unlock(l)} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">Ξεκλείδωμα</button>
                      : l.release_reason ? <span className="text-[11px] text-slate-400" title={l.release_reason}>{l.release_reason}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!!activeLocks.length && <p className="mt-1 text-[11px] text-slate-400">Ξεκλείδωμα μόνο αφού μιλήσεις με τον πελάτη. Καταγράφεται ποιος ξεκλείδωσε και γιατί.</p>}
      </section>

      <section className="flex flex-wrap items-center gap-2">
        {[1, 7, 30].map((n) => (
          <button key={n} onClick={() => setDays(n)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${days === n ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
            {n === 1 ? "Σήμερα" : `${n} ημέρες`}
          </button>
        ))}
      </section>

      <AccessPolicyPhase2 settings={d?.settings} over={d?.over_limit ?? []} exports={d?.exports ?? []} />

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"><Gauge className="h-4 w-4" /> Αιτήματα ανά λεπτό, ανά χρήστη</h2>
        {res.isLoading && <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">Φόρτωση…</div>}
        {!res.isLoading && !kinds.length && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
            Δεν υπάρχουν ακόμη μετρήσεις. Τα πρώτα λεπτά εμφανίζονται μέσα σε ~5′ από την ενεργοποίηση.
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          {kinds.map(([k, p]) => (
            <div key={k} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{KIND[k] ?? k}</div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center">
                {(["p50", "p95", "p99", "max"] as const).map((q) => (
                  <div key={q}>
                    <div className={`text-xl font-bold tabular-nums ${q !== "max" && p[q] > POLICY_LIMIT ? "text-rose-600" : "text-slate-900"}`}>{p[q]}</div>
                    <div className="text-[11px] text-slate-400">{q === "max" ? "μέγιστο" : q}</div>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11px] text-slate-400">{p.minutes.toLocaleString("el-GR")} ενεργά λεπτά χρηστών · όριο οδηγίας {POLICY_LIMIT}/λεπτό</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-700">Οι πιο «γρήγοροι» χρήστες</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Χρήστης</th>
                <th className="px-3 py-2.5 text-left font-semibold">Φαρμακείο</th>
                <th className="px-3 py-2.5 text-left font-semibold">Ημέρα</th>
                <th className="px-3 py-2.5 text-right font-semibold">Μέγιστο/λεπτό</th>
                <th className="px-3 py-2.5 text-right font-semibold">Αιτήματα</th>
                <th className="px-3 py-2.5 text-right font-semibold">Ενεργά λεπτά</th>
                <th className="px-3 py-2.5 text-right font-semibold">Λίστες &gt;50</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!d?.top_users.length && <tr><td colSpan={7} className="p-6 text-center text-slate-400">—</td></tr>}
              {d?.top_users.map((t, i) => (
                <tr key={i}>
                  <td className="px-4 py-2"><div className="font-medium text-slate-800">{t.user}</div>
                    <div className="text-[11px] text-slate-400">{KIND[t.kind] ?? t.kind}</div></td>
                  <td className="px-3 py-2 text-slate-600">{t.tenant || t.tenant_id || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{t.day.split("-").reverse().join("/")}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${t.max_per_min > POLICY_LIMIT ? "text-rose-600" : "text-slate-800"}`}>{t.max_per_min}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{t.total.toLocaleString("el-GR")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{t.minutes}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{t.big_limit || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"><Bot className="h-4 w-4" /> AI browser / αυτοματισμός σε συνεδρία χρήστη — γεγονότα 30 ημερών</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Πότε</th>
                <th className="px-3 py-2.5 text-left font-semibold">Γεγονός</th>
                <th className="px-3 py-2.5 text-left font-semibold">Χρήστης / φαρμακείο</th>
                <th className="px-3 py-2.5 text-left font-semibold">IP</th>
                <th className="px-3 py-2.5 text-left font-semibold">User agent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!d?.events.length && !d?.suspicious_sessions.length && (
                <tr><td colSpan={5} className="p-6 text-center text-emerald-700">Κανένα εύρημα.</td></tr>
              )}
              {d?.events.map((e, i) => (
                <tr key={`e${i}`} className="bg-rose-50/40">
                  <td className="px-4 py-2 text-slate-600">{dt(e.at)}</td>
                  <td className="px-3 py-2"><div className="font-semibold text-rose-700">{EV[e.type] ?? e.type}</div>
                    <div className="text-[11px] text-slate-500">{e.signature || e.path}</div></td>
                  <td className="px-3 py-2 text-slate-700">{e.user}<div className="text-[11px] text-slate-400">{KIND[e.kind] ?? e.kind}{e.tenant ? ` · ${e.tenant}` : ""}</div></td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{e.ip}</td>
                  <td className="max-w-[340px] truncate px-3 py-2 text-xs text-slate-500" title={e.ua}>{e.ua}</td>
                </tr>
              ))}
              {d?.suspicious_sessions.map((s, i) => (
                <tr key={`s${i}`}>
                  <td className="px-4 py-2 text-slate-600">{dt(s.at)}</td>
                  <td className="px-3 py-2 text-slate-700">συνεδρία ({s.surface === "app" ? "εφαρμογή" : "πύλη"})</td>
                  <td className="px-3 py-2 text-slate-500">{s.tenant_id || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{s.ip || "—"}</td>
                  <td className="max-w-[340px] truncate px-3 py-2 text-xs text-slate-500" title={s.ua}>{s.ua}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!!d?.sessions_without_ua_30d && (
          <p className="mt-2 text-xs text-slate-400">
            {d.sessions_without_ua_30d} συνεδρίες των τελευταίων 30 ημερών δεν έχουν user agent (παλιό σφάλμα: το refresh τον έσβηνε — διορθώθηκε 25/11/2026).
          </p>
        )}
      </section>
    </div>
  );
}
