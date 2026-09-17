"use client";

/* Καρτέλα lead — έξι ενότητες, με τη σειρά που σκέφτεται κάποιος πριν σηκώσει το τηλέφωνο:
   ποιος είναι · πού βρίσκεται · τι έκανε · τι του στείλαμε · τι προσφορά πήρε · τι κάνω τώρα.
   Δίπλα, μόνιμα, το χρονολόγιο: η ιστορία του φαρμακείου, όχι καρτέλα που πρέπει να διαλέξεις. */

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Phone, Mail, Building2, Loader2, Check, Plus, CalendarClock, Tag as TagIcon, RotateCcw,
} from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appPrompt } from "@/store/dialogStore";
import { DateInput } from "@/components/ui/DateInput";

type Ev = { _id: string; kind: string; title: string; at: string; by: string };
type Note = { _id: string; kind: string; kind_label: string; body: string; by: string; at: string };
type Task = { _id: string; action: string; action_label: string; title: string; due_at: string; priority: string; status: string };
type Lead = {
  _id: string; pharmacy_name?: string; contact_name?: string; email?: string; phone?: string;
  afm?: string; city?: string; tenant_id?: string | null;
  stage: string; stage_label: string; status: string; status_label?: string; status_reason?: string;
  trial?: { started_at?: string; ends_at?: string; duration_days?: number; days_left?: number; days_since_expiry?: number };
  activity?: { last_login_at?: string; days_since_activity?: number; actions_30d?: number; actions_total?: number; active_days_30d?: number; features?: string[]; data_connected?: boolean; returned_after_days?: number };
  score?: { value?: number | null; band?: string; band_label?: string; signals?: { key: string; points: number; why: string }[] };
  tags?: string[]; tag_labels?: string[]; assigned_name?: string | null;
  trials?: { count: number; granted: number; last_granted_at?: string | null; last_granted_by?: string | null };
  trial_allowed?: boolean;
  suggestion: { action: string; title: string; why: string; urgency: string; buttons: string[] };
};
type Grant = { _id: string; days: number; kind: string; reason: string; by: string; at: string; ends_at: string };
type Detail = { lead: Lead; trial_grants: Grant[]; timeline: Ev[]; notes: Note[]; tasks: Task[]; history: { _id: string; from: string; to: string; by: string; at: string; reason?: string }[] };

