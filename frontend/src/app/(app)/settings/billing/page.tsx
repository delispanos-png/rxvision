"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { useT } from "@/store/prefStore";
import { CreditCard, Sparkles, Database, Check, Loader2, Lock, Users, RefreshCw } from "lucide-react";
import { appConfirm, appAlert } from "@/store/dialogStore";

/** Άνοιγμα του Revolut Checkout popup για ένα order token (φορτώνει το embed.js on demand). */
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
type AiPack = { _id: string; name?: string; questions: number; price_cents: number };

type Subscription = {
  plan: string;
  status: string;
  price: number; // cents / month
  renews_at: string;
  modules: string[];
};

type Usage = {
  items: { metric: string; label: string; used: number; limit: number }[];
};

type Receipt = {
  id: string; kind: string; kind_label?: { el: string; en: string }; description?: string;
  amount_cents: number; status: string; method?: string | null; provider?: string | null; created_at: string | null;
};

type Extras = {
  card_on_file: boolean;
  billing_cycle: string;
  currency: string;
  addons_total_cents: number;
  ai: { included: number; period: string; used: number; remaining: number; credits: number };
  retention: { months: number; default: number; max: number; price_per_year_cents: number; surcharge_cents: number };
};

type Seats = {
  seats: number; included_free: number; max_seats: number; extra_users: number;
  per_seat_price_cents: number; billing_cycle: string; currency: string;
  card_on_file: boolean; live_sessions: number;
  pending_decrease: { seats: number; effective_at: string | null } | null;
};
type SeatPreview = { new_seats: number; current_seats: number; delta: number; direction: string;
  immediate_charge_gross_cents: number; recurring_delta_net_cents: number; remaining_days?: number };
const RET_OPTS = [36, 48, 60, 72, 84, 96, 120];

