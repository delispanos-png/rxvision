"use client";

import { useState } from "react";
import Link from "next/link";
import { Pill, Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import { patientAuth } from "@/lib/patientClient";
import { useT } from "@/store/prefStore";

export default function PortalForgotPassword() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    // Ασφάλεια: πάντα δείχνουμε επιτυχία (δεν αποκαλύπτουμε αν το email υπάρχει).
    try { await patientAuth("/patient/auth/forgot-password", { email }); } catch { /* ignore */ }
    setDone(true); setBusy(false);
  }

  return (
    <div className="h-full overflow-y-auto"><div className="flex min-h-full items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
        <div className="text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-500/30"><Pill className="h-6 w-6" /></span>
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{t("Ανάκτηση κωδικού", "Reset password")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Θα σου στείλουμε σύνδεσμο για νέο κωδικό", "We'll send you a link to set a new password")}</p>
        </div>

        {done ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>{t("Αν το email αντιστοιχεί σε λογαριασμό, στείλαμε σύνδεσμο για ορισμό νέου κωδικού. Έλεγξε το email (και τα ανεπιθύμητα). Ο σύνδεσμος λήγει σε 7 ημέρες.", "If the email matches an account, we've sent a link to set a new password. Check your inbox (and spam). The link expires in 7 days.")}</span>
            </div>
            <Link href="/portal/login" className="flex items-center justify-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">
              <ArrowLeft className="h-4 w-4" /> {t("Επιστροφή στη σύνδεση", "Back to sign in")}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input type="email" required autoFocus placeholder={t("Το email σου", "Your email")} value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
            </div>
            <button type="submit" disabled={busy}
              className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
              {busy ? t("Αποστολή…", "Sending…") : t("Στείλε σύνδεσμο ανάκτησης", "Send reset link")}
            </button>
            <Link href="/portal/login" className="flex items-center justify-center gap-1.5 text-sm font-medium text-slate-500 hover:text-brand-600 hover:underline">
              <ArrowLeft className="h-4 w-4" /> {t("Επιστροφή στη σύνδεση", "Back to sign in")}
            </Link>
          </form>
        )}
      </div>
    </div></div>
  );
}
