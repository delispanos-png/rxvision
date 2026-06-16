"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Loader2, Users, Settings, Target } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PanelCard } from "@/components/ui/Card";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { fmtDate } from "@/lib/formatters";

type Campaign = { id: string; channel: string; subject?: string | null; recipients: number; sent: number; failed: number; created_at: string };

type T = (el: string, en: string) => string;
const makeSegments = (t: T) => [
  { value: "all", label: t("Όλοι (με συγκατάθεση)", "Everyone (with consent)"), needs: null },
  { value: "upcoming", label: t("Με επερχόμενη συνταγή", "With upcoming prescription"), needs: "days", ph: t("ημέρες (π.χ. 30)", "days (e.g. 30)") },
  { value: "substance", label: t("Σε δραστική / θεραπεία", "On active substance / therapy"), needs: "text", ph: t("ATC ή ουσία (π.χ. C10AA ή ATORVASTATIN)", "ATC or substance (e.g. C10AA or ATORVASTATIN)") },
  { value: "icd", label: t("Με διάγνωση (ICD-10)", "With diagnosis (ICD-10)"), needs: "text", ph: t("κωδικός ICD (π.χ. I10)", "ICD code (e.g. I10)") },
  { value: "inactive", label: t("Ανενεργοί πελάτες", "Inactive customers"), needs: "days", ph: t("ημέρες χωρίς συνταγή (π.χ. 180)", "days without prescription (e.g. 180)") },
];

const makeTemplates = (t: T) => [
  { label: t("Υπενθύμιση επανάληψης", "Refill reminder"), text: t("Αγαπητέ/ή {first}, η συνταγή σας ανανεώνεται σύντομα. Περνώντας από το φαρμακείο μπορούμε να την εκτελέσουμε άμεσα. Με εκτίμηση.", "Dear {first}, your prescription renews soon. Drop by the pharmacy and we can fill it right away. Best regards.") },
  { label: t("Εποχική ενημέρωση", "Seasonal update"), text: t("Καλημέρα {first}! Ήρθε η εποχή για ενίσχυση του ανοσοποιητικού — περάστε από το φαρμακείο για εξατομικευμένη συμβουλή.", "Good morning {first}! It's the season to boost your immune system — visit the pharmacy for personalized advice.") },
  { label: t("Διαθεσιμότητα προϊόντος", "Product availability"), text: t("{first}, το προϊόν που ζητήσατε είναι διαθέσιμο. Σας περιμένουμε!", "{first}, the product you requested is available. We're waiting for you!") },
];

