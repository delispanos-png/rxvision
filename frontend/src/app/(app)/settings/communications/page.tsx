"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Loader2, Wallet, Info, Download, RefreshCw } from "lucide-react";
import { api, API_BASE } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { appAlert } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Chan = { count: number; spent_cents: number };
type WalletRes = {
  balance_cents: number; days: number;
  prices: { email: number; sms: number; viber: number };
  by_channel: { email: Chan; sms: Chan; viber: Chan };
  ledger?: { channel: string; kind: string; count: number; amount_cents: number; balance_after: number; ts: string | null }[];
  auto_recharge?: { enabled?: boolean; threshold_cents?: number; package_id?: string | null };
  card_on_file?: boolean;
};

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const cents = (c: number) => "€" + ((c || 0) / 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

type Pkg = { _id: string; name: string; price_cents: number; credits_cents: number };

/** Open the Revolut Checkout popup for a top-up order token (loads embed.js on demand). */
function payWithRevolut(token: string, mode: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const w = window as unknown as { RevolutCheckout?: (t: string, m: string) => Promise<{ payWithPopup: (o: Record<string, () => void>) => void }> };
    const run = () => {
      if (!w.RevolutCheckout) return resolve();
      w.RevolutCheckout(token, mode === "live" ? "prod" : "sandbox")
        .then((rc) => rc.payWithPopup({ onSuccess: resolve, onError: resolve, onCancel: resolve }))
        .catch(() => resolve());
    };
    if (w.RevolutCheckout) return run();
    const s = document.createElement("script");
    s.src = mode === "live" ? "https://merchant.revolut.com/embed.js" : "https://sandbox-merchant.revolut.com/embed.js";
    s.onload = run; s.onerror = () => resolve();
    document.body.appendChild(s);
  });
}

