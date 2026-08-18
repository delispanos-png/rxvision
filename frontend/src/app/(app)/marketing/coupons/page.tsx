"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ticket, Plus, Copy, Check, Power, Loader2, Gift, Percent, Euro, Stethoscope } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appAlert } from "@/store/dialogStore";
import { QueryState } from "@/components/ui/QueryState";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Coupon = {
  code: string; reward_type: string; discount_type: string; discount_value: number;
  service_name: string | null; service_free: boolean; valid_until: string | null;
  max_redemptions: number; redemptions: number; redeemed_value_cents: number;
  status: string; standalone: boolean; note: string | null; channel: string | null; segment: string | null;
};
type Svc = { id: string; name: string };

const eur = (c: number) => `${((c || 0) / 100).toLocaleString("el-GR", { maximumFractionDigits: 2 })} €`;
const ddmmyyyy = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

export default function CouponsPage() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["coupons"], queryFn: () => api<{ items: Coupon[] }>("/marketing/coupons") });
  const svc = useQuery({ queryKey: ["marketing-services"], queryFn: () => api<{ items: Svc[] }>("/marketing/services") });

  const [copied, setCopied] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  // φόρμα νέου αυτόνομου κουπονιού
  const [reward, setReward] = useState<"discount" | "service">("discount");
  const [dtype, setDtype] = useState<"pct" | "fixed">("pct");
  const [dval, setDval] = useState("");
  const [svcId, setSvcId] = useState("");
  const [svcFree, setSvcFree] = useState(true);
  const [svcPct, setSvcPct] = useState("");
  const [days, setDays] = useState("30");
  const [maxR, setMaxR] = useState("");
  const [note, setNote] = useState("");

  const create = useMutation({
    mutationFn: () => {
      const svcName = svc.data?.items.find((s) => s.id === svcId)?.name || null;
      const body = reward === "service"
        ? { reward_type: "service", service_id: svcId, service_name: svcName, service_free: svcFree,
            discount_value: svcFree ? 0 : Math.max(0, parseInt(svcPct || "0", 10)),
            valid_days: parseInt(days || "30", 10), max_redemptions: parseInt(maxR || "0", 10), note: note.trim() || null }
        : { reward_type: "discount", discount_type: dtype,
            discount_value: dtype === "fixed" ? Math.round(parseFloat(dval || "0") * 100) : Math.max(0, parseInt(dval || "0", 10)),
            valid_days: parseInt(days || "30", 10), max_redemptions: parseInt(maxR || "0", 10), note: note.trim() || null };
      return api<{ code: string }>("/marketing/coupons", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: async (r) => {
      qc.invalidateQueries({ queryKey: ["coupons"] });
      setShowNew(false); setDval(""); setSvcId(""); setSvcPct(""); setMaxR(""); setNote("");
      await appAlert(`${t("Δημιουργήθηκε ο κωδικός", "Created code")}: ${r.code}`, { title: t("Νέο κουπόνι", "New coupon") });
    },
  });

  const toggle = useMutation({
    mutationFn: (v: { code: string; active: boolean }) => api(`/marketing/coupons/${encodeURIComponent(v.code)}/status`, { method: "POST", body: JSON.stringify({ active: v.active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coupons"] }),
  });

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(code); setTimeout(() => setCopied(null), 1500); } catch { /* noop */ }
  };

  const reward_desc = (c: Coupon) => {
    if (c.reward_type === "service") return c.service_free ? `${t("Δωρεάν", "Free")}: ${c.service_name || "—"}` : `${c.discount_value}% ${t("σε", "on")} ${c.service_name || "—"}`;
    return c.discount_type === "fixed" ? `${eur(c.discount_value)} ${t("έκπτωση", "off")}` : `${c.discount_value}% ${t("έκπτωση", "off")}`;
  };
  const STATUS: Record<string, { label: string; cls: string }> = {
    active: { label: t("Ενεργό", "Active"), cls: "bg-emerald-100 text-emerald-700" },
    expired: { label: t("Έληξε", "Expired"), cls: "bg-slate-100 text-slate-500" },
    exhausted: { label: t("Εξαντλήθηκε", "Exhausted"), cls: "bg-amber-100 text-amber-700" },
    inactive: { label: t("Ανενεργό", "Inactive"), cls: "bg-rose-100 text-rose-700" },
  };

  return (
    <ModuleGuard module="marketing">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-violet-600 text-white shadow-lg"><Ticket className="h-6 w-6" /></span>
            <div>
              <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Κουπόνια", "Coupons")}</h1>
              <p className="text-xs text-slate-500">{t("Όλα τα κουπόνια σου — έκπτωση ή δωρεάν/εκπτωτική υπηρεσία.", "All your coupons — discount or free/discounted service.")}</p>
            </div>
          </div>
          <button onClick={() => setShowNew((s) => !s)} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
            <Plus className="h-4 w-4" /> {t("Νέο κουπόνι", "New coupon")}
          </button>
        </div>

        {showNew && (
          <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-800 dark:bg-violet-950/20">
            <div className="mb-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t("Νέο αυτόνομο κουπόνι", "New standalone coupon")}</div>
            {/* τύπος ανταμοιβής */}
            <div className="mb-3 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
              <button onClick={() => setReward("discount")} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold ${reward === "discount" ? "bg-violet-600 text-white" : "text-slate-500"}`}><Euro className="h-3.5 w-3.5" /> {t("Έκπτωση", "Discount")}</button>
              <button onClick={() => setReward("service")} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold ${reward === "service" ? "bg-violet-600 text-white" : "text-slate-500"}`}><Stethoscope className="h-3.5 w-3.5" /> {t("Υπηρεσία", "Service")}</button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {reward === "discount" ? (
                <>
                  <label className="text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Τύπος", "Type")}</span>
                    <select value={dtype} onChange={(e) => setDtype(e.target.value as "pct" | "fixed")} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
                      <option value="pct">{t("Ποσοστό %", "Percent %")}</option>
                      <option value="fixed">{t("Ποσό €", "Amount €")}</option>
                    </select></label>
                  <label className="text-sm"><span className="mb-1 block text-xs text-slate-500">{dtype === "pct" ? t("Ποσοστό (%)", "Percent (%)") : t("Ποσό (€)", "Amount (€)")}</span>
                    <input value={dval} onChange={(e) => setDval(e.target.value)} type="number" min="0" placeholder={dtype === "pct" ? "15" : "5"} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                </>
              ) : (
                <>
                  <label className="text-sm sm:col-span-2"><span className="mb-1 block text-xs text-slate-500">{t("Υπηρεσία", "Service")}</span>
                    <select value={svcId} onChange={(e) => setSvcId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
                      <option value="">{t("— Επίλεξε —", "— Select —")}</option>
                      {svc.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    {!svc.data?.items.length && <span className="mt-1 block text-[11px] text-amber-600">{t("Δεν υπάρχουν υπηρεσίες — πρόσθεσέ τες στις Υπηρεσίες/Ραντεβού.", "No services — add them in Services/Appointments.")}</span>}
                  </label>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <button onClick={() => setSvcFree(true)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${svcFree ? "bg-emerald-100 text-emerald-700" : "border border-slate-200 text-slate-500"}`}><Gift className="h-3.5 w-3.5" /> {t("Δωρεάν / δοκιμαστική", "Free / trial")}</button>
                    <button onClick={() => setSvcFree(false)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${!svcFree ? "bg-violet-100 text-violet-700" : "border border-slate-200 text-slate-500"}`}><Percent className="h-3.5 w-3.5" /> {t("Με έκπτωση %", "Discounted %")}</button>
                    {!svcFree && <input value={svcPct} onChange={(e) => setSvcPct(e.target.value)} type="number" min="0" max="100" placeholder="20" className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />}
                  </div>
                </>
              )}
              <label className="text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Ισχύ (ημέρες)", "Valid (days)")}</span>
                <input value={days} onChange={(e) => setDays(e.target.value)} type="number" min="1" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
              <label className="text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Όριο εξαργυρώσεων (0=χωρίς)", "Redemption limit (0=none)")}</span>
                <input value={maxR} onChange={(e) => setMaxR(e.target.value)} type="number" min="0" placeholder="0" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
              <label className="text-sm sm:col-span-2"><span className="mb-1 block text-xs text-slate-500">{t("Σημείωση (προαιρετικά)", "Note (optional)")}</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("π.χ. αφίσα βιτρίνας", "e.g. window poster")} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
            </div>
            <div className="mt-3 flex justify-end">
              <button onClick={() => create.mutate()} disabled={create.isPending || (reward === "service" && !svcId)} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {t("Δημιουργία", "Create")}
              </button>
            </div>
          </div>
        )}

        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
          {q.data && (q.data.items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900">{t("Δεν υπάρχουν κουπόνια ακόμη.", "No coupons yet.")}</div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-400 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-4 py-2 font-semibold">{t("Κωδικός", "Code")}</th>
                    <th className="px-4 py-2 font-semibold">{t("Προσφορά", "Reward")}</th>
                    <th className="px-4 py-2 font-semibold">{t("Λήξη", "Expires")}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t("Εξαργυρώσεις", "Redemptions")}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t("Αξία", "Value")}</th>
                    <th className="px-4 py-2 font-semibold">{t("Κατάσταση", "Status")}</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {q.data.items.map((c) => (
                    <tr key={c.code} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-2.5">
                        <button onClick={() => copy(c.code)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 font-mono text-xs font-bold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
                          {c.code} {copied === c.code ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-slate-400" />}
                        </button>
                        {!c.standalone && <div className="mt-0.5 text-[11px] text-slate-400">{t("από καμπάνια", "from campaign")}{c.channel ? ` · ${c.channel}` : ""}</div>}
                        {c.note && <div className="mt-0.5 text-[11px] text-slate-400">{c.note}</div>}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-700 dark:text-slate-200">
                        <span className="inline-flex items-center gap-1.5">{c.reward_type === "service" ? <Stethoscope className="h-3.5 w-3.5 text-violet-500" /> : <Euro className="h-3.5 w-3.5 text-slate-400" />}{reward_desc(c)}</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{ddmmyyyy(c.valid_until)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-600 dark:text-slate-300">{c.redemptions}{c.max_redemptions ? ` / ${c.max_redemptions}` : ""}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-emerald-600">{c.redeemed_value_cents ? eur(c.redeemed_value_cents) : "—"}</td>
                      <td className="px-4 py-2.5"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS[c.status]?.cls || "bg-slate-100 text-slate-500"}`}>{STATUS[c.status]?.label || c.status}</span></td>
                      <td className="px-4 py-2.5 text-right">
                        {(c.status === "active" || c.status === "inactive") && (
                          <button onClick={() => toggle.mutate({ code: c.code, active: c.status !== "active" })} disabled={toggle.isPending}
                            title={c.status === "active" ? t("Απενεργοποίηση", "Deactivate") : t("Ενεργοποίηση", "Activate")}
                            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold ${c.status === "active" ? "border border-slate-200 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700" : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"}`}>
                            <Power className="h-3.5 w-3.5" /> {c.status === "active" ? t("Απενεργοποίηση", "Off") : t("Ενεργοποίηση", "On")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </QueryState>
      </div>
    </ModuleGuard>
  );
}