export default function CommunicationsPage() {
  const t = useT();
  const SEGMENTS = makeSegments(t);
  const TEMPLATES = makeTemplates(t);
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["comms", "history"], queryFn: () => api<{ items: Campaign[] }>("/communications/history"), retry: false });

  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [segment, setSegment] = useState("all");
  const [value, setValue] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  // prefill from a "Δημιουργία καμπάνιας" deep-link (e.g. from the cross-sell drill-down)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("segment")) setSegment(p.get("segment")!);
    if (p.get("value")) setValue(p.get("value")!);
    if (p.get("subject")) setSubject(p.get("subject")!);
    if (p.get("channel") === "sms") setChannel("sms");
  }, []);

  const seg = SEGMENTS.find((s) => s.value === segment)!;
  const qs = `channel=${channel}&segment=${segment}${value ? `&value=${encodeURIComponent(value)}` : ""}`;
  const audience = useQuery({ queryKey: ["comms", "audience", qs], queryFn: () => api<{ count: number }>(`/communications/audience?${qs}`), retry: false });

  const send = useMutation({
    mutationFn: () => api<{ recipients: number; sent: number; failed: number }>("/communications/send", { method: "POST", body: JSON.stringify({ channel, subject, message, segment, value: value || null }) }),
    onSuccess: (r) => { appAlert(t(`Στάλθηκαν ${r.sent}/${r.recipients} (${r.failed} αποτυχίες)`, `Sent ${r.sent}/${r.recipients} (${r.failed} failures)`)); setMessage(""); setSubject(""); qc.invalidateQueries({ queryKey: ["comms", "history"] }); },
    onError: (e: Error) => appAlert(t("Αποτυχία: ", "Failed: ") + e.message),
  });

  const inp = "rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none";

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><Mail className="h-6 w-6 text-brand-600" /> {t("Επικοινωνία", "Communications")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Στοχευμένα newsletter & ειδοποιήσεις σε ασθενείς με συγκατάθεση.", "Targeted newsletters & notifications to patients with consent.")}</p>
        </div>
        <Link href="/settings/communications" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"><Settings className="h-4 w-4" /> {t("Ρυθμίσεις αποστολέα", "Sender settings")}</Link>
      </div>

      <div className="space-y-4">
        <PanelCard title={t("Νέα στοχευμένη αποστολή", "New targeted send")}>
          {/* channel */}
          <div className="mb-4 flex gap-2">
            <button onClick={() => setChannel("email")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "email" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><Mail className="h-4 w-4" /> Email</button>
            <button onClick={() => setChannel("sms")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "sms" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><MessageSquare className="h-4 w-4" /> SMS</button>
          </div>

          {/* audience builder */}
          <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Target className="h-3.5 w-3.5" /> {t("Κοινό-στόχος", "Target audience")}</div>
            <div className="flex flex-wrap items-center gap-2">
              <select value={segment} onChange={(e) => { setSegment(e.target.value); setValue(""); }} className={inp}>
                {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {seg.needs && <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={seg.ph} className={`${inp} w-full sm:w-72`} />}
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm"><Users className="h-4 w-4 text-brand-600" /> {t("Παραλήπτες:", "Recipients:")} <b className="text-slate-900">{audience.isFetching ? "…" : audience.data?.count ?? 0}</b></span>
            </div>
          </div>

          {/* templates */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            <span className="py-1 text-xs text-slate-400">{t("Πρότυπα:", "Templates:")}</span>
            {TEMPLATES.map((t) => <button key={t.label} onClick={() => setMessage(t.text)} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">{t.label}</button>)}
          </div>

          {channel === "email" && <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("Θέμα email", "Email subject")} className={`${inp} mb-2 w-full`} />}
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} placeholder={channel === "sms" ? t("Κείμενο SMS…", "SMS text…") : t("Μήνυμα… (μεταβλητές: {name} = πλήρες όνομα, {first} = επώνυμο)", "Message… (variables: {name} = full name, {first} = last name)")} className={`${inp} w-full`} />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">{channel === "sms" ? t(`${message.length} χαρακτήρες`, `${message.length} characters`) : t("Διαθέσιμες μεταβλητές: {name}, {first}", "Available variables: {name}, {first}")}</span>
            <button onClick={async () => { if (message.trim() && await appConfirm(t(`Αποστολή σε ${audience.data?.count ?? 0} παραλήπτες;`, `Send to ${audience.data?.count ?? 0} recipients?`))) send.mutate(); }}
              disabled={send.isPending || !message.trim() || !(audience.data?.count)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Αποστολή", "Send")}
            </button>
          </div>
        </PanelCard>

        <PanelCard collapsible defaultOpen={false} title={t("Ιστορικό αποστολών", "Send history")}>
          {(history.data?.items?.length ?? 0) === 0 ? <p className="text-sm text-slate-400">{t("Καμία αποστολή ακόμη.", "No sends yet.")}</p> : (
            <div className="divide-y divide-slate-100">
              {history.data!.items.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="flex items-center gap-2 text-slate-700">{c.channel === "email" ? <Mail className="h-4 w-4 text-slate-400" /> : <MessageSquare className="h-4 w-4 text-slate-400" />}{c.subject || (c.channel === "sms" ? "SMS" : "Email")}</span>
                  <span className="text-slate-500">{fmtDate(c.created_at)} · {c.sent}/{c.recipients} {c.failed ? `· ${c.failed} ✗` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </PanelCard>
      </div>
    </ModuleGuard>
  );
}
