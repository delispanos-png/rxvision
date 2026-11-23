"use client";

/* RxVision Κύπρος: Καμπάνιες. Η αποστολή είναι η ΚΟΙΝΗ μηχανή (ουρά, χρέωση πορτοφολιού, μία φορά
   ανά παραλήπτη, υποσέλιδο διαγραφής, προτιμήσεις πελάτη)· εδώ διαλέγεις μόνο ΠΟΙΟΥΣ, από τα
   δεδομένα ΓεΣΥ. Μήνυμα φεύγει ΜΟΝΟ σε όσους έδωσαν συγκατάθεση. Κοινό με δεδομένα υγείας
   (συνταγές, αναλώσιμα) → μόνο μήνυμα φροντίδας. */

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { api, ApiError } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { appConfirm } from "@/store/dialogStore";
import { fmtDateTime, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Seg = { key: string; label: string; label_en: string; clinical: boolean };
type Aud = { recipients: number; candidates: number; clinical: boolean; sample: (string | null)[];
  excluded: { no_contact: number; no_consent: number; unsubscribed: number; channel_off: number; capped: number } };
type Camp = { id: string; channel: string; segment: string; subject: string | null; message: string; status: string;
  recipients: number; sent: number; failed: number; created_at: string; purpose?: string };
const CHANNELS: [string, string, string][] = [["sms", "SMS", "SMS"], ["viber", "Viber", "Viber"], ["email", "Email", "Email"], ["push", "Ειδοποίηση πύλης", "Portal notification"]];
const ERR: Record<string, [string, string]> = {
  clinical_segment_requires_care_purpose: ["Αυτό το κοινό βγαίνει από δεδομένα υγείας: επιτρέπεται μόνο μήνυμα φροντίδας.", "This audience comes from health data: only a care message is allowed."],
  subject_required: ["Το email θέλει θέμα.", "An email needs a subject."],
  care_message_cannot_carry_offer: ["Το μήνυμα φροντίδας δεν μπορεί να έχει κουπόνι.", "A care message cannot carry a coupon."],
  bad_discount: ["Η έκπτωση % πρέπει να είναι έως 100.", "A % discount must be at most 100."],
};

export default function CyCampaignsPage() {
  // useSearchParams θέλει Suspense στο Next 14 (αλλιώς σπάει το build της σελίδας)
  return <Suspense fallback={null}><CyCampaignsInner /></Suspense>;
}

function CyCampaignsInner() {
  const t = useT();
  const qc = useQueryClient();
  // από Marketing → Dashboard / Θεραπευτικές κατηγορίες: ?segment=therapy:diabetes&channel=email
  const sp = useSearchParams();
  const [channel, setChannel] = useState(() => (["sms", "viber", "email", "push"].includes(sp.get("channel") ?? "") ? sp.get("channel")! : "sms"));
  const [segment, setSegment] = useState(() => sp.get("segment") || "all");
  // από «Ομάδες πελατών»: ?audience=<κανόνες>&label=… → ΜΟΝΟ όσοι ταιριάζουν (services/cy/audience.py)
  const [rules, setRules] = useState<{ conditions?: { field?: string }[] } | null>(() => {
    try { const a = sp.get("audience"); return a ? JSON.parse(a) : null; } catch { return null; }
  });
  const rulesLabel = sp.get("label") || "";
  const rulesCare = !!rules?.conditions?.some((c) => c.field === "therapy_atc");   // κλινικό πεδίο → μόνο φροντίδα
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Κουπόνι (μόνο σε εμπορικό μήνυμα): {coupon} στο κείμενο γίνεται ο κωδικός· εξαργύρωση στο ταμείο → απόδοση
  const [cpOn, setCpOn] = useState(false);
  const [cpType, setCpType] = useState<"pct" | "fixed">("pct");
  const [cpVal, setCpVal] = useState("10");
  const [cpDays, setCpDays] = useState("30");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const segs = useQuery({ queryKey: ["cy", "camp", "segs"], queryFn: () => api<{ items: Seg[] }>("/cy/campaigns/segments") });
  const aud = useQuery({ queryKey: ["cy", "camp", "aud", channel, segment, rules ? JSON.stringify(rules) : ""],
    queryFn: () => api<Aud>(rules
      ? `/cy/campaigns/audience?channel=${channel}&rules=${encodeURIComponent(JSON.stringify(rules))}&purpose=${rulesCare ? "care" : "commercial"}`
      : `/cy/campaigns/audience?channel=${channel}&segment=${segment}`) });
  const hist = useQuery({ queryKey: ["cy", "camp", "hist"], queryFn: () => api<{ items: Camp[] }>("/cy/campaigns") });
  const wallet = useQuery({ queryKey: ["comms", "wallet"], queryFn: () => api<{ balance_cents: number }>("/communications/wallet"), retry: false });
  const seg = segs.data?.items.find((s) => s.key === segment);
  const care = rules ? rulesCare : !!seg?.clinical;
  const a = aud.data;

  async function send() {
    if (!a || a.recipients === 0) return;
    const ok = await appConfirm(
      t(`Να σταλεί σε ${a.recipients} πελάτες μέσω ${channel.toUpperCase()};`, `Send to ${a.recipients} customers via ${channel.toUpperCase()}?`),
      { title: t("Αποστολή καμπάνιας", "Send campaign"), confirmText: t("Αποστολή", "Send"), cancelText: t("Άκυρο", "Cancel") });
    if (!ok) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ recipients: number }>("/cy/campaigns", { method: "POST",
        body: JSON.stringify({ channel, segment, rules: rules ?? undefined, purpose: care ? "care" : "commercial", subject: subject || null, message,
          coupon: cpOn && !care ? { discount_type: cpType, discount_value: cpType === "pct" ? Number(cpVal) : Math.round(Number(String(cpVal).replace(",", ".")) * 100),
            valid_days: Number(cpDays) || 30 } : null }) });
      setMsg({ ok: true, text: t(`Μπήκε στην ουρά για ${r.recipients} πελάτες. Η αποστολή γίνεται σε λίγα λεπτά.`, `Queued for ${r.recipients} customers. Sending takes a few minutes.`) });
      setMessage(""); setSubject("");
      qc.invalidateQueries({ queryKey: ["cy", "camp"] });
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: string })?.detail : "";
      const m = ERR[d || ""];
      setMsg({ ok: false, text: m ? t(m[0], m[1]) : t("Η αποστολή απέτυχε.", "Sending failed.") });
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Καμπάνιες", "Campaigns")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Στείλε μήνυμα σε μια ομάδα πελατών. Φεύγει μόνο σε όσους έδωσαν συγκατάθεση στην Καρτέλα πελάτη.", "Message a group of customers. It goes only to those who consented on their customer card.")}</p>
        </div>
        {wallet.data && (
          <Link href="/settings/communications" className="text-sm text-slate-500 hover:text-brand-600">
            {t("Υπόλοιπο μηνυμάτων", "Message credits")}: <b>{fmtEur(wallet.data.balance_cents)}</b> →
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title={t("Νέα καμπάνια", "New campaign")} className="lg:col-span-2">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map(([k, el, en]) => (
                <button key={k} onClick={() => setChannel(k)}
                  className={`rounded-full border px-3 py-1 text-sm ${channel === k ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>{t(el, en)}</button>
              ))}
            </div>
            {rules ? (
              <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm dark:bg-brand-950/30">
                <span className="text-xs text-slate-500">{t("Σε ποιους", "To whom")}:</span>
                <b className="text-brand-700 dark:text-brand-300">{rulesLabel || t("Ομάδα πελατών", "Customer group")}</b>
                <button type="button" onClick={() => setRules(null)} className="ml-auto text-xs text-slate-500 underline">{t("αλλαγή", "change")}</button>
              </div>
            ) : (
            <label className="block text-xs font-medium text-slate-500">{t("Σε ποιους", "To whom")}
              <select value={segment} onChange={(e) => setSegment(e.target.value)} className={`mt-1 ${inp}`}>
                {(segs.data?.items ?? []).map((s) => <option key={s.key} value={s.key}>{t(s.label, s.label_en)}{s.clinical ? ` · ${t("φροντίδα", "care")}` : ""}</option>)}
              </select>
            </label>
            )}
            {care && <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">
              {t("Αυτό το κοινό βγαίνει από τις συνταγές τους (δεδομένα υγείας). Γράψε μήνυμα φροντίδας, π.χ. υπενθύμιση, όχι προσφορά.", "This audience comes from their prescriptions (health data). Write a care message, e.g. a reminder, not an offer.")}</p>}
            {(channel === "email" || channel === "push") && (
              <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} className={inp}
                placeholder={channel === "email" ? t("Θέμα", "Subject") : t("Τίτλος ειδοποίησης (προαιρετικός)", "Notification title (optional)")} />
            )}
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} maxLength={1000} className={inp}
              placeholder={t("Γεια σου {first}! Η επόμενη φάση της συνταγής σου σε περιμένει στο φαρμακείο.", "Hi {first}! The next step of your prescription is waiting for you at the pharmacy.")} />
            <p className="text-[11px] text-slate-400">{t("{first} = μικρό όνομα, {name} = ονοματεπώνυμο.", "{first} = first name, {name} = full name.")}{cpOn && !care && ` ${t("{coupon} = ο κωδικός του κουπονιού.", "{coupon} = the coupon code.")}`} {channel === "sms" && `${message.length}/160`}</p>
            {!care && (
              <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
                <label className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">
                  <input type="checkbox" checked={cpOn} onChange={(e) => setCpOn(e.target.checked)} /> {t("Με κουπόνι έκπτωσης", "With a discount coupon")}
                </label>
                {cpOn && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <select value={cpType} onChange={(e) => setCpType(e.target.value as "pct" | "fixed")} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900">
                      <option value="pct">%</option><option value="fixed">€</option>
                    </select>
                    <input value={cpVal} onChange={(e) => setCpVal(e.target.value)} inputMode="decimal" className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900" />
                    <span className="text-xs text-slate-500">{t("ισχύει για", "valid for")}</span>
                    <input value={cpDays} onChange={(e) => setCpDays(e.target.value)} inputMode="numeric" className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900" />
                    <span className="text-xs text-slate-500">{t("ημέρες", "days")}</span>
                    {!message.includes("{coupon}") && <span className="w-full text-xs text-amber-700">{t("Βάλε {coupon} στο κείμενο για να φαίνεται ο κωδικός.", "Put {coupon} in the text so the code shows.")}</span>}
                  </div>
                )}
              </div>
            )}
            <button onClick={send} disabled={busy || !a || a.recipients === 0 || message.trim().length < 3 || (channel === "email" && !subject.trim())}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Αποστολή", "Send")}
            </button>
            {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
          </div>
        </PanelCard>

        <PanelCard title={t("Ποιοι θα το λάβουν", "Who will receive it")}>
          {aud.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-slate-400" /> : a && (
            <div className="space-y-2 text-sm">
              <div className="text-3xl font-bold text-slate-900 dark:text-slate-100">{fmtNum(a.recipients)}</div>
              <div className="text-xs text-slate-500">{t("από", "of")} {fmtNum(a.candidates)} {t("πελάτες του κοινού", "customers in the audience")}</div>
              <ul className="space-y-0.5 text-xs text-slate-500">
                <li>{t("χωρίς στοιχεία για το κανάλι", "no contact for this channel")}: {a.excluded.no_contact}</li>
                <li>{t("χωρίς συγκατάθεση", "no consent")}: {a.excluded.no_consent}</li>
                <li>{t("ζήτησαν να μη λαμβάνουν", "unsubscribed")}: {a.excluded.unsubscribed}</li>
                <li>{t("έκλεισαν το κανάλι", "turned this channel off")}: {a.excluded.channel_off}</li>
                <li>{t("έφτασαν το μηνιαίο όριο", "reached the monthly limit")}: {a.excluded.capped}</li>
              </ul>
              {a.excluded.no_contact + a.excluded.no_consent > 0 && (
                <p className="text-xs text-slate-400">{t("Για να μπουν κι άλλοι: γράψε κινητό/email και συγκατάθεση στην Καρτέλα πελάτη.", "To reach more: add mobile/email and consent on the customer card.")}</p>
              )}
            </div>
          )}
        </PanelCard>
      </div>

      <PanelCard title={t("Ιστορικό", "History")}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr>
              <th className="py-2 pr-3">{t("Ημ/νία", "Date")}</th><th className="py-2 pr-3">{t("Κανάλι", "Channel")}</th>
              <th className="py-2 pr-3">{t("Κοινό", "Audience")}</th><th className="py-2 pr-3">{t("Μήνυμα", "Message")}</th>
              <th className="py-2 pr-3 text-right">{t("Στάλθηκαν", "Sent")}</th><th className="py-2 text-right">{t("Κατάσταση", "Status")}</th></tr></thead>
            <tbody>
              {(hist.data?.items ?? []).map((c) => (
                <tr key={c.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="whitespace-nowrap py-2 pr-3">{fmtDateTime(c.created_at)}</td>
                  <td className="py-2 pr-3 uppercase">{c.channel}</td>
                  <td className="py-2 pr-3 text-xs">{(() => { const s = segs.data?.items.find((x) => x.key === c.segment); return s ? t(s.label, s.label_en) : c.segment; })()}</td>
                  <td className="max-w-md truncate py-2 pr-3 text-xs text-slate-600 dark:text-slate-300" title={c.message}>{c.subject ? `${c.subject}: ` : ""}{c.message}</td>
                  <td className="py-2 pr-3 text-right">{c.sent}/{c.recipients}{c.failed ? <span className="text-rose-600"> · {c.failed}✗</span> : null}</td>
                  <td className="py-2 text-right text-xs">{c.status}</td>
                </tr>
              ))}
              {hist.data && hist.data.items.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">{t("Καμία καμπάνια ακόμη.", "No campaigns yet.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </PanelCard>
    </div>
  );
}
