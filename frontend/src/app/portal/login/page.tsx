"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pill, Mail, Lock, ShieldCheck } from "lucide-react";
import { patientAuth, patientTokens, ApiError } from "@/lib/patientClient";
import { useT } from "@/store/prefStore";

type Session = { access_token?: string | null; refresh_token?: string; active_tenant?: string | null; must_change_password?: boolean; twofa_required?: boolean; error?: string };

export default function PortalLogin() {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [need2fa, setNeed2fa] = useState(false);
  const [totp, setTotp] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const s = await patientAuth<Session>("/patient/auth/login",
        { email, password, ...(need2fa ? { totp } : {}) });
      if (s.twofa_required) {
        setNeed2fa(true);
        if (s.error === "wrong_code") setErr(t("Λάθος κωδικός επαλήθευσης.", "Wrong verification code."));
        setBusy(false);
        return;
      }
      patientTokens.set(s.access_token ?? null, s.refresh_token ?? "");
      router.replace(s.must_change_password ? "/portal/set-password" : "/portal");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? t("Λάθος email ή κωδικός.", "Wrong email or password.") : t("Κάτι πήγε στραβά.", "Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto"><div className="flex min-h-full items-center justify-center px-4 py-8">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
        <div className="text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-500/30"><Pill className="h-6 w-6" /></span>
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{t("Καλώς ήρθες", "Welcome")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Σύνδεση στην Πύλη Πελατών RxVision", "Sign in to the RxVision Customer Portal")}</p>
        </div>
        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </div>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="password" required placeholder={t("Κωδικός", "Password")} value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </div>
        {need2fa && (
          <div className="relative">
            <ShieldCheck className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input inputMode="numeric" autoFocus required placeholder={t("Κωδικός επαλήθευσης (2FA)", "Verification code (2FA)")} value={totp} onChange={(e) => setTotp(e.target.value)}
              className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
            <p className="mt-1 text-[11px] text-slate-400">{t("Από την εφαρμογή authenticator — ή εφεδρικός κωδικός.", "From your authenticator app — or a backup code.")}</p>
          </div>
        )}
        <button type="submit" disabled={busy}
          className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
          {busy ? t("Σύνδεση…", "Signing in…") : need2fa ? t("Επαλήθευση & Σύνδεση", "Verify & sign in") : t("Σύνδεση", "Sign in")}
        </button>
        <p className="text-center text-sm">
          <Link href="/portal/forgot-password" className="font-medium text-slate-500 hover:text-brand-600 hover:underline">{t("Ξέχασες τον κωδικό σου;", "Forgot your password?")}</Link>
        </p>
        <p className="text-center text-sm text-slate-500">
          {t("Δεν έχεις λογαριασμό;", "Don't have an account?")} <Link href="/portal/register" className="font-semibold text-brand-600 hover:underline">{t("Εγγραφή", "Sign up")}</Link>
        </p>
      </form>
    </div></div>
  );
}
