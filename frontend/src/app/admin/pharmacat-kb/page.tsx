"use client";

import { useState } from "react";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useQuery } from "@tanstack/react-query";
import { Brain, Search, Trash2, Pencil, Save, X, Loader2, RefreshCw, ThumbsDown, AlertTriangle } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Report = { reason: string | null; at: string | null };
type Entry = {
  sig: string;
  query: string | null;
  reply: string;
  substances: string[];
  otc_categories: string[];
  stage: string | null;
  hits: number;
  flag_open: boolean;
  flag_count: number;
  reports: Report[];
  edited_at: string | null;
  last_at: string | null;
  created_at: string | null;
  scope?: "shared" | "GR" | "CY";
};
type Stats = {
  days: number;
  entries: { total: number; new: number; never_used: number; edited: number; reuses: number; scope: { shared: number; GR: number; CY: number } };
  questions: { total: number; cache: number; llm: number; GR: number; CY: number; chat: number; interaction: number; hit_rate: number | null };
  flags: { new: number; resolved: number; open: number };
  top_all: { sig: string; query: string | null; hits: number; scope: string }[];
  top_period: { sig: string; query: string | null; n: number }[];
};
const PERIODS: [number, string][] = [[7, "7 ημέρες"], [30, "30 ημέρες"], [90, "90 ημέρες"], [365, "12 μήνες"], [0, "Όλο"]];
const SCOPE: Record<string, [string, string]> = {
  shared: ["Κοινή", "bg-slate-100 text-slate-600"],
  GR: ["Μόνο Ελλάδα", "bg-sky-100 text-sky-700"],
  CY: ["Μόνο Κύπρος", "bg-amber-100 text-amber-800"],
};
const nf = (n: number | null | undefined) => (n ?? 0).toLocaleString("el-GR");

