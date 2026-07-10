"use client";

import { useState, useEffect } from "react";
import { UserPlus, X, Loader2, ShieldCheck, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type LookupRes = {
  found: boolean; error?: string;
  full_name?: string | null; birth_year?: number | null; sex?: string | null; area?: string | null;
  address?: string | null; postal_code?: string | null; city?: string | null;
  mobile?: string | null; phone?: string | null; email?: string | null;
};
type OnboardRes = { ok: boolean; patient_ref: string; already_existed: boolean };

const LOOKUP_ERR: Record<string, [string, string]> = {
  bad_amka_format: ["Το ΑΜΚΑ πρέπει να είναι 11 ψηφία.", "ΑΜΚΑ must be 11 digits."],
  invalid_amka: ["Λάθος ΑΜΚΑ — η ΗΔΥΚΑ δεν το αναγνωρίζει.", "Wrong ΑΜΚΑ — ΗΔΥΚΑ does not recognise it."],
  deceased: ["Η ΗΔΥΚΑ αναφέρει θάνατο για αυτό το ΑΜΚΑ.", "ΗΔΥΚΑ reports this ΑΜΚΑ as deceased."],
  not_configured: ["Δεν έχει ρυθμιστεί η σύνδεση ΗΔΥΚΑ — συμπλήρωσε χειροκίνητα.", "ΗΔΥΚΑ not configured — fill in manually."],
  hdika_unavailable: ["Η ΗΔΥΚΑ δεν αποκρίθηκε — συμπλήρωσε χειροκίνητα.", "ΗΔΥΚΑ unavailable — fill in manually."],
  empty: ["Δεν επιστράφηκαν στοιχεία — συμπλήρωσε χειροκίνητα.", "No data returned — fill in manually."],
};

export function NewPatientModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [amka, setAmka] = useState("");
  const [looking, setLooking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  const [fullName, setFullName] = useState("");
  const [mobile, setMobile] = useState("");
  const [birthYear, setBirthYear] = useState<number | "">("");
  const [sex, setSex] = useState("");
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<OnboardRes | null>(null);
  const [fetchedAmka, setFetchedAmka] = useState("");

  // ΑΥΤΟΜΑΤΗ άντληση μόλις συμπληρωθεί έγκυρο ΑΜΚΑ (11 ψηφία) — απλώς δείχνει τα στοιχεία (ΔΕΝ σώζει).
  useEffect(() => {
    const a = amka.trim();
    if (done || !/^\d{11}$/.test(a) || a === fetchedAmka) return;
    const tmo = setTimeout(() => lookup(a), 450);
    return () => clearTimeout(tmo);
  }, [amka, fetchedAmka, done]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  function reset() {
    setAmka(""); setNote(null); setFetched(false); setFullName(""); setMobile("");
    setBirthYear(""); setSex(""); setArea(""); setAddress(""); setPostalCode(""); setPhone("");
    setEmail(""); setConsent(false); setDone(null); setFetchedAmka("");
  }
  function close() { reset(); onClose(); }

  async function lookup(a: string) {
    setLooking(true); setNote(null); setFetchedAmka(a);
    try {
      const r = await api<LookupRes>("/patients/lookup", { method: "POST", body: JSON.stringify({ amka: a }) });
      setFetched(true);
      if (r.found) {
        if (r.full_name) setFullName(r.full_name);
        if (r.birth_year) setBirthYear(r.birth_year);
        if (r.sex) setSex(r.sex);
        if (r.city || r.area) setArea(r.city || r.area || "");
        if (r.address) setAddress(r.address);
        if (r.postal_code) setPostalCode(r.postal_code);
        if (r.mobile) setMobile(r.mobile);
        if (r.phone) setPhone(r.phone);
        if (r.email) setEmail(r.email);
        setNote(r.full_name ? null : t("Βρέθηκε, αλλά χωρίς όνομα — συμπλήρωσέ το.", "Found, but no name — fill it in."));
      } else {
        const m = LOOKUP_ERR[r.error ?? "empty"] ?? LOOKUP_ERR.empty;
        setNote(t(m[0], m[1]));
      }
    } catch {
      setFetched(true); setNote(t("Σφάλμα άντλησης — συμπλήρωσε χειροκίνητα.", "Fetch error — fill in manually."));
    } finally { setLooking(false); }
  }

  async function create() {
    setSaving(true);
    try {
      const r = await api<OnboardRes>("/patients/onboard", { method: "POST", body: JSON.stringify({
        amka: amka.trim(), full_name: fullName.trim() || null, sex: sex || null,
        birth_year: birthYear || null, area: area || null, city: area || null,
        address: address.trim() || null, postal_code: postalCode.trim() || null,
        mobile: mobile.trim() || null, phone: phone.trim() || null, email: email.trim() || null, consent,
      }) });
      setDone(r);
    } catch { setNote(t("Η δημιουργία απέτυχε — δοκίμασε ξανά.", "Creation failed — try again.")); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={close}>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-800 dark:text-slate-100"><UserPlus className="h-5 w-5 text-indigo-600" /> {t("Νέος πελάτης", "New patient")}</div>
          <button onClick={close}><X className="h-5 w-5 text-slate-400" /></button>
        </div>

        {done ? (
          <div className="space-y-3 py-4 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {done.already_existed
                ? t("Ο πελάτης υπήρχε ήδη — η καρτέλα ενημερώθηκε.", "Patient already existed — record updated.")
                : t("Η καρτέλα δημιουργήθηκε! Ο πελάτης μπορεί να εγγραφεί στην πύλη με το ΑΜΚΑ του.", "Record created! The patient can register on the portal with their ΑΜΚΑ.")}
            </div>
            <div className="flex justify-center gap-2">
              <button onClick={reset} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">{t("Νέα καρτέλα", "Another")}</button>
              <button onClick={close} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">{t("Κλείσιμο", "Close")}</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">{t("Καταχώρησε το ΑΜΚΑ, άντλησε τα στοιχεία από τη ΗΔΥΚΑ και δημιούργησε καρτέλα — χωρίς εκτέλεση συνταγής — για να ξεκινήσει ο πελάτης την πύλη.", "Enter the ΑΜΚΑ, fetch details from ΗΔΥΚΑ and create a record — without a prescription — so the patient can start using the portal.")}</p>

            <div className="relative">
              <input value={amka} onChange={(e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 11); setAmka(v); if (v !== fetchedAmka) setFetched(false); }} inputMode="numeric" placeholder={t("ΑΜΚΑ (11 ψηφία) — άντληση αυτόματα", "ΑΜΚΑ (11 digits) — auto-fetch")} className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-9 text-sm dark:border-slate-600 dark:bg-slate-800" />
              {looking && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-indigo-500" />}
            </div>
            {note && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">{note}</div>}

            {fetched && (
              <>
                <label className="block text-xs text-slate-500">{t("Ονοματεπώνυμο", "Full name")}<input value={fullName} onChange={(e) => setFullName(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="text-xs text-slate-500">{t("Έτος γέν.", "Birth yr")}<input type="number" value={birthYear} onChange={(e) => setBirthYear(e.target.value ? +e.target.value : "")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                  <label className="text-xs text-slate-500">{t("Φύλο", "Sex")}<select value={sex} onChange={(e) => setSex(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"><option value="">—</option><option value="M">{t("Α", "M")}</option><option value="F">{t("Θ", "F")}</option></select></label>
                  <label className="text-xs text-slate-500">{t("Πόλη", "City")}<input value={area} onChange={(e) => setArea(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="col-span-2 text-xs text-slate-500">{t("Διεύθυνση", "Address")}<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("Οδός & αριθμός", "Street & no.")} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                  <label className="text-xs text-slate-500">{t("Τ.Κ.", "Postal")}<input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-500">{t("Κινητό (πύλη/OTP)", "Mobile (portal/OTP)")}<input value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="tel" placeholder="69…" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                  <label className="text-xs text-slate-500">{t("Σταθερό", "Phone")}<input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
                </div>
                <label className="block text-xs text-slate-500">{t("Email", "Email")}<input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>

                <label className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" /> <span><ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-emerald-600" /> {t("Έχω τη συγκατάθεση του πελάτη για δημιουργία καρτέλας & άντληση στοιχείων από τη ΗΔΥΚΑ (GDPR).", "I have the patient consent to create a record & fetch their ΗΔΥΚΑ data (GDPR).")}</span></label>

                <p className="text-[11px] text-slate-400">{t("Έλεγξε/διόρθωσε τα στοιχεία — τίποτα δεν αποθηκεύεται μέχρι να πατήσεις «Δημιουργία καρτέλας».", "Review/edit — nothing is saved until you press «Create record».")}</p>
                <button onClick={create} disabled={saving || !fullName.trim() || !consent} className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {t("Δημιουργία καρτέλας", "Create record")}</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
