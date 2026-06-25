"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Search, Trash2, Pencil, Save, X, Loader2, RefreshCw } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Entry = {
  sig: string;
  query: string | null;
  reply: string;
  substances: string[];
  otc_categories: string[];
  stage: string | null;
  hits: number;
  edited_at: string | null;
  last_at: string | null;
  created_at: string | null;
};
type ListRes = { page: number; page_size: number; total: number; items: Entry[] };

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("el-GR") : "—");

export default function PharmaCatKbPage() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ query: string; reply: string; substances: string; otc: string }>({ query: "", reply: "", substances: "", otc: "" });
  const [busy, setBusy] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["admin", "pharmacat-kb", term],
    queryFn: () => adminApi<ListRes>("/admin/pharmacat-kb?page_size=60&q=" + encodeURIComponent(term)),
    retry: false,
  });

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
      const typed = prompt("Δεν υπάρχει αποθηκευμένη ερώτηση. Γράψε την ερώτηση που να ξαναρωτηθεί το AI (π.χ. «Αλλεργία»):", "");
      if (typed === null || !typed.trim()) return;
      question = typed.trim();
    } else if (!confirm("Να ξαναρωτηθεί το AI για «" + question + "» και να αντικατασταθεί η αποθηκευμένη απάντηση με τη νέα;")) {
      return;
    }
    setBusy(e.sig);
    try {
      await adminApi("/admin/pharmacat-kb/" + e.sig + "/regenerate", { method: "POST", body: JSON.stringify({ question }) });
      await list.refetch();
    } catch {
      alert("Αποτυχία — το AI δεν απάντησε (ή έχει εξαντληθεί το όριο). Δοκίμασε ξανά.");
    } finally { setBusy(null); }
  }

  async function del(sig: string) {
    if (!confirm("Διαγραφή αυτής της αποθηκευμένης απάντησης; Την επόμενη φορά θα ξαναρωτηθεί το AI από την αρχή.")) return;
    setBusy(sig);
    try {
      await adminApi("/admin/pharmacat-kb/" + sig, { method: "DELETE" });
      await list.refetch();
    } finally { setBusy(null); }
  }

  const items = list.data?.items ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-800">
        <Brain className="h-6 w-6 text-brand-600" /> PharmaCat — Βάση γνώσης
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Κοινές αποθηκευμένες απαντήσεις του κλινικού βοηθού (σερβίρονται σε όλα τα φαρμακεία).
        Διόρθωσε ή διέγραψε μια λάθος/κακο-κατηγοριοποιημένη απάντηση — η διαγραφή προκαλεί νέα ερώτηση στο AI.
      </p>

      <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση σε ερώτηση ή απάντηση (π.χ. καούρα)…"
            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
        </div>
        <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Αναζήτηση</button>
        {term && <button type="button" onClick={() => { setQ(""); setTerm(""); }} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">Καθαρισμός</button>}
      </form>

      <div className="mb-3 text-xs text-slate-400">
        {list.isLoading ? "Φόρτωση…" : `${list.data?.total ?? 0} εγγραφές${term ? " (φιλτραρισμένες)" : ""}`}
      </div>

      <div className="space-y-3">
        {items.map((e) => (
          <div key={e.sig} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{e.query || <span className="italic text-slate-400">(άγνωστη ερώτηση)</span>}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
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
                </div>
              )}
            </div>

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
