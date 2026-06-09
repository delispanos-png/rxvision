"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Loader2, Users, Settings, Target } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PanelCard } from "@/components/ui/Card";

type Campaign = { id: string; channel: string; subject?: string | null; recipients: number; sent: number; failed: number; created_at: string };

const SEGMENTS = [
  { value: "all", label: "Όλοι (με συγκατάθεση)", needs: null },
  { value: "upcoming", label: "Με επερχόμενη συνταγή", needs: "days", ph: "ημέρες (π.χ. 30)" },
  { value: "substance", label: "Σε δραστική / θεραπεία", needs: "text", ph: "ATC ή ουσία (π.χ. C10AA ή ATORVASTATIN)" },
  { value: "icd", label: "Με διάγνωση (ICD-10)", needs: "text", ph: "κωδικός ICD (π.χ. I10)" },
  { value: "inactive", label: "Ανενεργοί πελάτες", needs: "days", ph: "ημέρες χωρίς συνταγή (π.χ. 180)" },
];

const TEMPLATES = [
  { label: "Υπενθύμιση επανάληψης", text: "Αγαπητέ/ή {first}, η συνταγή σας ανανεώνεται σύντομα. Περνώντας από το φαρμακείο μπορούμε να την εκτελέσουμε άμεσα. Με εκτίμηση." },
  { label: "Εποχική ενημέρωση", text: "Καλημέρα {first}! Ήρθε η εποχή για ενίσχυση του ανοσοποιητικού — περάστε από το φαρμακείο για εξατομικευμένη συμβουλή." },
  { label: "Διαθεσιμότητα προϊόντος", text: "{first}, το προϊόν που ζητήσατε είναι διαθέσιμο. Σας περιμένουμε!" },
];

export default function CommunicationsPage() {
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["comms", "history"], queryFn: () => api<{ items: Campaign[] }>("/communications/history"), retry: false });

  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [segment, setSegment] = useState("all");
  const [value, setValue] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const seg = SEGMENTS.find((s) => s.value === segment)!;
  const qs = `channel=${channel}&segment=${segment}${value ? `&value=${encodeURIComponent(value)}` : ""}`;
  const audience = useQuery({ queryKey: ["comms", "audience", qs], queryFn: () => api<{ count: number }>(`/communications/audience?${qs}`), retry: false });

  const send = useMutation({
    mutationFn: () => api<{ recipients: number; sent: number; failed: number }>("/communications/send", { method: "POST", body: JSON.stringify({ channel, subject, message, segment, value: value || null }) }),
    onSuccess: (r) => { alert(`Στάλθηκαν ${r.sent}/${r.recipients} (${r.failed} αποτυχίες)`); setMessage(""); setSubject(""); qc.invalidateQueries({ queryKey: ["comms", "history"] }); },
    onError: (e: Error) => alert("Αποτυχία: " + e.message),
  });

  const inp = "rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none";

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><Mail className="h-6 w-6 text-brand-600" /> Επικοινωνία</h1>
          <p className="mt-1 text-sm text-slate-500">Στοχευμένα newsletter & ειδοποιήσεις σε ασθενείς με συγκατάθεση.</p>
        </div>
        <Link href="/settings/communications" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"><Settings className="h-4 w-4" /> Ρυθμίσεις αποστολέα</Link>
      </div>

      <div className="space-y-4">
        <PanelCard title="Νέα στοχευμένη αποστολή">
          {/* channel */}
          <div className="mb-4 flex gap-2">
            <button onClick={() => setChannel("email")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "email" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><Mail className="h-4 w-4" /> Email</button>
            <button onClick={() => setChannel("sms")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "sms" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><MessageSquare className="h-4 w-4" /> SMS</button>
          </div>

          {/* audience builder */}
          <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Target className="h-3.5 w-3.5" /> Κοινό-στόχος</div>
            <div className="flex flex-wrap items-center gap-2">
              <select value={segment} onChange={(e) => { setSegment(e.target.value); setValue(""); }} className={inp}>
                {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {seg.needs && <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={seg.ph} className={`${inp} w-72`} />}
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm"><Users className="h-4 w-4 text-brand-600" /> Παραλήπτες: <b className="text-slate-900">{audience.isFetching ? "…" : audience.data?.count ?? 0}</b></span>
            </div>
          </div>

          {/* templates */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            <span className="py-1 text-xs text-slate-400">Πρότυπα:</span>
            {TEMPLATES.map((t) => <button key={t.label} onClick={() => setMessage(t.text)} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">{t.label}</button>)}
          </div>

          {channel === "email" && <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Θέμα email" className={`${inp} mb-2 w-full`} />}
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} placeholder={channel === "sms" ? "Κείμενο SMS…" : "Μήνυμα… (μεταβλητές: {name} = πλήρες όνομα, {first} = επώνυμο)"} className={`${inp} w-full`} />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">{channel === "sms" ? `${message.length} χαρακτήρες` : "Διαθέσιμες μεταβλητές: {name}, {first}"}</span>
            <button onClick={() => { if (message.trim() && confirm(`Αποστολή σε ${audience.data?.count ?? 0} παραλήπτες;`)) send.mutate(); }}
              disabled={send.isPending || !message.trim() || !(audience.data?.count)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Αποστολή
            </button>
          </div>
        </PanelCard>

        <PanelCard collapsible defaultOpen={false} title="Ιστορικό αποστολών">
          {(history.data?.items?.length ?? 0) === 0 ? <p className="text-sm text-slate-400">Καμία αποστολή ακόμη.</p> : (
            <div className="divide-y divide-slate-100">
              {history.data!.items.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="flex items-center gap-2 text-slate-700">{c.channel === "email" ? <Mail className="h-4 w-4 text-slate-400" /> : <MessageSquare className="h-4 w-4 text-slate-400" />}{c.subject || (c.channel === "sms" ? "SMS" : "Email")}</span>
                  <span className="text-slate-500">{new Date(c.created_at).toLocaleDateString("el-GR")} · {c.sent}/{c.recipients} {c.failed ? `· ${c.failed} ✗` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
