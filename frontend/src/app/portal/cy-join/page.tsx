"use client";

/* Πύλη πελάτη — ΚΥΠΡΟΣ: σελίδα που ανοίγει το QR του πάγκου (26/11/2026).
   Ο πελάτης στέλνει ΑΙΤΗΣΗ (όνομα, κωδικός ΟΑΥ ή ταυτότητα/ARC, email) μαζί με τις συγκαταθέσεις του.
   ΚΑΝΕΝΑΣ λογαριασμός εδώ: ο φαρμακοποιός την εγκρίνει στα «Πελάτες πύλης» αφού δει την ταυτότητα, και
   τότε έρχεται email για τον κωδικό. Το XML ΓεΣΥ δεν έχει κινητό/email για OTP (όπως το ΑΜΚΑ στην Ελλάδα).
   Ο αριθμός εγγράφου στέλνεται μία φορά και ΔΕΝ αποθηκεύεται (μόνο το ψευδώνυμό του). */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Download, Loader2, Pill, Share, Smartphone } from "lucide-react";
import { API_BASE, ApiError, patientAuth } from "@/lib/patientClient";
import { useT } from "@/store/prefStore";

type BIPEvent = Event & { prompt: () => Promise<void> };
const CHANNELS = [["email", "Email"], ["sms", "SMS"], ["viber", "Viber"], ["push", "Ειδοποιήσεις εφαρμογής"]] as const;

function InstallApp() {
  const t = useT();
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  useEffect(() => {
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    if (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone) { setInstalled(true); return; }
    const on = (e: Event) => { e.preventDefault(); setDeferred(e as BIPEvent); };
    window.addEventListener("beforeinstallprompt", on);
    window.addEventListener("appinstalled", () => setInstalled(true));
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);
  if (installed) return <p className="text-center text-sm font-medium text-emerald-700">✓ {t("Η εφαρμογή είναι εγκατεστημένη.", "The app is installed.")}</p>;
  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/70 p-4 text-sm text-slate-700">
      <div className="mb-2 flex items-center gap-2 font-semibold text-slate-900"><Smartphone className="h-4 w-4 text-brand-600" /> {t("Βάλε την εφαρμογή στο κινητό σου", "Add the app to your phone")}</div>
      {deferred ? (
        <button type="button" onClick={async () => { await deferred.prompt(); setDeferred(null); }}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 py-2.5 font-semibold text-white hover:bg-brand-700">
          <Download className="h-4 w-4" /> {t("Εγκατάσταση εφαρμογής", "Install the app")}
        </button>
      ) : ios ? (
        <p>{t("Στο Safari πάτα", "In Safari tap")} <Share className="inline h-4 w-4" /> <b>{t("Κοινή χρήση", "Share")}</b> {t("και μετά", "then")} <b>{t("«Προσθήκη στην οθόνη Αφετηρίας»", "“Add to Home Screen”")}</b>.</p>
      ) : (
        <p>{t("Στο Chrome πάτα το μενού ⋮ και μετά «Εγκατάσταση εφαρμογής» ή «Προσθήκη στην αρχική οθόνη».", "In Chrome tap the ⋮ menu, then “Install app” or “Add to Home screen”.")}</p>
      )}
    </div>
  );
}