const STATUSES: [string, string][] = [
  ["new", "Δεν του έχουμε μιλήσει"], ["contacted", "Του μιλήσαμε"], ["engaged", "Ανταποκρίθηκε"],
  ["offer_sent", "Πήρε προσφορά"], ["negotiating", "Το συζητάμε"],
  ["lost", "Δεν προχωράει"], ["do_not_contact", "Δεν θέλει επικοινωνία"],
];
const NOTE_KINDS: [string, string][] = [
  ["call", "Τηλέφωνο"], ["meeting", "Συνάντηση"], ["demo", "Παρουσίαση"],
  ["objection", "Αντίρρηση"], ["note", "Σημείωση"],
];
const TAGS: [string, string][] = [
  ["HOT_LEAD", "Καυτό"], ["NEEDS_CALL", "Θέλει τηλέφωνο"], ["PRICE_OBJECTION", "Θέμα τιμής"],
  ["INTERESTED", "Ενδιαφέρεται"], ["RETURNING", "Επέστρεψε"], ["DEMO_REQUESTED", "Ζήτησε παρουσίαση"],
  ["HIGH_VALUE", "Μεγάλο φαρμακείο"], ["REACTIVATION", "Επαναπροσέγγιση"],
];
const EV_ICON: Record<string, string> = {
  "trial.started": "🚀", "trial.expiring": "⏳", "trial.expired": "🔚", "trial.purged": "🗑️",
  "lead.created": "📋", "lead.status_changed": "🔄", "lead.activity": "⚡", "lead.returned": "↩️",
  "lead.note": "📝", "lead.task_created": "📌", "lead.task_done": "✅", "lead.tagged": "🏷️",
  "lead.assigned": "👤", "email.sent": "📧", "email.opened": "👀", "email.clicked": "🔗",
  "offer.sent": "🎁", "offer.redeemed": "💳", "lead.converted": "🎉", "lead.lost": "❌",
  "lead.suppressed": "🚫",
};
const gr = (s?: string | null, time = false) => (s ? new Date(s).toLocaleDateString("el-GR",
  { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Athens", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }) : "—");

export default function LeadDetailPage() {
  const key = decodeURIComponent(String(useParams()?.id ?? ""));
  const router = useRouter();
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["lead", key] });

  const d = useQuery({ queryKey: ["lead", key], queryFn: () => adminApi<Detail>(`/admin/leads/${encodeURIComponent(key)}/detail`) });
  const [noteKind, setNoteKind] = useState("call");
  const [noteBody, setNoteBody] = useState("");
  const [due, setDue] = useState("");
  const [grantDays, setGrantDays] = useState("15");

  const setStatus = useMutation({
    mutationFn: async (s: string) => {
      let reason: string | null = null;
      if (s === "lost") {
        reason = await appPrompt("Γιατί δεν προχωράει; (ο λόγος είναι ό,τι πιο χρήσιμο μένει)");
        if (!reason) throw new Error("cancelled");
      }
      return adminApi(`/admin/leads/${encodeURIComponent(key)}/status`, { method: "POST", body: JSON.stringify({ status: s, reason }) });
    },
    onSuccess: inv,
    onError: (e: Error) => { if (e.message !== "cancelled") appAlert("Δεν έγινε η αλλαγή."); },
  });
  const addNote = useMutation({
    mutationFn: () => adminApi(`/admin/leads/${encodeURIComponent(key)}/notes`, { method: "POST", body: JSON.stringify({ body: noteBody, kind: noteKind }) }),
    onSuccess: () => { setNoteBody(""); inv(); },
  });
  const addTask = useMutation({
    mutationFn: () => adminApi(`/admin/leads/${encodeURIComponent(key)}/tasks`, { method: "POST", body: JSON.stringify({ action: "call", due_at: new Date(due).toISOString(), priority: "high" }) }),
    onSuccess: () => { setDue(""); inv(); },
  });
  const doneTask = useMutation({
    mutationFn: (id: string) => adminApi(`/admin/leads/tasks/${id}/done`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: inv,
  });
  // Κατ' εξαίρεση νέα δοκιμαστική. Ζητά ΠΑΝΤΑ λόγο — χωρίς αυτόν, σε τρεις μήνες κανείς δεν
  // θυμάται γιατί δόθηκε δεύτερη δωρεάν δοκιμή, και η «εξαίρεση» γίνεται κανόνας.
  const grantTrial = useMutation({
    mutationFn: async () => {
      const reason = await appPrompt("Γιατί του δίνουμε ξανά δοκιμαστική;");
      if (!reason) throw new Error("cancelled");
      return adminApi<{ kind: string; days: number }>(`/admin/leads/${encodeURIComponent(key)}/grant-trial`,
        { method: "POST", body: JSON.stringify({ days: Number(grantDays) || 15, reason }) });
    },
    onSuccess: (r) => {
      appAlert(r.kind === "extend"
        ? `Δόθηκε δοκιμαστική ${r.days} ημερών. Ο λογαριασμός ξαναδουλεύει αμέσως.`
        : `Ξεκλειδώθηκε το ΑΦΜ — μπορεί να γραφτεί ξανά και να πάρει ${r.days} ημέρες δοκιμής.`);
      inv();
    },
    onError: (e: Error) => {
      if (e.message === "cancelled") return;
      appAlert("Δεν δόθηκε η δοκιμαστική. Αν είναι πληρωμένη συνδρομή, δεν γίνεται να μετατραπεί σε δοκιμή.");
    },
  });

  const toggleTag = useMutation({
    mutationFn: (t: string) => {
      const cur = new Set(d.data?.lead.tags ?? []);
      cur.has(t) ? cur.delete(t) : cur.add(t);
      return adminApi(`/admin/leads/${encodeURIComponent(key)}/tags`, { method: "POST", body: JSON.stringify({ tags: [...cur] }) });
    },
    onSuccess: inv,
  });

  if (d.isLoading) return <div className="grid place-items-center p-20"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>;
  if (!d.data) return <p className="p-8 text-sm text-slate-400">Δεν βρέθηκε.</p>;
  const { lead, timeline, notes, tasks } = d.data;
  const a = lead.activity ?? {};
  const t = lead.trial ?? {};
  const sc = lead.score ?? {};

  return (
    <div className="w-full">
      <button onClick={() => router.push("/admin/leads")} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-4 w-4" />Πίσω στη λίστα
      </button>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          {/* 1. ΠΟΙΟΣ ΕΙΝΑΙ */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex items-start gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500"><Building2 className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-bold text-slate-900">{lead.pharmacy_name || key}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                  {/* Σε πολλά φαρμακεία η επωνυμία ΕΙΝΑΙ το όνομα επαφής — μην τη γράψεις δύο φορές. */}
                  {lead.contact_name && lead.contact_name !== lead.pharmacy_name && <span>{lead.contact_name}</span>}
                  {lead.phone ? <a href={`tel:${lead.phone}`} className="inline-flex items-center gap-1 font-semibold text-indigo-600 hover:underline"><Phone className="h-3.5 w-3.5" />{lead.phone}</a>
                    : <span className="text-rose-500">χωρίς τηλέφωνο</span>}
                  {lead.email ? <a href={`mailto:${lead.email}`} className="inline-flex items-center gap-1 text-slate-600 hover:underline"><Mail className="h-3.5 w-3.5" />{lead.email}</a>
                    : <span className="text-rose-500">χωρίς email</span>}
                  {lead.afm && <span className="text-slate-400">ΑΦΜ {lead.afm}</span>}
                  {lead.city && <span className="text-slate-400">{lead.city}</span>}
                </div>
              </div>
            </div>
          </section>

          {/* 6. ΤΙ ΚΑΝΩ ΤΩΡΑ — ψηλά, γιατί γι' αυτό άνοιξες την καρτέλα */}
          <section className={`rounded-2xl border p-5 ${lead.suggestion.urgency === "high" ? "border-rose-200 bg-rose-50" : "border-indigo-100 bg-indigo-50/60"}`}>
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Τι κάνω τώρα</h2>
            <p className="mt-1 text-lg font-bold text-slate-900">{lead.suggestion.title}</p>
            <p className="mt-1 text-sm text-slate-600">{lead.suggestion.why}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {lead.phone && <a href={`tel:${lead.phone}`} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><Phone className="h-4 w-4" />Κάλεσέ τον</a>}
              <div className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-2 py-1.5">
                <CalendarClock className="h-4 w-4 text-slate-400" />
                <DateInput value={due} onChange={setDue} className="w-32 border-0 p-0 text-sm focus:ring-0" />
                <button onClick={() => addTask.mutate()} disabled={!due} className="rounded-lg bg-slate-800 px-2 py-1 text-xs font-semibold text-white disabled:opacity-40">Θύμισέ μου</button>
              </div>
            </div>
          </section>

          {/* 2. ΠΟΥ ΒΡΙΣΚΕΤΑΙ */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Πού βρίσκεται</h2>
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Field label="Λογαριασμός" value={lead.stage_label} />
              <Field label="Δοκιμή" value={t.ends_at ? `έληξε ${gr(t.ends_at)}` : "—"}
                sub={t.days_since_expiry != null ? `πριν ${t.days_since_expiry} μέρες` : t.days_left != null ? `σε ${t.days_left} μέρες` : undefined} />
              <Field label="Δραστηριότητα" value={sc.value == null ? "δεν μετριέται" : String(sc.value)} sub={sc.band_label} />
              <Field label="Δοκιμαστικές" value={`${lead.trials?.count ?? 0} ${lead.trials?.count === 1 ? "φορά" : "φορές"}`}
                sub={lead.trials?.granted ? `${lead.trials.granted} κατ' εξαίρεση` : "μόνο η αρχική"} />
            </div>

            {/* Κατ' εξαίρεση νέα δοκιμαστική */}
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <span className="text-xs font-semibold text-amber-900">Δώσε ξανά δοκιμαστική:</span>
              <input type="number" min={1} max={90} value={grantDays} onChange={(e) => setGrantDays(e.target.value)}
                className="w-16 rounded-lg border border-amber-300 px-2 py-1 text-sm focus:border-amber-500 focus:outline-none" />
              <span className="text-xs text-amber-900">ημέρες</span>
              <button onClick={() => grantTrial.mutate()} disabled={grantTrial.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50">
                {grantTrial.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                {lead.tenant_id ? "Ενεργοποίηση" : "Ξεκλείδωμα για νέα εγγραφή"}
              </button>
              {(lead.trials?.count ?? 0) > 1 && (
                <span className="text-[11px] font-semibold text-amber-700">
                  Προσοχή: έχει ήδη πάρει {lead.trials!.count} δοκιμαστικές.
                </span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Field label="Υπεύθυνος" value={lead.assigned_name || "κανείς"} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">Πού είναι η κουβέντα:</span>
              {STATUSES.map(([k, l]) => (
                <button key={k} onClick={() => setStatus.mutate(k)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${lead.status === k ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{l}</button>
              ))}
            </div>
            {lead.status_reason && <p className="mt-2 text-xs text-slate-500">Λόγος: {lead.status_reason}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <TagIcon className="h-3.5 w-3.5 text-slate-400" />
              {TAGS.map(([k, l]) => (
                <button key={k} onClick={() => toggleTag.mutate(k)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${(lead.tags ?? []).includes(k) ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>{l}</button>
              ))}
            </div>
          </section>

          {/* 3. ΤΙ ΕΚΑΝΕ */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Τι έκανε μέσα στο RxVision</h2>
            {sc.value == null ? (
              <p className="text-sm text-slate-500">Ο λογαριασμός του διαγράφηκε πριν αρχίσουμε να μετράμε — η δραστηριότητά του χάθηκε μαζί του.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  <Field label="Ενέργειες (30 μέρες)" value={String(a.actions_30d ?? 0)} />
                  <Field label="Ημέρες που μπήκε" value={String(a.active_days_30d ?? 0)} />
                  <Field label="Τελευταία σύνδεση" value={gr(a.last_login_at)} />
                  <Field label="Δεδομένα ΗΔΥΚΑ" value={a.data_connected ? "συνδεδεμένα" : "όχι"} />
                </div>
                {!!(a.features ?? []).length && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {a.features!.map((f) => <span key={f} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{f}</span>)}
                  </div>
                )}
                {!!(sc.signals ?? []).length && (
                  <ul className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-xs">
                    {sc.signals!.map((s) => (
                      <li key={s.key} className="flex items-center gap-2">
                        <span className={`w-9 shrink-0 text-right font-bold tabular-nums ${s.points >= 0 ? "text-emerald-600" : "text-rose-500"}`}>{s.points > 0 ? `+${s.points}` : s.points}</span>
                        <span className="text-slate-500">{s.why}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {/* 4+5. ΕΠΙΚΟΙΝΩΝΙΑ & ΠΡΟΣΦΟΡΕΣ — Φάση 2/3· λέμε την αλήθεια αντί να δείχνουμε μηδενικά */}
          <section className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-5">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Επικοινωνία &amp; προσφορές</h2>
            <p className="mt-1 text-sm text-slate-500">
              Δεν έχει σταλεί ακόμη κανένα μήνυμα από το σύστημα. Οι καμπάνιες και οι προσφορές έρχονται
              στις επόμενες φάσεις — μέχρι τότε κάθε επαφή καταγράφεται ως σημείωση.
            </p>
          </section>

          {!!d.data.trial_grants.length && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Δοκιμαστικές που δώσαμε</h2>
              {d.data.trial_grants.map((g) => (
                <div key={g._id} className="border-b border-slate-50 py-2 text-sm last:border-0">
                  <span className="font-semibold text-slate-700">{g.days} ημέρες</span>
                  <span className="text-slate-400"> · {gr(g.at)} · {g.by} · {g.kind === "extend" ? "παράταση λογαριασμού" : "ξεκλείδωμα ΑΦΜ"}</span>
                  <p className="text-slate-600">{g.reason}</p>
                </div>
              ))}
            </section>
          )}

          {/* Σημειώσεις */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Σημειώσεις πωλήσεων</h2>
            <div className="flex flex-wrap items-start gap-2">
              <select value={noteKind} onChange={(e) => setNoteKind(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm focus:border-indigo-500 focus:outline-none">
                {NOTE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input value={noteBody} onChange={(e) => setNoteBody(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && noteBody.trim()) addNote.mutate(); }}
                placeholder="π.χ. Θέλει πρώτα να δει το Loyalty. Να καλέσουμε μετά τις 15:00."
                className="min-w-[200px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              <button onClick={() => addNote.mutate()} disabled={!noteBody.trim()} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"><Plus className="h-4 w-4" />Κράτα το</button>
            </div>
            <div className="mt-3 space-y-2">
              {notes.map((n) => (
                <div key={n._id} className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                  <span className="font-semibold text-slate-700">{n.kind_label}</span>
                  <span className="text-slate-400"> · {gr(n.at, true)} · {n.by}</span>
                  <p className="text-slate-700">{n.body}</p>
                </div>
              ))}
              {!notes.length && <p className="text-xs text-slate-400">Καμία σημείωση ακόμη.</p>}
            </div>
          </section>

          {/* Εργασίες */}
          {!!tasks.filter((x) => x.status === "open").length && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Υπενθυμίσεις</h2>
              {tasks.filter((x) => x.status === "open").map((x) => (
                <div key={x._id} className="flex items-center gap-2 border-b border-slate-50 py-2 last:border-0">
                  <span className="flex-1 text-sm text-slate-700">{x.title} — <b>{gr(x.due_at)}</b></span>
                  <button onClick={() => doneTask.mutate(x._id)} className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"><Check className="h-3.5 w-3.5" />Έγινε</button>
                </div>
              ))}
            </section>
          )}
        </div>

        {/* ΧΡΟΝΟΛΟΓΙΟ — μόνιμα δίπλα, όχι καρτέλα που πρέπει να διαλέξεις */}
        <aside className="rounded-2xl border border-slate-200 bg-white p-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
          <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Η ιστορία του</h2>
          <ol className="space-y-2.5">
            {timeline.map((e) => (
              <li key={e._id} className="flex gap-2.5 text-sm">
                <span className="w-5 shrink-0 text-center">{EV_ICON[e.kind] ?? "•"}</span>
                <div className="min-w-0">
                  <div className="text-slate-700">{e.title}</div>
                  <div className="text-[11px] text-slate-400">{gr(e.at, true)}{e.by && e.by !== "system" ? ` · ${e.by}` : ""}</div>
                </div>
              </li>
            ))}
            {!timeline.length && <p className="text-xs text-slate-400">Δεν έχει καταγραφεί ακόμη τίποτα.</p>}
          </ol>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-800">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}
