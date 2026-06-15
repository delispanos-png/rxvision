"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Cat, Send, Loader2, AlertOctagon, Stethoscope, Pill, Package, ShieldAlert,
  HelpCircle, Sparkles, Lightbulb, FlaskConical, Mic, X, Info, Trash2,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtEur } from "@/lib/formatters";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type RedFlag = { flag: string; action: string };
type Substance = { name: string; atc: string; note: string };
type Interaction = { a: string; b: string; severity: string; mechanism: string; risk: string; action: string };
type Product = { name: string; narcotic: boolean; eof: string };
type MedInfo = { ok: boolean; eof: string; full_name: string; name: string; substance: string; atc: string; content: string; form_code: string; package_form: string; barcode: string; retail_cents: number; wholesale_cents: number; reference_cents: number; participation: number; narcotic: boolean; high_cost: boolean; category: string };
type ProductGroup = { substance: string; products: Product[] };
type Safety = { pregnancy: string; lactation: string; renal: string; hepatic: string; pediatric: string; elderly: string };
type Referral = { needed: boolean; urgency: string; reason: string };
type Question = { question: string; options: string[] };
type Result = {
  ok: boolean; error?: string; limit?: number; source?: string; reply: string; stage?: string;
  red_flags: RedFlag[]; questions: Question[]; otc_categories: string[];
  substances: Substance[]; non_drug_advice: string[]; interactions: Interaction[];
  safety?: Safety; referral?: Referral; products?: ProductGroup[];
};
type Status = { configured: boolean; enabled: boolean; model: string; today_used: number; daily_limit: number };
type Turn = { role: "user" | "assistant"; content: string; result?: Result };

const SYMPTOMS = ["Βήχας", "Πονόλαιμος", "Συνάχι", "Πυρετός", "Πονοκέφαλος", "Ημικρανία", "Δυσπεψία", "Διάρροια", "Δυσκοιλιότητα", "Καούρα", "Αλλεργία", "Ξηροφθαλμία", "Μυϊκός πόνος", "Δερματικός ερεθισμός", "Ναυτία"];

const SEV: Record<string, { cls: string; el: string }> = {
  minor: { cls: "bg-emerald-100 text-emerald-700 border-emerald-200", el: "Ήσσονος" },
  moderate: { cls: "bg-amber-100 text-amber-700 border-amber-200", el: "Μέτρια" },
  major: { cls: "bg-orange-100 text-orange-700 border-orange-200", el: "Σοβαρή" },
  contraindicated: { cls: "bg-rose-100 text-rose-700 border-rose-200", el: "Αντένδειξη" },
};
const URGENCY: Record<string, { cls: string; el: string }> = {
  none: { cls: "bg-slate-100 text-slate-600", el: "—" },
  gp: { cls: "bg-amber-100 text-amber-700", el: "Παραπομπή σε ιατρό" },
  urgent: { cls: "bg-orange-100 text-orange-700", el: "Επείγουσα παραπομπή" },
  emergency: { cls: "bg-rose-100 text-white !bg-rose-600", el: "ΕΠΕΙΓΟΝ — Νοσοκομείο" },
};

export default function PharmaCatPage() {
  return (
    <ModuleGuard module="pharmacat">
      <PharmaCatInner />
    </ModuleGuard>
  );
}

