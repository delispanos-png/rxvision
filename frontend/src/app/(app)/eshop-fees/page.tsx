"use client";

import { useQuery } from "@tanstack/react-query";
import { Receipt, Coins, Wallet, ClipboardList, CheckCircle2, ShieldCheck, Info } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { fmtDate, fmtDateTime } from "@/lib/formatters";

// backend charge_weekday: 0=Δευτέρα … 6=Κυριακή (Python weekday)
const WEEKDAYS_EL = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο", "Κυριακή"];
const WEEKDAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type RecentFee = { order_no?: string; cents: number; created_at: string; billed: boolean; billed_at: string | null };
type Charge = { count: number; net_cents: number; gross_cents: number; charged_at: string; provider?: string; status: string };
type Fees = {
  enabled: boolean;
  fee_cents: number;
  exempt: boolean;
  min_charge_cents: number;
  charge_weekday: number;
  min_order_cents: number;
  cap_pct: number;
  unbilled: { count: number; cents: number };
  will_charge: boolean;
  recent: RecentFee[];
  charges: Charge[];
};

const eur = (c?: number) => `${((c ?? 0) / 100).toFixed(2)}€`;

function Kpi({ icon: Icon, label, value, note, tint }: { icon: typeof Coins; label: string; value: string; note?: string; tint: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tint}`}><Icon className="h-5 w-5" /></span>
        <div className="min-w-0">
          <div className="truncate text-xs text-slate-500">{label}</div>
          <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
        </div>
      </div>
      {note && <div className="mt-2 text-[11px] leading-snug text-slate-500">{note}</div>}
    </div>
  );
}

export default function EshopFeesPage() {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["eshop-fees"],
    queryFn: () => api<Fees>("/orders/delivery/fees"),
    refetchInterval: 30000,
    retry: false,
  });

  const weekday = data ? t(WEEKDAYS_EL[data.charge_weekday] ?? "", WEEKDAYS_EN[data.charge_weekday] ?? "") : "";

  return (
    <ModuleGuard module="order_delivery">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-500 text-white shadow-lg"><Receipt className="h-6 w-6" /></span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Προμήθειες συναλλαγών", "Transaction fees")}</h1>
            <p className="text-sm text-slate-500">{t("Μια μικρή προμήθεια ανά παραγγελία e-shop, που χρεώνεται εβδομαδιαία στην κάρτα σου.", "A small fee per e-shop order, billed weekly to your card.")}</p>
            {data && !data.exempt && (data.min_order_cents > 0 || data.cap_pct > 0) && (
              <p className="mt-0.5 text-xs text-slate-400">
                {data.min_order_cents > 0 && t(`Καμία χρέωση σε παραγγελίες κάτω από ${eur(data.min_order_cents)}.`, `No fee on orders below ${eur(data.min_order_cents)}.`)}
                {data.min_order_cents > 0 && data.cap_pct > 0 ? " " : ""}
                {data.cap_pct > 0 && t(`Ποτέ πάνω από ${data.cap_pct}% της αξίας.`, `Never more than ${data.cap_pct}% of the order value.`)}
              </p>
            )}
          </div>
        </div>

        {isLoading && <div className="p-6 text-slate-400">{t("Φόρτωση…", "Loading…")}</div>}
        {isError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
            {t("Δεν ήταν δυνατή η φόρτωση των προμηθειών. Δοκίμασε ξανά.", "Could not load transaction fees. Please try again.")}
          </div>
        )}

        {data && (
          <>
            {/* Exempt banner */}
            {data.exempt && (
              <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
                <span>{t("Το φαρμακείο σου εξαιρείται — δεν χρεώνονται προμήθειες συναλλαγής.", "Your pharmacy is exempt — no transaction fees are charged.")}</span>
              </div>
            )}

            {/* Feature not active */}
            {!data.exempt && !data.enabled && (
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
                <Info className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <span>{t("Οι προμήθειες συναλλαγών δεν είναι ενεργές για το φαρμακείο σου αυτή τη στιγμή.", "Transaction fees are not active for your pharmacy at the moment.")}</span>
              </div>
            )}

            {/* Charge UI — hidden when exempt */}
            {!data.exempt && (
              <>
                {/* KPI cards */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Kpi
                    icon={Coins}
                    label={t("Προμήθεια ανά παραγγελία", "Fee per order")}
                    value={eur(data.fee_cents)}
                    tint="bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400"
                  />
                  <Kpi
                    icon={ClipboardList}
                    label={t("Δεδουλευμένα τώρα", "Accrued now")}
                    value={eur(data.unbilled.cents)}
                    note={
                      data.will_charge
                        ? t("Θα χρεωθούν στην επόμενη εβδομαδιαία χρέωση.", "Will be billed on the next weekly charge.")
                        : data.unbilled.cents > 0
                          ? t("Κάτω από το κατώφλι — μεταφέρονται στην επόμενη εβδομάδα.", "Below the threshold — carried over to next week.")
                          : undefined
                    }
                    tint="bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                  />
                  <Kpi
                    icon={Wallet}
                    label={t("Κατώφλι εβδομαδιαίας χρέωσης", "Weekly charge threshold")}
                    value={eur(data.min_charge_cents)}
                    note={weekday ? t(`Χρέωση κάθε ${weekday}.`, `Charged every ${weekday}.`) : undefined}
                    tint="bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400"
                  />
                </div>

                <div className="text-xs text-slate-500">
                  {data.unbilled.count === 1
                    ? t(`${data.unbilled.count} εκκρεμής παραγγελία προς χρέωση.`, `${data.unbilled.count} pending order to be billed.`)
                    : t(`${data.unbilled.count} εκκρεμείς παραγγελίες προς χρέωση.`, `${data.unbilled.count} pending orders to be billed.`)}
                </div>

                {/* Δεδουλευμένες προμήθειες (recent) */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                  <div className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">{t("Δεδουλευμένες προμήθειες", "Accrued fees")}</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-700">
                        <tr>
                          <th className="px-3 py-2">{t("Παραγγελία", "Order")}</th>
                          <th className="px-3 py-2">{t("Ημ/νία", "Date")}</th>
                          <th className="px-3 py-2 text-right">{t("Ποσό", "Amount")}</th>
                          <th className="px-3 py-2">{t("Κατάσταση", "Status")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recent.map((r, i) => (
                          <tr key={`${r.order_no ?? i}-${i}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                            <td className="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{r.order_no || "—"}</td>
                            <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{fmtDate(r.created_at)}</td>
                            <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">{eur(r.cents)}</td>
                            <td className="px-3 py-2">
                              {r.billed ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" title={r.billed_at ? fmtDateTime(r.billed_at) : undefined}>
                                  <CheckCircle2 className="h-3 w-3" /> {t("Χρεώθηκε", "Billed")}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                                  {t("Εκκρεμεί", "Pending")}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                        {data.recent.length === 0 && (
                          <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-slate-400">{t("Καμία δεδουλευμένη προμήθεια ακόμη.", "No accrued fees yet.")}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* Ιστορικό χρεώσεων (charges) — shown even when exempt if any exist */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <div className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">{t("Ιστορικό χρεώσεων", "Charge history")}</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-700">
                    <tr>
                      <th className="px-3 py-2">{t("Ημ/νία", "Date")}</th>
                      <th className="px-3 py-2 text-right">{t("Παραγγελίες", "Orders")}</th>
                      <th className="px-3 py-2 text-right">{t("Καθαρό", "Net")}</th>
                      <th className="px-3 py-2 text-right">{t("Σύνολο με ΦΠΑ", "Total incl. VAT")}</th>
                      <th className="px-3 py-2">{t("Κατάσταση", "Status")}</th>
                      <th className="px-3 py-2">{t("Πάροχος", "Provider")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.charges.map((c, i) => {
                      const ok = c.status === "ok" || c.status === "success" || c.status === "paid";
                      return (
                        <tr key={`${c.charged_at}-${i}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{fmtDate(c.charged_at)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{c.count}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{eur(c.net_cents)}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">{eur(c.gross_cents)}</td>
                          <td className="px-3 py-2">
                            {ok ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                                <CheckCircle2 className="h-3 w-3" /> {t("Επιτυχής", "Successful")}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                                {t("Αποτυχία", "Failed")}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">{c.provider || "—"}</td>
                        </tr>
                      );
                    })}
                    {data.charges.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-400">{t("Καμία χρέωση ακόμη.", "No charges yet.")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </ModuleGuard>
  );
}
