"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { api, ApiError } from "@/lib/apiClient";
import { Logo } from "@/components/brand/Logo";

const schema = z.object({
  email: z.string().email("Μη έγκυρο email"),
  password: z.string().min(6, "Τουλάχιστον 6 χαρακτήρες"),
});

type FormValues = z.infer<typeof schema>;

type LoginResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

type RenewPkg = { _id: string; name?: string; price_monthly?: number; price_yearly?: number; modules?: string[]; seats?: number; sla?: string; billing_cycles?: string[] };
type RenewState = { token: string; pkgs: RenewPkg[]; choice: string; yearly: boolean; busy: boolean; currentPlan?: string; currentPlanName?: string };
const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);

const MODULE_LABELS: Record<string, string> = {
  dashboard: "Πίνακας Ελέγχου", prescription_analytics: "Ανάλυση Συνταγών", doctor_analytics: "Ανάλυση Ιατρών",
  patient_analytics: "Ανάλυση Ασφαλισμένων", icd10_analytics: "Ανάλυση ICD-10", profitability: "Κερδοφορία",
  future_prescriptions: "Μελλοντικές Συνταγές", order_suggestions: "Προτάσεις Παραγγελίας", monthly_closing: "Κλείσιμο Μήνα",
  pharmacyone: "PharmacyOne", patient_portal: "Πύλη Πελατών", pharmacat: "PharmaCat",
  drug_interactions: "Αλληλεπιδράσεις Φαρμάκων", ai_assistant: "AI Βοηθός", loyalty: "Πιστότητα",
};
const modLabel = (k: string) => MODULE_LABELS[k] || k;