export default function CyJoin() {
  const t = useT();
  const [ph, setPh] = useState<string | null>(null);
  const [pharmacy, setPharmacy] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const [f, setF] = useState({ first_name: "", last_name: "", email: "", mobile: "", id_kind: "HIO", hio_code: "", doc_type: "NID", doc_number: "", website: "" });
  const [c, setC] = useState({ accept_terms: false, health_data: false, marketing: false, email: false, sms: false, viber: false, push: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("ph");
    if (!p) { setBad(true); return; }
    setPh(p);
    fetch(`${API_BASE}/patient/cy/join/${encodeURIComponent(p)}`).then((r) => r.json())
      .then((r: { ok: boolean; pharmacy_name?: string }) => { if (r.ok) setPharmacy(r.pharmacy_name || ""); else setBad(true); })
      .catch(() => setBad(true));
  }, []);

  const ERR: Record<string, string> = {
    terms_required: t("Χρειάζεται να αποδεχτείς τους όρους και την ενημέρωση απορρήτου.", "Please accept the terms and the privacy notice."),
    health_consent_required: t("Χωρίς συγκατάθεση για τα δεδομένα υγείας η πύλη δεν μπορεί να σου δείξει τις συνταγές σου.", "Without consent for health data the portal cannot show your prescriptions."),
    id_required: t("Γράψε τον κωδικό δικαιούχου ΟΑΥ ή τον αριθμό ταυτότητας/ARC.", "Enter your HIO beneficiary code or ID/ARC number."),
    bad_email: t("Το email δεν είναι σωστό.", "The email is not valid."),
    name_required: t("Γράψε όνομα και επώνυμο.", "Enter first and last name."),
    too_many_requests: t("Πολλές αιτήσεις αυτή τη στιγμή. Ζήτησε βοήθεια από το φαρμακείο.", "Too many requests right now. Please ask the pharmacy."),
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const r = await patientAuth<{ ok: boolean; error?: string }>("/patient/cy/join", {
        pharmacy: ph, first_name: f.first_name, last_name: f.last_name, email: f.email, mobile: f.mobile || undefined,
        hio_code: f.id_kind === "HIO" ? f.hio_code : undefined,
        doc_type: f.id_kind === "DOC" ? f.doc_type : undefined, doc_number: f.id_kind === "DOC" ? f.doc_number : undefined,
        website: f.website || undefined, accept_terms: c.accept_terms, health_data: c.health_data, marketing: c.marketing,
        channels: { email: c.email, sms: c.sms, viber: c.viber, push: c.push } });
      if (r.ok) setDone(true); else setErr(ERR[r.error ?? ""] ?? t("Κάτι πήγε στραβά. Έλεγξε τα στοιχεία.", "Something went wrong. Check your details."));
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.status === 429 ? ERR.too_many_requests : t("Κάτι πήγε στραβά. Δοκίμασε ξανά.", "Something went wrong. Please try again."));
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
  const box = "mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300";
  const card = "w-full max-w-md space-y-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8";

  return (
    <div className="h-full overflow-y-auto"><div className="flex min-h-full items-center justify-center px-4 py-8">
      {bad ? (
        <div className={`${card} text-center`}>
          <h1 className="text-lg font-bold text-slate-900">{t("Ο σύνδεσμος δεν ισχύει", "This link is not valid")}</h1>
          <p className="text-sm text-slate-500">{t("Σκάναρε ξανά το QR στο φαρμακείο ή ζήτησε από τον φαρμακοποιό να σε εγγράψει.", "Scan the QR at the pharmacy again or ask the pharmacist to register you.")}</p>
        </div>
      ) : done ? (
        <div className={card}>
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <h1 className="mt-2 text-xl font-extrabold text-slate-900">{t("Η αίτησή σου στάλθηκε", "Your request was sent")}</h1>
            <p className="mt-1 text-sm text-slate-600">{t(`Δείξε την ταυτότητά σου στον φαρμακοποιό${pharmacy ? ` (${pharmacy})` : ""}. Μόλις την εγκρίνει, θα λάβεις email για να ορίσεις τον κωδικό σου.`, `Show your ID to the pharmacist${pharmacy ? ` (${pharmacy})` : ""}. Once approved, you will receive an email to set your password.`)}</p>
          </div>
          <InstallApp />
          <p className="text-center text-sm text-slate-500"><Link href="/portal/login" className="font-semibold text-brand-600 hover:underline">{t("Σύνδεση", "Sign in")}</Link> {t("όταν ορίσεις τον κωδικό σου.", "once you have set your password.")}</p>
        </div>
      ) : (
        <form onSubmit={submit} className={card}>
          <div className="text-center">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-500/30"><Pill className="h-6 w-6" /></span>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{t("Εγγραφή στην πύλη πελατών", "Join the customer portal")}</h1>
            <p className="mt-1 text-sm text-slate-500">{pharmacy === null ? <Loader2 className="inline h-4 w-4 animate-spin" /> : pharmacy}</p>
          </div>
          {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
          <div className="grid grid-cols-2 gap-2">
            <input required placeholder={t("Όνομα", "First name")} value={f.first_name} onChange={set("first_name")} className={inp} />
            <input required placeholder={t("Επώνυμο", "Last name")} value={f.last_name} onChange={set("last_name")} className={inp} />
          </div>
          <input type="email" required placeholder="Email" value={f.email} onChange={set("email")} className={inp} />
          <input placeholder={t("Κινητό (προαιρετικό)", "Mobile (optional)")} value={f.mobile} onChange={set("mobile")} className={inp} />
          <select value={f.id_kind} onChange={set("id_kind")} className={inp}>
            <option value="HIO">{t("Κωδικός δικαιούχου ΟΑΥ", "HIO beneficiary code")}</option>
            <option value="DOC">{t("Ταυτότητα / κάρτα αλλοδαπού (ARC)", "ID card / alien card (ARC)")}</option>
          </select>
          {f.id_kind === "HIO" ? (
            <input required placeholder={t("Κωδικός δικαιούχου ΟΑΥ", "HIO beneficiary code")} value={f.hio_code} onChange={set("hio_code")} className={inp} />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <select value={f.doc_type} onChange={set("doc_type")} className={inp}><option value="NID">{t("Ταυτότητα", "ID")}</option><option value="ARC">ARC</option></select>
              <input required placeholder={t("Αριθμός", "Number")} value={f.doc_number} onChange={set("doc_number")} className={`${inp} col-span-2`} />
            </div>
          )}
          {/* honeypot: κρυφό από ανθρώπους */}
          <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} className="hidden" aria-hidden="true" />

          <div className="space-y-2 rounded-2xl bg-slate-50 p-3 text-xs text-slate-700">
            <label className="flex gap-2"><input type="checkbox" className={box} checked={c.accept_terms} onChange={(e) => setC({ ...c, accept_terms: e.target.checked })} />
              <span><b>{t("Αποδέχομαι", "I accept")}</b> {t("τους", "the")} <Link href="/portal/terms" target="_blank" className="text-brand-600 underline">{t("Όρους χρήσης της πύλης", "portal terms of use")}</Link> {t("και έλαβα γνώση της", "and have read the")} <Link href="/portal/privacy" target="_blank" className="text-brand-600 underline">{t("Ενημέρωσης απορρήτου", "privacy notice")}</Link>. *</span></label>
            <label className="flex gap-2"><input type="checkbox" className={box} checked={c.health_data} onChange={(e) => setC({ ...c, health_data: e.target.checked })} />
              <span>{t("Συναινώ να βλέπω στην πύλη τις συνταγές και τα δεδομένα υγείας μου που τηρεί το φαρμακείο (άρθρο 9 ΓΚΠΔ). *", "I consent to viewing in the portal my prescriptions and health data held by the pharmacy (GDPR Art. 9). *")}</span></label>
            <div className="border-t border-slate-200 pt-2">
              <div className="mb-1 font-semibold text-slate-800">{t("Πώς θέλεις να επικοινωνεί μαζί σου το φαρμακείο (προαιρετικό):", "How the pharmacy may contact you (optional):")}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {CHANNELS.map(([k, label]) => (
                  <label key={k} className="inline-flex items-center gap-1.5"><input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.checked })} />{k === "push" ? t(label, "App notifications") : label}</label>
                ))}
              </div>
              <label className="mt-2 flex gap-2"><input type="checkbox" className={box} checked={c.marketing} onChange={(e) => setC({ ...c, marketing: e.target.checked })} />
                <span>{t("Θέλω να λαμβάνω και προσφορές/ενημερώσεις του φαρμακείου από τα κανάλια που διάλεξα.", "I also want to receive pharmacy offers/news through the channels I chose.")}</span></label>
              <p className="mt-1 text-[11px] text-slate-500">{t("Μπορείς να τα αλλάξεις ή να τα ανακαλέσεις οποτεδήποτε από την πύλη (Προφίλ).", "You can change or withdraw these at any time in the portal (Profile).")}</p>
            </div>
          </div>
          <button type="submit" disabled={busy || !c.accept_terms || !c.health_data} className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
            {busy ? t("Αποστολή…", "Sending…") : t("Αποστολή αίτησης", "Send request")}
          </button>
          <p className="text-center text-[11px] text-slate-500">{t("🔒 Ο φαρμακοποιός θα ελέγξει την ταυτότητά σου στον πάγκο πριν ανοίξει ο λογαριασμός. Ο αριθμός ταυτότητας δεν αποθηκεύεται.", "🔒 The pharmacist will check your ID at the counter before the account opens. Your ID number is not stored.")}</p>
          <p className="text-center text-sm text-slate-500">{t("Έχεις ήδη λογαριασμό;", "Already have an account?")} <Link href="/portal/login" className="font-semibold text-brand-600 hover:underline">{t("Σύνδεση", "Sign in")}</Link></p>
        </form>
      )}
    </div></div>
  );
}
