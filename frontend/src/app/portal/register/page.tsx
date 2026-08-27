"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pill, ShieldCheck } from "lucide-react";
import { patientAuth, patientTokens, ApiError } from "@/lib/patientClient";
import { useT } from "@/store/prefStore";

type Session = { access_token: string | null; refresh_token: string; pharmacies: { pharmacy_name: string }[] };
type Channel = { type: "email" | "sms"; hint: string };
type OtpStart = { otp_required: true; challenge_id: string; channels: Channel[] };

export default function PortalRegister() {
  const t = useT();
  const router = useRouter();

  const errText = (code?: string): string => {
    switch (code) {
      case "email_exists": return t("Υπάρχει ήδη λογαριασμός με αυτό το email.", "An account with this email already exists.");
      case "amka_exists": return t("Υπάρχει ήδη λογαριασμός με αυτό το ΑΜΚΑ.", "An account with this ΑΜΚΑ already exists.");
      case "approval_required":
        return t("Δεν βρέθηκαν στοιχεία επικοινωνίας σου σε κάποιο φαρμακείο του δικτύου, ώστε να επιβεβαιώσουμε την ταυτότητά σου. Ζήτησε από το φαρμακείο σου να δημιουργήσει τον λογαριασμό σου.", "We couldn't find your contact details at any pharmacy in the network to verify your identity. Please ask your pharmacy to create your account.");
      case "otp_send_failed": return t("Δεν στάλθηκε ο κωδικός. Δοκίμασε ξανά σε λίγο.", "The code couldn't be sent. Please try again shortly.");
      case "otp_invalid": return t("Λάθος κωδικός. Δοκίμασε ξανά.", "Wrong code. Please try again.");
      case "otp_expired": return t("Ο κωδικός έληξε. Ξεκίνα ξανά την εγγραφή.", "The code has expired. Please start registration again.");
      case "otp_locked": return t("Πολλές λάθος προσπάθειες. Ξεκίνα ξανά την εγγραφή.", "Too many wrong attempts. Please start registration again.");
      default: return t("Κάτι πήγε στραβά. Έλεγξε τα στοιχεία.", "Something went wrong. Please check your details.");
    }
  };

  const [step, setStep] = useState<"form" | "otp">("form");
  const [f, setF] = useState({ first_name: "", last_name: "", email: "", phone: "", amka: "", password: "" });
  const [ph, setPh] = useState<string | null>(null);   // «αγαπημένο» φαρμακείο από QR πάγκου (?ph=)
  const [challenge, setChallenge] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [code, setCode] = useState("");
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
      const r = await patientAuth<OtpStart>("/patient/auth/register", { ...f, pharmacy: ph || undefined });
      setChallenge(r.challenge_id);
      setChannels(r.channels || []);
      setStep("otp");
    } catch (e) {
      setErr(errText(e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : ""));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const s = await patientAuth<Session>("/patient/auth/register/verify", { challenge_id: challenge, code });
      patientTokens.set(s.access_token, s.refresh_token);
      router.replace("/portal");
    } catch (e) {
      const c = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : "";
      setErr(errText(c));
      if (c === "otp_expired" || c === "otp_locked") { setStep("form"); setCode(""); }
    } finally {
      setBusy(false);
    }
  }

  const inp = "w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
  return (
    <div className="h-full overflow-y-auto"><div className="flex min-h-full items-center justify-center px-4 py-8">
      {step === "form" ? (
        <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
          <div className="text-center">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-500/30"><Pill className="h-6 w-6" /></span>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{t("Δημιουργία λογαριασμού", "Create account")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("Δες τις συνταγές σου & κλείσε ραντεβού στο φαρμακείο σου", "View your prescriptions & book appointments at your pharmacy")}</p>
          </div>
          {ph && <div className="rounded-xl bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-700">{t("📍 Εγγραφή με το φαρμακείο σου ως αγαπημένο", "📍 Registering with your pharmacy pre-selected as favourite")}</div>}
          {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input required placeholder={t("Όνομα", "First name")} value={f.first_name} onChange={set("first_name")} className={inp} />
            <input required placeholder={t("Επώνυμο", "Last name")} value={f.last_name} onChange={set("last_name")} className={inp} />
          </div>
          <input type="email" required placeholder="Email" value={f.email} onChange={set("email")} className={inp} />
          <input required placeholder={t("Τηλέφωνο", "Phone")} value={f.phone} onChange={set("phone")} className={inp} />
          <input required placeholder="ΑΜΚΑ" value={f.amka} onChange={set("amka")} className={inp} />
          <input type="password" required minLength={8} placeholder={t("Κωδικός (8+ χαρακτήρες)", "Password (8+ characters)")} value={f.password} onChange={set("password")} className={inp} />
          <p className="rounded-xl bg-brand-50 px-3 py-2 text-[11px] text-brand-600">{t("🔒 Για την ασφάλειά σου, θα στείλουμε έναν κωδικό επιβεβαίωσης στο τηλέφωνο ή email που έχει το φαρμακείο σου καταχωρημένο για εσένα.", "🔒 For your security, we'll send a verification code to the phone or email your pharmacy has on file for you.")}</p>
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
            {busy ? t("Αποστολή κωδικού…", "Sending code…") : t("Συνέχεια", "Continue")}
          </button>
          <p className="text-center text-sm text-slate-500">
            {t("Έχεις ήδη λογαριασμό;", "Already have an account?")} <Link href="/portal/login" className="font-semibold text-brand-600 hover:underline">{t("Σύνδεση", "Sign in")}</Link>
          </p>
        </form>
      ) : (
        <form onSubmit={verify} className="w-full max-w-sm space-y-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
          <div className="text-center">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/30"><ShieldCheck className="h-6 w-6" /></span>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{t("Επιβεβαίωση ταυτότητας", "Verify your identity")}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {t("Στείλαμε 6ψήφιο κωδικό", "We sent a 6-digit code")} {channels.length ? t("στο ", "to ") + channels.map((c) => c.hint).join(t(" και ", " and ")) : ""}. {t("Πληκτρολόγησέ τον για να ολοκληρωθεί η εγγραφή.", "Enter it to complete your registration.")}
            </p>
          </div>
          {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
          <input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="______"
                 value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                 className={`${inp} text-center text-2xl font-bold tracking-[0.5em]`} />
          <button type="submit" disabled={busy || code.length < 4} className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm shadow-brand-500/30 hover:bg-brand-700 disabled:opacity-60">
            {busy ? t("Επιβεβαίωση…", "Verifying…") : t("Ολοκλήρωση εγγραφής", "Complete registration")}
          </button>
          <button type="button" onClick={() => { setStep("form"); setErr(""); setCode(""); }} className="w-full text-center text-sm text-slate-500 hover:underline">
            {t("← Πίσω / αλλαγή στοιχείων", "← Back / edit details")}
          </button>
        </form>
      )}
    </div></div>
  );
}