export default function LoginPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [renew, setRenew] = useState<RenewState | null>(null);   // ληγμένη συνδρομή → οθόνη ανανέωσης
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const qp = new URLSearchParams(window.location.search);
    if (qp.get("renewed")) setNotice("Η ανανέωση ολοκληρώθηκε ✓ — συνδέσου για να συνεχίσεις.");
  }, []);

  async function startRenewal() {
    if (!renew || !renew.choice) return;
    setRenew({ ...renew, busy: true });
    try {
      const r = await api<{ ok: boolean; checkout_url?: string }>("/billing/renew", {
        method: "POST",
        body: JSON.stringify({ renew_token: renew.token, package_code: renew.choice, billing_cycle: renew.yearly ? "yearly" : "monthly" }),
      });
      if (r.checkout_url) {
        if (typeof window !== "undefined") window.localStorage.setItem("renew_pending", "1");
        window.location.href = r.checkout_url; return;
      }
      setServerError("Δεν ξεκίνησε η ανανέωση. Δοκιμάστε ξανά."); setRenew({ ...renew, busy: false });
    } catch { setServerError("Η ανανέωση απέτυχε. Δοκιμάστε ξανά."); setRenew({ ...renew, busy: false }); }
  }

  // Admin impersonation hand-off: #imp=<access>~<refresh> → store & enter the app.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = window.location.hash;
    if (!h.startsWith("#imp=")) return;
    const [access, refresh] = decodeURIComponent(h.slice(5)).split("~");
    if (access && refresh) {
      window.localStorage.setItem("access_token", access);
      window.localStorage.setItem("refresh_token", refresh);
      window.location.hash = "";
      router.replace("/dashboard");
    }
  }, [router]);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof FormValues;
        setError(field, { message: issue.message });
      }
      return;
    }

    try {
      const res = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem("access_token", res.access_token);
        window.localStorage.setItem("refresh_token", res.refresh_token);
      }
      router.push("/dashboard");
    } catch (e) {
      const detail = (e instanceof ApiError ? (e.problem as { detail?: { error?: string; seats?: number; reason?: string; renew_token?: string; current_plan?: string; current_plan_name?: string } })?.detail : null) || {};
      if (e instanceof ApiError && e.status === 403 && detail.error === "seat_limit") {
        setServerError(
          `Συμπληρώθηκε το όριο ταυτόχρονων χρηστών${detail.seats ? ` (${detail.seats})` : ""} της συνδρομής σας. ` +
          "Αποσυνδεθείτε από άλλη συσκευή ή αναβαθμίστε τις θέσεις χρηστών."
        );
      } else if (e instanceof ApiError && e.status === 403 && detail.error === "access_blocked" && detail.reason === "expired" && detail.renew_token) {
        // ΛΗΓΜΕΝΗ συνδρομή → οθόνη ανανέωσης (διάλεξε πακέτο & πλήρωσε)
        try {
          const cfg = await api<{ packages: RenewPkg[] }>("/onboarding/packages");
          const paid = (cfg.packages || []).filter((p) => (p.price_monthly || 0) > 0 || (p.price_yearly || 0) > 0);
          const hasYearly = paid.some((p) => (p.billing_cycles ? p.billing_cycles.includes("yearly") : (p.price_yearly || 0) > 0));
          const preferred = paid.find((p) => p._id === detail.current_plan) || paid[0];   // preselect το τρέχον
          setRenew({ token: detail.renew_token, pkgs: paid, choice: preferred?._id || "", yearly: hasYearly, busy: false,
                     currentPlan: detail.current_plan, currentPlanName: detail.current_plan_name });
        } catch {
          setRenew({ token: detail.renew_token, pkgs: [], choice: "", yearly: true, busy: false });
        }
      } else if (e instanceof ApiError && e.status === 403 && detail.error === "access_blocked") {
        setServerError(
          "Ο λογαριασμός σας είναι σε αναστολή. Επικοινωνήστε μαζί μας."
        );
      } else {
        setServerError(
          e instanceof ApiError && e.status === 401
            ? "Λάθος email ή κωδικός."
            : "Η σύνδεση απέτυχε. Δοκιμάστε ξανά."
        );
      }
    }
  }

  if (renew) {
    const cyc = (p?: RenewPkg) => (p?.billing_cycles && p.billing_cycles.length ? p.billing_cycles : ["yearly"]);
    const hasMonthly = renew.pkgs.some((p) => cyc(p).includes("monthly") && (p.price_monthly || 0) > 0);
    const hasYearly = renew.pkgs.some((p) => cyc(p).includes("yearly"));
    const yearly = hasYearly ? renew.yearly : false;      // αν δεν υπάρχει ετήσια, δείξε μηνιαία
    const per = yearly ? "έτος" : "μήνα";
    const sel = renew.pkgs.find((x) => x._id === renew.choice);
    const price = yearly ? sel?.price_yearly : sel?.price_monthly;
    const curPkg = renew.pkgs.find((x) => x._id === renew.currentPlan);
    const curMods = new Set(curPkg?.modules || []);
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex justify-center"><Logo markClassName="h-10 w-10" subtitle={false} /></div>
        <h1 className="mb-1 text-lg font-bold text-slate-900">Η συνδρομή σου έληξε</h1>
        <p className="mb-3 text-sm text-slate-500">Διάλεξε πακέτο και ανανέωσε για να συνεχίσεις. Ο κωδικός σου παραμένει ο ίδιος.</p>
        {renew.currentPlan && (
          <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Το πακέτο σου μέχρι τώρα: <b>{renew.currentPlanName || curPkg?.name || renew.currentPlan}</b></div>
        )}
        {hasMonthly && hasYearly && (
          <div className="mb-3 inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
            <button type="button" onClick={() => setRenew({ ...renew, yearly: true })} className={`rounded-md px-3 py-1.5 font-medium ${yearly ? "bg-white text-brand-700 shadow-sm" : "text-slate-500"}`}>Ετήσια</button>
            <button type="button" onClick={() => setRenew({ ...renew, yearly: false })} className={`rounded-md px-3 py-1.5 font-medium ${!yearly ? "bg-white text-brand-700 shadow-sm" : "text-slate-500"}`}>Μηνιαία</button>
          </div>
        )}
        <div className="space-y-2">
          {renew.pkgs.map((pk) => {
            const pr = yearly ? pk.price_yearly : pk.price_monthly;
            const active = renew.choice === pk._id;
            const isCur = pk._id === renew.currentPlan;
            return (
              <button key={pk._id} type="button" onClick={() => setRenew({ ...renew, choice: pk._id })} className={`flex w-full items-center justify-between rounded-xl border-2 p-3 text-left ${active ? "border-brand-400 bg-brand-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                <span className="flex items-center gap-2 font-medium text-slate-800">{pk.name || pk._id}{isCur && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">τρέχον</span>}<span className="text-[11px] font-normal text-slate-400">{(pk.modules?.length || 0)} δυνατότητες · έως {pk.seats || 1} χρήστες</span></span>
                <span className="shrink-0 text-sm font-bold text-brand-700">{eur(pr)}<span className="text-[10px] font-normal text-slate-400">/{per}</span></span>
              </button>
            );
          })}
          {renew.pkgs.length === 0 && <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">Δεν φορτώθηκαν πακέτα — δοκίμασε ανανέωση σελίδας.</div>}
        </div>
        {sel && (
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="mb-1.5 text-xs font-semibold text-slate-600">Τι περιλαμβάνει το «{sel.name || sel._id}»:</div>
            <div className="flex flex-wrap gap-1.5">
              {(sel.modules || []).map((m) => {
                const isNew = renew.currentPlan && !curMods.has(m);
                return <span key={m} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isNew ? "bg-emerald-100 text-emerald-700" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{isNew ? "＋ " : ""}{modLabel(m)}</span>;
              })}
            </div>
            {renew.currentPlan && sel._id !== renew.currentPlan && (sel.modules || []).some((m) => !curMods.has(m)) && (
              <div className="mt-2 text-[11px] text-emerald-700">＋ = επιπλέον σε σχέση με το προηγούμενο πακέτο σου</div>
            )}
          </div>
        )}
        {serverError && <div role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{serverError}</div>}
        <button type="button" disabled={!renew.choice || renew.busy} onClick={startRenewal} className="mt-4 w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{renew.busy ? "Άνοιγμα πληρωμής…" : `Πλήρωσε ${eur(price)} & Ανανέωσε`}</button>
        <button type="button" onClick={() => { setRenew(null); setServerError(null); }} className="mt-2 w-full text-center text-xs text-slate-400 hover:text-slate-600">← Πίσω στη σύνδεση</button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex justify-center">
        <Logo markClassName="h-10 w-10" subtitle={false} />
      </div>
      <h1 className="mb-1 text-lg font-bold text-slate-900">Σύνδεση</h1>
      <p className="mb-5 text-sm text-slate-500">Στατιστική ανάλυση εκτελέσεων συνταγών</p>

      {notice && <div className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div>
          <label className="mb-1 block text-sm text-slate-600">Email</label>
          <input
            type="email"
            autoComplete="email"
            {...register("email")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          />
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-600">Κωδικός</label>
          <input
            type="password"
            autoComplete="current-password"
            {...register("password")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          />
          {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>}
        </div>

        {serverError && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{serverError}</div>
        )}

        <div className="text-right">
          <a href="/forgot-password" className="text-sm text-brand-600 hover:underline">
            Ξέχασα τον κωδικό;
          </a>
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {isSubmitting ? "Σύνδεση…" : "Σύνδεση"}
        </button>
      </form>

      <div className="mt-4 space-y-1 text-center text-sm text-slate-500">
        <div>
          <a href="/register" className="text-brand-600 hover:underline">
            Νέο φαρμακείο; Εγγραφή
          </a>
        </div>
      </div>
    </div>
  );
}
