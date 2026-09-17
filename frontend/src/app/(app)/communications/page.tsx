"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Loader2, Users, Settings, Target, Smartphone, ShieldCheck, Pause, Play, X, FlaskConical, Sparkles } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { fmtDate } from "@/lib/formatters";

type Campaign = { id: string; channel: string; subject?: string | null; recipients: number; sent: number; failed: number; created_at: string };

type T = (el: string, en: string) => string;
// Θεραπευτικές κατηγορίες (ίδια κλειδιά με services/marketing.py) — για στόχευση 1-κλικ.
const THERAPY_CATS: [string, string, string][] = [
  ["diabetes", "🩸 Διαβήτης", "🩸 Diabetes"], ["hypertension", "❤️ Υπέρταση", "❤️ Hypertension"], ["cardio", "🫀 Καρδιολογικά", "🫀 Cardiac"],
  ["cholesterol", "🧈 Χοληστερίνη", "🧈 Cholesterol"], ["thyroid", "🦋 Θυρεοειδής", "🦋 Thyroid"], ["respiratory", "🫁 Αναπνευστικά", "🫁 Respiratory"],
  ["allergy", "🤧 Αλλεργίες", "🤧 Allergies"], ["psych", "🧠 Νευρο/Ψυχ.", "🧠 Neuro/Psych"], ["osteo", "🦴 Οστεοπόρωση", "🦴 Osteoporosis"], ["gastro", "🩹 Γαστρεντερικά", "🩹 Gastrointestinal"],
];
const makeSegments = (t: T) => [
  { value: "all", label: t("Όλοι (με συγκατάθεση)", "Everyone (with consent)"), needs: null },
  { value: "therapy", label: t("Θεραπευτική κατηγορία", "Therapeutic category"), needs: "therapy", ph: "" },
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

  const [channel, setChannel] = useState<"email" | "sms" | "viber" | "push">("email");
  const [segment, setSegment] = useState("all");
  const [value, setValue] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  // κουπόνι (προαιρετικό) — μετρά την απόδοση: {coupon} στο κείμενο γίνεται ο κωδικός
  const [cpOn, setCpOn] = useState(false);
  const [cpType, setCpType] = useState<"pct" | "fixed">("pct");
  const [cpVal, setCpVal] = useState("10");
  const [cpDays, setCpDays] = useState("30");

  // prefill from a "Δημιουργία καμπάνιας" deep-link (e.g. from the cross-sell drill-down)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("segment")) setSegment(p.get("segment")!);
    if (p.get("value")) setValue(p.get("value")!);
    if (p.get("subject")) setSubject(p.get("subject")!);
    if (p.get("channel") === "sms") setChannel("sms");
    // Κοινό που ήρθε από τις «Ομάδες ανθρώπων» — ταξιδεύει ως κανόνας, όχι ως λίστα ονομάτων.
    const a = p.get("audience");
    if (a) { try { setAudRules(JSON.parse(a)); setAudLabel(p.get("label") || ""); } catch { /* αγνόησε */ } }
  }, []);

  const [audRules, setAudRules] = useState<Record<string, unknown> | null>(null);
  const [audLabel, setAudLabel] = useState("");
  const seg = SEGMENTS.find((s) => s.value === segment)!;
  const audQs = audRules ? `&audience=${encodeURIComponent(JSON.stringify(audRules))}` : "";
  const qs = `channel=${channel}&segment=${segment}${value ? `&value=${encodeURIComponent(value)}` : ""}`;
  const audience = useQuery({ queryKey: ["comms", "audience", qs], queryFn: () => api<{ count: number }>(`/communications/audience?${qs}`), retry: false });
  const wallet = useQuery({ queryKey: ["comms", "wallet"], queryFn: () => api<{ balance_cents: number; prices: Record<string, number> }>("/communications/wallet"), retry: false });

  // Ανάλυση κοινού: πόσοι θα λάβουν και ΠΟΙΟΙ εξαιρούνται, με τον λόγο του καθενός.
  const bd = useQuery({
    queryKey: ["comms", "breakdown", qs, audQs],
    queryFn: () => api<{ total: number; will_receive: number; cap: number;
                         excluded: { n: number; reason: string; code: string }[] }>(`/communications/audience/breakdown?${qs}${audQs}`),
    retry: false,
  });
  const [liveId, setLiveId] = useState<string | null>(null);
  const live = useQuery({
    queryKey: ["comms", "progress", liveId],
    queryFn: () => api<{ status: string; paused_reason?: string | null; recipients: number;
                         sent: number; failed: number; pending: number }>(`/communications/campaigns/${liveId}/progress`),
    enabled: !!liveId,
    refetchInterval: (q) => (["queued", "sending"].includes((q.state.data as { status?: string })?.status ?? "") ? 2000 : false),
  });

  const count = bd.data?.will_receive ?? audience.data?.count ?? 0;
  const unit = wallet.data?.prices?.[channel] ?? 0;                 // κόστος/μήνυμα (cents)
  const costCents = count * unit;
  const balance = wallet.data?.balance_cents ?? 0;
  const insufficient = wallet.data != null && costCents > balance;  // δεν φτάνει το υπόλοιπο
  const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

  const send = useMutation({
    mutationFn: () => api<{ campaign_id: string; recipients: number }>("/communications/send", { method: "POST", body: JSON.stringify({ channel, subject, message, segment, value: value || null, audience_rules: audRules, audience_name: audLabel || null, coupon: cpOn ? { enabled: true, discount_type: cpType, discount_value: cpType === "fixed" ? Math.round(parseFloat(cpVal || "0") * 100) : Math.round(parseFloat(cpVal || "0")), valid_days: parseInt(cpDays) || 30 } : null }) }),
    // Δεν περιμένουμε πια το τέλος της αποστολής: παρακολουθούμε την πρόοδο ζωντανά.
    onSuccess: (r) => { setLiveId(r.campaign_id); setMessage(""); setSubject(""); qc.invalidateQueries({ queryKey: ["comms", "history"] }); },
    onError: (e: Error) => appAlert(t("Δεν μπήκε στην ουρά: ", "Could not queue: ") + e.message),
  });
  const testSend = useMutation({
    mutationFn: (to: string) => api("/communications/test-send", { method: "POST", body: JSON.stringify({ channel, subject, message, to }) }),
    onSuccess: () => appAlert(t("✓ Η δοκιμή στάλθηκε. Δες την πριν φύγει στους υπόλοιπους.", "✓ Test sent. Check it before the real send.")),
    onError: (e: Error) => appAlert(t("Η δοκιμή δεν στάλθηκε: ", "Test failed: ") + e.message),
  });
  // AI προσχέδιο — γυρίζει ΣΤΗ ΦΟΡΜΑ. Δεν στέλνεται ποτέ μόνο του.
  const aiDraft = useMutation({
    mutationFn: (brief: string) => api<{ subject: string; message: string }>("/communications/draft", {
      method: "POST", body: JSON.stringify({ brief, channel, audience_label: audLabel }) }),
    onSuccess: (d) => { if (d.subject) setSubject(d.subject); setMessage(d.message); },
    onError: () => appAlert(t("Δεν μπόρεσα να γράψω προσχέδιο τώρα. Γράψ' το εσύ — ή δοκίμασε ξανά.",
      "Could not draft right now.")),
  });
  const control = useMutation({
    mutationFn: (action: string) => api(`/communications/campaigns/${liveId}/action`, { method: "POST", body: JSON.stringify({ action }) }),
    onSuccess: () => live.refetch(),
  });

  const inp = "rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none";

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Link href="/settings/communications" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"><Settings className="h-4 w-4" /> {t("Κανάλια & όρια", "Channels & limits")}</Link>
      </div>

      <div className="space-y-4">
        {/* Ζωντανή πρόοδος: ο φαρμακοποιός δεν μένει ποτέ να κοιτάζει το κενό. */}
        {liveId && live.data && (
          <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-brand-900">
                {live.data.status === "completed"
                  ? t(`Έφυγαν ${live.data.sent} μηνύματα.`, `${live.data.sent} messages sent.`)
                  : live.data.status === "paused"
                    ? (live.data.paused_reason === "no_credits"
                        ? t("Πάγωσε — τελείωσε το υπόλοιπο. Συνεχίζει μόλις ανανεωθεί.", "Paused — out of credits.")
                        : t("Σε παύση.", "Paused."))
                    : t(`Στέλνεται… ${live.data.sent} από ${live.data.recipients}`, `Sending… ${live.data.sent} of ${live.data.recipients}`)}
              </span>
              {live.data.failed > 0 && <span className="text-xs text-rose-600">{t(`${live.data.failed} απέτυχαν`, `${live.data.failed} failed`)}</span>}
              <span className="ml-auto flex gap-2">
                {["queued", "sending"].includes(live.data.status) && (
                  <button onClick={() => control.mutate("pause")} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600"><Pause className="h-3.5 w-3.5" />{t("Παύση", "Pause")}</button>
                )}
                {live.data.status === "paused" && (
                  <button onClick={() => control.mutate("resume")} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600"><Play className="h-3.5 w-3.5" />{t("Συνέχισε", "Resume")}</button>
                )}
                {["queued", "sending", "paused"].includes(live.data.status) && (
                  <button onClick={async () => { if (await appConfirm(t(`Να σταματήσει; Έχουν λάβει ${live.data!.sent}. Όσοι έλαβαν δεν αναιρούνται.`, `Stop? ${live.data!.sent} already received.`), { danger: true })) control.mutate("cancel"); }}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-600"><X className="h-3.5 w-3.5" />{t("Σταμάτα", "Stop")}</button>
                )}
                {["completed", "cancelled"].includes(live.data.status) && (
                  <button onClick={() => setLiveId(null)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-400">{t("Κλείσιμο", "Close")}</button>
                )}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
              <div className="h-full rounded-full bg-brand-600 transition-all"
                style={{ width: `${Math.round(((live.data.sent + live.data.failed) / Math.max(1, live.data.recipients)) * 100)}%` }} />
            </div>
          </div>
        )}

        {audRules && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50/60 p-3 text-sm dark:border-brand-900 dark:bg-slate-800/40">
            <Users className="h-4 w-4 text-brand-600" />
            <span className="font-semibold text-brand-900 dark:text-brand-200">{audLabel || t("Δική σου ομάδα", "Your group")}</span>
            <span className="text-brand-700 dark:text-brand-300">{t(`· ${count} θα το λάβουν`, `· ${count} will receive`)}</span>
            <button onClick={() => { setAudRules(null); setAudLabel(""); }} className="ml-auto text-xs font-semibold text-slate-500 hover:text-slate-700">{t("Άλλαξε ομάδα", "Change")}</button>
          </div>
        )}

        <PanelCard title={t("Νέα στοχευμένη αποστολή", "New targeted send")}>
          {/* channel */}
          <div className="mb-4 flex gap-2">
            <button onClick={() => setChannel("email")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "email" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><Mail className="h-4 w-4" /> Email</button>
            <button onClick={() => setChannel("sms")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "sms" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}><MessageSquare className="h-4 w-4" /> SMS</button>
            <button onClick={() => setChannel("viber")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "viber" ? "border-violet-300 bg-violet-50 text-violet-700" : "border-slate-300 text-slate-600"}`}><MessageSquare className="h-4 w-4" /> Viber</button>
            <button onClick={() => setChannel("push")} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === "push" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600"}`}><Smartphone className="h-4 w-4" /> Push <span className="rounded-full bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-700">{t("ΔΩΡΕΑΝ", "FREE")}</span></button>
          </div>

          {/* audience builder */}
          <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Target className="h-3.5 w-3.5" /> {t("Κοινό-στόχος", "Target audience")}</div>
            <div className="flex flex-wrap items-center gap-2">
              <select value={segment} onChange={(e) => { setSegment(e.target.value); setValue(""); }} className={inp}>
                {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {seg.needs === "therapy"
                ? <select value={value} onChange={(e) => setValue(e.target.value)} className={`${inp} w-full sm:w-72`}>
                    <option value="">{t("— διάλεξε κατηγορία —", "— pick a category —")}</option>
                    {THERAPY_CATS.map(([k, el, en]) => <option key={k} value={k}>{t(el, en)}</option>)}
                  </select>
                : seg.needs ? <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={seg.ph} className={`${inp} w-full sm:w-72`} /> : null}
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm"><Users className="h-4 w-4 text-brand-600" /> {t("Παραλήπτες:", "Recipients:")} <b className="text-slate-900">{audience.isFetching ? "…" : count}</b></span>
            </div>
            {/* Εκτιμώμενο κόστος πριν την αποστολή (παραλήπτες × τιμή καναλιού) + υπόλοιπο πορτοφολιού */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {channel === "push" ? (
                <span className="font-semibold text-emerald-600">📱 {t("Δωρεάν — μόνο σε ασθενείς με την εφαρμογή & ενεργό push", "Free — only patients with the app & push enabled")}</span>
              ) : (<>
                <span className="text-slate-500">{t("Εκτιμώμενο κόστος:", "Estimated cost:")} <b className="text-slate-800">{eur(costCents)}</b> <span className="text-slate-400">({count} × {eur(unit)})</span></span>
                <span className="text-slate-500">{t("Υπόλοιπο:", "Balance:")} <b className={insufficient ? "text-rose-600" : "text-slate-800"}>{eur(balance)}</b></span>
                {insufficient && <Link href="/settings/communications" className="font-semibold text-rose-600 hover:underline">{t("⚠ Ανεπαρκές υπόλοιπο — αγορά credits", "⚠ Insufficient balance — buy credits")}</Link>}
              </>)}
            </div>
          </div>

          {/* templates */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            <span className="py-1 text-xs text-slate-400">{t("Πρότυπα:", "Templates:")}</span>
            {TEMPLATES.map((t) => <button key={t.label} onClick={() => setMessage(t.text)} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">{t.label}</button>)}
          </div>

          {/* Κουπόνι — μετρά την απόδοση (στάλθηκε → εξαργυρώθηκε → αξία) */}
          <div className="mb-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={cpOn} onChange={(e) => setCpOn(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
              🎟️ {t("Πρόσθεσε κουπόνι", "Attach a coupon")} <span className="text-xs font-normal text-slate-400">{t("(για να μετράς τι απέδωσε)", "(to measure what it earned)")}</span>
            </label>
            {cpOn && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <select value={cpType} onChange={(e) => setCpType(e.target.value as "pct" | "fixed")} className={inp}>
                  <option value="pct">{t("Έκπτωση %", "% discount")}</option>
                  <option value="fixed">{t("Έκπτωση €", "€ discount")}</option>
                </select>
                <input type="number" min={1} value={cpVal} onChange={(e) => setCpVal(e.target.value)} className={`${inp} w-24`} />
                <span className="text-slate-400">{cpType === "pct" ? "%" : "€"}</span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-500">{t("ισχύς", "valid")}</span>
                <input type="number" min={1} value={cpDays} onChange={(e) => setCpDays(e.target.value)} className={`${inp} w-20`} />
                <span className="text-slate-400">{t("ημέρες", "days")}</span>
                {!message.includes("{coupon}") && <button onClick={() => setMessage((m) => `${m}${m ? " " : ""}${t("Κωδικός:", "Code:")} {coupon}`)} className="rounded-lg border border-violet-300 bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-100">{t("+ βάλε {coupon} στο μήνυμα", "+ insert {coupon}")}</button>}
              </div>
            )}
          </div>
          {(channel === "email" || channel === "push") && <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={channel === "push" ? t("Τίτλος ειδοποίησης (προαιρετικό)", "Notification title (optional)") : t("Θέμα email", "Email subject")} className={`${inp} mb-2 w-full`} />}
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} placeholder={channel !== "email" ? t("Κείμενο μηνύματος…", "Message text…") : t("Μήνυμα… (μεταβλητές: {name} = πλήρες όνομα, {first} = επώνυμο)", "Message… (variables: {name} = full name, {first} = last name)")} className={`${inp} w-full`} />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">{channel !== "email" ? t(`${message.length} χαρακτήρες`, `${message.length} characters`) : t("Διαθέσιμες μεταβλητές: {name}, {first}", "Available variables: {name}, {first}")}</span>
            <button onClick={async () => {
              if (!message.trim()) return;
              const ex = (bd.data?.excluded ?? []).filter((x) => x.n > 0);
              const lines = ex.map((x) => `· ${x.n} ${x.reason}`).join("\n");
              const ok = await appConfirm(
                t(`Να σταλεί σε ${count} ανθρώπους;`, `Send to ${count} people?`) +
                (channel === "push" ? t("\n\nΤο κανάλι αυτό δεν χρεώνεται.", "\n\nThis channel is free.")
                                    : t(`\n\nΚόστος περίπου ${eur(costCents)}.`, `\n\nAbout ${eur(costCents)}.`)) +
                (ex.length ? t(`\n\nΕξαιρούνται ${bd.data!.total - count}:\n${lines}`, `\n\n${bd.data!.total - count} excluded:\n${lines}`) : "") +
                t("\n\nΜόλις ξεκινήσει μπορείς να το σταματήσεις, αλλά όσοι έχουν λάβει δεν αναιρούνται.",
                  "\n\nYou can stop it, but delivered messages cannot be recalled."),
                { confirmText: t(`Στείλε το σε ${count} ανθρώπους`, `Send to ${count}`) });
              if (ok) send.mutate();
            }}
              disabled={send.isPending || !message.trim() || !count || insufficient}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {count ? t(`Στείλε το σε ${count}`, `Send to ${count}`) : t("Αποστολή", "Send")}
            </button>
            {/* Δοκιμαστική αποστολή — ΠΑΝΤΑ πριν φύγει στους υπόλοιπους. */}
            <button onClick={async () => {
              const to = await appPrompt(t("Σε ποιο email/κινητό να σταλεί η δοκιμή;", "Where should the test go?"));
              if (to?.trim()) testSend.mutate(to.trim());
            }} disabled={!message.trim() || testSend.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              {testSend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} {t("Δοκιμαστική αποστολή", "Test send")}
            </button>
            {/* Ο AI γράφει ΠΡΟΣΧΕΔΙΟ. Το διαβάζεις, το αλλάζεις, το εγκρίνεις — ποτέ δεν φεύγει μόνο του. */}
            <button onClick={async () => {
              const b = await appPrompt(t("Τι θέλεις να τους πεις; (μια πρόταση αρκεί)", "What do you want to say?"));
              if (b?.trim()) aiDraft.mutate(b.trim());
            }} disabled={aiDraft.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              {aiDraft.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {t("Γράψ' το για μένα", "Draft it for me")}
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
    </>
  );
}