export default function BillingSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const subscription = useQuery({
    queryKey: queryKeys.subscription(),
    queryFn: () => api<Subscription>(`/subscription`),
  });
  const usage = useQuery({
    queryKey: queryKeys.subscriptionUsage(),
    queryFn: () => api<Usage>(`/subscription/usage`),
  });
  const receipts = useQuery({
    queryKey: ["subscription", "receipts"],
    queryFn: () => api<{ items: Receipt[] }>(`/subscription/receipts`),
    retry: false,
  });
  const extras = useQuery({
    queryKey: ["subscription", "extras"],
    queryFn: () => api<Extras>(`/subscription/extras`),
    retry: false,
  });
  const seats = useQuery({
    queryKey: ["subscription", "seats"],
    queryFn: () => api<Seats>(`/subscription/seats`),
    retry: false,
  });

  const aiPacks = useQuery({
    queryKey: ["subscription", "ai-credit-packs"],
    queryFn: () => api<{ items: AiPack[]; balance: number }>(`/subscription/ai-credit-packs`),
    retry: false,
  });

  const s = subscription.data;
  const x = extras.data;
  const [cardBusy, setCardBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [buyingAi, setBuyingAi] = useState<string | null>(null);
  async function buyAiCredits(packId: string) {
    setBuyingAi(packId);
    try {
      const r = await api<{ token?: string; mode?: string; provider?: string; checkout_url?: string }>("/subscription/ai-credits/topup", { method: "POST", body: JSON.stringify({ pack_id: packId }) });
      if (r.provider === "viva" && r.checkout_url) { window.location.href = r.checkout_url; return; }
      await payWithRevolut(r.token!, r.mode!);
      setTimeout(() => { aiPacks.refetch(); refresh(); }, 3000);
      appAlert(t("Η πληρωμή ολοκληρώθηκε — τα credits ενημερώνονται σε λίγο. ✅", "Payment done — credits update shortly. ✅"));
    } catch (e) {
      appAlert(t("Αποτυχία αγοράς: ", "Purchase failed: ") + (e as Error).message);
    } finally { setBuyingAi(null); }
  }

  const refresh = () => { qc.invalidateQueries({ queryKey: ["subscription", "extras"] }); qc.invalidateQueries({ queryKey: ["subscription", "seats"] }); qc.invalidateQueries({ queryKey: queryKeys.subscription() }); };

  // Αλλαγή αριθμού χρηστών: αύξηση → προεπισκόπηση αναλογικής χρέωσης + επιβεβαίωση· μείωση → στην ανανέωση.
  const [seatBusy, setSeatBusy] = useState(false);
  async function changeSeats(target: number) {
    const se = seats.data;
    if (!se || target === se.seats) return;
    const per = perLabel;
    if (target > se.seats) {
      let pv: SeatPreview | null = null;
      try { pv = await api<SeatPreview>("/subscription/seats/preview", { method: "POST", body: JSON.stringify({ seats: target }) }); } catch { /* fallthrough */ }
      const now = pv ? fmtEur(pv.immediate_charge_gross_cents) : "—";
      const rec = pv ? fmtEur(pv.recurring_delta_net_cents) : "—";
      const ok = await appConfirm(
        t(`Αύξηση σε ${target} χρήστες. Θα χρεωθεί ΤΩΡΑ αναλογικά ${now} (με ΦΠΑ) για το υπόλοιπο της περιόδου, και +${rec}/${per} (καθαρά) στην ανανέωση. Συνέχεια;`,
          `Increase to ${target} users. You will be charged ${now} now (incl. VAT) for the rest of the period, and +${rec}/${per} (net) at renewal. Continue?`),
        { title: t("Αγορά επιπλέον χρηστών", "Buy more users"), confirmText: t("Αγορά & χρέωση", "Buy & charge") });
      if (!ok) return;
    } else {
      const eff = seats.data?.pending_decrease?.effective_at;
      const ok = await appConfirm(
        t(`Μείωση σε ${target} χρήστες. Θα εφαρμοστεί στην ΑΝΑΝΕΩΣΗ (κρατάς τους τρέχοντες μέχρι τότε). Συνέχεια;`,
          `Reduce to ${target} users. Applies at RENEWAL (you keep current until then). Continue?`),
        { title: t("Μείωση χρηστών", "Reduce users"), confirmText: t("Προγραμματισμός", "Schedule") });
      if (!ok) return;
      void eff;
    }
    setSeatBusy(true); setNotice(null);
    try {
      await api<Seats>("/subscription/seats", { method: "PUT", body: JSON.stringify({ seats: target }) });
      setNotice(target > se.seats
        ? t("Οι επιπλέον χρήστες ενεργοποιήθηκαν ✓", "Extra users activated ✓")
        : t("Η μείωση προγραμματίστηκε για την ανανέωση ✓", "Reduction scheduled for renewal ✓"));
      refresh();
    } catch (e) {
      setNotice((e as ApiError)?.status === 402
        ? t("Πρόσθεσε κάρτα για να αγοράσεις επιπλέον χρήστες.", "Add a card to buy more users.")
        : t("Δεν ήταν δυνατή η αλλαγή χρηστών.", "Could not change users."));
    } finally { setSeatBusy(false); }
  }

  // Revolut save-card popup (ίδιο pattern με την εγγραφή)
  async function payWithRevolut(token: string, mode: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const w = window as unknown as { RevolutCheckout?: (t: string, m: string) => Promise<{ payWithPopup: (o: Record<string, () => void>) => void }> };
      const run = () => {
        if (!w.RevolutCheckout) return resolve();
        w.RevolutCheckout(token, mode === "live" ? "prod" : "sandbox")
          .then((rc) => rc.payWithPopup({ onSuccess: resolve, onError: resolve, onCancel: resolve }))
          .catch(() => resolve());
      };
      if (w.RevolutCheckout) return run();
      const el = document.createElement("script");
      el.src = mode === "live" ? "https://merchant.revolut.com/embed.js" : "https://sandbox-merchant.revolut.com/embed.js";
      el.onload = run; el.onerror = () => resolve();
      document.body.appendChild(el);
    });
  }

  async function addCard() {
    setCardBusy(true); setNotice(null);
    try {
      const cc = await api<{ ok: boolean; token?: string; mode?: string; error?: string; provider?: string; checkout_url?: string }>("/billing/card-capture", { method: "POST" });
      if (cc.ok && cc.provider === "viva" && cc.checkout_url) {
        window.location.href = cc.checkout_url;   // Viva Smart Checkout (κάρτα ή IRIS) → επιστροφή μετά
        return;
      }
      if (cc.ok && cc.token) {
        await payWithRevolut(cc.token, cc.mode || "sandbox");
        setNotice(t("Η κάρτα αποθηκεύτηκε ✓ — η συνδρομή σου ανανεώνεται πλέον αυτόματα & ξεκλείδωσες τις επιπλέον δυνατότητες.", "Card saved ✓ — your subscription now auto-renews & extras are unlocked."));
        refresh();
      } else {
        setNotice(t("Η χρέωση με κάρτα δεν είναι διαθέσιμη αυτή τη στιγμή. Δοκίμασε αργότερα ή επικοίνωσε μαζί μας.", "Card payment is not available right now."));
      }
    } catch { setNotice(t("Κάτι πήγε στραβά με την κάρτα. Δοκίμασε ξανά.", "Something went wrong with the card.")); }
    finally { setCardBusy(false); }
  }

  const setRetention = useMutation({
    mutationFn: (months: number) => api<Extras>("/subscription/extras/retention", { method: "PUT", body: JSON.stringify({ months }) }),
    onSuccess: () => { setNotice(t("Το παράθυρο διατήρησης ενημερώθηκε ✓", "Retention window updated ✓")); refresh(); },
    onError: (e) => setNotice((e as ApiError)?.status === 402
      ? t("Πρόσθεσε κάρτα για να επεκτείνεις τη διατήρηση πάνω από τα 36 μήνες.", "Add a card to extend retention beyond 36 months.")
      : t("Δεν ήταν δυνατή η αλλαγή της διατήρησης.", "Could not change retention.")),
  });

  const KIND_ICON: Record<string, string> = { subscription: "🔄", upgrade: "⬆️", addon: "✨", topup: "💬" };
  const STCLS: Record<string, string> = { paid: "bg-emerald-100 text-emerald-700", pending: "bg-amber-100 text-amber-700", failed: "bg-rose-100 text-rose-700" };

  // helper τιμής (τοπικά) για ζωντανή προεπισκόπηση στο dropdown διατήρησης
  const retSurcharge = (m: number) => x ? Math.max(0, Math.ceil((m - x.retention.default) / 12)) * x.retention.price_per_year_cents : 0;
  const perLabel = x?.billing_cycle === "yearly" ? t("έτος", "yr") : t("μήνα", "mo");

  return (
    <ModuleGuard module="settings">
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label={t("Πλάνο", "Plan")} help={t("Το πλάνο συνδρομής του φαρμακείου.", "The pharmacy's subscription plan.")} value={s?.plan ?? "—"} />
        <KpiCard label={t("Κατάσταση", "Status")} help={t("Κατάσταση συνδρομής (active/trial κ.λπ.).", "Subscription status.")} value={s?.status ?? "—"} />
        <KpiCard label={t("Μηνιαία χρέωση", "Monthly charge")} help={t("Συνδρομή + ενεργά extras.", "Subscription + active extras.")} value={s ? fmtEur(s.price) : "—"} />
      </div>

      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      {/* ── Τρόπος πληρωμής (κάρτα) ── */}
      <div className={`mb-6 rounded-xl border p-5 shadow-sm ${x?.card_on_file ? "border-emerald-200 bg-emerald-50/50" : "border-amber-300 bg-amber-50/60"}`}>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-800"><CreditCard className="h-4 w-4" /> {t("Τρόπος πληρωμής", "Payment method")}</h2>
        {x?.card_on_file ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-emerald-800">
              <RefreshCw className="h-4 w-4 text-emerald-600" />
              {t("Αυτόματη ανανέωση: ΕΝΕΡΓΗ", "Auto-renewal: ON")}
              <button onClick={addCard} disabled={cardBusy} className="ml-auto rounded-lg border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                {cardBusy ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : t("Αλλαγή κάρτας", "Change card")}
              </button>
            </div>
            <p className="text-xs text-emerald-800">
              {t(`Η συνδρομή σου${subscription.data?.plan ? ` «${subscription.data.plan}»` : ""} ανανεώνεται αυτόματα${subscription.data?.renews_at ? ` στις ${fmtDate(subscription.data.renews_at)}` : ""} — δεν χρειάζεται να την αγοράζεις κάθε ${perLabel}. Αλλάζει μόνο αν κάνεις εσύ upgrade/downgrade.`,
                `Your subscription${subscription.data?.plan ? ` «${subscription.data.plan}»` : ""} renews automatically${subscription.data?.renews_at ? ` on ${fmtDate(subscription.data.renews_at)}` : ""} — no need to buy it each ${perLabel}. It only changes if you upgrade/downgrade.`)}
            </p>
            <p className="text-[11px] text-emerald-700 flex items-center gap-1"><Check className="h-3 w-3" /> {t("Οι επιπλέον δυνατότητες είναι ξεκλείδωτες και χρεώνονται στη συνδρομή σου.", "Extras are unlocked and billed to your subscription.")}</p>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-amber-900">
            <p className="flex items-start gap-1.5 font-semibold"><RefreshCw className="mt-0.5 h-4 w-4 shrink-0" /> {t(`Πρόσθεσε κάρτα → η συνδρομή σου ανανεώνεται ΑΥΤΟΜΑΤΑ κάθε ${perLabel} στο ίδιο πλάνο. Τέλος στη χειροκίνητη αγορά — δεν χρειάζεται να θυμάσαι τίποτα.`, `Add a card → your subscription auto-renews every ${perLabel} on the same plan. No more manual purchase — nothing to remember.`)}</p>
            <p>{t("Ξεκλειδώνεις επίσης τις επιπλέον δυνατότητες: top-up μηνυμάτων (SMS / Viber / email), περισσότερα AI ερωτήματα, μεγαλύτερη διατήρηση δεδομένων, επιπλέον χρήστες και ό,τι νέο προστεθεί.", "You also unlock extras: message top-up (SMS / Viber / email), more AI questions, longer data retention, extra users, and anything new.")}</p>
            <p className="text-xs text-amber-700">{t("Ασφαλής αποθήκευση κάρτας μέσω Viva (κάρτα ή IRIS). Μπορείς να κάνεις upgrade/downgrade ή να αφαιρέσεις την κάρτα όποτε θες.", "Secure card storage via Viva (card or IRIS). You can upgrade/downgrade or remove the card anytime.")}</p>
            <button onClick={addCard} disabled={cardBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
              {cardBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />} {t("Πρόσθεσε κάρτα & ενεργοποίησε αυτόματη ανανέωση", "Add card & enable auto-renewal")}
            </button>
          </div>
        )}
      </div>

      {/* ── Επιπλέον δυνατότητες (self-service, ξεκλειδώνουν με κάρτα) ── */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"><Sparkles className="h-4 w-4 text-violet-600" /> {t("Επιπλέον δυνατότητες", "Extras")}</h2>
        <p className="mb-4 text-sm text-slate-500">{t("Ρύθμισέ τα μόνος σου. Το βασικό είναι δωρεάν· ό,τι παραπάνω μπαίνει ως πάγιο στη συνδρομή σου και χρεώνεται στην κάρτα σου κάθε", "Set them yourself. The base is free; anything more is added as a fixed line to your subscription, billed to your card each")} {perLabel}.</p>

        {extras.isLoading ? <div className="py-4 text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div> : x && (
          <div className="grid gap-4 sm:grid-cols-2">
            {/* AI ερωτήματα — περιλαμβάνονται στο πακέτο (read-only) */}
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><Sparkles className="h-4 w-4 text-violet-500" /> {t("AI ερωτήματα", "AI questions")}</div>
              <div className="text-xs text-slate-500">{t("Το πλάνο σου περιλαμβάνει", "Your plan includes")} <b>{x.ai.included}</b> {x.ai.period === "month" ? t("ερωτήσεις/μήνα", "questions/month") : x.ai.period === "year" ? t("ερωτήσεις/έτος", "questions/year") : t("ερωτήσεις/μέρα", "questions/day")}.</div>
              <div className="mt-1 text-xs text-slate-500">{t("Κατανάλωσες", "Used")}: <b>{x.ai.used}</b> / {x.ai.included} · {t("απομένουν", "remaining")} <b className="text-emerald-700">{x.ai.remaining}</b></div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${x.ai.included > 0 ? Math.min(100, Math.round((x.ai.used / x.ai.included) * 100)) : 0}%` }} />
              </div>
              {/* AI credits (overage) — αγορά επιπλέον ερωτήσεων πάνω από το included */}
              <div className="mt-3 border-t border-slate-100 pt-2">
                <div className="mb-1.5 text-xs text-slate-500">{t("Επιπλέον ερωτήσεις (credits)", "Extra questions (credits)")}: <b className="text-violet-700">{x.ai.credits ?? 0}</b></div>
                <div className="flex flex-wrap gap-1.5">
                  {(aiPacks.data?.items ?? []).map((p) => (
                    <button key={p._id} onClick={() => buyAiCredits(p._id)} disabled={buyingAi !== null}
                      className="inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-50">
                      {buyingAi === p._id ? <Loader2 className="h-3 w-3 animate-spin" /> : "+"} {p.questions} · {fmtEur(p.price_cents)}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-slate-400">{t("Όταν εξαντληθούν τα ερωτήματα του πακέτου, τραβάμε από τα credits.", "When your plan's questions run out, we draw from credits.")}</p>
              </div>
            </div>

            {/* Διατήρηση δεδομένων */}
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><Database className="h-4 w-4 text-indigo-500" /> {t("Διατήρηση δεδομένων", "Data retention")}</div>
              <div className="mb-1 text-xs text-slate-500">{t("Παράθυρο", "Window")}: <b>{x.retention.months} {t("μήνες", "months")}</b> ({x.retention.months / 12} {t("χρ.", "yr")}){x.retention.surcharge_cents > 0 && <span className="ml-1 text-indigo-600">· +{fmtEur(x.retention.surcharge_cents)}/{perLabel}</span>}</div>
              <div className="flex items-center gap-2">
                <select value={x.retention.months} disabled={setRetention.isPending}
                  onChange={(e) => setRetention.mutate(+e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
                  {RET_OPTS.map((m) => {
                    const locked = m > x.retention.default && !x.card_on_file;
                    return <option key={m} value={m} disabled={locked}>
                      {m} {t("μήνες", "mo")} ({m / 12} {t("χρ.", "yr")}){m === x.retention.default ? ` · ${t("βασικό", "base")}` : ` · +${fmtEur(retSurcharge(m))}/${perLabel}`}{locked ? " 🔒" : ""}
                    </option>;
                  })}
                </select>
                {setRetention.isPending && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
              </div>
              {!x.card_on_file && <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-700"><Lock className="h-3 w-3" /> {t("Πρόσθεσε κάρτα για πάνω από", "Add a card for more than")} {x.retention.default} {t("μήνες", "months")}.</p>}
            </div>
          </div>
        )}
        {/* ── Χρήστες / άδειες (αύξηση άμεση/αναλογική, μείωση στην ανανέωση) ── */}
        {seats.data && (() => {
          const se = seats.data!;
          const opts = Array.from({ length: se.max_seats - se.included_free + 1 }, (_, i) => se.included_free + i);
          return (
            <div className="mt-4 rounded-xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><Users className="h-4 w-4 text-sky-500" /> {t("Χρήστες (άδειες ταυτόχρονης σύνδεσης)", "Users (concurrent-session seats)")}</div>
              <div className="mb-2 text-xs text-slate-500">
                {t("Τρέχοντες", "Current")}: <b>{se.seats}</b> / {se.max_seats} {t("μέγιστο πακέτου", "plan max")}
                <span className="ml-1 text-slate-400">· {t("συνδεδεμένοι τώρα", "online now")}: {se.live_sessions}</span>
                {se.extra_users > 0 && <span className="ml-1 text-sky-600">· +{fmtEur(se.extra_users * se.per_seat_price_cents)}/{perLabel}</span>}
              </div>
              <div className="flex items-center gap-2">
                <select value={se.seats} disabled={seatBusy}
                  onChange={(e) => changeSeats(+e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
                  {opts.map((n) => {
                    const locked = n > se.included_free && se.per_seat_price_cents > 0 && !se.card_on_file;
                    const extra = (n - se.included_free) * se.per_seat_price_cents;
                    return <option key={n} value={n} disabled={locked}>
                      {n} {t("χρήστες", "users")}{n === se.included_free ? ` · ${t("βασικό", "base")}` : ` · +${fmtEur(extra)}/${perLabel}`}{locked ? " 🔒" : ""}
                    </option>;
                  })}
                </select>
                {seatBusy && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
              </div>
              {se.pending_decrease && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
                  {t("Προγραμματισμένη μείωση σε", "Scheduled reduction to")} <b>{se.pending_decrease.seats}</b> {t("χρήστες στην ανανέωση", "users at renewal")}
                  {se.pending_decrease.effective_at ? ` (${new Date(se.pending_decrease.effective_at).toLocaleDateString("el-GR")})` : ""}.
                </p>
              )}
              {!se.card_on_file && se.per_seat_price_cents > 0
                ? <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-700"><Lock className="h-3 w-3" /> {t("Πρόσθεσε κάρτα για περισσότερους από", "Add a card for more than")} {se.included_free} {t("χρήστη", "user")}.</p>
                : <p className="mt-2 text-[11px] text-slate-400">{t("Η αύξηση χρεώνεται αναλογικά τώρα· η μείωση εφαρμόζεται στην ανανέωση.", "Increases are charged pro-rata now; decreases apply at renewal.")}</p>}
            </div>
          );
        })()}

        {x && x.addons_total_cents > 0 && (
          <p className="mt-3 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">{t("Σύνολο επιπλέον χρεώσεων", "Total extras")}: <b>+{fmtEur(x.addons_total_cents)}/{perLabel}</b> — {t("μπαίνει στην επόμενη χρέωση της συνδρομής σου.", "added to your next subscription charge.")}</p>
        )}
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("Χρήση", "Usage")}</h2>
        {usage.isLoading ? (
          <div className="text-slate-400">{t("Φόρτωση δεδομένων…", "Loading data…")}</div>
        ) : (
          <div className="space-y-3">
            {(usage.data?.items ?? []).map((u) => {
              const pct = u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 0;
              return (
                <div key={u.metric}>
                  <div className="mb-1 flex justify-between text-sm text-slate-600">
                    <span>{u.label}</span>
                    <span>
                      {fmtNum(u.used)} / {fmtNum(u.limit)}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Παραστατικά αγορών (ό,τι χρεώθηκε μέσω RxVision) ── */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("Παραστατικά αγορών", "Purchase receipts")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2">{t("Ημ/νία", "Date")}</th>
              <th>{t("Τύπος", "Type")}</th>
              <th>{t("Περιγραφή", "Description")}</th>
              <th className="text-right">{t("Ποσό", "Amount")}</th>
              <th className="text-right">{t("Κατάσταση", "Status")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-50">
              {(receipts.data?.items ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap py-2 text-slate-500">{r.created_at ? new Date(r.created_at).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"}</td>
                  <td className="text-slate-700">{KIND_ICON[r.kind] ?? "•"} {r.kind_label ? t(r.kind_label.el, r.kind_label.en) : r.kind}</td>
                  <td className="text-slate-500">{r.description}{r.provider ? <span className="ml-1 text-xs text-slate-400">· {r.provider}</span> : ""}</td>
                  <td className="text-right font-medium text-slate-800">{fmtEur(r.amount_cents)}</td>
                  <td className="text-right"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STCLS[r.status] ?? "bg-slate-100 text-slate-600"}`}>{r.status === "paid" ? t("Πληρώθηκε", "Paid") : r.status === "pending" ? t("Εκκρεμεί", "Pending") : t("Απέτυχε", "Failed")}</span></td>
                </tr>
              ))}
              {!receipts.data?.items?.length && <tr><td colSpan={5} className="py-6 text-center text-slate-400">{receipts.isLoading ? t("Φόρτωση…", "Loading…") : t("Δεν υπάρχουν παραστατικά ακόμη.", "No receipts yet.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold text-slate-700">{t("Αλλαγή πλάνου", "Change plan")}</h2>
        <p className="mb-3 text-sm text-slate-500">{t("Δες τα διαθέσιμα πακέτα, αναβάθμισε (κάρτα ή τραπεζική κατάθεση) ή προγραμμάτισε υποβάθμιση.", "See available packages, upgrade (card or bank transfer) or schedule a downgrade.")}</p>
        <Link href="/settings/modules" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          {t("Διαχείριση πλάνου →", "Manage plan →")}
        </Link>
      </div>
    </ModuleGuard>
  );
}
