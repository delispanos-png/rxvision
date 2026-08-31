"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, refreshSession, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useT } from "@/store/prefStore";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { Check, ArrowUp, ArrowDown, Sparkles, Crown, Loader2, Users, Star, CreditCard, Building2, X, Clock, Plus, RefreshCw } from "lucide-react";

// ── types (defensive: fields may be absent on older docs) ──────────────────────
type Pkg = {
  _id: string; name?: string; description?: string;
  price_monthly?: number; price_yearly?: number; seats?: number;
  modules?: string[]; features?: string[]; available_addons?: string[];
  sla?: string; trial_days?: number; billing_cycles?: string[];
};
type Sub = {
  plan?: string; status?: string; price?: number; price_monthly?: number;
  billing_cycle?: string; seats?: number; addons_total?: number; modules_included?: string[];
};
type AddonLite = {
  _id: string; name: string; icon?: string; description?: string;
  price_monthly: number; price_yearly: number;
  status: "included" | "active" | "granted" | "available"; offered?: boolean;
};
type Bank = { beneficiary?: string; bank_name?: string; iban?: string; swift?: string; notes?: string };
type Pending = {
  plan?: string; plan_name?: string; kind?: "upgrade" | "downgrade"; method?: "card" | "bank";
  status?: string; new_price?: number; effective_at?: string | null; reference?: string; bank?: Bank;
};

const MODULE_LABELS: Record<string, { el: string; en: string }> = {
  dashboard: { el: "Πίνακας Ελέγχου", en: "Dashboard" },
  prescription_analytics: { el: "Ανάλυση Συνταγών", en: "Prescription analytics" },
  doctor_analytics: { el: "Ανάλυση Ιατρών", en: "Doctor analytics" },
  patient_analytics: { el: "Ανάλυση Ασφαλισμένων", en: "Patient analytics" },
  icd10_analytics: { el: "Ανάλυση ICD-10", en: "ICD-10 analytics" },
  profitability: { el: "Κερδοφορία", en: "Profitability" },
  future_prescriptions: { el: "Μελλοντικές Συνταγές", en: "Upcoming prescriptions" },
  order_suggestions: { el: "Προτάσεις Παραγγελίας", en: "Order suggestions" },
  monthly_closing: { el: "Κλείσιμο Μήνα", en: "Month closing" },
  pharmacyone: { el: "PharmacyOne", en: "PharmacyOne" },
  patient_portal: { el: "Πύλη Πελατών", en: "Customer portal" },
  pharmacat: { el: "PharmaCat", en: "PharmaCat" },
  drug_interactions: { el: "Αλληλεπιδράσεις Φαρμάκων", en: "Drug interactions" },
  ai_assistant: { el: "AI Βοηθός", en: "AI Assistant" },
  loyalty: { el: "Πιστότητα", en: "Loyalty" },
};

const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);

/** Open the Revolut Checkout popup for an order token (loads embed.js on demand). */
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

/** Auto-submit a hidden form to Alpha Bank's hosted payment page (redirect flow). */
function submitAlphaForm(action: string, fields: Record<string, string>) {
  const f = document.createElement("form");
  f.method = "POST"; f.action = action; f.style.display = "none";
  Object.entries(fields).forEach(([k, v]) => {
    const i = document.createElement("input");
    i.type = "hidden"; i.name = k; i.value = String(v ?? "");
    f.appendChild(i);
  });
  document.body.appendChild(f);
  f.submit();
}

