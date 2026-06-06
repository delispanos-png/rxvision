"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/apiClient";

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-bold text-slate-900">Επαναφορά κωδικού</h1>
        <div className="mt-4 rounded-lg bg-rose-50 px-3 py-3 text-sm text-rose-700">
          Μη έγκυρος σύνδεσμος.
        </div>
        <div className="mt-4 text-center text-sm text-slate-500">
          <a href="/forgot-password" className="text-teal-700 hover:underline">
            Ζητήστε νέον σύνδεσμο
          </a>
        </div>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError("Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Οι κωδικοί δεν ταιριάζουν.");
      return;
    }
    setSubmitting(true);
    try {
      await api<{ ok: boolean }>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, new_password: newPassword }),
      });
      setDone(true);
      setTimeout(() => router.push("/login"), 1500);
    } catch (err) {
      const detail = err instanceof ApiError ? (err.problem as any)?.detail : null;
      const code = detail?.error;
      if (code === "invalid_or_expired_token")
        setError("Ο σύνδεσμος έληξε ή δεν είναι έγκυρος — ζητήστε νέον.");
      else if (code === "weak_password") setError("Ο κωδικός είναι πολύ αδύναμος.");
      else setError("Η επαναφορά απέτυχε. Δοκιμάστε ξανά.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-bold text-slate-900">Νέος κωδικός</h1>
      <p className="mb-5 text-sm text-slate-500">Επιλέξτε έναν νέο κωδικό για τον λογαριασμό σας.</p>

      {done ? (
        <div className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-700">
          Ο κωδικός άλλαξε ✓ — ανακατεύθυνση στη σύνδεση…
        </div>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <div>
            <label className="mb-1 block text-sm text-slate-600">Νέος κωδικός</label>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-teal-600 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-600">Επιβεβαίωση κωδικού</label>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-teal-600 focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {submitting ? "Αποθήκευση…" : "Αλλαγή κωδικού"}
          </button>
        </form>
      )}

      <div className="mt-4 text-center text-sm text-slate-500">
        <a href="/login" className="text-teal-700 hover:underline">
          Επιστροφή στη σύνδεση
        </a>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
