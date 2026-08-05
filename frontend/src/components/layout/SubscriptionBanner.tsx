"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
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

  const msg = expired ? "Η συνδρομή σας έχει λήξει."
    : days === 0 ? "Η συνδρομή σας λήγει σήμερα."
    : days === 1 ? "Η συνδρομή σας λήγει αύριο."
    : `Η συνδρομή σας λήγει σε ${days} ημέρες${data.current_period_end ? ` (${fmtDate(data.current_period_end)})` : ""}.`;

  return (
    <>
      <div className={`flex flex-wrap items-center justify-center gap-3 px-3 py-2 text-center text-sm font-medium text-white sm:px-6 ${expired ? "bg-rose-600" : "bg-amber-500"}`}>
        <span>⏳ {msg}</span>
        <button onClick={() => setOpen(true)} className="rounded-md bg-white/20 px-3 py-1 font-semibold hover:bg-white/30">
          Ανανέωση συνδρομής ▸
        </button>
      </div>
      {open && <RenewModal current={data} onClose={() => setOpen(false)} />}
    </>
  );
}

function RenewModal({ current, onClose }: { current?: Status; onClose: () => void }) {
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
    if (!code) { setErr("Επίλεξε πακέτο."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api<{ checkout_url?: string }>("/billing/renew-now", {
        method: "POST", body: JSON.stringify({ package_code: code, billing_cycle: effCycle }),
      });
      if (r.checkout_url) { window.location.href = r.checkout_url; return; }
      setErr("Δεν ξεκίνησε η πληρωμή. Δοκίμασε ξανά.");
    } catch { setErr("Σφάλμα — δοκίμασε ξανά."); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} size="lg">
      <h2 className="mb-1 text-lg font-bold text-slate-900 dark:text-slate-100">Ανανέωση συνδρομής</h2>
      <p className="mb-4 text-sm text-slate-500">Επίλεξε πακέτο (ίδιο ή διαφορετικό) και κύκλο χρέωσης. Μετά την πληρωμή, η συνδρομή σου <b>επεκτείνεται</b> — αν δεν έχει λήξει, οι υπόλοιπες μέρες <b>δεν χάνονται</b>.</p>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Πακέτο</label>
          <select className={inp} value={plan || sel?.code || ""} onChange={(e) => setPlan(e.target.value)}>
            {items.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </div>
        {cycles.length > 1 && (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Κύκλος χρέωσης</label>
            <div className="flex gap-2">
              {cycles.map((c) => (
                <button key={c} type="button" onClick={() => setCycle(c)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${effCycle === c ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"}`}>
                  {c === "yearly" ? "Ετήσια" : "Μηνιαία"}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3 dark:bg-slate-800">
          <div>
            <div className="text-sm text-slate-600 dark:text-slate-300">Αξία <span className="text-xs text-slate-400">(δεν περιλαμβάνει ΦΠΑ)</span></div>
            <div className="text-[11px] text-slate-400">Ο ΦΠΑ προστίθεται στο παραστατικό.</div>
          </div>
          <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{eur(price)}</span>
        </div>
        {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300">Άκυρο</button>
          <button onClick={renew} disabled={busy || price <= 0} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {busy ? "Μεταφορά στην πληρωμή…" : "Πληρωμή & ανανέωση"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