export default function CommsSettingsPage() {
  const t = useT();
  const q = useQuery({ queryKey: ["comms", "wallet"], queryFn: () => api<WalletRes>("/communications/wallet"), retry: false });
  const [testTo, setTestTo] = useState("");
  const [chan, setChan] = useState<"email" | "sms" | "viber">("email");
  const test = useMutation({
    mutationFn: () => api(`/communications/test-${chan}?to=${encodeURIComponent(testTo)}`, { method: "POST" }),
    onError: (e: Error) => appAlert(t("Αποτυχία: ", "Failed: ") + e.message),
    onSuccess: () => { appAlert(t("Στάλθηκε δοκιμαστικό ✅", "Test sent ✅")); q.refetch(); },
  });
  const pkgs = useQuery({ queryKey: ["credit-packages"], queryFn: () => api<{ items: Pkg[] }>("/communications/credit-packages"), retry: false });
  type Msg = { id: string; channel: string; recipient: string; status: string; cost_cents: number; kind?: string; subject?: string | null; refunded?: boolean; created_at: string | null; delivered_at?: string | null };
  const msgs = useQuery({ queryKey: ["comms", "messages"], queryFn: () => api<{ items: Msg[]; summary_30d: Record<string, number> }>("/communications/messages"), retry: false, refetchInterval: 30000 });
  type Charge = { id: string; channel: string; recipient: string; status: string; cost_cents: number; refunded: boolean; created_at: string | null };
  type ChargesRes = { items: Charge[]; days: number; total_cents: number; count: number; by_channel: Record<string, number>; refunded_cents: number };
  const [chDays, setChDays] = useState(30);
  const charges = useQuery({ queryKey: ["comms", "charges", chDays], queryFn: () => api<ChargesRes>(`/communications/charges?days=${chDays}`), retry: false });
  type SenderCfg = { sms_sender: string; sms_sender_approved: boolean; viber_sender: string; viber_sender_approved: boolean };
  const senderQ = useQuery({ queryKey: ["comms", "sender"], queryFn: () => api<SenderCfg>("/communications/sender"), retry: false });
  const [senderIn, setSenderIn] = useState("");
  const saveSender = useMutation({
    mutationFn: () => api("/communications/sender", { method: "PUT", body: JSON.stringify({ channel: "sms", sender: senderIn }) }),
    onSuccess: () => { setSenderIn(""); senderQ.refetch(); appAlert(t("Το αίτημα καταχωρήθηκε — αναμονή έγκρισης.", "Request saved — pending approval.")); },
  });
  const ST: Record<string, { el: string; en: string; cls: string }> = {
    sent: { el: "Εστάλη", en: "Sent", cls: "bg-sky-100 text-sky-700" },
    delivered: { el: "Παραδόθηκε", en: "Delivered", cls: "bg-emerald-100 text-emerald-700" },
    failed: { el: "Απέτυχε", en: "Failed", cls: "bg-rose-100 text-rose-700" },
    undelivered: { el: "Δεν παραδόθηκε", en: "Undelivered", cls: "bg-rose-100 text-rose-700" },
  };
  const [buying, setBuying] = useState<string | null>(null);
  async function buy(pid: string) {
    setBuying(pid);
    try {
      const r = await api<{ token?: string; mode?: string; provider?: string; checkout_url?: string }>("/communications/topup", { method: "POST", body: JSON.stringify({ package_id: pid }) });
      if (r.provider === "viva" && r.checkout_url) { window.location.href = r.checkout_url; return; }  // κάρτα/IRIS
      await payWithRevolut(r.token!, r.mode!);
      setTimeout(() => q.refetch(), 3000);   // wallet is credited asynchronously by the webhook
      appAlert(t("Η πληρωμή ολοκληρώθηκε — το υπόλοιπο ενημερώνεται σε λίγο. ✅", "Payment done — balance updates shortly. ✅"));
    } catch (e) {
      appAlert(t("Αποτυχία αγοράς: ", "Purchase failed: ") + (e as Error).message);
    } finally { setBuying(null); }
  }
  async function downloadCsv() {
    const token = typeof window !== "undefined" ? window.localStorage.getItem("access_token") : null;
    const res = await fetch(`${API_BASE}/communications/charges?days=${chDays}&format=csv`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `charges_${chDays}d.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  const [arForm, setArForm] = useState<{ enabled: boolean; threshold: string; package_id: string } | null>(null);
  const d = q.data;
  const CH: { k: "email" | "sms" | "viber"; label: string; icon: typeof Mail }[] = [
    { k: "email", label: "Email", icon: Mail },
    { k: "sms", label: "SMS", icon: MessageSquare },
    { k: "viber", label: "Viber", icon: MessageSquare },
  ];
  const low = (d?.balance_cents ?? 0) < 200;
  const arCur = arForm ?? { enabled: !!d?.auto_recharge?.enabled, threshold: String((d?.auto_recharge?.threshold_cents ?? 200) / 100), package_id: d?.auto_recharge?.package_id ?? "" };
  const saveAr = useMutation({
    mutationFn: () => api("/communications/auto-recharge", { method: "PUT", body: JSON.stringify({ enabled: arCur.enabled, threshold_cents: Math.round((parseFloat(arCur.threshold) || 0) * 100), package_id: arCur.package_id || null }) }),
    onSuccess: () => { q.refetch(); appAlert(t("Αποθηκεύτηκε.", "Saved.")); },
  });

  return (
    <div className="space-y-4">
      <PanelCard title={t("Επικοινωνία — Υπόλοιπο μηνυμάτων", "Communications — Message credits")}>
        <p className="-mt-1 mb-4 flex items-start gap-1.5 text-xs text-slate-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          {t("Όλα τα email/SMS/Viber προς τους πελάτες σου φεύγουν κεντρικά από την πλατφόρμα RxVision (email με το όνομα του φαρμακείου σου). Χρεώνεσαι προπληρωμένα από το υπόλοιπο μηνυμάτων.",
             "All email/SMS/Viber to your patients are sent centrally by the RxVision platform (email shows your pharmacy name). You are charged from a prepaid message balance.")}
        </p>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${low ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20" : "border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20"}`}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500"><Wallet className="h-3.5 w-3.5" /> {t("Υπόλοιπο", "Balance")}</div>
            <div className={`mt-1 text-2xl font-extrabold ${low ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}`}>{eur(d?.balance_cents ?? 0)}</div>
            {low && <div className="mt-0.5 text-[11px] font-medium text-amber-700">{t("Χαμηλό — χρειάζεται ανανέωση", "Low — top up soon")}</div>}
          </div>
          {CH.map((c) => (
            <div key={c.k} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500"><c.icon className="h-3.5 w-3.5" /> {c.label}</div>
              <div className="mt-1 text-sm font-bold text-slate-900 dark:text-slate-100">{cents(d?.prices?.[c.k] ?? 0)}<span className="text-[11px] font-normal text-slate-400">/{t("μήνυμα", "msg")}</span></div>
              <div className="mt-0.5 text-[11px] text-slate-400">{t("30 ημ:", "30d:")} {d?.by_channel?.[c.k]?.count ?? 0} · {eur(d?.by_channel?.[c.k]?.spent_cents ?? 0)}</div>
            </div>
          ))}
        </div>

        {/* buy credits (top-up) */}
        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">💳 {t("Αγορά credits", "Buy credits")}</div>
          <div className="grid gap-2 sm:grid-cols-4">
            {(pkgs.data?.items ?? []).map((p) => (
              <button key={p._id} disabled={!!buying} onClick={() => buy(p._id)}
                className="rounded-xl border-2 border-slate-200 p-3 text-center transition hover:border-brand-400 disabled:opacity-50 dark:border-slate-700">
                <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{buying === p._id ? "…" : p.name}</div>
                <div className="text-[11px] font-medium text-emerald-600">+{eur(p.credits_cents)} {t("credits", "credits")}</div>
                <div className="mt-1 text-xs text-slate-500">{t("πληρωμή", "pay")} {eur(p.price_cents)}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">{t("Ασφαλής πληρωμή με κάρτα ή IRIS (Viva). Το υπόλοιπο πιστώνεται αυτόματα μετά την πληρωμή.", "Secure card or IRIS payment (Viva). Balance is credited automatically after payment.")}</p>
        </div>

        {/* test send */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex overflow-hidden rounded-lg border border-slate-300 text-sm">
            {CH.map((c) => (
              <button key={c.k} onClick={() => setChan(c.k)} className={`px-3 py-2 ${chan === c.k ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{c.label}</button>
            ))}
          </div>
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={chan === "email" ? t("email για δοκιμή", "email to test") : t("κινητό για δοκιμή", "mobile to test")} className="w-52 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button onClick={() => test.mutate()} disabled={test.isPending || !testTo} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{test.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Δοκιμαστικό", "Test")}</button>
        </div>
      </PanelCard>

      {!!d?.ledger?.length && (
        <PanelCard collapsible defaultOpen={false} title={t("Κινήσεις υπολοίπου", "Wallet activity")}>
          <div className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {d.ledger.map((l, i) => (
              <div key={i} className="flex items-center justify-between py-1.5">
                <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                  {l.kind === "credit" ? "➕" : l.kind === "refund" ? "↩" : "➖"} {l.channel}{l.count ? ` ×${l.count}` : ""}
                  <span className="text-[11px] text-slate-400">{l.ts ? new Date(l.ts).toLocaleString("el-GR") : ""}</span>
                </span>
                <span className={`font-medium ${l.amount_cents >= 0 ? "text-emerald-600" : "text-slate-700 dark:text-slate-300"}`}>{l.amount_cents >= 0 ? "+" : ""}{eur(l.amount_cents)}</span>
              </div>
            ))}
          </div>
        </PanelCard>
      )}

      {/* Ιστορικό ΑΝΑ μήνυμα — παραλήπτης, κανάλι, κόστος, κατάσταση (παραδόθηκε/όχι) */}
      {/* Όνομα αποστολέα (Sender ID) — default RxVision, προαιρετικά το όνομα του φαρμακείου (με έγκριση) */}
      <PanelCard collapsible title={t("Όνομα αποστολέα SMS", "SMS sender name")}>
        {(() => {
          const s = senderQ.data;
          const active = s?.sms_sender && s.sms_sender_approved ? s.sms_sender : "RxVision";
          return (
            <div className="space-y-2">
              <p className="text-sm text-slate-600 dark:text-slate-300">{t("Τα SMS σου φαίνονται τώρα από:", "Your SMS currently show as from:")} <b className="text-brand-700">{active}</b></p>
              {s?.sms_sender && !s.sms_sender_approved && <p className="text-xs text-amber-600">⏳ {t("Ζήτησες", "Requested")}: <b>{s.sms_sender}</b> — {t("σε αναμονή έγκρισης (μέχρι τότε φεύγει από RxVision).", "pending approval (until then, sent as RxVision).")}</p>}
              <label className="block text-xs text-slate-500">{t("Ζήτησε δικό σου όνομα (≤11 χαρ.)", "Request your own name (≤11 chars)")}
                <div className="mt-1 flex gap-2">
                  <input value={senderIn} onChange={(e) => setSenderIn(e.target.value)} maxLength={11} placeholder={s?.sms_sender || t("π.χ. το όνομα του φαρμακείου", "e.g. your pharmacy name")} className="w-56 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                  <button onClick={() => saveSender.mutate()} disabled={saveSender.isPending} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saveSender.isPending ? "…" : t("Υποβολή αιτήματος", "Submit request")}</button>
                </div>
              </label>
              <p className="text-[11px] text-slate-400">{t("Απαιτείται έγκριση από τον πάροχο (Apifon). Μέχρι να εγκριθεί, φεύγει από RxVision. Κενό = επαναφορά στο RxVision.", "Needs provider (Apifon) approval. Until approved, sent as RxVision. Empty = reset to RxVision.")}</p>
            </div>
          );
        })()}
      </PanelCard>

      <PanelCard collapsible defaultOpen title={t("Ιστορικό μηνυμάτων", "Message history")}>
        {msgs.data?.summary_30d && (
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(msgs.data.summary_30d).map(([k, n]) => (
              <span key={k} className={`rounded-full px-2 py-0.5 font-medium ${ST[k]?.cls || "bg-slate-100 text-slate-600"}`}>{ST[k] ? t(ST[k].el, ST[k].en) : k}: {n}</span>
            ))}
            <span className="text-slate-400">{t("τελευταίες 30 ημέρες", "last 30 days")}</span>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-slate-800">
              <th className="py-2">{t("Ημ/νία", "Date")}</th>
              <th>{t("Παραλήπτης", "Recipient")}</th>
              <th>{t("Κανάλι", "Channel")}</th>
              <th className="text-right">{t("Κόστος", "Cost")}</th>
              <th className="text-right">{t("Κατάσταση", "Status")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {(msgs.data?.items ?? []).map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap py-2 text-slate-500">{m.created_at ? new Date(m.created_at).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                  <td className="text-slate-700 dark:text-slate-200">{m.recipient}</td>
                  <td className="text-slate-500">{m.channel === "email" ? "✉ Email" : m.channel === "viber" ? "💬 Viber" : "📱 SMS"}</td>
                  <td className="text-right text-slate-600">{m.refunded ? <span className="text-emerald-600">↩ {eur(m.cost_cents)}</span> : eur(m.cost_cents)}</td>
                  <td className="text-right"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ST[m.status]?.cls || "bg-slate-100 text-slate-600"}`}>{ST[m.status] ? t(ST[m.status].el, ST[m.status].en) : m.status}</span></td>
                </tr>
              ))}
              {!msgs.data?.items?.length && <tr><td colSpan={5} className="py-6 text-center text-slate-400">{msgs.isLoading ? t("Φόρτωση…", "Loading…") : t("Δεν έχουν σταλεί μηνύματα ακόμη.", "No messages sent yet.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </PanelCard>

      {/* Αυτόματη αναπλήρωση credits με κάρτα-on-file */}
      <PanelCard collapsible title={t("Αυτόματη αναπλήρωση credits", "Auto-recharge credits")}>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">{t("Όταν το υπόλοιπο πέσει κάτω από το όριο, χρεώνεται αυτόματα η αποθηκευμένη κάρτα για ένα πακέτο credits — ώστε να μη διακόπτονται τα μηνύματα.", "When the balance drops below the threshold, the saved card is auto-charged for a credit package — so messaging never stops.")}</p>
        {!d?.card_on_file && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t("Χρειάζεται αποθηκευμένη κάρτα (συνδρομή με κάρτα) για να ενεργοποιηθεί.", "Requires a saved card (card subscription) to enable.")}</div>}
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!d?.card_on_file} checked={arCur.enabled} onChange={(e) => setArForm({ ...arCur, enabled: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-brand-600" />
          <span className="font-medium text-slate-800 dark:text-slate-100">{t("Ενεργή αυτόματη αναπλήρωση", "Enable auto-recharge")}</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Όριο (€)", "Threshold (€)")}
            <input type="number" step="0.5" min="0" value={arCur.threshold} onChange={(e) => setArForm({ ...arCur, threshold: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </label>
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">{t("Πακέτο αναπλήρωσης", "Recharge package")}
            <select value={arCur.package_id} onChange={(e) => setArForm({ ...arCur, package_id: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
              <option value="">—</option>
              {(pkgs.data?.items ?? []).map((p) => <option key={p._id} value={p._id}>{p.name} · {eur(p.price_cents)}</option>)}
            </select>
          </label>
        </div>
        <button onClick={() => saveAr.mutate()} disabled={saveAr.isPending || (arCur.enabled && !arCur.package_id)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saveAr.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t("Αποθήκευση", "Save")}</button>
      </PanelCard>

      {/* Χρεώσεις αποστολών — έλεγχος των χρεώσεών μας ανά αποστολή, με σύνολα */}
      <PanelCard collapsible title={t("Χρεώσεις αποστολών", "Send charges")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">{t("Περίοδος", "Period")}:</span>
          {[30, 90, 365].map((dd) => (
            <button key={dd} onClick={() => setChDays(dd)} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${chDays === dd ? "bg-brand-600 text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{dd === 365 ? t("12 μήνες", "12 mo") : `${dd} ${t("ημέρες", "days")}`}</button>
          ))}
          <button onClick={downloadCsv} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"><Download className="h-3.5 w-3.5" /> {t("Εξαγωγή CSV", "Export CSV")}</button>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl bg-brand-50 p-3"><div className="text-[11px] uppercase text-brand-600">{t("Σύνολο χρεώσεων", "Total charged")}</div><div className="text-xl font-extrabold text-brand-700">{eur(charges.data?.total_cents ?? 0)}</div><div className="text-[11px] text-slate-400">{charges.data?.count ?? 0} {t("αποστολές", "sends")}</div></div>
          {(["email", "sms", "viber"] as const).map((ch) => (
            <div key={ch} className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] uppercase text-slate-400">{ch === "email" ? "✉ Email" : ch === "viber" ? "💬 Viber" : "📱 SMS"}</div><div className="text-lg font-bold text-slate-700">{eur(charges.data?.by_channel?.[ch] ?? 0)}</div></div>
          ))}
        </div>
        {(charges.data?.refunded_cents ?? 0) > 0 && <p className="mb-2 text-[11px] text-emerald-600">↩ {t("Επιστροφές (μη παραδοθέντα)", "Refunds (undelivered)")}: {eur(charges.data!.refunded_cents)}{t(" — δεν προσμετρώνται στο σύνολο.", " — not counted in the total.")}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-slate-800">
              <th className="py-2">{t("Ημ/νία", "Date")}</th>
              <th>{t("Παραλήπτης", "Recipient")}</th>
              <th>{t("Κανάλι", "Channel")}</th>
              <th className="text-right">{t("Χρέωση", "Charge")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {(charges.data?.items ?? []).map((m) => (
                <tr key={m.id} className={m.refunded ? "opacity-60" : ""}>
                  <td className="whitespace-nowrap py-2 text-slate-500">{m.created_at ? new Date(m.created_at).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                  <td className="text-slate-700 dark:text-slate-200">{m.recipient}</td>
                  <td className="text-slate-500">{m.channel === "email" ? "✉ Email" : m.channel === "viber" ? "💬 Viber" : "📱 SMS"}</td>
                  <td className="text-right font-medium text-slate-700">{m.refunded ? <span className="text-emerald-600 line-through">{eur(m.cost_cents)}</span> : eur(m.cost_cents)}</td>
                </tr>
              ))}
              {!charges.data?.items?.length && <tr><td colSpan={4} className="py-6 text-center text-slate-400">{charges.isLoading ? t("Φόρτωση…", "Loading…") : t("Καμία χρέωση στην περίοδο.", "No charges in this period.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </PanelCard>
    </div>
  );
}