function Kpi({ label, value, sub, tone = "text-slate-800", hint }: { label: string; value: string; sub?: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3" title={hint}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-2xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}
type ListRes = { page: number; page_size: number; total: number; flagged_total: number; items: Entry[] };

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("el-GR") : "—");

export default function PharmaCatKbPage() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ query: string; reply: string; substances: string; otc: string }>({ query: "", reply: "", substances: "", otc: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [sort, setSort] = useState("recent");
  const stats = useQuery({
    queryKey: ["admin", "pharmacat-kb", "stats", days],
    queryFn: () => adminApi<Stats>("/admin/pharmacat-kb/stats?days=" + days),
    retry: false,
  });

  const list = useQuery({
    queryKey: ["admin", "pharmacat-kb", term, onlyFlagged, sort],
    queryFn: () => adminApi<ListRes>("/admin/pharmacat-kb?page_size=60&sort=" + sort + "&flagged=" + onlyFlagged + "&q=" + encodeURIComponent(term)),
    retry: false,
  });

  async function dismiss(sig: string) {
    if (!(await appConfirm("Απόρριψη της αναφοράς (χωρίς διόρθωση); Θα θεωρηθεί ότι η απάντηση ήταν σωστή.", { title: "Απόρριψη αναφοράς", confirmText: "Απόρριψη" }))) return;
    setBusy(sig);
    try { await adminApi("/admin/pharmacat-kb/" + sig + "/resolve", { method: "POST" }); await list.refetch(); }
    finally { setBusy(null); }
  }

  function startEdit(e: Entry) {
    setEditing(e.sig);
    setDraft({ query: e.query || "", reply: e.reply, substances: e.substances.join(", "), otc: e.otc_categories.join(", ") });
  }

  async function save(sig: string) {
    setBusy(sig);
    try {
      await adminApi("/admin/pharmacat-kb/" + sig, {
        method: "PUT",
        body: JSON.stringify({
          query: draft.query,
          reply: draft.reply,
          substances: draft.substances.split(",").map((s) => s.trim()).filter(Boolean),
          otc_categories: draft.otc.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setEditing(null);
      await list.refetch();
    } finally { setBusy(null); }
  }

  async function regen(e: Entry) {
    let question = e.query || "";
    if (!question) {
      const typed = await appPrompt("Δεν υπάρχει αποθηκευμένη ερώτηση. Γράψε την ερώτηση που να ξαναρωτηθεί το AI (π.χ. «Αλλεργία»):", { title: "Επαναδημιουργία απάντησης", placeholder: "Αλλεργία", confirmText: "Ερώτηση στο AI" });
      if (typed === null || !typed.trim()) return;
      question = typed.trim();
    } else if (!(await appConfirm("Να ξαναρωτηθεί το AI για «" + question + "» και να αντικατασταθεί η αποθηκευμένη απάντηση με τη νέα;", { title: "Επαναδημιουργία απάντησης", confirmText: "Επαναδημιουργία" }))) {
      return;
    }
    setBusy(e.sig);
    try {
      await adminApi("/admin/pharmacat-kb/" + e.sig + "/regenerate", { method: "POST", body: JSON.stringify({ question }) });
      await list.refetch();
    } catch {
      await appAlert("Αποτυχία — το AI δεν απάντησε (ή έχει εξαντληθεί το όριο). Δοκίμασε ξανά.", { title: "Αποτυχία" });
    } finally { setBusy(null); }
  }

  async function del(sig: string) {
    if (!(await appConfirm("Διαγραφή αυτής της αποθηκευμένης απάντησης; Την επόμενη φορά θα ξαναρωτηθεί το AI από την αρχή.", { title: "Διαγραφή απάντησης", danger: true, confirmText: "Διαγραφή" }))) return;
    setBusy(sig);
    try {
      await adminApi("/admin/pharmacat-kb/" + sig, { method: "DELETE" });
      await list.refetch();
    } finally { setBusy(null); }
  }

  const items = list.data?.items ?? [];

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-800">
        <Brain className="h-6 w-6 text-brand-600" /> PharmaCat — Βάση γνώσης
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Αποθηκευμένες απαντήσεις του κλινικού βοηθού, κοινές για Ελλάδα και Κύπρο (εκτός όσες αναφέρουν φορείς μιας χώρας).
        Τα σκευάσματα βγαίνουν πάντα από τον κατάλογο της χώρας του φαρμακείου.
        Διόρθωσε ή διέγραψε μια λάθος/κακο-κατηγοριοποιημένη απάντηση — η διαγραφή προκαλεί νέα ερώτηση στο AI.
      </p>

      {/* Δείκτες: πόσο δουλεύει η βάση γνώσεων στο επιλεγμένο διάστημα */}
      <div className="mb-5 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-700">Πώς δουλεύει η βάση γνώσης</div>
          <div className="flex flex-wrap gap-1">
            {PERIODS.map(([d, l]) => (
              <button key={d} onClick={() => setDays(d)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${days === d ? "bg-brand-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{l}</button>
            ))}
          </div>
        </div>
        {stats.isLoading ? <div className="text-xs text-slate-400">Φόρτωση…</div> : stats.data && (() => {
          const s = stats.data, qd = s.questions, en = s.entries;
          return (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
                <Kpi label="Αποθηκευμένες απαντήσεις" value={nf(en.total)} sub={`+${nf(en.new)} νέες στο διάστημα`} />
                <Kpi label="Ερωτήσεις" value={nf(qd.total)} sub={`${nf(qd.chat)} κλινικές · ${nf(qd.interaction)} αλληλεπιδράσεις`} />
                <Kpi label="Από τη βάση" value={qd.hit_rate == null ? "—" : `${qd.hit_rate}%`} tone="text-emerald-600"
                  sub={`${nf(qd.cache)} χωρίς AI · ${nf(qd.llm)} από AI`} hint="Πόσες ερωτήσεις απαντήθηκαν αμέσως από τη βάση, χωρίς νέα κλήση (και κόστος) AI." />
                <Kpi label="Νέες ερωτήσεις στο AI" value={nf(qd.llm)} tone="text-violet-600" sub="κάθε μία γίνεται νέα απάντηση στη βάση" />
                <Kpi label="Σημάνσεις ως λάθος" value={nf(s.flags.new)} tone={s.flags.open ? "text-rose-600" : "text-slate-800"}
                  sub={`${nf(s.flags.open)} ανοιχτές · ${nf(s.flags.resolved)} διορθώθηκαν`} />
                <Kpi label="Ανά χώρα (ερωτήσεις)" value={`🇬🇷 ${nf(qd.GR)} · 🇨🇾 ${nf(qd.CY)}`}
                  sub={`απαντήσεις: ${nf(en.scope.shared)} κοινές · ${nf(en.scope.GR)} ΕΛ · ${nf(en.scope.CY)} ΚΥ`} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">
                <Kpi label="Επαναχρησιμοποιήσεις (σύνολο)" value={nf(en.reuses)} sub="φορές που σερβιρίστηκε αποθηκευμένη απάντηση" />
                <Kpi label="Ποτέ χρησιμοποιημένες" value={nf(en.never_used)} sub="απαντήσεις που δεν ξαναζητήθηκαν" />
                <Kpi label="Διορθώσεις από admin" value={nf(en.edited)} sub="στο διάστημα" />
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {[["Οι πιο συχνές (όλο το ιστορικό)", s.top_all.map((x) => ({ q: x.query, n: x.hits, scope: x.scope }))],
                  ["Οι πιο συχνές στο διάστημα", s.top_period.map((x) => ({ q: x.query, n: x.n, scope: undefined as string | undefined }))]].map(([title, rows]) => (
                  <div key={title as string} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="mb-1.5 text-xs font-semibold text-slate-600">{title as string}</div>
                    {(rows as { q: string | null; n: number; scope?: string }[]).length === 0
                      ? <div className="text-xs text-slate-400">Μετριέται από 18/11/2026 — δεν υπάρχουν ακόμη δεδομένα για το διάστημα.</div>
                      : (rows as { q: string | null; n: number; scope?: string }[]).map((r, i) => (
                        <button key={i} onClick={() => { if (r.q) { setQ(r.q.slice(0, 60)); setTerm(r.q.slice(0, 60)); } }}
                          className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-slate-50">
                          <span className="min-w-0 truncate text-slate-700">{i + 1}. {r.q || <i className="text-slate-400">(άγνωστη ερώτηση)</i>}</span>
                          <span className="shrink-0 font-semibold text-slate-800">{nf(r.n)}×</span>
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση σε ερώτηση ή απάντηση (π.χ. καούρα)…"
            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
        </div>
        <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Αναζήτηση</button>
        {term && <button type="button" onClick={() => { setQ(""); setTerm(""); }} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">Καθαρισμός</button>}
      </form>

      <div className="mb-3 flex items-center justify-between gap-2">
        <button onClick={() => setOnlyFlagged((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${onlyFlagged ? "border-rose-300 bg-rose-50 text-rose-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
          <ThumbsDown className="h-3.5 w-3.5" /> {onlyFlagged ? "Όλες οι εγγραφές" : "Μόνο χαρακτηρισμένες ως λάθος"}
          {!!list.data?.flagged_total && <span className="rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white">{list.data.flagged_total}</span>}
        </button>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="ml-auto rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600">
          <option value="recent">Πιο πρόσφατες</option>
          <option value="hits">Πιο συχνές</option>
          <option value="unused">Ποτέ χρησιμοποιημένες</option>
        </select>
        <span className="text-xs text-slate-400">
          {list.isLoading ? "Φόρτωση…" : `${list.data?.total ?? 0} εγγραφές${term || onlyFlagged ? " (φιλτραρισμένες)" : ""}`}
        </span>
      </div>

      <div className="space-y-3">
        {items.map((e) => (
          <div key={e.sig} className={`rounded-xl border bg-white p-4 ${e.flag_open ? "border-rose-300 ring-1 ring-rose-200" : "border-slate-200"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  {e.flag_open && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700"><ThumbsDown className="h-3 w-3" /> ΛΑΘΟΣ ×{e.flag_count}</span>}
                  {e.query || <span className="italic text-slate-400">(άγνωστη ερώτηση)</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                  {e.scope && <span className={`rounded px-1.5 font-medium ${SCOPE[e.scope]?.[1] ?? ""}`}>{SCOPE[e.scope]?.[0] ?? e.scope}</span>}
                  <span>{e.hits} εμφανίσεις</span>
                  {e.stage && <span>στάδιο: {e.stage}</span>}
                  <span>τελ.: {fmt(e.last_at)}</span>
                  {e.edited_at && <span className="text-amber-600">διορθώθηκε: {fmt(e.edited_at)}</span>}
                </div>
              </div>
              {editing !== e.sig && (
                <div className="flex shrink-0 gap-1.5">
                  <button onClick={() => regen(e)} disabled={busy === e.sig} title="Ξαναρώτησε το AI και αντικατέστησε με τη νέα απάντηση (αν λείπει η ερώτηση, θα τη ζητήσει)"
                    className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-40">
                    {busy === e.sig ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Νέα ερώτηση
                  </button>
                  <button onClick={() => startEdit(e)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                    <Pencil className="h-3.5 w-3.5" /> Διόρθωση
                  </button>
                  <button onClick={() => del(e.sig)} disabled={busy === e.sig} className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50">
                    {busy === e.sig ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Διαγραφή
                  </button>
                  {e.flag_open && (
                    <button onClick={() => dismiss(e.sig)} disabled={busy === e.sig} title="Η αναφορά ήταν λάθος — η απάντηση είναι σωστή" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50">
                      <X className="h-3.5 w-3.5" /> Απόρριψη αναφοράς
                    </button>
                  )}
                </div>
              )}
            </div>

            {e.flag_open && e.reports.length > 0 && (
              <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50/60 p-2 text-xs text-rose-800">
                <div className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> Αναφορές φαρμακοποιών:</div>
                <ul className="space-y-0.5">
                  {e.reports.map((rp, i) => <li key={i}>• {rp.reason ? rp.reason : <span className="italic text-rose-400">(χωρίς σχόλιο)</span>}</li>)}
                </ul>
                <div className="mt-1 text-[11px] text-rose-500">Μετά τη διόρθωση/«Νέα ερώτηση» ειδοποιείται αυτόματα ο φαρμακοποιός.</div>
              </div>
            )}

            {editing === e.sig ? (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-medium text-slate-500">Ερώτηση (ώστε να ξαναρωτιέται σωστά)
                  <input value={draft.query} onChange={(ev) => setDraft((d) => ({ ...d, query: ev.target.value }))} placeholder="π.χ. Αλλεργία"
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
                </label>
                <label className="block text-xs font-medium text-slate-500">Απάντηση
                  <textarea value={draft.reply} onChange={(ev) => setDraft((d) => ({ ...d, reply: ev.target.value }))} rows={6}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
                </label>
                <label className="block text-xs font-medium text-slate-500">Δραστικές / προτεινόμενες ουσίες (χωρισμένες με κόμμα)
                  <input value={draft.substances} onChange={(ev) => setDraft((d) => ({ ...d, substances: ev.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
                </label>
                <label className="block text-xs font-medium text-slate-500">Κατηγορίες OTC (χωρισμένες με κόμμα)
                  <input value={draft.otc} onChange={(ev) => setDraft((d) => ({ ...d, otc: ev.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
                </label>
                <div className="flex gap-2">
                  <button onClick={() => save(e.sig)} disabled={busy === e.sig} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                    {busy === e.sig ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Αποθήκευση
                  </button>
                  <button onClick={() => setEditing(null)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                    <X className="h-3.5 w-3.5" /> Άκυρο
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{e.reply}</p>
                {(e.substances.length > 0 || e.otc_categories.length > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {e.substances.map((s) => <span key={s} className="rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">{s}</span>)}
                    {e.otc_categories.map((c) => <span key={c} className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{c}</span>)}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {!list.isLoading && items.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Καμία εγγραφή.</div>
        )}
      </div>
    </div>
  );
}
