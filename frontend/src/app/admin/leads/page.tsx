"use client";

/* Leads & Conversions — η οθόνη απαντά ΜΙΑ ερώτηση:
   «ποιο φαρμακείο χρειάζεται την προσοχή μου σήμερα και τι να του πω;»
   Ό,τι δεν βοηθά σε αυτό δεν μπαίνει. Γι' αυτό το «Σήμερα» είναι ΠΑΝΩ από τις μετρήσεις. */

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users, Search, RefreshCw, Phone, Mail, Loader2, ArrowRight, Settings2, X,
} from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appAlert } from "@/store/dialogStore";

type Suggestion = { action: string; title: string; why: string; urgency: string; buttons: string[] };
type Row = {
  _id: string; pharmacy_name: string; city?: string | null; tenant_id?: string | null;
  stage: string; stage_label: string; status: string; status_label?: string;
  days_since_expiry?: number | null; days_left?: number | null;
  score?: number | null; band?: string; band_label?: string;
  days_since_activity?: number | null; actions_30d?: number | null;
  has_email: boolean; has_phone: boolean; tags: string[];
  assigned_name?: string | null;
  next_action?: { title?: string; due_at?: string; priority?: string } | null;
  last_comm_at?: string | null; suggestion: Suggestion;
};
type Today = { tone: string; icon: string; n: number; text: string; link: { kind: string; value: string } };
type Kpis = {
  total: number; trialing: number; ending: number; expired: number; needs_contact: number;
  reengage: number; offers_sent: number; customers: number; lost: number;
  conversion: { won: number; of: number } | null; contacted_30d: number | null;
};
type Seg = { key: string; icon: string; name: string; why: string; count: number };
type Tab = { key: string; label: string; count: number };
type Overview = { today: Today[]; kpis: Kpis; tabs: Tab[]; segments: Seg[]; last_projection_at?: string | null };

const TONE: Record<string, string> = {
  red: "border-rose-200 bg-rose-50 text-rose-900 hover:bg-rose-100",
  orange: "border-orange-200 bg-orange-50 text-orange-900 hover:bg-orange-100",
  yellow: "border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100",
  green: "border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100",
  slate: "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100",
};
// Ενιαία κλίμακα κρισιμότητας: ίδιο χρώμα = ίδια σημασία σε όλο το προϊόν.
const BAND: Record<string, { bar: string; text: string }> = {
  hot: { bar: "bg-emerald-500", text: "text-emerald-700" },
  engaged: { bar: "bg-sky-500", text: "text-sky-700" },
  warm: { bar: "bg-amber-500", text: "text-amber-700" },
  cold: { bar: "bg-rose-400", text: "text-rose-600" },
  unknown: { bar: "bg-slate-300", text: "text-slate-400" },
};
const URGENCY: Record<string, string> = {
  high: "bg-rose-600 text-white hover:bg-rose-700",
  normal: "bg-indigo-600 text-white hover:bg-indigo-700",
  low: "bg-white text-slate-600 border border-slate-300 hover:bg-slate-50",
};

const ago = (iso?: string | null) => {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "σήμερα";
  if (d === 1) return "χθες";
  if (d < 30) return `πριν ${d} μέρες`;
  const m = Math.floor(d / 30);
  return m === 1 ? "πριν έναν μήνα" : `πριν ${m} μήνες`;
};

