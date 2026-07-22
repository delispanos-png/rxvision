"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { useT } from "@/store/prefStore";
import { CreditCard, Sparkles, Database, Check, Loader2, Lock } from "lucide-react";

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
  ai: { limit: number; used_today: number; default: number; max: number; block: number; price_per_block_cents: number; surcharge_cents: number };
  retention: { months: number; default: number; max: number; price_per_year_cents: number; surcharge_cents: number };
};

const AI_LIMIT_OPTS = [50, 75, 100, 150, 200, 300, 500, 1000];
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

  const s = subscription.data;
  const x = extras.data;
  const [cardBusy, setCardBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => { qc.invalidateQueries({ queryKey: ["subscription", "extras"] }); qc.invalidateQueries({ queryKey: queryKeys.subscription() }); };

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
        setNotice(t("Η κάρτα αποθηκεύτηκε. Ξεκλείδωσες τις επιπλέον δυνατότητες ✓", "Card saved. Extras unlocked ✓"));
        refresh();
      } else {
        setNotice(t("Η χρέωση με κάρτα δεν είναι διαθέσιμη αυτή τη στιγμή. Δοκίμασε αργότερα ή επικοίνωσε μαζί μας.", "Card payment is not available right now."));
      }
    } catch { setNotice(t("Κάτι πήγε στραβά με την κάρτα. Δοκίμασε ξανά.", "Something went wrong with the card.")); }
    finally { setCardBusy(false); }
  }

  const setAiLimit = useMutation({
    mutationFn: (limit: number) => api<Extras>("/subscription/extras/ai-limit", { method: "PUT", body: JSON.stringify({ daily_limit: limit }) }),
    onSuccess: () => { setNotice(t("Το όριο AI ενημερώθηκε ✓", "AI limit updated ✓")); refresh(); },
    onError: (e) => setNotice((e as ApiError)?.status === 402
      ? t("Πρόσθεσε κάρτα για να ανεβάσεις το όριο AI πάνω από το βασικό.", "Add a card to raise the AI limit above the base.")
      : t("Δεν ήταν δυνατή η αλλαγή του ορίου.", "Could not change the limit.")),
  });
  const setRetention = useMutation({
    mutationFn: (months: number) => api<Extras>("/subscription/extras/retention", { method: "PUT", body: JSON.stringify({ months }) }),
    onSuccess: () => { setNotice(t("Το παράθυρο διατήρησης ενημερώθηκε ✓", "Retention window updated ✓")); refresh(); },
    onError: (e) => setNotice((e as ApiError)?.status === 402
      ? t("Πρόσθεσε κάρτα για να επεκτείνεις τη διατήρηση πάνω από τα 36 μήνες.", "Add a card to extend retention beyond 36 months.")
      : t("Δεν ήταν δυνατή η αλλαγή της διατήρησης.", "Could not change retention.")),
  });

  const KIND_ICON: Record<string, string> = { subscription: "🔄", upgrade: "⬆️", addon: "✨", topup: "💬" };
  const STCLS: Record<string, string> = { paid: "bg-emerald-100 text-emerald-700", pending: "bg-amber-100 text-amber-700", failed: "bg-rose-100 text-rose-700" };

  // helpers τιμής (τοπικά, από τις τιμές του server) για ζωντανή προεπισκόπηση στα dropdowns
  const aiSurcharge = (v: number) => x ? Math.max(0, Math.ceil((v - x.ai.default) / x.ai.block)) * x.ai.price_per_block_cents : 0;
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
          <div className="flex flex-wrap items-center gap-2 text-sm text-emerald-800">
            <Check className="h-4 w-4 text-emerald-600" />
            {t("Έχεις αποθηκευμένη κάρτα. Οι επιπλέον δυνατότητες είναι ξεκλείδωτες και χρεώνονται στη συνδρομή σου.", "Card on file. Extras are unlocked and billed to your subscription.")}
            <button onClick={addCard} disabled={cardBusy} className="ml-auto rounded-lg border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
              {cardBusy ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : t("Αλλαγή κάρτας", "Change card")}
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-amber-900">
            <p>{t("Δεν έχεις καταχωρήσει κάρτα. Πρόσθεσε μία για να ξεκλειδώσεις τις επιπλέον δυνατότητες (περισσότερα AI ερωτήματα, μεγαλύτερη διατήρηση δεδομένων και ό,τι νέο προστεθεί).", "No card on file. Add one to unlock extras (more AI questions, longer data retention, and anything new).")}</p>
            <p className="text-xs text-amber-700">{t("Ασφαλής αποθήκευση μέσω Revolut. Χρεώνεσαι μόνο για ό,τι επιλέξεις — μπαίνει στη συνδρομή σου.", "Secure storage via Revolut. You are charged only for what you choose — added to your subscription.")}</p>
            <button onClick={addCard} disabled={cardBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
              {cardBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />} {t("Πρόσθεσε κάρτα", "Add card")}
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
            {/* AI ερωτήματα/μέρα */}
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><Sparkles className="h-4 w-4 text-violet-500" /> {t("AI ερωτήματα ανά ημέρα", "AI questions per day")}</div>
              <div className="mb-1 text-xs text-slate-500">{t("Σήμερα", "Today")}: <b>{x.ai.used_today}</b> / {x.ai.limit}{x.ai.surcharge_cents > 0 && <span className="ml-1 text-violet-600">· +{fmtEur(x.ai.surcharge_cents)}/{perLabel}</span>}</div>
              <div className="flex items-center gap-2">
                <select value={x.ai.limit} disabled={setAiLimit.isPending}
                  onChange={(e) => setAiLimit.mutate(+e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
                  {AI_LIMIT_OPTS.map((v) => {
                    const locked = v > x.ai.default && !x.card_on_file;
                    return <option key={v} value={v} disabled={locked}>
                      {v}/{t("μέρα", "day")}{v === x.ai.default ? ` · ${t("βασικό", "base")}` : ` · +${fmtEur(aiSurcharge(v))}/${perLabel}`}{locked ? " 🔒" : ""}
                    </option>;
                  })}
                </select>
                {setAiLimit.isPending && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
              </div>
              {!x.card_on_file && <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-700"><Lock className="h-3 w-3" /> {t("Πρόσθεσε κάρτα για πάνω από", "Add a card for more than")} {x.ai.default}/{t("μέρα", "day")}.</p>}
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
