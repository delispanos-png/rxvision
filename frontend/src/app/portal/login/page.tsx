"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pill, Mail, Lock } from "lucide-react";
import { patientAuth, patientTokens, ApiError } from "@/lib/patientClient";

type Session = { access_token: string | null; refresh_token: string; active_tenant: string | null };

export default function PortalLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const s = await patientAuth<Session>("/patient/auth/login", { email, password });
      patientTokens.set(s.access_token, s.refresh_token);
      router.replace("/portal");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? "Λάθος email ή κωδικός." : "Κάτι πήγε στραβά.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
        <div className="text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-500/30"><Pill className="h-6 w-6" /></span>
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Καλώς ήρθες πίσω</h1>
          <p className="mt-1 text-sm text-slate-500">Σύνδεση στην Πύλη Πελατών RxVision</p>
        </div>
        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </div>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="password" required placeholder="Κωδικός" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        </div>
        <button type="submit" disabled={busy}
          className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
          {busy ? "Σύνδεση…" : "Σύνδεση"}
        </button>
        <p className="text-center text-sm text-slate-500">
          Δεν έχεις λογαριασμό; <Link href="/portal/register" className="font-semibold text-brand-600 hover:underline">Εγγραφή</Link>
        </p>
      </form>
    </div>
  );
}
