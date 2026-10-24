"use client";

// «Νέος κωδικός ΗΔΥΚΑ» με ΕΝΑ κλικ από το SMS/email (24/10/2026) — χωρίς σύνδεση στο RxVision.
// Το token έρχεται στο #fragment (δεν φτάνει σε logs/Referer). Όλοι οι φραγμοί ασφαλείας ζουν στον
// server (`services/hdika_password_link.py`): μίας χρήσης, 48 ώρες, ≤3 προσπάθειες, δοκιμή στην ΗΔΥΚΑ.

import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";

type Check = { ok: boolean; pharmacy_name?: string; attempts_left?: number; error?: string };
type Submit = { ok: boolean; error?: string; attempts_left?: number };

export default function HdikaUpdatePage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<Check | null>(null);
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t");
    setToken(t);
    if (!t) { setInfo({ ok: false, error: "invalid_or_expired" }); return; }
    api<Check>("/hdika-link/check", { method: "POST", body: JSON.stringify({ token: t }) })
      .then(setInfo).catch(() => setInfo({ ok: false, error: "invalid_or_expired" }));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !pw.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<Submit>("/hdika-link/submit", { method: "POST", body: JSON.stringify({ token, password: pw }) });
      if (r.ok) { setDone(true); return; }
      if (r.error === "wrong_password")
        setMsg(r.attempts_left
          ? `Η ΗΔΥΚΑ δεν δέχτηκε τον κωδικό. Ελέγξτε τον και δοκιμάστε ξανά (απομένουν ${r.attempts_left}).`
          : "Η ΗΔΥΚΑ δεν δέχτηκε τον κωδικό. Για να μην κλειδωθεί ο λογαριασμός σας, ο σύνδεσμος έκλεισε — καταχωρίστε τον από τις Ρυθμίσεις του RxVision.");
      else if (r.error === "hdika_unavailable")
        setMsg("Η ΗΔΥΚΑ δεν απαντά αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγα λεπτά — η προσπάθεια δεν μετράει.");
      else setMsg("Ο σύνδεσμος έληξε ή χρησιμοποιήθηκε ήδη.");
      if (r.error === "wrong_password" && !r.attempts_left) setInfo({ ok: false, error: "invalid_or_expired" });
    } catch {
      setMsg("Κάτι πήγε στραβά. Δοκιμάστε ξανά.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-bold text-slate-900">Νέος κωδικός ΗΔΥΚΑ</h1>
      {info === null ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Έλεγχος συνδέσμου…</div>
      ) : done ? (
        <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
          ✓ Ο κωδικός καταχωρίστηκε. Ο συγχρονισμός με την ΗΔΥΚΑ ξαναρχίζει μέσα στα επόμενα λεπτά — δεν χρειάζεται τίποτε άλλο.
        </div>
      ) : !info.ok ? (
        <div className="mt-4 space-y-3 text-sm">
          <div className="rounded-lg bg-rose-50 px-3 py-3 text-rose-700">{msg ?? "Ο σύνδεσμος έληξε ή χρησιμοποιήθηκε ήδη."}</div>
          <a href="/settings/ingestion" className="block text-center text-brand-700 hover:underline">Καταχώριση από τις Ρυθμίσεις του RxVision</a>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">
            Φαρμακείο: <b>{info.pharmacy_name}</b>. Γράψτε τον <b>νέο</b> κωδικό σας στην ΗΔΥΚΑ για να ξαναρχίσει ο συγχρονισμός.
          </p>
          <div className="relative">
            <input type={show ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus
              autoComplete="off" placeholder="Νέος κωδικός ΗΔΥΚΑ"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 pr-10 text-sm" />
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Απόκρυψη" : "Εμφάνιση"}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600">
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {msg && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{msg}</div>}
          <button type="submit" disabled={busy || !pw.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Αποθήκευση
          </button>
          <p className="text-xs text-slate-400">
            Ο κωδικός ελέγχεται πρώτα στην ΗΔΥΚΑ και αποθηκεύεται κρυπτογραφημένος. Ο σύνδεσμος ισχύει 48 ώρες και μία φορά.
          </p>
        </form>
      )}
    </div>
  );
}
