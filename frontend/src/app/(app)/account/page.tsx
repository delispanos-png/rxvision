"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, User } from "lucide-react";
import { api, ApiError, queryKeys } from "@/lib/apiClient";
import { PanelCard } from "@/components/ui/Card";
import { useT } from "@/store/prefStore";

type Me = {
  user_id: string;
  tenant_id: string;
  roles?: string[];
  modules?: Record<string, unknown>;
  full_name?: string;
  email?: string;
  phone?: string;
  mfa_enabled?: boolean;
};

const inputCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

export default function AccountPage() {
  const t = useT();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false });

  // ---- Profile form ----
  const [profile, setProfile] = useState({ full_name: "", phone: "" });
  useEffect(() => {
    if (!me.data) return;
    setProfile({ full_name: me.data.full_name ?? "", phone: me.data.phone ?? "" });
  }, [me.data]);

  const saveProfile = useMutation({
    mutationFn: () =>
      api<Me>("/auth/profile", { method: "PATCH", body: JSON.stringify(profile) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.me() }),
  });

  // ---- Password form ----
  const [pwd, setPwd] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [pwdError, setPwdError] = useState<string | null>(null);

  const changePassword = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: pwd.current_password,
          new_password: pwd.new_password,
        }),
      }),
    onSuccess: () => {
      setPwdError(null);
      setPwd({ current_password: "", new_password: "", confirm_password: "" });
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? (e.problem as any)?.detail : null;
      const err = detail?.error;
      if (err === "wrong_current_password") setPwdError(t("Λάθος τρέχων κωδικός.", "Wrong current password."));
      else if (err === "weak_password") setPwdError(t("Ο νέος κωδικός είναι πολύ αδύναμος.", "The new password is too weak."));
      else setPwdError(t("Η αλλαγή κωδικού απέτυχε. Δοκιμάστε ξανά.", "Password change failed. Please try again."));
    },
  });

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwdError(null);
    if (pwd.new_password.length < 8) {
      setPwdError(t("Ο νέος κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.", "The new password must be at least 8 characters."));
      return;
    }
    if (pwd.new_password !== pwd.confirm_password) {
      setPwdError(t("Οι κωδικοί δεν ταιριάζουν.", "The passwords do not match."));
      return;
    }
    changePassword.mutate();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-slate-900">{t("Ο λογαριασμός μου", "My account")}</h1>

      {/* Στοιχεία λογαριασμού */}
      <PanelCard title={t("Στοιχεία λογαριασμού", "Account details")}>
        {me.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("Φόρτωση…", "Loading…")}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("Ονοματεπώνυμο", "Full name")}>
                <input
                  className={inputCls}
                  value={profile.full_name}
                  onChange={(e) => setProfile((s) => ({...s, full_name: e.target.value }))}
                />
              </Field>
              <Field label={t("Τηλέφωνο", "Phone")}>
                <input
                  className={inputCls}
                  value={profile.phone}
                  onChange={(e) => setProfile((s) => ({...s, phone: e.target.value }))}
                />
              </Field>
              <Field label="Email" hint={t("Το email δεν μπορεί να αλλάξει από εδώ.", "Email cannot be changed here.")}>
                <input
                  className={`${inputCls} bg-slate-50 text-slate-500`}
                  value={me.data?.email ?? ""}
                  disabled
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saveProfile.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
              >
                {saveProfile.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {t("Αποθήκευση", "Save")}
              </button>
              {saveProfile.isSuccess && <span className="text-sm text-emerald-600">{t("Αποθηκεύτηκε ✓", "Saved ✓")}</span>}
              {saveProfile.isError && <span className="text-sm text-rose-600">{t("Σφάλμα αποθήκευσης", "Save error")}</span>}
            </div>
          </form>
        )}
      </PanelCard>

      {/* Αλλαγή κωδικού */}
      <PanelCard title={t("Αλλαγή κωδικού", "Change password")}>
        <div id="password" className="-mt-24 pt-24" />
        <form onSubmit={submitPassword} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("Τρέχων κωδικός", "Current password")}>
              <input
                type="password"
                autoComplete="current-password"
                className={inputCls}
                value={pwd.current_password}
                onChange={(e) => setPwd((s) => ({...s, current_password: e.target.value }))}
              />
            </Field>
            <Field label={t("Νέος κωδικός", "New password")} hint={t("Τουλάχιστον 8 χαρακτήρες", "At least 8 characters")}>
              <input
                type="password"
                autoComplete="new-password"
                className={inputCls}
                value={pwd.new_password}
                onChange={(e) => setPwd((s) => ({...s, new_password: e.target.value }))}
              />
            </Field>
            <Field label={t("Επιβεβαίωση νέου κωδικού", "Confirm new password")}>
              <input
                type="password"
                autoComplete="new-password"
                className={inputCls}
                value={pwd.confirm_password}
                onChange={(e) => setPwd((s) => ({...s, confirm_password: e.target.value }))}
              />
            </Field>
          </div>

          {pwdError && (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{pwdError}</div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={changePassword.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
            >
              {changePassword.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {t("Αλλαγή κωδικού", "Change password")}
            </button>
            {changePassword.isSuccess && (
              <span className="text-sm text-emerald-600">
                {t("Ο κωδικός άλλαξε ✓ — οι άλλες συνεδρίες αποσυνδέθηκαν.", "Password changed ✓ — other sessions were signed out.")}
              </span>
            )}
          </div>
        </form>
      </PanelCard>

      {/* Ασφάλεια */}
      <PanelCard title={t("Ασφάλεια", "Security")}>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`grid h-10 w-10 place-items-center rounded-xl ${
              me.data?.mfa_enabled ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"
            }`}
          >
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="mr-auto">
            <div className="text-sm font-semibold text-slate-800">
              {t("Έλεγχος ταυτότητας δύο παραγόντων (MFA)", "Two-factor authentication (MFA)")}
            </div>
            <div className="text-xs text-slate-400">
              {me.data?.mfa_enabled ? t("Ενεργοποιημένο", "Enabled") : t("Ανενεργό", "Disabled")}
            </div>
          </div>
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-400"
          >
            <ShieldCheck className="h-4 w-4" /> {t("Ενεργοποίηση MFA (σύντομα)", "Enable MFA (soon)")}
          </button>
        </div>
      </PanelCard>
    </div>
  );
}
