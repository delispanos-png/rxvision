"use client";

import { useState } from "react";
import { api } from "@/lib/apiClient";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api<{ ok: boolean }>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    } catch {
      // Always show the same success message (no account enumeration).
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-bold text-slate-900">Επαναφορά κωδικού</h1>
      <p className="mb-5 text-sm text-slate-500">
        Δώστε το email σας και θα σας στείλουμε σύνδεσμο επαναφοράς.
      </p>

      {sent ? (
        <div className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-700">
          Αν υπάρχει λογαριασμός με αυτό το email, στάλθηκε σύνδεσμος επαναφοράς.
        </div>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <div>
            <label className="mb-1 block text-sm text-slate-600">Email</label>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {submitting ? "Αποστολή…" : "Αποστολή συνδέσμου"}
          </button>
        </form>
      )}

      <div className="mt-4 text-center text-sm text-slate-500">
        <a href="/login" className="text-brand-700 hover:underline">
          Επιστροφή στη σύνδεση
        </a>
      </div>
    </div>
  );
}
