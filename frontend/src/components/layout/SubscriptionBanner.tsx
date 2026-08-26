"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Modal } from "@/components/ui/Modal";
import { fmtDate } from "@/lib/formatters";

type Status = {
  effective_status?: string;
  days_to_expiry?: number | null;
  current_period_end?: string | null;
  plan?: string | null;
  billing_cycle?: string | null;
};
type Pkg = { code: string; name: string; price_monthly: number; price_yearly: number; billing_cycles: string[] };

const eur = (c: number) => (c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + " €";

/**
 * App-wide banner που εμφανίζεται όταν η συνδρομή πλησιάζει λήξη (≤30 μέρες) ή έχει λήξει, με κουμπί
 * «Ανανέωση» → picker πακέτου/κύκλου → Viva checkout. Η επέκταση περιόδου γίνεται στο webhook.
 */
export function SubscriptionBanner() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["billing-status", "banner"],
    queryFn: () => api<Status>("/billing/status"),
    retry: false,
    refetchInterval: 300_000,
  });
  const [open, setOpen] = useState(false);
  const eff = data?.effective_status;
  const days = data?.days_to_expiry;
  const near = (eff === "active" || eff === "trial" || eff === "past_due") && days != null && days <= 30;
  const expired = eff === "expired";
  if (!data || (!near && !expired)) return null;

  const msg = expired ? t("Η συνδρομή σας έχει λήξει.", "Your subscription has expired.")
    : days === 0 ? t("Η συνδρομή σας λήγει σήμερα.", "Your subscription expires today.")
    : days === 1 ? t("Η συνδρομή σας λήγει αύριο.", "Your subscription expires tomorrow.")
    : t(`Η συνδρομή σας λήγει σε ${days} ημέρες${data.current_period_end ? ` (${fmtDate(data.current_period_end)})` : ""}.`,
        `Your subscription expires in ${days} days${data.current_period_end ? ` (${fmtDate(data.current_period_end)})` : ""}.`);

  return (
    <>
      <div className={`flex flex-wrap items-center justify-center gap-3 px-3 py-2 text-center text-sm font-medium text-white sm:px-6 ${expired ? "bg-rose-600" : "bg-amber-500"}`}>
        <span>⏳ {msg}</span>
        <button onClick={() => setOpen(true)} className="rounded-md bg-white/20 px-3 py-1 font-semibold hover:bg-white/30">
          {t("Ανανέωση συνδρομής", "Renew subscription")} ▸
        </button>
      </div>
      {open && <RenewModal current={data} onClose={() => setOpen(false)} />}
    </>
  );
}

function RenewModal({ current, onClose }: { current?: Status; onClose: () => void }) {
  const t = useT();
  const pkgs = useQuery({ queryKey: ["billing-packages"], queryFn: () => api<{ items: Pkg[] }>("/billing/packages"), retry: false });
  const items = pkgs.data?.items ?? [];
  const [plan, setPlan] = useState(current?.plan || "");
  const [cycle, setCycle] = useState<"monthly" | "yearly">((current?.billing_cycle as "monthly" | "yearly") || "yearly");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sel = items.find((p) => p.code === plan) || (plan ? undefined : items[0]);
  // ΜΟΝΟ οι κύκλοι που προσφέρει το πακέτο (π.χ. αν είναι μόνο ετήσιο, δεν δείχνουμε μηνιαίο)
  const cycles = (sel?.billing_cycles?.length ? sel.billing_cycles : ["yearly"]) as ("monthly" | "yearly")[];
  const effCycle: "monthly" | "yearly" = cycles.includes(cycle) ? cycle : cycles[0];
  const price = sel ? (effCycle === "yearly" ? sel.price_yearly : sel.price_monthly) : 0;
  const inp = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800";

  async function renew() {
    const code = plan || sel?.code || "";
    if (!code) { setErr(t("Επίλεξε πακέτο.", "Select a package.")); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api<{ checkout_url?: string }>("/billing/renew-now", {
        method: "POST", body: JSON.stringify({ package_code: code, billing_cycle: effCycle }),
      });
      if (r.checkout_url) { window.location.href = r.checkout_url; return; }
      setErr(t("Δεν ξεκίνησε η πληρωμή. Δοκίμασε ξανά.", "Payment didn't start. Please try again."));
    } catch { setErr(t("Σφάλμα — δοκίμασε ξανά.", "Error — please try again.")); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} size="lg">
      <h2 className="mb-1 text-lg font-bold text-slate-900 dark:text-slate-100">{t("Ανανέωση συνδρομής", "Renew subscription")}</h2>
      <p className="mb-4 text-sm text-slate-500">{t("Επίλεξε πακέτο (ίδιο ή διαφορετικό) και κύκλο χρέωσης. Μετά την πληρωμή, η συνδρομή σου ", "Choose a package (same or different) and a billing cycle. After payment, your subscription is ")}<b>{t("επεκτείνεται", "extended")}</b>{t(" — αν δεν έχει λήξει, οι υπόλοιπες μέρες ", " — if it hasn't expired yet, the remaining days are ")}<b>{t("δεν χάνονται", "not lost")}</b>.</p>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{t("Πακέτο", "Package")}</label>
          <select className={inp} value={plan || sel?.code || ""} onChange={(e) => setPlan(e.target.value)}>
            {items.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </div>
        {cycles.length > 1 && (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{t("Κύκλος χρέωσης", "Billing cycle")}</label>
            <div className="flex gap-2">
              {cycles.map((c) => (
                <button key={c} type="button" onClick={() => setCycle(c)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${effCycle === c ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"}`}>
                  {c === "yearly" ? t("Ετήσια", "Annual") : t("Μηνιαία", "Monthly")}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3 dark:bg-slate-800">
          <div>
            <div className="text-sm text-slate-600 dark:text-slate-300">{t("Αξία", "Amount")} <span className="text-xs text-slate-400">{t("(δεν περιλαμβάνει ΦΠΑ)", "(excludes ΦΠΑ)")}</span></div>
            <div className="text-[11px] text-slate-400">{t("Ο ΦΠΑ προστίθεται στο παραστατικό.", "ΦΠΑ is added on the invoice.")}</div>
          </div>
          <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{eur(price)}</span>
        </div>
        {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300">{t("Άκυρο", "Cancel")}</button>
          <button onClick={renew} disabled={busy || price <= 0} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {busy ? t("Μεταφορά στην πληρωμή…", "Redirecting to payment…") : t("Πληρωμή & ανανέωση", "Pay & renew")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
