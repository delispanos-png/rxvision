"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Send, Loader2, ArrowUpRight, Compass, Mic, Zap } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { appConfirm } from "@/store/dialogStore";

type Action =
  | { type: "navigate"; href: string; label: string }
  | { type: "action"; action: string; label: string; summary: string; params?: Record<string, unknown> };
type Result = { ok: boolean; error?: string; limit?: number; reply: string; actions?: Action[] };
type PlanCard = { id: string; urgency: "high" | "medium" | "low"; icon: string; title: string; why: string; impact: string; executable?: boolean; action: { kind: "act"; key: string } | { kind: "navigate"; href: string }; cta: string };
type Plan = { cards: PlanCard[]; count: number; generated_at: string };
type Turn = { role: "user" | "assistant"; content: string; result?: Result };
type Status = { configured: boolean; enabled: boolean; model: string; today_used: number; daily_limit: number };

const QUICK = [
  ["Πόσος τζίρος & κέρδος τον τελευταίο μήνα;", "Revenue & profit last month?"],
  ["Ποιοι είναι οι top 5 ιατροί;", "Who are the top 5 doctors?"],
  ["Έχω εκκρεμή αιτήματα πελατών;", "Any pending customer requests?"],
  ["Ξεκίνα συγχρονισμό ΗΔΥΚΑ", "Start ΗΔΥΚΑ sync"],
  ["Πώς κάνω κλείσιμο μήνα;", "How do I do the monthly closing?"],
] as const;

