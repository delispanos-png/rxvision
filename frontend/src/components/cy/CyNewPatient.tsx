"use client";

/* RxVision Κύπρος — νέος πελάτης ΧΩΡΙΣ εκτελέσεις ΓεΣΥ (π.χ. αγοράζει μόνο μη συνταγογραφούμενα, μέλος
   οικογένειας). Κλειδί = κωδικός δικαιούχου ΟΑΥ (αλλιώς έγγραφο), ΙΔΙΟΣ κανόνας με το XML: η πρώτη εκτέλεση
   «κουμπώνει» στην ίδια καρτέλα. Ο αριθμός εγγράφου δεν αποθηκεύεται. Backend: POST /cy/patients. */

import { useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { ApiError, api } from "@/lib/apiClient";
import { DateInput } from "@/components/ui/DateInput";
import { useT } from "@/store/prefStore";
import { toastError, toastSuccess } from "@/store/toastStore";

const input = "min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800";
const EMPTY = { first_name: "", last_name: "", hio_code: "", doc_type: "NID", doc_number: "", dob: "", gender: "", mobile: "", email: "" };

export function CyNewPatient({ onDone, onCancel }: { onDone: (patientId: string) => void; onCancel: () => void }) {
  const t = useT();
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const ERR: Record<string, string> = {
    name_required: t("Γράψε όνομα και επώνυμο.", "Enter first and last name."),
    id_required: t("Γράψε κωδικό δικαιούχου ΟΑΥ ή αριθμό εγγράφου.", "Enter the HIO beneficiary code or a document number."),
    bad_dob: t("Λάθος ημερομηνία γέννησης.", "Invalid date of birth."),
  };
  async function save() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; patient_id: string; existed: boolean; contact_error?: string }>("/cy/patients", { method: "POST",
        body: JSON.stringify({ first_name: f.first_name, last_name: f.last_name, hio_code: f.hio_code || undefined, doc_type: f.doc_type,
          doc_number: f.doc_number || undefined, dob: f.dob || undefined, gender: f.gender || undefined,
          mobile: f.mobile || undefined, email: f.email || undefined }) });
      toastSuccess(r.existed ? t("Ο πελάτης υπάρχει ήδη — άνοιξε η καρτέλα του.", "Customer already exists — opening the card.")
        : r.contact_error ? t("Ο πελάτης γράφτηκε, αλλά το κινητό/email δεν είναι έγκυρο — διόρθωσέ το στην καρτέλα.", "Registered, but the mobile/email is invalid — fix it on the card.")
        : t("✓ Ο πελάτης γράφτηκε.", "✓ Customer registered."));
      onDone(r.patient_id);
    } catch (e) {
      const code = e instanceof ApiError ? ((e.problem as { detail?: string } | null)?.detail ?? "") : "";
      toastError(ERR[code] ?? t("Δεν ήταν δυνατή η εγγραφή.", "Could not register."));
    } finally { setBusy(false); }
  }
  const ok = f.first_name.trim() && f.last_name.trim() && (f.hio_code.trim() || f.doc_number.trim());
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) save(); }} className="rx-card space-y-3 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
        <UserPlus className="h-4 w-4 text-brand-600" /> {t("Νέος πελάτης χωρίς συνταγές ΓεΣΥ", "New customer without GHS prescriptions")}
      </div>
      <p className="text-xs text-slate-500">{t("Για όποιον δεν έχει ακόμα εκτέλεση ΓεΣΥ στο φαρμακείο σου. Με τον κωδικό δικαιούχου ΟΑΥ, η πρώτη του συνταγή θα μπει στην ίδια καρτέλα. Ο αριθμός εγγράφου δεν αποθηκεύεται.",
        "For anyone without a GHS dispensing at your pharmacy yet. With the HIO beneficiary code, their first prescription lands on the same card. The document number is never stored.")}</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <input value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} placeholder={t("όνομα", "first name")} className={input} />
        <input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} placeholder={t("επώνυμο", "last name")} className={input} />
        <input value={f.hio_code} inputMode="numeric" onChange={(e) => setF({ ...f, hio_code: e.target.value })} placeholder={t("κωδικός δικαιούχου ΟΑΥ", "HIO beneficiary code")} className={input} />
        <div className="flex gap-2">
          <select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })} className={`${input} w-36 shrink-0`}>
            <option value="NID">{t("Ταυτότητα", "ID card")}</option><option value="ARC">ARC</option><option value="PASSPORT">{t("Διαβατήριο", "Passport")}</option>
          </select>
          <input value={f.doc_number} onChange={(e) => setF({ ...f, doc_number: e.target.value })} placeholder={t("αριθμός", "number")} className={`${input} flex-1`} />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500">{t("Γέννηση", "Born")}
          <DateInput value={f.dob} onChange={(v) => setF({ ...f, dob: v })} max={new Date().toISOString().slice(0, 10)} className="flex-1" />
        </label>
        <select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })} className={input}>
          <option value="">{t("φύλο", "sex")}</option><option value="F">{t("Γυναίκα", "Female")}</option><option value="M">{t("Άνδρας", "Male")}</option>
        </select>
        <input value={f.mobile} inputMode="tel" onChange={(e) => setF({ ...f, mobile: e.target.value })} placeholder={t("κινητό (προαιρετικό)", "mobile (optional)")} className={input} />
        <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder={t("email (προαιρετικό)", "email (optional)")} className={input} />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !ok} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {t("Εγγραφή", "Register")}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">{t("Άκυρο", "Cancel")}</button>
      </div>
    </form>
  );
}
