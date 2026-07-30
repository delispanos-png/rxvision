"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/apiClient";
import { Logo } from "@/components/brand/Logo";
import { PoweredBy } from "@/components/brand/PoweredBy";
import { Loader2, Check } from "lucide-react";

type Form = {
  strong_points: string; weak_points: string; would_choose: string; pricing_view: string;
  churn_reason: string; most_useful: string; missing: string; nps: number | null;
  competitor: string; contact_ok: boolean; contact_phone: string;
};
const EMPTY: Form = { strong_points: "", weak_points: "", would_choose: "", pricing_view: "",
  churn_reason: "", most_useful: "", missing: "", nps: null, competitor: "", contact_ok: false, contact_phone: "" };

const ta = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-400";
const lbl = "mb-1 block text-sm font-medium text-slate-700";

export default function FeedbackPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [state, setState] = useState<"loading" | "ready" | "done" | "invalid">("loading");
  const [pharmacy, setPharmacy] = useState<string>("");
  const [f, setF] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ pharmacy_name?: string; status?: string }>(`/feedback/${token}`)
      .then((r) => { setPharmacy(r.pharmacy_name || ""); setState(r.status === "submitted" ? "done" : "ready"); })
      .catch(() => setState("invalid"));
  }, [token]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api(`/feedback/${token}`, { method: "POST", body: JSON.stringify({ ...f, nps: f.nps ?? undefined }) });
      setState("done");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? "Η αξιολόγηση έχει ήδη υποβληθεί." : "Κάτι πήγε στραβά. Δοκίμασε ξανά.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex justify-center"><Logo markClassName="h-9 w-9" /></div>

        {state === "loading" && <div className="grid place-items-center py-20"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>}

        {state === "invalid" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-lg font-bold text-slate-900">Ο σύνδεσμος δεν είναι έγκυρος</h1>
            <p className="mt-2 text-sm text-slate-500">Ο σύνδεσμος αξιολόγησης έληξε ή δεν υπάρχει.</p>
          </div>
        )}

        {state === "done" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <Check className="mx-auto h-10 w-10 text-emerald-600" />
            <h1 className="mt-3 text-lg font-bold text-slate-900">Ευχαριστούμε πολύ! 🙏</h1>
            <p className="mt-2 text-sm text-slate-500">Η γνώμη σου μας βοηθά να κάνουμε το RxVision καλύτερο για τα φαρμακεία.</p>
          </div>
        )}

        {state === "ready" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-xl font-bold text-slate-900">Η γνώμη σου μετράει</h1>
            <p className="mt-1 text-sm text-slate-500">{pharmacy ? <>Γεια σου <b>{pharmacy}</b> — δοκίμασες</> : "Δοκίμασες"} το RxVision. Πες μας ειλικρινά τη γνώμη σου (2 λεπτά).</p>

            <div className="mt-5 space-y-4">
              <div><label className={lbl}>Δυνατά σημεία που βρήκες</label><textarea rows={2} className={ta} value={f.strong_points} onChange={(e) => set("strong_points", e.target.value)} /></div>
              <div><label className={lbl}>Αδύνατα σημεία που βρήκες</label><textarea rows={2} className={ta} value={f.weak_points} onChange={(e) => set("weak_points", e.target.value)} /></div>
              <div><label className={lbl}>Τι θα σε έκανε να επιλέξεις το πρόγραμμα;</label><textarea rows={2} className={ta} value={f.would_choose} onChange={(e) => set("would_choose", e.target.value)} /></div>
              <div><label className={lbl}>Ο κύριος λόγος που δεν ανανέωσες;</label><textarea rows={2} className={ta} value={f.churn_reason} onChange={(e) => set("churn_reason", e.target.value)} /></div>
              <div>
                <label className={lbl}>Πώς βλέπεις το κόστος/τιμή;</label>
                <select className={ta} value={f.pricing_view} onChange={(e) => set("pricing_view", e.target.value)}>
                  <option value="">— επίλεξε —</option>
                  <option>Πολύ ακριβό</option><option>Λίγο ακριβό</option><option>Λογικό</option>
                  <option>Καλή σχέση αξίας/τιμής</option><option>Φθηνό</option>
                </select>
              </div>
              <div><label className={lbl}>Ποια δυνατότητα σου φάνηκε πιο χρήσιμη;</label><input className={ta} value={f.most_useful} onChange={(e) => set("most_useful", e.target.value)} /></div>
              <div><label className={lbl}>Τι έλειπε / τι θα πρόσθετες;</label><textarea rows={2} className={ta} value={f.missing} onChange={(e) => set("missing", e.target.value)} /></div>
              <div>
                <label className={lbl}>Πόσο πιθανό να το πρότεινες σε συνάδελφο; (0–10)</label>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: 11 }, (_, i) => (
                    <button key={i} type="button" onClick={() => set("nps", i)} className={`h-9 w-9 rounded-lg border text-sm font-medium ${f.nps === i ? "border-brand-500 bg-brand-600 text-white" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{i}</button>
                  ))}
                </div>
              </div>
              <div><label className={lbl}>Χρησιμοποιείς άλλο εργαλείο; (ποιο)</label><input className={ta} value={f.competitor} onChange={(e) => set("competitor", e.target.value)} /></div>
              <div className="rounded-lg bg-slate-50 p-3">
                <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={f.contact_ok} onChange={(e) => set("contact_ok", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600" /> Θέλω να επικοινωνήσετε μαζί μου</label>
                {f.contact_ok && <input className={`${ta} mt-2`} placeholder="Τηλέφωνο" value={f.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} />}
              </div>
              {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
              <button type="button" disabled={busy} onClick={submit} className="w-full rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? "Αποστολή…" : "Υποβολή αξιολόγησης"}</button>
            </div>
          </div>
        )}

        <div className="mt-8"><PoweredBy /></div>
      </div>
    </div>
  );
}
