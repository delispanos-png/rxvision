"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Pill, Lock } from "lucide-react";
import { patientApi, patientAuth, patientTokens, ApiError } from "@/lib/patientClient";

type Session = { access_token: string | null; refresh_token: string };

function SetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");        // link flow· χωρίς token = υποχρεωτική αλλαγή στο 1ο login

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // self flow (χωρίς token): χρειάζεται ενεργή σύνδεση· αλλιώς στείλε στο login
  const selfMode = !token;
  if (selfMode && typeof window !== "undefined" && !patientTokens.access) {
    router.replace("/portal/login");
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (password.length < 8) { setErr("Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες."); return; }
    if (password !== confirm) { setErr("Οι κωδικοί δεν ταιριάζουν."); return; }
    setBusy(true);
    try {
      const s = token
        ? await patientAuth<Session>("/patient/auth/set-password", { token, password })
        : await patientApi<Session>("/patient/auth/set-password/self",
            { method: "POST", body: JSON.stringify({ password }) });
      patientTokens.set(s.access_token, s.refresh_token);
      router.replace("/portal");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      if (code === "invalid_or_expired_token") setErr("Ο σύνδεσμος έληξε ή δεν είναι έγκυρος — ζήτησε νέον από το φαρμακείο.");
      else setErr("Κάτι πήγε στραβά. Δοκίμασε ξανά.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto"><div className="flex min-h-full items-center justify-center px-4 py-8">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
        <div className="text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-500/30"><Pill className="h-6 w-6" /></span>
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Όρισε τον κωδικό σου</h1>
          <p className="mt-1 text-sm text-slate-500">{selfMode ? "Επίλεξε έναν δικό σου κωδικό για την Πύλη Πελατών." : "Καλώς ήρθες! Όρισε τον κωδικό πρόσβασής σου."}</p>
        </div>
        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="password" required minLength={8} placeholder="Νέος κωδικός" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </div>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="password" required minLength={8} placeholder="Επιβεβαίωση κωδικού" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </div>
        <button type="submit" disabled={busy}
          className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
          {busy ? "Αποθήκευση…" : "Αποθήκευση & Σύνδεση"}
        </button>
      </form>
    </div></div>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-slate-400">Φόρτωση…</div>}>
      <SetPasswordForm />
    </Suspense>
  );
}
