"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Loader2, Wallet, Info } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { appAlert } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Chan = { count: number; spent_cents: number };
type WalletRes = {
  balance_cents: number; days: number;
  prices: { email: number; sms: number; viber: number };
  by_channel: { email: Chan; sms: Chan; viber: Chan };
  ledger?: { channel: string; kind: string; count: number; amount_cents: number; balance_after: number; ts: string | null }[];
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
  const [buying, setBuying] = useState<string | null>(null);
  async function buy(pid: string) {
    setBuying(pid);
    try {
      const r = await api<{ token: string; mode: string }>("/communications/topup", { method: "POST", body: JSON.stringify({ package_id: pid }) });
      await payWithRevolut(r.token, r.mode);
      setTimeout(() => q.refetch(), 3000);   // wallet is credited asynchronously by the Revolut webhook
      appAlert(t("Η πληρωμή ολοκληρώθηκε — το υπόλοιπο ενημερώνεται σε λίγο. ✅", "Payment done — balance updates shortly. ✅"));
    } catch (e) {
      appAlert(t("Αποτυχία αγοράς: ", "Purchase failed: ") + (e as Error).message);
    } finally { setBuying(null); }
  }
  const d = q.data;
  const CH: { k: "email" | "sms" | "viber"; label: string; icon: typeof Mail }[] = [
    { k: "email", label: "Email", icon: Mail },
    { k: "sms", label: "SMS", icon: MessageSquare },
    { k: "viber", label: "Viber", icon: MessageSquare },
  ];
  const low = (d?.balance_cents ?? 0) < 200;

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
          <p className="mt-2 text-[11px] text-slate-400">{t("Ασφαλής πληρωμή με κάρτα (Revolut). Το υπόλοιπο πιστώνεται αυτόματα μετά την πληρωμή.", "Secure card payment (Revolut). Balance is credited automatically after payment.")}</p>
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
    </div>
  );
}