export default function ModulesPlanPage() {
  const t = useT();
  const qc = useQueryClient();
  const [upgradeFor, setUpgradeFor] = useState<Pkg | null>(null);   // package chosen → method chooser modal
  const [busy, setBusy] = useState(false);

  const subQ = useQuery({ queryKey: queryKeys.subscription(), queryFn: () => api<Sub>("/subscription"), retry: false });
  const pkgsQ = useQuery({ queryKey: ["onboarding", "packages"], queryFn: () => api<{ packages: Pkg[] }>("/onboarding/packages"), retry: false });
  const addonsQ = useQuery({ queryKey: ["addons"], queryFn: () => api<{ addons: AddonLite[]; addons_total: number; billing_cycle: "monthly" | "yearly" }>("/addons"), retry: false });
  const pendQ = useQuery({ queryKey: ["subscription", "plan-change"], queryFn: () => api<{ pending: Pending | null }>("/subscription/plan-change"), retry: false });
  const methodsQ = useQuery({ queryKey: ["subscription", "payment-methods"], queryFn: () => api<{ methods: { id: string; label: { el: string; en: string } }[] }>("/subscription/payment-methods"), retry: false });
  const enabledMethods = methodsQ.data?.methods ?? [];

  const sub = subQ.data;
  const yearly = (sub?.billing_cycle ?? addonsQ.data?.billing_cycle) === "yearly";
  const per = yearly ? t("έτος", "yr") : t("μήνα", "mo");
  // ── Ενεργοποίηση/απενεργοποίηση add-ons ΕΔΩ (ενοποιήθηκαν με το «Modules/Πλάνο») ──
  const refreshAddons = async () => {
    await refreshSession();   // φέρε το νέο entitlement στο JWT άμεσα
    qc.invalidateQueries({ queryKey: ["addons"] });
    qc.invalidateQueries({ queryKey: ["me"] });
    qc.invalidateQueries({ queryKey: ["billing-status"] });
  };
  const actAddon = useMutation({
    mutationFn: (id: string) => api(`/addons/${id}/activate`, { method: "POST" }),
    onSuccess: refreshAddons,
    onError: () => appAlert(t("Η ενεργοποίηση απέτυχε. Δοκίμασε ξανά.", "Activation failed. Please try again.")),
  });
  const deactAddon = useMutation({
    mutationFn: (id: string) => api(`/addons/${id}/deactivate`, { method: "POST" }),
    onSuccess: refreshAddons,
  });
  const addonBusy = actAddon.isPending || deactAddon.isPending;
  async function activateAddon(a: AddonLite) {
    const price = yearly ? a.price_yearly : a.price_monthly;
    if (await appConfirm(t(`Ενεργοποίηση «${a.name}» με επιπλέον ${eur(price)}/${per}; Η χρέωση ξεκινά από τον επόμενο κύκλο. Μπορείς να το απενεργοποιήσεις όποτε θες.`,
      `Activate «${a.name}» for +${eur(price)}/${per}? Billing starts next cycle. You can turn it off anytime.`))) actAddon.mutate(a._id);
  }
  async function deactivateAddon(a: AddonLite) {
    if (await appConfirm(t(`Απενεργοποίηση «${a.name}»;`, `Deactivate «${a.name}»?`), { danger: true })) deactAddon.mutate(a._id);
  }
  const priceOf = (p?: Pkg) => (yearly ? p?.price_yearly ?? p?.price_monthly : p?.price_monthly) ?? 0;

  const packages = [...(pkgsQ.data?.packages ?? [])].sort((a, b) => (a.price_monthly ?? 0) - (b.price_monthly ?? 0));
  const current = packages.find((p) => p._id === sub?.plan);
  const currentPrice = current ? priceOf(current) : (sub?.price ?? sub?.price_monthly ?? 0);
  const includedModules = current?.modules ?? sub?.modules_included ?? [];
  // Το «Δωρεάν δοκιμή» (€0) ΔΕΝ είναι επιλέξιμο πακέτο — μόνο πληρωμένα εμφανίζονται στη λίστα.
  const selectable = packages.filter((p) => (p.price_monthly ?? 0) > 0);
  const pending = pendQ.data?.pending || null;

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["subscription", "plan-change"] });
    qc.invalidateQueries({ queryKey: queryKeys.subscription() });
  };

  // ── downgrade: schedule to period end / renewal ──
  async function doDowngrade(p: Pkg) {
    const ok = await appConfirm(
      t(`Υποβάθμιση σε «${p.name || p._id}»; Θα εφαρμοστεί στο τέλος της τρέχουσας περιόδου${yearly ? " (ετήσια ανανέωση)" : ""} — μέχρι τότε διατηρείς το τρέχον πλάνο.`,
        `Downgrade to «${p.name || p._id}»? It applies at the end of your current period${yearly ? " (yearly renewal)" : ""} — you keep your current plan until then.`));
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api<{ effective_at?: string }>("/subscription/plan-change", { method: "POST", body: JSON.stringify({ plan: p._id }) });
      invalidateAll();
      appAlert(t(`Η υποβάθμιση προγραμματίστηκε${r.effective_at ? ` για ${new Date(r.effective_at).toLocaleDateString("el-GR")}` : ""}.`,
                 `Downgrade scheduled${r.effective_at ? ` for ${new Date(r.effective_at).toLocaleDateString("el-GR")}` : ""}.`));
    } catch (e) { appAlert(e instanceof ApiError ? t(`Σφάλμα (${e.status})`, `Error (${e.status})`) : t("Αποτυχία", "Failed")); }
    finally { setBusy(false); }
  }

  // ── upgrade: card (Revolut) · alpha (Alpha Bank redirect) · bank transfer (admin request) ──
  async function doUpgrade(p: Pkg, method: "card" | "alpha" | "bank") {
    setBusy(true);
    try {
      const r = await api<{ token?: string; mode?: string; action?: string; fields?: Record<string, string> }>("/subscription/plan-change", { method: "POST", body: JSON.stringify({ plan: p._id, method }) });
      if (method === "card") {
        if (r.token) await payWithRevolut(r.token, r.mode || "sandbox");
        await refreshSession();
        qc.invalidateQueries({ queryKey: ["me"] });
        invalidateAll();
        appAlert(t("Η πληρωμή ολοκληρώθηκε — η αναβάθμιση ενεργοποιείται αμέσως. Οι νέες δυνατότητες θα εμφανιστούν στην επόμενη σύνδεση.", "Payment complete — the upgrade is applied. New capabilities appear on your next login."));
      } else if (method === "alpha") {
        if (r.action && r.fields) { submitAlphaForm(r.action, r.fields); return; }  // redirect → Alpha
        invalidateAll();
      } else {
        invalidateAll();   // banner θα δείξει τα στοιχεία κατάθεσης
      }
      setUpgradeFor(null);
    } catch (e) { appAlert(e instanceof ApiError ? t(`Σφάλμα (${e.status})`, `Error (${e.status})`) : t("Αποτυχία", "Failed")); }
    finally { setBusy(false); }
  }

  async function cancelPending() {
    if (!(await appConfirm(t("Ακύρωση εκκρεμούς αλλαγής πλάνου;", "Cancel the pending plan change?"), { danger: true }))) return;
    setBusy(true);
    try { await api("/subscription/plan-change", { method: "DELETE" }); invalidateAll(); }
    finally { setBusy(false); }
  }

  // ── αλλαγή κύκλου χρέωσης: μηνιαία → ετήσια (μέσω renew-now/Viva· ίδιο πακέτο, ετήσια τιμή) ──
  async function switchToYearly() {
    if (!current) return;
    const saving = (current.price_monthly ?? 0) * 12 - (current.price_yearly ?? 0);
    const ok = await appConfirm(
      t(`Αλλαγή σε ΕΤΗΣΙΑ χρέωση «${current.name}»: ${eur(current.price_yearly)}/έτος${saving > 0 ? ` (γλιτώνεις ${eur(saving)}/έτος)` : ""}. Θα μεταφερθείς στην ασφαλή πληρωμή Viva· μετά την πληρωμή η συνδρομή σου γίνεται ετήσια — οι υπόλοιπες μέρες σου ΔΕΝ χάνονται. Συνέχεια;`,
        `Switch to ANNUAL billing for «${current.name}»: ${eur(current.price_yearly)}/yr${saving > 0 ? ` (save ${eur(saving)}/yr)` : ""}. You'll go to secure Viva payment; after payment your subscription becomes annual — your remaining days are NOT lost. Continue?`));
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api<{ checkout_url?: string }>("/billing/renew-now", { method: "POST", body: JSON.stringify({ package_code: current._id, billing_cycle: "yearly" }) });
      if (r.checkout_url) { window.location.href = r.checkout_url; return; }
      appAlert(t("Δεν ξεκίνησε η πληρωμή — δοκίμασε ξανά.", "Payment didn't start — try again."));
    } catch (e) { appAlert(e instanceof ApiError ? t(`Σφάλμα (${e.status})`, `Error (${e.status})`) : t("Αποτυχία", "Failed")); }
    finally { setBusy(false); }
  }

  function pick(p: Pkg) {
    if (pending) { appAlert(t("Υπάρχει ήδη εκκρεμής αλλαγή πλάνου — ακύρωσέ την πρώτα.", "There's already a pending plan change — cancel it first.")); return; }
    if (priceOf(p) > currentPrice) setUpgradeFor(p);
    else doDowngrade(p);
  }

  const offeredAddons = (addonsQ.data?.addons ?? []).filter((a) => a.status === "active" || a.status === "granted" || (a.status === "available" && a.offered));
  const bundled = (addonsQ.data?.addons ?? []).filter((a) => a.status === "included");

  return (
    <ModuleGuard module="settings">
      <div className="max-w-5xl space-y-6">
        {/* ── Εκκρεμής αλλαγή πλάνου (banner) ───────────────────────────── */}
        {pending && (
          <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700/60 dark:bg-amber-950/20">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {pending.kind === "downgrade" ? (
                  <>
                    <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300"><Clock className="h-4 w-4" /> {t("Προγραμματισμένη υποβάθμιση", "Scheduled downgrade")}</div>
                    <p className="mt-1 text-sm text-amber-700 dark:text-amber-200/90">
                      {t(`Μετάβαση σε «${pending.plan_name}»`, `Switching to «${pending.plan_name}»`)}
                      {pending.effective_at ? t(` στις ${new Date(pending.effective_at).toLocaleDateString("el-GR")}.`, ` on ${new Date(pending.effective_at).toLocaleDateString("el-GR")}.`) : "."}
                      {t(" Μέχρι τότε διατηρείς το τρέχον πλάνο.", " You keep your current plan until then.")}
                    </p>
                  </>
                ) : pending.method === "bank" ? (
                  <>
                    <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300"><Building2 className="h-4 w-4" /> {t("Αναβάθμιση — αναμονή τραπεζικής κατάθεσης", "Upgrade — awaiting bank transfer")}</div>
                    <p className="mt-1 text-sm text-amber-700 dark:text-amber-200/90">
                      {t(`Για αναβάθμιση σε «${pending.plan_name}» (${eur(pending.new_price)}), κατάθεσε στον λογαριασμό:`, `To upgrade to «${pending.plan_name}» (${eur(pending.new_price)}), deposit to:`)}
                    </p>
                    <div className="mt-2 grid gap-1 rounded-xl bg-white p-3 text-sm dark:bg-slate-900">
                      {pending.bank?.beneficiary && <div><span className="text-slate-400">{t("Δικαιούχος:", "Beneficiary:")}</span> <b>{pending.bank.beneficiary}</b></div>}
                      {pending.bank?.bank_name && <div><span className="text-slate-400">{t("Τράπεζα:", "Bank:")}</span> {pending.bank.bank_name}</div>}
                      {pending.bank?.iban && <div><span className="text-slate-400">IBAN:</span> <b className="font-mono">{pending.bank.iban}</b></div>}
                      {pending.bank?.swift && <div><span className="text-slate-400">SWIFT/BIC:</span> <span className="font-mono">{pending.bank.swift}</span></div>}
                      <div><span className="text-slate-400">{t("Αιτιολογία:", "Reference:")}</span> <b className="font-mono">{pending.reference}</b></div>
                      {pending.bank?.notes && <div className="text-xs text-slate-400">{pending.bank.notes}</div>}
                      {!pending.bank?.iban && <div className="text-xs text-rose-500">{t("Ο λογαριασμός δεν έχει ρυθμιστεί ακόμη — επικοινώνησε με τη διαχείριση.", "Bank account not configured yet — contact support.")}</div>}
                    </div>
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-200/90">{t("Μόλις λάβουμε την κατάθεση, η διαχείριση ενεργοποιεί την αναβάθμιση.", "Once we receive the deposit, support activates the upgrade.")}</p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300"><CreditCard className="h-4 w-4" /> {t("Αναβάθμιση — εκκρεμεί πληρωμή με κάρτα", "Upgrade — card payment pending")}</div>
                    <p className="mt-1 text-sm text-amber-700 dark:text-amber-200/90">{t(`Μετάβαση σε «${pending.plan_name}» (${eur(pending.new_price)}). Ολοκλήρωσε την πληρωμή για ενεργοποίηση.`, `Switching to «${pending.plan_name}» (${eur(pending.new_price)}). Complete payment to activate.`)}</p>
                  </>
                )}
              </div>
              <button onClick={cancelPending} disabled={busy} className="shrink-0 rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-300">{t("Ακύρωση", "Cancel")}</button>
            </div>
          </section>
        )}

        {/* ── Τρέχον πλάνο ──────────────────────────────────────────────── */}
        <section className="rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-5 shadow-sm dark:border-brand-800/60 dark:from-brand-950/30 dark:to-slate-900">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400"><Crown className="h-3.5 w-3.5" /> {t("Τρέχον πλάνο", "Current plan")}</div>
              <h2 className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{current?.name || sub?.plan || "—"}</h2>
              {current?.description && <p className="mt-1 max-w-xl text-sm text-slate-500">{current.description}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
                {sub?.status && <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium capitalize text-slate-600 shadow-sm dark:bg-slate-800 dark:text-slate-300">{sub.status}</span>}
                {(current?.seats ?? sub?.seats) != null && <span className="inline-flex items-center gap-1"><Users className="h-4 w-4 text-slate-400" /> {current?.seats ?? sub?.seats} {t("χρήστες", "seats")}</span>}
                {(sub?.addons_total ?? 0) > 0 && <span>{t("Πρόσθετα:", "Add-ons:")} <b>{eur(sub!.addons_total)}/{per}</b></span>}
              </div>
            </div>
            <div className="text-right">
              <div className="text-3xl font-extrabold text-slate-900 dark:text-slate-100">{eur(currentPrice)}</div>
              <div className="text-xs text-slate-400">/{per}{(sub?.addons_total ?? 0) > 0 && <> + {eur(sub!.addons_total)} {t("πρόσθετα", "add-ons")}</>}</div>
            </div>
          </div>
          {includedModules.length > 0 && (
            <div className="mt-4 border-t border-brand-100 pt-3 dark:border-brand-900/40">
              <div className="mb-2 text-xs font-semibold text-slate-500">{t("Περιλαμβάνονται στο πλάνο", "Included in your plan")}</div>
              <div className="flex flex-wrap gap-1.5">
                {includedModules.map((m) => (
                  <span key={m} className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs text-slate-700 shadow-sm dark:bg-slate-800 dark:text-slate-200">
                    <Check className="h-3 w-3 text-emerald-500" /> {MODULE_LABELS[m] ? t(MODULE_LABELS[m].el, MODULE_LABELS[m].en) : m}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── Κύκλος χρέωσης: μηνιαία → ετήσια ──────────────────────────── */}
        {!yearly && current && (current.price_yearly ?? 0) > 0 && ((current.billing_cycles?.includes("yearly")) ?? true) && (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800/50 dark:bg-emerald-950/20">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300"><RefreshCw className="h-4 w-4" /> {t("Πληρώνεις μηνιαία — πέρνα σε ΕΤΗΣΙΑ χρέωση", "You pay monthly — switch to ANNUAL billing")}</div>
                <p className="mt-1 text-sm text-emerald-800/90 dark:text-emerald-200/80">
                  {t(`Ετήσια: ${eur(current.price_yearly)}/έτος (${eur(Math.round((current.price_yearly ?? 0) / 12))}/μήνα)`, `Annual: ${eur(current.price_yearly)}/yr (${eur(Math.round((current.price_yearly ?? 0) / 12))}/mo)`)}
                  {(current.price_monthly ?? 0) * 12 > (current.price_yearly ?? 0) && <b className="ml-1 text-emerald-700 dark:text-emerald-400">· {t(`γλιτώνεις ${eur((current.price_monthly ?? 0) * 12 - (current.price_yearly ?? 0))}/έτος`, `save ${eur((current.price_monthly ?? 0) * 12 - (current.price_yearly ?? 0))}/yr`)}</b>}
                </p>
                <p className="mt-0.5 text-[11px] text-emerald-700/80 dark:text-emerald-300/70">{t("Μία πληρωμή τον χρόνο — οι υπόλοιπες μέρες σου δεν χάνονται.", "One payment per year — your remaining days are not lost.")}</p>
              </div>
              <button onClick={switchToYearly} disabled={busy} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t("Άλλαξε σε ετήσια", "Switch to annual")}
              </button>
            </div>
          </section>
        )}

        {/* ── Διαθέσιμα πακέτα (αναβάθμιση/υποβάθμιση) ──────────────────── */}
        <section>
          <h3 className="mb-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t("Διαθέσιμα πακέτα", "Available packages")}</h3>
          {pkgsQ.isLoading ? (
            <div className="p-6 text-slate-400"><Loader2 className="inline h-4 w-4 animate-spin" /> {t("Φόρτωση…", "Loading…")}</div>
          ) : selectable.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900">{t("Δεν υπάρχουν διαθέσιμα πακέτα.", "No packages available.")}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {selectable.map((p) => {
                const isCurrent = p._id === sub?.plan;
                const price = priceOf(p);
                const isUp = price > currentPrice;
                const isDown = price < currentPrice;
                return (
                  <div key={p._id} className={`flex flex-col rounded-2xl border p-4 ${isCurrent ? "border-brand-400 ring-1 ring-brand-300 dark:border-brand-600" : "border-slate-200 dark:border-slate-700"} bg-white dark:bg-slate-900`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-bold text-slate-900 dark:text-slate-100">{p.name || p._id}</div>
                      {isCurrent && <span className="shrink-0 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white">{t("Τρέχον", "Current")}</span>}
                    </div>
                    {p.description && <p className="mt-0.5 text-xs text-slate-500">{p.description}</p>}
                    <div className="mt-3">
                      <span className="text-2xl font-extrabold text-slate-900 dark:text-slate-100">{price === 0 ? t("Δωρεάν", "Free") : eur(price)}</span>
                      {price > 0 && <span className="text-xs text-slate-400">/{per}</span>}
                    </div>
                    {p.seats != null && <div className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500"><Users className="h-3.5 w-3.5" /> {p.seats} {t("χρήστες", "seats")}{p.sla ? ` · SLA ${p.sla}` : ""}</div>}
                    <ul className="mt-3 flex-1 space-y-1">
                      {(p.features?.length ? p.features : (p.modules ?? []).map((m) => (MODULE_LABELS[m] ? t(MODULE_LABELS[m].el, MODULE_LABELS[m].en) : m))).slice(0, 7).map((f, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300"><Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" /> {f}</li>
                      ))}
                    </ul>
                    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                      {isCurrent ? (
                        <div className="text-center text-xs font-medium text-brand-600 dark:text-brand-400">{t("Το πλάνο σου", "Your plan")}</div>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || !!pending}
                          onClick={() => pick(p)}
                          className={`inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${isUp ? "bg-brand-600 text-white hover:bg-brand-700" : "border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300"}`}
                        >
                          {isUp ? <ArrowUp className="h-4 w-4" /> : isDown ? <ArrowDown className="h-4 w-4" /> : null}
                          {isUp ? t("Αναβάθμιση", "Upgrade") : isDown ? t("Υποβάθμιση", "Downgrade") : t("Αλλαγή", "Switch")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">{t("Αναβάθμιση: άμεση με κάρτα ή με τραπεζική κατάθεση (έγκριση διαχείρισης). Υποβάθμιση: στο τέλος της περιόδου/ανανέωσης.", "Upgrade: instant by card or by bank transfer (admin approval). Downgrade: at period end/renewal.")}</p>
        </section>

        {/* ── Διαθέσιμα Add-ons για τη συνδρομή σου ─────────────────────── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100"><Sparkles className="h-4 w-4 text-violet-500" /> {t("Πρόσθετα (Add-ons)", "Add-ons")}</h3>
          <p className="mt-1 text-sm text-slate-500">{t("Πρόσθεσε δυνατότητες à la carte πάνω στο πλάνο σου — ενεργοποίηση/απενεργοποίηση όποτε θες. Η χρέωση ξεκινά από τον επόμενο κύκλο.", "Add à-la-carte capabilities on top of your plan — turn on/off anytime. Billing starts next cycle.")}</p>

          {addonsQ.isLoading ? (
            <div className="mt-3 text-slate-400"><Loader2 className="inline h-4 w-4 animate-spin" /> {t("Φόρτωση…", "Loading…")}</div>
          ) : offeredAddons.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">{t("Δεν υπάρχουν διαθέσιμα πρόσθετα για το πλάνο σου.", "No add-ons available for your plan.")}</p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {offeredAddons.map((a) => {
                const price = yearly ? a.price_yearly : a.price_monthly;
                return (
                  <div key={a._id} className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${a.status === "active" ? "border-violet-300 bg-violet-50/40 dark:border-violet-700 dark:bg-violet-950/20" : "border-slate-200 dark:border-slate-700"}`}>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{a.icon} {a.name}</div>
                      {a.description && <div className="truncate text-xs text-slate-400">{a.description}</div>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{price === 0 ? t("Δωρεάν", "Free") : `${eur(price)}/${per}`}</div>
                      {a.status === "granted" && <span className="text-[10px] font-semibold text-emerald-600">{t("Παραχωρημένο", "Granted")}</span>}
                      {a.status === "available" && <button disabled={addonBusy} onClick={() => activateAddon(a)} className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /> {t("Ενεργοποίηση", "Activate")}</button>}
                      {a.status === "active" && <button disabled={addonBusy} onClick={() => deactivateAddon(a)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600"><X className="h-3.5 w-3.5" /> {t("Απενεργοποίηση", "Deactivate")}</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {bundled.length > 0 && (
            <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
              ✓ {t("Ήδη στο πλάνο σου:", "Already in your plan:")} {bundled.map((a) => `${a.icon ?? ""} ${a.name}`).join(" · ")}
            </p>
          )}
        </section>
      </div>

      {/* ── Modal: επιλογή τρόπου πληρωμής για αναβάθμιση ─────────────── */}
      {upgradeFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => !busy && setUpgradeFor(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Αναβάθμιση σε", "Upgrade to")} «{upgradeFor.name || upgradeFor._id}»</h3>
                <p className="mt-0.5 text-sm text-slate-500">{eur(priceOf(upgradeFor))}/{per} · {t("Διάλεξε τρόπο πληρωμής", "Choose a payment method")}</p>
              </div>
              <button onClick={() => !busy && setUpgradeFor(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>
            <div className="mt-4 space-y-2">
              {enabledMethods.map((m) => {
                if (m.id === "card_revolut") return (
                  <button key={m.id} disabled={busy} onClick={() => doUpgrade(upgradeFor, "card")} className="flex w-full items-center gap-3 rounded-xl border border-brand-300 bg-brand-50 px-4 py-3 text-left hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-950/30">
                    <CreditCard className="h-5 w-5 text-brand-600" />
                    <div className="flex-1"><div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("Κάρτα / IRIS — Viva (άμεση ενεργοποίηση)", "Card / IRIS — Viva (instant)")}</div><div className="text-xs text-slate-500">{t("Ασφαλής πληρωμή — η αναβάθμιση ισχύει αμέσως.", "Secure payment — upgrade applies immediately.")}</div></div>
                    {busy && <Loader2 className="h-4 w-4 animate-spin text-brand-600" />}
                  </button>
                );
                if (m.id === "card_alpha") return (
                  <button key={m.id} disabled={busy} onClick={() => doUpgrade(upgradeFor, "alpha")} className="flex w-full items-center gap-3 rounded-xl border border-brand-300 bg-brand-50 px-4 py-3 text-left hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-950/30">
                    <CreditCard className="h-5 w-5 text-brand-600" />
                    <div className="flex-1"><div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("Κάρτα — Alpha Bank (άμεση ενεργοποίηση)", "Card — Alpha Bank (instant)")}</div><div className="text-xs text-slate-500">{t("Ασφαλής πληρωμή στη σελίδα της Alpha Bank.", "Secure payment on Alpha Bank's page.")}</div></div>
                    {busy && <Loader2 className="h-4 w-4 animate-spin text-brand-600" />}
                  </button>
                );
                if (m.id === "bank_transfer") return (
                  <button key={m.id} disabled={busy} onClick={() => doUpgrade(upgradeFor, "bank")} className="flex w-full items-center gap-3 rounded-xl border border-slate-300 px-4 py-3 text-left hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-800">
                    <Building2 className="h-5 w-5 text-slate-500" />
                    <div className="flex-1"><div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("Τραπεζική κατάθεση", "Bank transfer")}</div><div className="text-xs text-slate-500">{t("Θα λάβεις τα στοιχεία λογαριασμού — η διαχείριση ενεργοποιεί μετά την κατάθεση.", "You'll get the account details — support activates after the deposit.")}</div></div>
                  </button>
                );
                return null;
              })}
              {enabledMethods.length === 0 && <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-400 dark:bg-slate-800">{t("Δεν υπάρχει διαθέσιμος τρόπος πληρωμής. Επικοινώνησε με τη διαχείριση.", "No payment method available. Contact support.")}</p>}
            </div>
          </div>
        </div>
      )}
    </ModuleGuard>
  );
}
