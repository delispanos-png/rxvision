"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminTokens } from "@/lib/adminClient";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/platform/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError("Λάθος στοιχεία ή χωρίς δικαίωμα platform admin.");
        return;
      }
      const d = (await res.json()) as { access_token: string; refresh_token: string };
      adminTokens.set(d.access_token, d.refresh_token);
      router.replace("/admin");
    } catch {
      setError("Σφάλμα σύνδεσης.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-6 flex items-center gap-2 font-semibold text-slate-900">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-indigo-500 text-sm font-bold text-white">Cl</span>
          CloudOn <span className="text-slate-400">· Console</span>
        </div>
        <h1 className="mb-1 text-lg font-bold text-slate-900">Σύνδεση διαχειριστή πλατφόρμας</h1>
        <p className="mb-6 text-sm text-slate-500">Πρόσβαση μόνο για CloudOn — όχι για φαρμακεία.</p>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-slate-600">Email</span>
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="mb-5 block text-sm">
          <span className="mb-1 block text-slate-600">Κωδικός</span>
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <button
          type="submit" disabled={busy}
          className="w-full rounded-lg bg-indigo-600 py-2.5 font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? "Σύνδεση…" : "Σύνδεση"}
        </button>
      </form>
    </div>
  );
}
