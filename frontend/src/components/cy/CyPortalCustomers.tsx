"use client";

/* RxVision Κύπρος — «Πελάτες πύλης». Ίδια οθόνη με την Ελλάδα (δείκτες, πρόσκληση με email, ξεκλείδωμα,
   εγγεγραμμένοι με διαγραφή), με κυπριακή ταυτότητα: κωδικός δικαιούχου ΟΑΥ ή ταυτότητα/ARC αντί ΑΜΚΑ.
   Νέος άνθρωπος ΧΩΡΙΣ συνταγές γράφεται με όνομα + κωδικό ΟΑΥ και «κουμπώνει» στις μελλοντικές εκτελέσεις.
   Καμία αυτο-εγγραφή με QR (απόφαση ιδιοκτήτη 17/11/2026). Backend: services/cy/portal.py. */

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart, KeyRound, Loader2, Mail, Search, Send, Trash2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appConfirm } from "@/store/dialogStore";
import { toastError, toastSuccess } from "@/store/toastStore";
import { fmtDateTime } from "@/lib/formatters";

type Resp = { registered: number; total: number; to_invite: number; adoption_pct: number; contactable: number;
  registered_list: { name: string; account_id: string; patient_id: string; since?: string | null; no_dispensings?: boolean }[] };
type Found = { patient_ref: string; full_name: string | null; no_dispensings?: boolean };

const input = "min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800";