export default function CopilotPage() {
  const t = useT();
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: ["copilot-status"], queryFn: () => api<Status>("/copilot/status") });
  const plan = useQuery({ queryKey: ["copilot-plan"], queryFn: () => api<Plan>("/copilot/action-plan"), refetchInterval: 120000 });
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns, busy]);

  // Voice input — browser-native Greek speech-to-text (no backend, no Anthropic credits)
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
  function toggleMic() {
    const r = recogRef.current;
    if (!r) return;
    if (listening) { r.stop(); setListening(false); }
    else { setInput(""); try { r.start(); setListening(true); } catch { /* already started */ } }
  }
  /* eslint-enable */

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || busy) return;
    const history = [...turns, { role: "user" as const, content: msg }];
    setTurns(history); setInput(""); setBusy(true);
    try {
      const res = await api<Result>("/copilot/chat", { method: "POST", body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })) }) });
      setTurns((s) => [...s, { role: "assistant", content: res.reply || "", result: res }]);
    } catch {
      setTurns((s) => [...s, { role: "assistant", content: "", result: { ok: false, error: "network" } as Result }]);
    }
    setBusy(false);
  }

  async function runAction(a: Extract<Action, { type: "action" }>) {
    if (busy) return;
    if (!(await appConfirm(`${a.summary}\n\nΝα συνεχίσω;`))) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; reply?: string; error?: string }>("/copilot/act", { method: "POST", body: JSON.stringify({ action: a.action, params: a.params ?? {} }) });
      const reply = r.reply || (r.ok ? "Έγινε." : t("Η ενέργεια απέτυχε.", "The action failed."));
      setTurns((s) => [...s, { role: "assistant", content: "", result: { ok: true, reply } }]);
    } catch {
      setTurns((s) => [...s, { role: "assistant", content: "", result: { ok: false, error: "network", reply: "" } }]);
    }
    setBusy(false);
  }

  async function execCard(c: PlanCard) {
    if (c.action.kind === "navigate") { router.push(c.action.href); return; }
    if (busy) return;
    if (!(await appConfirm(`${c.title}\n${c.why}\n\nΝα εκτελεστεί;`))) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; reply?: string }>("/copilot/act", { method: "POST", body: JSON.stringify({ action: (c.action as { key: string }).key, params: {} }) });
      setTurns((s) => [...s, { role: "assistant", content: "", result: { ok: true, reply: r.reply || "Έγινε." } }]);
      plan.refetch();
    } catch {
      setTurns((s) => [...s, { role: "assistant", content: "", result: { ok: false, error: "network", reply: "" } }]);
    }
    setBusy(false);
  }

  const notConfigured = status.data && !status.data.configured;
  const disabled = status.data && status.data.configured && !status.data.enabled;
  const blocked = notConfigured || disabled;

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] max-w-3xl flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 pb-3 dark:border-slate-700">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-lg"><Sparkles className="h-6 w-6" /></span>
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">RxVision Copilot</h1>
          <p className="text-xs text-slate-500">{t("Ρώτα με πώς γίνεται κάτι, ζήτα δεδομένα (τζίρος, top ιατροί, εκκρεμότητες) ή ζήτα ενέργειες (π.χ. συγχρονισμός ΗΔΥΚΑ).", "Ask how to do something, ask for data (revenue, top doctors, pending), or ask for actions (e.g. ΗΔΥΚΑ sync).")}</p>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto py-4">
        {notConfigured && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30">⚠️ {t("Δεν είναι ρυθμισμένο (λείπει το Anthropic API key — Admin → Integrations).", "Not configured (missing Anthropic API key — Admin → Integrations).")}</div>}
        {disabled && <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60">⏸️ {t("Η υπηρεσία είναι απενεργοποιημένη.", "The service is disabled.")}</div>}

        {!blocked && turns.length === 0 && !!plan.data?.cards?.length && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200"><Zap className="h-4 w-4 text-amber-500" /> {t("Πλάνο ημέρας", "Today's plan")}</div>
            {plan.data.cards.map((c) => (
              <div key={c.id} className={`rounded-xl border p-3 ${c.urgency === "high" ? "border-rose-200 bg-rose-50/50 dark:border-rose-900/40 dark:bg-rose-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800/60"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {c.urgency === "high" && <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">ΕΠΕΙΓΟΝ</span>}
                      {c.title}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{c.why}</div>
                  </div>
                  <button onClick={() => execCard(c)} disabled={busy}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${c.executable ? "bg-sky-600 text-white hover:bg-sky-700" : "border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"}`}>
                    {c.executable ? <Zap className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />} {c.cta}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {turns.length === 0 && !blocked && (
          <div className="space-y-4 py-6 text-center">
            <Compass className="mx-auto h-8 w-8 text-sky-400" />
            <p className="text-sm text-slate-500">{t("Π.χ. δοκίμασε:", "e.g. try:")}</p>
            <div className="mx-auto flex max-w-xl flex-wrap justify-center gap-1.5">
              {QUICK.map(([el, en]) => <button key={el} onClick={() => send(t(el, en))} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-sky-300 hover:bg-sky-50 dark:border-slate-700 dark:bg-slate-800">{t(el, en)}</button>)}
            </div>
          </div>
        )}

        {turns.map((turn, i) => turn.role === "user" ? (
          <div key={i} className="flex justify-end"><div className="max-w-[80%] rounded-2xl rounded-br-sm bg-sky-600 px-4 py-2 text-sm text-white">{turn.content}</div></div>
        ) : (
          <div key={i} className="flex gap-2">
            <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-900/40"><Sparkles className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1 space-y-2">
              {turn.result && !turn.result.ok ? (
                <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/30">
                  {turn.result.error === "daily_limit" ? `${t("Εξαντλήθηκε το ημερήσιο όριο", "Daily limit reached")} (${turn.result.limit ?? 50}).` : t("Σφάλμα — δοκιμάστε ξανά.", "Error — try again.")}
                </div>
              ) : (
                <>
                  <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-2.5 text-sm leading-relaxed text-slate-700 whitespace-pre-wrap dark:bg-slate-800 dark:text-slate-200">{turn.result?.reply}</div>
                  {!!turn.result?.actions?.length && (
                    <div className="flex flex-wrap gap-1.5">
                      {turn.result.actions.map((a, j) => a.type === "navigate" ? (
                        <button key={j} onClick={() => router.push(a.href)} className="inline-flex items-center gap-1 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:border-sky-400 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">{a.label} <ArrowUpRight className="h-3 w-3" /></button>
                      ) : (
                        <button key={j} onClick={() => runAction(a)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:border-amber-400 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"><Zap className="h-3 w-3" /> {a.label}</button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="flex gap-2 text-sm text-slate-400"><span className="grid h-7 w-7 place-items-center rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-900/40"><Sparkles className="h-4 w-4" /></span><span className="flex items-center gap-1.5 pt-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("ψάχνω…", "looking…")}</span></div>}
        <div ref={endRef} />
      </div>

      <div className="border-t border-slate-200 pt-3 dark:border-slate-700">
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(input); }}
            disabled={busy || blocked} placeholder={t("Πώς κάνω… ; / Πού βλέπω… ;", "How do I… ? / Where do I see… ?")}
            className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800" />
          {micOk && (
            <Tooltip label={t("Πες την εντολή", "Speak the command")}><button onClick={toggleMic} disabled={busy || blocked} className={`grid place-items-center rounded-xl border px-3 disabled:opacity-40 ${listening ? "animate-pulse border-rose-300 bg-rose-50 text-rose-600 dark:border-rose-700 dark:bg-rose-950/40" : "border-slate-300 text-slate-500 hover:bg-slate-50 dark:border-slate-600"}`}><Mic className="h-4 w-4" /></button></Tooltip>
          )}
          <button onClick={() => send(input)} disabled={busy || blocked || !input.trim()} className="grid place-items-center rounded-xl bg-sky-600 px-4 text-white hover:bg-sky-700 disabled:opacity-40"><Send className="h-4 w-4" /></button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-slate-400">{t("Οδηγός + δεδομένα + ενέργειες. Οι ενέργειες εκτελούνται μόνο μετά από επιβεβαίωσή σου.", "Guide + data + actions. Actions run only after your confirmation.")}</p>
      </div>
    </div>
  );
}