function PharmaCatInner() {
  const t = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: ["pharmacat-status"], queryFn: () => api<Status>("/pharmacat/status") });
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns, busy]);
  useEffect(() => { if (!busy) status.refetch(); }, [turns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Voice input — browser-native Greek speech-to-text (no backend, free)
  /* eslint-disable */
  const recogRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const [micOk, setMicOk] = useState(false);
  useEffect(() => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return;
    setMicOk(true);
    const r = new SR();
    r.lang = "el-GR";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e: any) => setInput(Array.from(e.results).map((res: any) => res[0].transcript).join(""));
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recogRef.current = r;
  }, []);
  /* eslint-enable */
  function toggleMic() {
    const r = recogRef.current;
    if (!r) return;
    if (listening) { r.stop(); setListening(false); }
    else { setInput(""); try { r.start(); setListening(true); } catch { /* already started */ } }
  }

  // Medicine info popup (ΗΔΥΚΑ catalogue) — click a product
  const [med, setMed] = useState<MedInfo | null>(null);
  const [medLoading, setMedLoading] = useState(false);
  async function openMed(eof: string) {
    if (!eof) return;
    setMed(null); setMedLoading(true);
    try { const d = await api<MedInfo>(`/pharmacat/medicine?eof=${encodeURIComponent(eof)}`); setMed(d.ok ? d : null); }
    catch { setMed(null); }
    setMedLoading(false);
  }
  function row(label: string, value: string | null | undefined) {
    if (!value) return null;
    return <div className="flex justify-between gap-3"><dt className="text-slate-500">{label}</dt><dd className="text-right font-medium text-slate-700 dark:text-slate-200">{value}</dd></div>;
  }

  async function send(text: string, mode: "chat" | "interactions" = "chat") {
    const msg = text.trim();
    if (!msg || busy) return;
    const history = [...turns, { role: "user" as const, content: msg }];
    setTurns(history);
    setInput("");
    setBusy(true);
    try {
      let res: Result;
      if (mode === "interactions") {
        res = await api<Result>("/pharmacat/interactions", { method: "POST", body: JSON.stringify({ drugs: msg.split(/[,\n]/).map((d) => d.trim()).filter(Boolean) }) });
      } else {
        res = await api<Result>("/pharmacat/chat", { method: "POST", body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })) }) });
      }
      setTurns((s) => [...s, { role: "assistant", content: res.reply || "", result: res }]);
    } catch {
      setTurns((s) => [...s, { role: "assistant", content: "", result: { ok: false, error: "network" } as Result }]);
    }
    setBusy(false);
  }

  const notConfigured = status.data && !status.data.configured;
  const svcOff = status.data && status.data.configured && !status.data.enabled;
  const blocked = notConfigured || svcOff;

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] max-w-4xl flex-col">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-slate-200 pb-3 dark:border-slate-700">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg"><Cat className="h-6 w-6" /></span>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">PharmaCat <span className="text-sm font-normal text-slate-400">Clinical Assistant</span></h1>
          <p className="text-xs text-slate-500">{t("Επιστημονικός βοηθός φαρμακοποιού (CDSS) — δεν διαγιγνώσκει, δεν αντικαθιστά ιατρό.", "Pharmacist's scientific assistant (CDSS) — not diagnosis, not a doctor replacement.")}</p>
        </div>
        {status.data?.configured && status.data?.enabled && (
          <span className="hidden shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500 sm:inline dark:bg-slate-800" title={t("Νέες ερωτήσεις AI σήμερα (οι αποθηκευμένες είναι δωρεάν)", "New AI questions today (cached are free)")}>{status.data.today_used}/{status.data.daily_limit} {t("σήμερα", "today")}</span>
        )}
        {turns.length > 0 && (
          <button onClick={() => { setTurns([]); setInput(""); setMed(null); }}
            title={t("Καθαρισμός συνομιλίας", "Clear conversation")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800">
            <Trash2 className="h-3.5 w-3.5" /> {t("Καθαρισμός", "Clear")}
          </button>
        )}
      </div>

      {/* thread */}
      <div className="flex-1 space-y-4 overflow-y-auto py-4">
        {notConfigured && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30">
            ⚠️ {t("Το PharmaCat δεν είναι ρυθμισμένο. Καταχωρήστε το Anthropic API key στο Admin → Integrations.", "PharmaCat is not configured. Enter the Anthropic API key in Admin → Integrations.")}
          </div>
        )}
        {svcOff && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60">
            ⏸️ {t("Η υπηρεσία PharmaCat είναι προσωρινά απενεργοποιημένη από τον διαχειριστή.", "PharmaCat is temporarily disabled by the administrator.")}
          </div>
        )}

        {turns.length === 0 && !blocked && (
          <div className="space-y-4 py-6 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-violet-400" />
            <p className="text-sm text-slate-500">{t("Περιγράψτε ένα σύμπτωμα ή ρωτήστε κλινικά (π.χ. «Ασθενής με Xarelto & Concor — μπορώ Algofren;»). Ο PharmaCat κάνει triage, ελέγχει red flags & αλληλεπιδράσεις, και προτείνει κατηγορίες/προϊόντα.", "Describe a symptom or ask clinically (e.g. \"Patient on Xarelto & Concor — can I give Algofren?\"). PharmaCat triages, checks red flags & interactions, suggests categories/products.")}</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {SYMPTOMS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-violet-300 hover:bg-violet-50 dark:border-slate-700 dark:bg-slate-800">{s}</button>)}
            </div>
          </div>
        )}

        {turns.map((turn, i) => turn.role === "user" ? (
          <div key={i} className="flex justify-end"><div className="max-w-[80%] rounded-2xl rounded-br-sm bg-violet-600 px-4 py-2 text-sm text-white">{turn.content}</div></div>
        ) : (
          <div key={i} className="flex gap-2">
            <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-900/40"><Cat className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1 space-y-2">
              {turn.result && !turn.result.ok ? (
                <div className={`rounded-xl px-3 py-2 text-sm ${turn.result.error === "daily_limit" ? "bg-amber-50 text-amber-800 dark:bg-amber-950/30" : "bg-rose-50 text-rose-700 dark:bg-rose-950/30"}`}>
                  {turn.result.error === "daily_limit"
                    ? `${t("Εξαντλήθηκε το ημερήσιο όριο νέων ερωτήσεων", "Daily new-question limit reached")} (${turn.result.limit ?? 50}). ${t("Οι αποθηκευμένες απαντήσεις παραμένουν διαθέσιμες — δοκιμάστε ξανά αύριο.", "Saved answers remain available — try again tomorrow.")}`
                    : turn.result.error === "disabled" ? t("Η υπηρεσία είναι απενεργοποιημένη.", "The service is disabled.")
                    : turn.result.error === "not_configured" ? t("Μη ρυθμισμένο (λείπει το API key).", "Not configured (missing API key).")
                    : t("Σφάλμα επικοινωνίας — δοκιμάστε ξανά.", "Communication error — try again.")}
                </div>
              ) : <AssistantCard r={turn.result!} t={t} onAnswer={(a) => send(a)} onMed={openMed} />}
            </div>
          </div>
        ))}
        {busy && <div className="flex gap-2 text-sm text-slate-400"><span className="grid h-7 w-7 place-items-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-900/40"><Cat className="h-4 w-4" /></span><span className="flex items-center gap-1.5 pt-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("σκέφτεται…", "thinking…")}</span></div>}
        <div ref={endRef} />
      </div>

      {/* input */}
      <div className="border-t border-slate-200 pt-3 dark:border-slate-700">
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            disabled={busy || blocked} placeholder={t("Σύμπτωμα ή κλινική ερώτηση…", "Symptom or clinical question…")}
            className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800" />
          {micOk && (
            <button onClick={toggleMic} disabled={busy || blocked} title={t("Πες το σύμπτωμα", "Speak the symptom")} className={`grid place-items-center rounded-xl border px-3 disabled:opacity-40 ${listening ? "animate-pulse border-rose-300 bg-rose-50 text-rose-600 dark:border-rose-700 dark:bg-rose-950/40" : "border-slate-300 text-slate-500 hover:bg-slate-50 dark:border-slate-600"}`}><Mic className="h-4 w-4" /></button>
          )}
          <button onClick={() => send(input, "interactions")} disabled={busy || blocked || !input.trim()} title={t("Έλεγχος αλληλεπιδράσεων (φάρμακα χωρισμένα με κόμμα)", "Interaction check (comma-separated drugs)")} className="grid place-items-center rounded-xl border border-slate-300 px-3 text-slate-500 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600"><FlaskConical className="h-4 w-4" /></button>
          <button onClick={() => send(input)} disabled={busy || blocked || !input.trim()} className="grid place-items-center rounded-xl bg-violet-600 px-4 text-white hover:bg-violet-700 disabled:opacity-40"><Send className="h-4 w-4" /></button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-slate-400">{t("Υποστήριξη απόφασης για επαγγελματία υγείας. Δεν υποκαθιστά την κλινική κρίση ή τον ιατρό.", "Decision support for a health professional. Does not replace clinical judgment or a physician.")}</p>
      </div>

      {/* medicine info modal — ΗΔΥΚΑ catalogue */}
      {(med || medLoading) && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => { setMed(null); setMedLoading(false); }}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            {medLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> {t("Φόρτωση…", "Loading…")}</div>
            ) : med ? (
              <>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-violet-500"><Info className="h-3.5 w-3.5" /> {t("Πληροφορίες ΗΔΥΚΑ", "ΗΔΥΚΑ info")}</div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{med.full_name}</h3>
                  </div>
                  <button onClick={() => setMed(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
                </div>
                <dl className="space-y-1.5 text-sm">
                  {row(t("Δραστική", "Substance"), med.substance)}
                  {row("ATC", med.atc)}
                  {row(t("Περιεκτικότητα", "Content"), med.content)}
                  {row(t("Μορφή", "Form"), med.form_code)}
                  {row(t("Συσκευασία", "Package"), med.package_form)}
                  {row("Barcode", med.barcode)}
                  {row(t("Λιανική (Δελτίο Τιμών)", "Retail (price bulletin)"), med.retail_cents != null ? fmtEur(med.retail_cents) : null)}
                  {row(t("Χονδρική", "Wholesale"), med.wholesale_cents != null ? fmtEur(med.wholesale_cents) : null)}
                  {row(t("Τιμή αναφοράς", "Reference price"), med.reference_cents ? fmtEur(med.reference_cents) : null)}
                  {row(t("Συμμετοχή", "Participation"), med.participation != null ? `${med.participation}%` : null)}
                </dl>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {med.narcotic && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">⚠ {t("Ναρκωτικό", "Narcotic")}</span>}
                  {med.high_cost && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">{t("Υψηλού κόστους (ΦΥΚ)", "High-cost")}</span>}
                </div>
                <p className="mt-3 text-[10px] text-slate-400">{t("Τιμή & διαθεσιμότητα στο φαρμακείο: από το σύστημά σας.", "Pharmacy price & stock: from your own system.")}</p>
              </>
            ) : (
              <div className="text-sm text-slate-500">{t("Δεν βρέθηκαν στοιχεία.", "No data found.")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AssistantCard({ r, t, onAnswer, onMed }: { r: Result; t: (el: string, en: string) => string; onAnswer: (a: string) => void; onMed: (eof: string) => void }) {
  const ref = r.referral;
  return (
    <>
      {/* RED FLAGS — top priority */}
      {!!r.red_flags?.length && (
        <div className="rounded-xl border-2 border-rose-300 bg-rose-50 p-3 dark:border-rose-800 dark:bg-rose-950/40">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-bold text-rose-700"><AlertOctagon className="h-4 w-4" /> {t("ΚΟΚΚΙΝΕΣ ΣΗΜΑΙΕΣ — διακοπή προτάσεων", "RED FLAGS — stop recommendations")}</div>
          <ul className="space-y-1 text-xs text-rose-700">{r.red_flags.map((f, i) => <li key={i}>• <b>{f.flag}</b> → {f.action}</li>)}</ul>
        </div>
      )}

      {r.source === "cache" && <div className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:bg-emerald-950/30">⚡ {t("από τη βάση γνώσης (άμεσο)", "from knowledge base (instant)")}</div>}

      {r.reply && <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-2.5 text-sm leading-relaxed text-slate-700 dark:bg-slate-800 dark:text-slate-200">{r.reply}</div>}

      {/* dynamic questions — one-click quick replies */}
      {!!r.questions?.length && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300"><HelpCircle className="h-3.5 w-3.5 text-indigo-500" /> {t("Για εξειδίκευση — ένα κλικ", "Refine — one click")}</div>
          <div className="space-y-2">{r.questions.map((q, i) => (
            <div key={i}>
              <div className="text-xs text-slate-600 dark:text-slate-300">{q.question}</div>
              {!!q.options?.length && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {q.options.map((o, j) => (
                    <button key={j} onClick={() => onAnswer(`${q.question} ${o}`)} className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:border-indigo-400 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300">{o}</button>
                  ))}
                </div>
              )}
            </div>
          ))}</div>
        </div>
      )}

      {/* OTC categories + substances */}
      {(!!r.otc_categories?.length || !!r.substances?.length) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-emerald-700"><Pill className="h-3.5 w-3.5" /> {t("Θεραπευτική πρόταση (OTC)", "Therapeutic suggestion (OTC)")}</div>
          {!!r.otc_categories?.length && <div className="mb-2 flex flex-wrap gap-1">{r.otc_categories.map((c, i) => <span key={i} className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{c}</span>)}</div>}
          {!!r.substances?.length && <ul className="space-y-0.5 text-xs text-slate-600 dark:text-slate-300">{r.substances.map((s, i) => <li key={i}>• <b>{s.name}</b>{s.atc ? <span className="font-mono text-slate-400"> {s.atc}</span> : ""}{s.note ? ` — ${s.note}` : ""}</li>)}</ul>}
        </div>
      )}

      {/* market products by substance — NAMES only (pharmacist sees price/stock in their own system) */}
      {!!r.products?.length && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300"><Package className="h-3.5 w-3.5 text-violet-500" /> {t("Σκευάσματα αγοράς ανά δραστική", "Market products by substance")}</div>
          <div className="space-y-2">{r.products.map((g, i) => (
            <div key={i}>
              <div className="mb-1 text-[11px] font-medium text-slate-400">{g.substance}</div>
              <div className="flex flex-wrap gap-1">
                {g.products.map((p, j) => (
                  <button key={j} onClick={() => onMed(p.eof)} title={t("Πληροφορίες φαρμάκου", "Medicine info")} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700 transition hover:bg-violet-100 hover:text-violet-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-violet-900/40">{p.name}{p.narcotic ? " ⚠" : ""}</button>
                ))}
              </div>
            </div>
          ))}</div>
          <p className="mt-2 text-[10px] text-slate-400">{t("Τιμή & διαθεσιμότητα: από το σύστημα του φαρμακείου.", "Price & availability: from the pharmacy's own system.")}</p>
        </div>
      )}

      {/* interactions */}
      {!!r.interactions?.length && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300"><ShieldAlert className="h-3.5 w-3.5 text-orange-500" /> {t("Αλληλεπιδράσεις", "Interactions")}</div>
          <div className="space-y-2">{r.interactions.map((x, i) => {
            const sv = SEV[x.severity] ?? SEV.moderate;
            return (
              <div key={i} className={`rounded-lg border p-2 text-xs ${sv.cls}`}>
                <div className="flex items-center justify-between font-semibold"><span>{x.a} ↔ {x.b}</span><span className="rounded-full bg-white/60 px-2 py-0.5 text-[10px]">{sv.el}</span></div>
                {x.mechanism && <div className="mt-0.5 opacity-90"><b>{t("Μηχανισμός", "Mechanism")}:</b> {x.mechanism}</div>}
                {x.risk && <div className="opacity-90"><b>{t("Κίνδυνος", "Risk")}:</b> {x.risk}</div>}
                {x.action && <div className="opacity-90"><b>{t("Ενέργεια", "Action")}:</b> {x.action}</div>}
              </div>
            );
          })}</div>
        </div>
      )}

      {/* non-drug advice */}
      {!!r.non_drug_advice?.length && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/50 p-3 dark:border-sky-900/40 dark:bg-sky-950/20">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-sky-700"><Lightbulb className="h-3.5 w-3.5" /> {t("Μη φαρμακευτικές συμβουλές", "Non-drug advice")}</div>
          <ul className="space-y-0.5 text-xs text-slate-600 dark:text-slate-300">{r.non_drug_advice.map((a, i) => <li key={i}>• {a}</li>)}</ul>
        </div>
      )}

      {/* safety grid */}
      {r.safety && Object.values(r.safety).some(Boolean) && (
        <div className="grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-3">
          {([["pregnancy", "Εγκυμοσύνη"], ["lactation", "Θηλασμός"], ["renal", "Νεφρική"], ["hepatic", "Ηπατική"], ["pediatric", "Παιδιατρική"], ["elderly", "Ηλικιωμένοι"]] as const).map(([k, lbl]) => r.safety![k] ? (
            <div key={k} className="rounded-lg border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"><span className="font-semibold text-slate-500">{lbl}:</span> <span className="text-slate-600 dark:text-slate-300">{r.safety![k]}</span></div>
          ) : null)}
        </div>
      )}

      {/* referral */}
      {ref?.needed && (
        <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ${URGENCY[ref.urgency]?.cls ?? URGENCY.gp.cls}`}>
          <Stethoscope className="h-4 w-4" /> {URGENCY[ref.urgency]?.el ?? ref.urgency}{ref.reason ? ` — ${ref.reason}` : ""}
        </div>
      )}
    </>
  );
}