function Kpi({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint: string }) {
  return (
    <div className="rx-card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tint}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

const EMPTY = { email: "", hio_code: "", doc_type: "NID", doc_number: "", first_name: "", last_name: "", mobile: "" };

export function CyPortalCustomers() {
  const t = useT();
  const qc = useQueryClient();
  const { data: d } = useQuery({ queryKey: ["portal-customers"], queryFn: () => api<Resp>("/portal/portal-customers") });

  // ── πρόσκληση: υπάρχων πελάτης (αναζήτηση) ή κωδικός ΟΑΥ / ταυτότητα ή νέος ──
  const [inv, setInv] = useState(EMPTY);
  const [picked, setPicked] = useState<Found | null>(null);
  const [q, setQ] = useState("");
  const search = useQuery({ queryKey: ["cy", "portal-search", q], enabled: q.trim().length >= 2 && !picked,
    queryFn: () => api<{ items: Found[] }>(`/cy/patients?q=${encodeURIComponent(q.trim())}&limit=8`) });
  const ERR: Record<string, string> = {
    bad_email: t("Το email δεν είναι έγκυρο.", "Invalid email."),
    name_required: t("Δεν βρέθηκε πελάτης με αυτά τα στοιχεία — γράψε όνομα και επώνυμο για εγγραφή νέου.", "No customer found — enter first and last name to register a new one."),
    id_required: t("Γράψε κωδικό δικαιούχου ΟΑΥ ή αριθμό ταυτότητας/ARC.", "Enter the HIO beneficiary code or ID/ARC number."),
    id_mismatch: t("Η ταυτότητα δεν ταιριάζει με αυτή που έχει ο πελάτης στο ΓεΣΥ.", "The ID does not match the one on the GHS record."),
    already_invited: t("Ο πελάτης έχει ήδη λογαριασμό πύλης — χρησιμοποίησε το «Ξεκλείδωμα».", "Already has a portal account — use «Unlock»."),
    email_exists: t("Αυτό το email χρησιμοποιείται ήδη σε λογαριασμό πύλης.", "This email is already used by a portal account."),
    deceased: t("Ο πελάτης έχει σημειωθεί ότι απεβίωσε.", "The customer is marked as deceased."),
    email_failed: t("Ο λογαριασμός φτιάχτηκε αλλά το email δεν στάλθηκε — δοκίμασε το «Ξεκλείδωμα».", "Account created but the email failed — try «Unlock»."),
  };
  const invite = useMutation({
    mutationFn: () => api<{ ok: boolean; email?: string; error?: string }>("/portal/portal-customers/invite", { method: "POST",
      body: JSON.stringify({ email: inv.email, patient_id: picked?.patient_ref || undefined, hio_code: inv.hio_code || undefined,
        doc_type: inv.doc_number ? inv.doc_type : undefined, doc_number: inv.doc_number || undefined,
        first_name: inv.first_name || undefined, last_name: inv.last_name || undefined, mobile: inv.mobile || undefined }) }),
    onSuccess: (r) => {
      if (r.ok) {
        toastSuccess(t(`✓ Στάλθηκε πρόσκληση στο ${r.email} με τη διεύθυνση, το όνομα χρήστη και τον κωδικό.`, `✓ Invitation sent to ${r.email}.`));
        setInv(EMPTY); setPicked(null); setQ("");
        qc.invalidateQueries({ queryKey: ["portal-customers"] });
      } else toastError(ERR[r.error ?? ""] ?? t("Δεν ήταν δυνατή η πρόσκληση — δοκίμασε ξανά.", "Could not invite — try again."));
    },
    onError: () => toastError(t("Κάτι πήγε στραβά.", "Something went wrong.")),
  });

  // ── ξεκλείδωμα ──
  const [resendId, setResendId] = useState("");
  const resend = useMutation({
    mutationFn: (identifier: string) => api<{ ok: boolean; sent?: { type: string; hint: string }[]; error?: string }>(
      "/portal/portal-customers/resend-set-password", { method: "POST", body: JSON.stringify({ identifier }) }),
    onSuccess: (r) => {
      if (r.ok && r.sent?.length) {
        toastSuccess(t(`✓ Στάλθηκε σύνδεσμος κωδικού (${r.sent.map((s) => `${s.type === "email" ? "email" : "SMS"} ${s.hint}`).join(" + ")}).`, "✓ Password link sent."));
        setResendId("");
      } else toastError(r.error === "not_found" ? t("Δεν υπάρχει λογαριασμός πύλης με αυτό το στοιχείο.", "No portal account with that detail.")
        : r.error === "not_your_customer" ? t("Ο πελάτης δεν ανήκει στο φαρμακείο σου.", "Not your customer.")
        : t("Δεν ήταν δυνατή η αποστολή — δοκίμασε ξανά.", "Could not send — try again."));
    },
    onError: () => toastError(t("Κάτι πήγε στραβά.", "Something went wrong.")),
  });

  async function remove(p: Resp["registered_list"][number]) {
    const ok = await appConfirm(t(`Να διαγραφεί ο/η ${p.name} από την πύλη;\n\nΗ καρτέλα, οι εκτελέσεις και το ιστορικό του στο φαρμακείο ΔΕΝ διαγράφονται.`,
      `Remove ${p.name} from the portal?\n\nTheir card, dispensings and history are NOT deleted.`),
      { title: t("Διαγραφή πελάτη από την πύλη", "Remove customer from portal"), danger: true, confirmText: t("Διαγραφή", "Remove") });
    if (!ok) return;
    const r = await api<{ ok: boolean }>(`/portal/portal-customers/${encodeURIComponent(p.account_id)}`, { method: "DELETE" }).catch(() => ({ ok: false }));
    if (r.ok) { toastSuccess(t("Αφαιρέθηκε από την πύλη.", "Removed from the portal.")); qc.invalidateQueries({ queryKey: ["portal-customers"] }); }
    else toastError(t("Δεν ήταν δυνατή η διαγραφή.", "Could not remove."));
  }

  const canSend = inv.email.trim() && (picked || inv.hio_code.trim() || inv.doc_number.trim());
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label={t("Εγγεγραμμένοι στην πύλη", "Registered")} value={d ? String(d.registered) : "—"} tint="text-emerald-600" />
        <Kpi label={t("Πελάτες ΓεΣΥ", "GHS customers")} value={d ? String(d.total) : "—"} tint="text-slate-800 dark:text-slate-100" />
        <Kpi label={t("Υιοθέτηση", "Adoption")} value={d ? `${d.adoption_pct}%` : "—"} tint="text-sky-600" />
        <Kpi label={t("Προς πρόσκληση", "To invite")} value={d ? String(d.to_invite) : "—"} tint="text-amber-600"
          sub={d ? t(`${d.contactable} με στοιχεία επικοινωνίας`, `${d.contactable} contactable`) : undefined} />
      </div>

      <div className="rx-card space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
          <Mail className="h-4 w-4 text-emerald-600" /> {t("Πρόσκληση πελάτη με email", "Invite a customer by email")}
        </div>
        <p className="text-xs text-slate-500">{t("Διάλεξε υπάρχοντα πελάτη ή γράψε τον κωδικό δικαιούχου ΟΑΥ. Δεν χρειάζεται να έχει συνταγές: για νέο άνθρωπο γράψε και όνομα/επώνυμο. Ο πελάτης παίρνει email με διεύθυνση, όνομα χρήστη και κωδικό.",
          "Pick an existing customer or enter the HIO beneficiary code. No prescriptions needed: for a new person also enter the name. The customer gets an email with the address, username and password.")}</p>
        {picked ? (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-950/30">
            <Heart className="h-4 w-4 text-rose-400" /><b>{picked.full_name || "—"}</b>
            <button type="button" onClick={() => setPicked(null)} className="ml-auto text-xs text-slate-500 underline">{t("αλλαγή", "change")}</button>
          </div>
        ) : (
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση υπάρχοντος πελάτη (όνομα ή κωδικός ΟΑΥ)", "Search an existing customer (name or HIO code)")}
              className={`${input} w-full pl-9`} />
            {(search.data?.items.length ?? 0) > 0 && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {search.data!.items.map((p) => (
                  <li key={p.patient_ref}><button type="button" onClick={() => { setPicked(p); setQ(""); }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">{p.full_name || "—"}
                    {p.no_dispensings && <span className="ml-2 text-xs text-slate-400">{t("χωρίς συνταγές", "no prescriptions")}</span>}</button></li>))}
              </ul>
            )}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); if (canSend) invite.mutate(); }} className="grid gap-2 sm:grid-cols-4">
          <input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder={t("email πελάτη", "customer email")} className={input} />
          {!picked && <input value={inv.hio_code} inputMode="numeric" onChange={(e) => setInv({ ...inv, hio_code: e.target.value })} placeholder={t("κωδικός δικαιούχου ΟΑΥ", "HIO beneficiary code")} className={input} />}
          <select value={inv.doc_type} onChange={(e) => setInv({ ...inv, doc_type: e.target.value })} className={input}>
            <option value="NID">{t("Ταυτότητα", "ID card")}</option><option value="ARC">ARC</option><option value="PASSPORT">{t("Διαβατήριο", "Passport")}</option>
          </select>
          <input value={inv.doc_number} onChange={(e) => setInv({ ...inv, doc_number: e.target.value })} placeholder={t("αριθμός εγγράφου (προαιρετικό)", "document number (optional)")} className={input} />
          {!picked && <>
            <input value={inv.first_name} onChange={(e) => setInv({ ...inv, first_name: e.target.value })} placeholder={t("όνομα (αν νέος)", "first name (if new)")} className={input} />
            <input value={inv.last_name} onChange={(e) => setInv({ ...inv, last_name: e.target.value })} placeholder={t("επώνυμο (αν νέος)", "last name (if new)")} className={input} />
          </>}
          <input value={inv.mobile} inputMode="tel" onChange={(e) => setInv({ ...inv, mobile: e.target.value })} placeholder={t("κινητό (προαιρετικό)", "mobile (optional)")} className={input} />
          <button type="submit" disabled={invite.isPending || !canSend}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {invite.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Αποστολή πρόσκλησης", "Send invitation")}
          </button>
        </form>
        <p className="text-[11px] text-slate-400">{t("Ο αριθμός εγγράφου δεν αποθηκεύεται: ελέγχεται μόνο ότι ταιριάζει με το ΓεΣΥ, αν ο πελάτης έχει ήδη εκτελέσεις.", "The document number is never stored: it is only checked against the GHS record if the customer already has dispensings.")}</p>
      </div>

      <div className="rx-card p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
          <KeyRound className="h-4 w-4 text-indigo-500" /> {t("Ξεκλείδωμα πελάτη — επαναποστολή συνδέσμου κωδικού", "Unlock a customer — resend password link")}
        </div>
        <p className="mt-0.5 text-xs text-slate-500">{t("Αν ο πελάτης δεν θυμάται τον κωδικό ή δεν έλαβε το email, γράψε το email ή τον κωδικό δικαιούχου ΟΑΥ του.", "If the customer forgot the password or never got the email, enter their email or HIO beneficiary code.")}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (resendId.trim()) resend.mutate(resendId.trim()); }} className="mt-2 flex flex-wrap gap-2">
          <input value={resendId} onChange={(e) => setResendId(e.target.value)} placeholder={t("email ή κωδικός ΟΑΥ", "email or HIO code")} className={`${input} flex-1`} />
          <button type="submit" disabled={resend.isPending || !resendId.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
            {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Αποστολή συνδέσμου", "Send link")}
          </button>
        </form>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold text-slate-500">{t("Εγγεγραμμένοι πελάτες", "Registered customers")} ({d?.registered ?? 0})</div>
        {(!d || d.registered_list.length === 0) ? (
          <p className="text-sm text-slate-400">{t("Κανένας εγγεγραμμένος ακόμη — στείλε την πρώτη πρόσκληση.", "No registered customers yet — send the first invitation.")}</p>
        ) : d.registered_list.map((p) => (
          <div key={p.account_id} className="mb-2 flex items-center justify-between rx-card p-3">
            <Link href={`/cy/patients/${encodeURIComponent(p.patient_id)}`} className="inline-flex items-center gap-2 text-sm font-medium text-slate-800 hover:underline dark:text-slate-200">
              <Heart className="h-4 w-4 text-rose-400" /> {p.name}
              {p.no_dispensings && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800">{t("χωρίς συνταγές", "no prescriptions")}</span>}
            </Link>
            <span className="inline-flex items-center gap-3">
              {p.since && <span className="text-xs text-slate-400">{t("Εγγραφή", "Joined")}: {fmtDateTime(p.since)}</span>}
              <button type="button" onClick={() => remove(p)} title={t("Διαγραφή από την πύλη", "Remove from portal")} className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
