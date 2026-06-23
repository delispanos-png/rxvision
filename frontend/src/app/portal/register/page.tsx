"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pill } from "lucide-react";
import { patientAuth, patientTokens, ApiError } from "@/lib/patientClient";

type Session = { access_token: string | null; refresh_token: string; pharmacies: { pharmacy_name: string }[] };

export default function PortalRegister() {
  const router = useRouter();
  const [f, setF] = useState({ first_name: "", last_name: "", email: "", phone: "", amka: "", password: "" });
  const [ph, setPh] = useState<string | null>(null);   // «αγαπημένο» φαρμακείο από QR πάγκου (?ph=)
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    try { const p = new URLSearchParams(window.location.search).get("ph"); if (p) setPh(p); } catch { /* ignore */ }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const s = await patientAuth<Session>("/patient/auth/register", { ...f, pharmacy: ph || undefined });
      patientTokens.set(s.access_token, s.refresh_token);
      router.replace("/portal");
    } catch (e) {
      const code = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : "";
      setErr(code === "email_exists" ? "Υπάρχει ήδη λογαριασμός με αυτό το email."
        : code === "amka_exists" ? "Υπάρχει ήδη λογαριασμός με αυτό το ΑΜΚΑ."
        : "Κάτι πήγε στραβά. Έλεγξε τα στοιχεία.");
    } finally {
      setBusy(false);
    }
  }

  const inp = "w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
        <div className="text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-500/30"><Pill className="h-6 w-6" /></span>
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Δημιουργία λογαριασμού</h1>
          <p className="mt-1 text-sm text-slate-500">Δες τις συνταγές σου & κλείσε ραντεβού στο φαρμακείο σου</p>
        </div>
        {ph && <div className="rounded-xl bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-700">📍 Εγγραφή με το φαρμακείο σου ως αγαπημένο</div>}
        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input required placeholder="Όνομα" value={f.first_name} onChange={set("first_name")} className={inp} />
          <input required placeholder="Επώνυμο" value={f.last_name} onChange={set("last_name")} className={inp} />
        </div>
        <input type="email" required placeholder="Email" value={f.email} onChange={set("email")} className={inp} />
        <input required placeholder="Τηλέφωνο" value={f.phone} onChange={set("phone")} className={inp} />
        <input required placeholder="ΑΜΚΑ" value={f.amka} onChange={set("amka")} className={inp} />
        <input type="password" required minLength={8} placeholder="Κωδικός (8+ χαρακτήρες)" value={f.password} onChange={set("password")} className={inp} />
        <p className="rounded-xl bg-brand-50 px-3 py-2 text-[11px] text-brand-600">🔒 Το ΑΜΚΑ συνδέει αυτόματα τις συνταγές σου από όλα τα φαρμακεία του δικτύου όπου εξυπηρετείσαι.</p>
        <button type="submit" disabled={busy} className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
          {busy ? "Εγγραφή…" : "Δημιουργία λογαριασμού"}
        </button>
        <p className="text-center text-sm text-slate-500">
          Έχεις ήδη λογαριασμό; <Link href="/portal/login" className="font-semibold text-brand-600 hover:underline">Σύνδεση</Link>
        </p>
      </form>
    </div>
  );
}
