"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, X, Sparkles } from "lucide-react";
import { api, refreshSession } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appConfirm, appAlert } from "@/store/dialogStore";

type Status = "included" | "active" | "granted" | "available";
type Addon = {
  _id: string; name: string; description?: string; icon?: string; category?: string;
  price_monthly: number; price_yearly: number; features?: string[]; status: Status; offered?: boolean;
};
type AddonsRes = { addons: Addon[]; addons_total: number; billing_cycle: "monthly" | "yearly" };

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);

export default function AddonsSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["addons"], queryFn: () => api<AddonsRes>("/addons") });
  const yearly = q.data?.billing_cycle === "yearly";
  const per = yearly ? t("έτος", "yr") : t("μήνα", "mo");

  const refreshAll = async () => {
    await refreshSession();   // pull the new module entitlement into the JWT immediately
    qc.invalidateQueries({ queryKey: ["addons"] });
    qc.invalidateQueries({ queryKey: ["me"] });
    qc.invalidateQueries({ queryKey: ["billing-status"] });
  };

  const act = useMutation({
    mutationFn: (id: string) => api(`/addons/${id}/activate`, { method: "POST" }),
    onSuccess: refreshAll,
    onError: () => appAlert(t("Η ενεργοποίηση απέτυχε. Δοκίμασε ξανά.", "Activation failed. Please try again.")),
  });
  const deact = useMutation({
    mutationFn: (id: string) => api(`/addons/${id}/deactivate`, { method: "POST" }),
    onSuccess: refreshAll,
  });

  async function activate(a: Addon) {
    const price = yearly ? a.price_yearly : a.price_monthly;
    const ok = await appConfirm(
      t(`Ενεργοποίηση «${a.name}» με επιπλέον ${eur(price)}/${per}; Η χρέωση ξεκινά από τον επόμενο κύκλο. Μπορείς να το απενεργοποιήσεις όποτε θες.`,
        `Activate «${a.name}» for +${eur(price)}/${per}? Billing starts next cycle. You can turn it off anytime.`));
    if (ok) act.mutate(a._id);
  }
  async function deactivate(a: Addon) {
    if (await appConfirm(t(`Απενεργοποίηση «${a.name}»;`, `Deactivate «${a.name}»?`), { danger: true })) deact.mutate(a._id);
  }

  const busy = act.isPending || deact.isPending;
  const allAddons = q.data?.addons ?? [];
  // Show only what's relevant for this tenant's package: active/granted always, plus purchasable ones
  // that THIS package actually offers. Bundled (included) add-ons are listed as a small note only.
  const addons = allAddons.filter((a) => a.status === "active" || a.status === "granted" || (a.status === "available" && a.offered));
  const included = allAddons.filter((a) => a.status === "included");

  return (
    <div className="max-w-4xl space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-slate-100"><Sparkles className="h-4 w-4 text-violet-500" /> {t("Πρόσθετα (Add-ons)", "Add-ons")}</h2>
            <p className="mt-1 text-sm text-slate-500">{t("Πρόσθεσε δυνατότητες à la carte πάνω στο πλάνο σου. Ενεργοποίηση/απενεργοποίηση όποτε θες.", "Add capabilities à la carte on top of your plan. Turn on/off anytime.")}</p>
          </div>
          {(q.data?.addons_total ?? 0) > 0 && (
            <div className="rounded-xl bg-violet-50 px-3 py-2 text-right dark:bg-violet-950/30">
              <div className="text-[11px] text-slate-500">{t("Σύνολο πρόσθετων", "Add-ons total")}</div>
              <div className="text-lg font-bold text-violet-700 dark:text-violet-300">{eur(q.data!.addons_total)}/{per}</div>
            </div>
          )}
        </div>
      </div>

      {q.isLoading ? (
        <div className="p-6 text-slate-400"><Loader2 className="inline h-4 w-4 animate-spin" /> {t("Φόρτωση…", "Loading…")}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {addons.map((a) => {
            const price = yearly ? a.price_yearly : a.price_monthly;
            return (
              <div key={a._id} className={`rounded-2xl border p-4 ${a.status === "active" ? "border-violet-300 bg-violet-50/40 dark:border-violet-700 dark:bg-violet-950/20" : "border-slate-200 dark:border-slate-700"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{a.icon} {a.name}</div>
                    <p className="mt-0.5 text-xs text-slate-500">{a.description}</p>
                  </div>
                  {a.status === "included" && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800">{t("Στο πλάνο", "In plan")}</span>}
                  {a.status === "granted" && <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40">{t("Παραχωρημένο", "Granted")}</span>}
                  {a.status === "active" && <span className="shrink-0 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-bold text-white">{t("Ενεργό", "Active")}</span>}
                </div>
                {!!a.features?.length && (
                  <ul className="mt-2 space-y-1">
                    {a.features.map((f, i) => <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300"><Check className="mt-0.5 h-3 w-3 shrink-0 text-violet-500" /> {f}</li>)}
                  </ul>
                )}
                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{price === 0 ? t("Δωρεάν", "Free") : `${eur(price)}/${per}`}</div>
                  {a.status === "available" && <button disabled={busy} onClick={() => activate(a)} className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /> {t("Ενεργοποίηση", "Activate")}</button>}
                  {a.status === "active" && <button disabled={busy} onClick={() => deactivate(a)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600"><X className="h-3.5 w-3.5" /> {t("Απενεργοποίηση", "Deactivate")}</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {included.length > 0 && (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
          ✓ {t("Περιλαμβάνονται ήδη στο πλάνο σου:", "Already included in your plan:")} {included.map((a) => `${a.icon ?? ""} ${a.name}`).join(" · ")}
        </p>
      )}
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60">
        💳 {t("Η χρέωση των πρόσθετων ξεκινά από τον επόμενο κύκλο και προστίθεται στη συνδρομή σου. Η ενεργοποίηση ισχύει άμεσα.", "Add-on billing starts next cycle and is added to your subscription. Activation is immediate.")}
      </p>
    </div>
  );
}
