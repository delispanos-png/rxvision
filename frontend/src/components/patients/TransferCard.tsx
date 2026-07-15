"use client";

// Μεταφορά πελάτη ΣΕ ΕΜΑΣ (αίτημα με ΑΜΚΑ + υποχρεωτική αιτιολογία → εγκρίνει ο πελάτης)
// + Ενημερώσεις ότι δικός μας πελάτης άλλαξε φαρμακείο εξυπηρέτησης.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Bell, Check, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { PanelCard } from "@/components/ui/Card";

type Reason = { value: string; label: string };
type Notice = { id: string; patient_ref: string; patient_name: string; amka?: string | null; reason_label: string; note?: string | null; at: string; read: boolean };
type Req = { _id: string; to_pharmacy_name: string; status: string; reason?: string; note?: string | null; created_at: string };

const ST: Record<string, string> = { pending: "Αναμονή έγκρισης πελάτη", accepted: "Εγκρίθηκε", declined: "Απορρίφθηκε", expired: "Έληξε" };
const ERR: Record<string, string> = {
  no_portal_account: "Ο πελάτης δεν έχει λογαριασμό στην πύλη — δεν μπορεί να δώσει έγκριση. Κάνε τον πρώτα εγγραφή.",
  already_linked: "Ο πελάτης είναι ήδη συνδεδεμένος με το φαρμακείο σου.",
  already_pending: "Υπάρχει ήδη εκκρεμές αίτημα για αυτόν τον πελάτη.",
};

export function TransferRequestCard() {
  const t = useT();
  const qc = useQueryClient();
  const [amka, setAmka] = useState("");
  const [reason, setReason] = useState("customer_choice");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reasons = useQuery({ queryKey: ["transfer-reasons"], queryFn: () => api<{ items: Reason[] }>("/patients/transfer-reasons"), staleTime: 3600_000 });
  const reqs = useQuery({ queryKey: ["transfer-requests"], queryFn: () => api<{ items: Req[] }>("/patients/transfer-requests") });

  const send = useMutation({
    mutationFn: () => api("/patients/transfer-request", { method: "POST", body: JSON.stringify({ amka: amka.trim(), reason, note: note.trim() || null }) }),
    onSuccess: () => {
      setMsg({ ok: true, text: "Στάλθηκε! Ο πελάτης θα το εγκρίνει από την πύλη του." });
      setAmka(""); setNote("");
      qc.invalidateQueries({ queryKey: ["transfer-requests"] });
    },
    onError: (e: unknown) => {
      // FastAPI: HTTPException(detail={"error": ...}) → problem.detail.error
      const p = (e as ApiError)?.problem as { detail?: { error?: string } } | undefined;
      const code = p?.detail?.error ?? "";
      setMsg({ ok: false, text: ERR[code] ?? "Δεν ήταν δυνατή η αποστολή του αιτήματος." });
    },
  });
  return (
    <PanelCard title={t("Μεταφορά πελάτη σε εμάς", "Transfer a customer to us")}>
        <p className="mb-3 text-xs text-slate-500">
          {t("Βάλε το ΑΜΚΑ του πελάτη — θα λάβει αίτημα στην πύλη του και θα το εγκρίνει. Μεταφέρονται πρόγραμμα λήψης, μετρήσεις & στοιχεία επικοινωνίας. Οι εκτελέσεις ΔΕΝ μεταφέρονται (μένουν στο φαρμακείο όπου έγιναν)· δικές μας παλιότερες εκτελέσεις του ίδιου ΑΜΚΑ ταυτίζονται αυτόματα.",
            "Enter the customer's ΑΜΚΑ — they approve it in their portal.")}
        </p>
        <div className="space-y-2.5">
          <label className="block text-sm">
            <span className="mb-1 block text-slate-600">ΑΜΚΑ</span>
            <input value={amka} onChange={(e) => { setAmka(e.target.value.replace(/\D/g, "").slice(0, 11)); setMsg(null); }}
              inputMode="numeric" placeholder="11 ψηφία" className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-600">{t("Αιτιολογία", "Reason")} <span className="text-rose-500">*</span></span>
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {(reasons.data?.items ?? []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-600">{t("Σχόλιο (προαιρετικό)", "Note (optional)")}</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="π.χ. μένει πλέον δίπλα μας"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            ⚠️ Η αιτιολογία <b>κοινοποιείται στον πελάτη</b> (τη βλέπει πριν εγκρίνει) και στο <b>προηγούμενο φαρμακείο</b> του.
          </p>
          {msg && <div className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}
          <button onClick={() => { setMsg(null); send.mutate(); }} disabled={amka.length !== 11 || send.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {t("Αποστολή αιτήματος", "Send request")}
          </button>
        </div>

        {(reqs.data?.items ?? []).length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="mb-2 text-xs font-semibold text-slate-500">{t("Αιτήματά μου", "My requests")}</div>
            <div className="space-y-1.5">
              {(reqs.data?.items ?? []).slice(0, 8).map((r) => (
                <div key={r._id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
                  <span className="text-slate-500">{new Date(r.created_at).toLocaleDateString("el-GR")}</span>
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${r.status === "accepted" ? "bg-emerald-100 text-emerald-700" : r.status === "pending" ? "bg-amber-100 text-amber-700" : "bg-slate-200 text-slate-600"}`}>{ST[r.status] ?? r.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </PanelCard>
  );
}


// ── Ενημερώσεις: ΔΙΚΟΣ ΜΑΣ πελάτης άλλαξε φαρμακείο εξυπηρέτησης ─────────────────────────
export function TransferNoticesCard() {
  const t = useT();
  const qc = useQueryClient();
  const notices = useQuery({ queryKey: ["transfer-notices"], queryFn: () => api<{ items: Notice[] }>("/patients/transfer-notices") });
  const markRead = useMutation({
    mutationFn: (id: string) => api(`/patients/transfer-notices/${id}/read`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["transfer-notices"] }),
  });
  const ns = notices.data?.items ?? [];
  const unread = ns.filter((n) => !n.read);

  return (
    <PanelCard title={`${t("Πελάτες που άλλαξαν φαρμακείο", "Customers who switched")}${unread.length ? ` (${unread.length} νέα)` : ""}`}>
      {ns.length === 0
        ? <p className="text-sm text-slate-400">{t("Καμία ενημέρωση.", "No notices.")}</p>
        : (
          <div className="space-y-2">
            {ns.map((n) => (
              <div key={n.id} className={`rounded-xl border p-3 ${n.read ? "border-slate-200 bg-white" : "border-amber-200 bg-amber-50/60"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {!n.read && <Bell className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
                      <span className="truncate text-sm font-semibold text-slate-800">{n.patient_name || "—"}</span>
                    </div>
                    {n.amka && <div className="mt-0.5 font-mono text-[11px] text-slate-500">ΑΜΚΑ {n.amka}</div>}
                    <div className="mt-1 text-xs text-slate-600">
                      Άλλαξε φαρμακείο εξυπηρέτησης · <b>{n.reason_label}</b>{n.note ? ` — «${n.note}»` : ""}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{new Date(n.at).toLocaleString("el-GR")}</div>
                  </div>
                  {!n.read && (
                    <button onClick={() => markRead.mutate(n.id)} title="Σήμανση ως διαβασμένο"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50">
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      <p className="mt-2 text-[11px] text-slate-400">
        {t("Ο πελάτης παραμένει ενεργός σε εσένα και το ιστορικό του μένει — απλά τον εξυπηρετεί πλέον άλλο φαρμακείο.",
          "The customer stays active with you and their history remains.")}
      </p>
    </PanelCard>
  );
}