function ScoreBar({ value, band, label }: { value?: number | null; band?: string; label?: string }) {
  const b = BAND[band || "unknown"] ?? BAND.unknown;
  if (value === null || value === undefined) {
    return <span className="text-[11px] text-slate-400" title="Ο λογαριασμός διαγράφηκε πριν αρχίσουμε να μετράμε">δεν μετριέται</span>;
  }
  return (
    <div className="flex items-center gap-2" title={label}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${b.bar}`} style={{ width: `${Math.max(4, value)}%` }} />
      </div>
      <span className={`text-[11px] font-bold tabular-nums ${b.text}`}>{value}</span>
    </div>
  );
}

export default function AdminLeadsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("attention");
  const [segment, setSegment] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showCfg, setShowCfg] = useState(false);

  const ov = useQuery({ queryKey: ["leads", "overview"], queryFn: () => adminApi<Overview>("/admin/leads/overview") });
  const list = useQuery({
    queryKey: ["leads", "list", tab, segment, q],
    queryFn: () => adminApi<{ items: Row[]; total: number }>(
      `/admin/leads?tab=${tab}${segment ? `&segment=${segment}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  const refresh = useMutation({
    mutationFn: () => adminApi<{ total: number }>("/admin/leads/refresh", { method: "POST" }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["leads"] }); appAlert(`Η λίστα ανανεώθηκε — ${r.total} φαρμακεία.`); },
  });

  const k = ov.data?.kpis;
  const rows = list.data?.items ?? [];

  // Οι γραμμές του «Σήμερα» ΟΔΗΓΟΥΝ κάπου. Γραμμή που δεν οδηγεί πουθενά δεν μπαίνει.
  function goto(link: Today["link"]) {
    if (link.kind === "tab") { setSegment(null); setTab(link.value); }
    else if (link.kind === "segment") { setTab("all"); setSegment(link.value); }
    else if (link.kind === "tasks") { setSegment(null); setTab("attention"); }
    document.getElementById("lead-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="w-full space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-indigo-600 text-white"><Users className="h-6 w-6" /></div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Leads &amp; Conversions</h1>
            <p className="text-sm text-slate-500">Διαχειρίσου τα φαρμακεία που δοκιμάζουν, επιστρέφουν και γίνονται πελάτες του RxVision.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowCfg(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"><Settings2 className="h-4 w-4" />Ρυθμίσεις</button>
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {refresh.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Ανανέωση
          </button>
        </div>
      </header>

      {/* ΣΗΜΕΡΑ — πάνω από τις μετρήσεις, γιατί γι' αυτό ανοίγεις τη σελίδα */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2.5 text-sm font-bold uppercase tracking-wider text-slate-400">Σήμερα</h2>
        {ov.isLoading && <p className="text-sm text-slate-400">Φόρτωση…</p>}
        {!ov.isLoading && !(ov.data?.today ?? []).length && (
          <p className="text-sm text-slate-500">Κανένα φαρμακείο δεν χρειάζεται προσοχή αυτή τη στιγμή. Όσα δοκιμάζουν είναι μέσα στον χρόνο τους.</p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {(ov.data?.today ?? []).map((t, i) => (
            <button key={i} onClick={() => goto(t.link)} className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm font-semibold transition ${TONE[t.tone] ?? TONE.slate}`}>
              <span className="text-base">{t.icon}</span>
              <span className="flex-1">{t.text}</span>
              <ArrowRight className="h-4 w-4 shrink-0 opacity-50" />
            </button>
          ))}
        </div>
      </section>

      {/* Μετρήσεις — πραγματικές. Ό,τι δεν υπολογίζεται λέει «δεν μετριέται ακόμη». */}
      <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Δοκιμάζουν", v: k?.trialing, tab: "trialing" },
          { label: "Τελειώνουν", v: k?.ending, tab: "ending" },
          { label: "Έληξαν", v: k?.expired, tab: "expired" },
          { label: "Θέλουν επικοινωνία", v: k?.needs_contact, tab: "attention" },
          { label: "Πήραν προσφορά", v: k?.offers_sent, tab: "all" },
          { label: "Έγιναν πελάτες", v: k?.customers, tab: "customers" },
        ].map((c) => (
          <button key={c.label} onClick={() => { setSegment(null); setTab(c.tab); }} className="rounded-2xl border border-slate-200 bg-white p-3.5 text-left transition hover:border-indigo-300 hover:shadow-sm">
            <div className="text-2xl font-bold tabular-nums text-slate-900">{c.v ?? "—"}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{c.label}</div>
          </button>
        ))}
      </section>
      {k?.conversion && (
        <p className="-mt-2 text-xs text-slate-500">
          Έγιναν πελάτες <b className="text-slate-700">{k.conversion.won} από {k.conversion.of}</b> φαρμακεία που δοκίμασαν.
        </p>
      )}

      {/* Έτοιμα τμήματα */}
      <section className="flex flex-wrap gap-2">
        {(ov.data?.segments ?? []).filter((s) => s.count > 0).map((s) => (
          <button key={s.key} onClick={() => { setTab("all"); setSegment(segment === s.key ? null : s.key); }} title={s.why}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${segment === s.key ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
            <span>{s.icon}</span>{s.name}<span className="rounded-full bg-slate-100 px-1.5 tabular-nums">{s.count}</span>
          </button>
        ))}
      </section>

      {/* Φίλτρα + αναζήτηση */}
      <section id="lead-table" className="flex flex-wrap items-center gap-2">
        {(ov.data?.tabs ?? []).map((t) => (
          <button key={t.key} onClick={() => { setTab(t.key); setSegment(null); }}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${tab === t.key && !segment ? "bg-indigo-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
            {t.label} <span className="tabular-nums opacity-60">{t.count}</span>
          </button>
        ))}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Φαρμακείο, ΑΦΜ, email, πόλη…"
            className="w-64 rounded-lg border border-slate-300 py-2 pl-8 pr-8 text-sm focus:border-indigo-500 focus:outline-none" />
          {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>}
        </div>
      </section>
      {segment && (
        <p className="-mt-2 text-xs text-indigo-700">
          Φιλτράρεις με «{ov.data?.segments.find((s) => s.key === segment)?.name}».{" "}
          <button onClick={() => setSegment(null)} className="font-semibold underline">Καθάρισε</button>
        </p>
      )}

      {/* Ο πίνακας — επτά στήλες, όχι δεκατέσσερις */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="hidden grid-cols-[1.6fr_1fr_0.8fr_0.7fr_1.3fr] gap-3 border-b border-slate-100 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 lg:grid">
          <span>Φαρμακείο</span><span>Κατάσταση</span><span>Δραστηριότητα</span><span>Τελευταία κίνηση</span><span>Τι κάνω</span>
        </div>
        {list.isLoading && <p className="p-8 text-center text-sm text-slate-400">Φόρτωση…</p>}
        {!list.isLoading && !rows.length && (
          <p className="p-8 text-center text-sm text-slate-400">
            Κανένα φαρμακείο εδώ.{" "}
            <button onClick={() => { setTab("all"); setSegment(null); }} className="font-semibold text-indigo-600 underline">Δες όλα</button>
          </p>
        )}
        {rows.map((r) => (
          <Link key={r._id} href={`/admin/leads/${encodeURIComponent(r._id)}`}
            className="grid gap-2 border-b border-slate-50 px-4 py-3 transition last:border-0 hover:bg-slate-50 lg:grid-cols-[1.6fr_1fr_0.8fr_0.7fr_1.3fr] lg:items-center lg:gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-800">{r.pharmacy_name}</div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                {r.city && <span>{r.city}</span>}
                {!r.has_email && !r.has_phone && <span className="font-semibold text-rose-500">χωρίς στοιχεία επαφής</span>}
                {r.has_phone && <Phone className="h-3 w-3" />}
                {r.has_email && <Mail className="h-3 w-3" />}
                {r.assigned_name && <span className="rounded bg-slate-100 px-1.5 font-semibold text-slate-500">{r.assigned_name}</span>}
              </div>
            </div>
            <div className="text-xs">
              <div className="font-semibold text-slate-700">{r.stage_label}</div>
              <div className="text-slate-400">
                {r.days_since_expiry != null ? `πριν ${r.days_since_expiry} μέρες`
                  : r.days_left != null ? `σε ${r.days_left} μέρες` : (r.status_label ?? "")}
              </div>
            </div>
            <ScoreBar value={r.score} band={r.band} label={r.band_label} />
            <div className="text-xs text-slate-500">{r.days_since_activity != null ? ago(new Date(Date.now() - r.days_since_activity * 86400000).toISOString()) : "—"}</div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center rounded-lg px-2.5 py-1.5 text-[11px] font-bold ${URGENCY[r.suggestion.urgency] ?? URGENCY.low}`}>{r.suggestion.title}</span>
            </div>
          </Link>
        ))}
      </section>

      {ov.data?.last_projection_at && (
        <p className="text-[11px] text-slate-400">Τελευταία ανανέωση δεδομένων: {new Date(ov.data.last_projection_at).toLocaleString("el-GR", { timeZone: "Europe/Athens" })}</p>
      )}

      {showCfg && <ConfigPanel onClose={() => { setShowCfg(false); qc.invalidateQueries({ queryKey: ["leads"] }); }} />}
    </div>
  );
}

/* Ρυθμίσεις: τα κατώφλια είναι εμπορικές αποφάσεις, όχι τεχνικές σταθερές. */
function ConfigPanel({ onClose }: { onClose: () => void }) {
  const cfg = useQuery({ queryKey: ["leads", "config"], queryFn: () => adminApi<Record<string, number>>("/admin/leads/config") });
  const [v, setV] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => adminApi("/admin/leads/config", { method: "PUT", body: JSON.stringify(
      Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "").map(([kk, x]) => [kk, Number(x)]))) }),
    onSuccess: onClose,
  });
  const F: [string, string][] = [
    ["trial_ending_days", "Πόσες μέρες πριν τη λήξη λέμε «τελειώνει»"],
    ["returned_after_days", "Σιωπή τόσων ημερών ώστε η επιστροφή να μετρήσει ως σήμα"],
    ["inactive_days", "Πάνω από τόσες μέρες χωρίς κίνηση = «δεν έχει επιστρέψει»"],
    ["signup_abandoned_hours", "Ώρες μέχρι μια ημιτελής εγγραφή να γίνει lead"],
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-bold text-slate-900">Ρυθμίσεις Leads</h3>
        <p className="mb-4 text-xs text-slate-500">Αλλάζοντας αυτά αλλάζουν και τα φίλτρα — δεν είναι γραμμένα στον κώδικα.</p>
        <div className="space-y-3">
          {F.map(([kk, label]) => (
            <label key={kk} className="block">
              <span className="text-xs font-semibold text-slate-600">{label}</span>
              <input type="number" value={v[kk] ?? ""} placeholder={String(cfg.data?.[kk] ?? "")}
                onChange={(e) => setV({ ...v, [kk]: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600">Άκυρο</button>
          <button onClick={() => save.mutate()} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">Αποθήκευση</button>
        </div>
      </div>
    </div>
  );
}
