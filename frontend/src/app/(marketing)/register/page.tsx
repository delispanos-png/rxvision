"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Package, UserCog, Search, Check, ArrowRight, ArrowLeft, Eye, EyeOff, Loader2, CreditCard, Landmark } from "lucide-react";
import { api, ApiError } from "@/lib/apiClient";
import { Tooltip } from "@/components/ui/Tooltip";
import { Logo } from "@/components/brand/Logo";
import { PoweredBy } from "@/components/brand/PoweredBy";

type Company = {
  name: string; title: string; afm: string; doy: string; country: "GR" | "CY";
  email: string; billing_email: string; phone: string; website: string;
  address: string; postal_code: string; city: string; region: string;
};
type Admin = { full_name: string; email: string; password: string };
type RegisterResponse = { access_token: string; refresh_token: string; tenant_id: string };
type Aade = { ok: boolean; error?: string; name?: string; title?: string; doy?: string; address?: string; postal_code?: string; city?: string; active?: boolean };
type Pkg = { _id: string; name?: string; description?: string; price_monthly?: number; price_yearly?: number; price_includes_vat?: boolean; trial_days?: number; seats?: number; sla?: string; extra_user_price?: number; extra_user_price_yearly?: number; modules?: string[]; available_addons?: string[]; billing_cycles?: string[] };
type Sla = { _id: string; name?: string; description?: string; response_hours?: number; channels?: string; price_monthly?: number; price_yearly?: number };
type Addon = { _id: string; name?: string; description?: string; icon?: string; price_monthly?: number; price_yearly?: number; features?: string[] };

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);
// Προτεινόμενο SLA: το «Basic» (id ή όνομα)· αλλιώς το φθηνότερο / με τη μεγαλύτερη ώρα απόκρισης (πιο βασικό)
const defaultSla = (tiers: Sla[]): string => {
  if (!tiers?.length) return "";
  const basic = tiers.find((s) => s._id === "basic" || (s.name || "").toLowerCase().includes("basic"));
  if (basic) return basic._id;
  return [...tiers].sort((a, b) => ((a.price_monthly ?? 0) - (b.price_monthly ?? 0)) || ((b.response_hours ?? 0) - (a.response_hours ?? 0)))[0]._id;
};
const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-500";
const label = "mb-1 block text-xs font-medium text-slate-600";

const STEPS = [
  { icon: Building2, title: "Στοιχεία Πελάτη", sub: "Επωνυμία, ΑΦΜ, επικοινωνία" },
  { icon: Package, title: "Πακέτο & Χρήστες", sub: "Πακέτο, SLA, χρήστες, κόστος" },
  { icon: UserCog, title: "Στοιχεία Owner", sub: "Ονοματεπώνυμο & email" },
  { icon: CreditCard, title: "Πληρωμή", sub: "Πλήρωσε για να ενεργοποιηθεί" },
];
const N = STEPS.length;
// Ο κωδικός (credentials) μπαίνει ΤΕΛΕΥΤΑΙΟΣ, μετά την πληρωμή (βλ. completion mode).
const STEP = { COMPANY: 0, PACKAGE: 1, OWNER: 2, PAYMENT: 3 } as const;

export default function RegisterWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [company, setCompany] = useState<Company>({ name: "", title: "", afm: "", doy: "", country: "GR", email: "", billing_email: "", phone: "", website: "", address: "", postal_code: "", city: "", region: "" });
  const [admin, setAdmin] = useState<Admin>({ full_name: "", email: "", password: "" });
  const [showPw, setShowPw] = useState(false);
  const [aade, setAade] = useState<{ loading: boolean; msg: string | null }>({ loading: false, msg: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // dynamic catalogue (only active packages/SLA are returned by the API)
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [slaTiers, setSlaTiers] = useState<Sla[]>([]);
  const [addonCat, setAddonCat] = useState<Addon[]>([]);
  const [selAddons, setSelAddons] = useState<string[]>([]);
  const [pkgCode, setPkgCode] = useState<string>("");
  const [billing, setBilling] = useState<"monthly" | "yearly">("yearly");
  const [sla, setSla] = useState<string>("");
  const [seats, setSeats] = useState<number>(1);
  // Ενεργοί τρόποι πληρωμής — δυναμικά από το adminpanel (public_methods), όχι hardcoded.
  const [payMethods, setPayMethods] = useState<{ id: string; label: { el: string; en: string } }[]>([]);
  const [payChoice, setPayChoice] = useState<string>("");   // επιλεγμένο method id (π.χ. card_viva)
  // «πληρωμή-πρώτα»: μετά την επιστροφή από Viva μπαίνουμε σε completion mode (?pending=<id>)
  const [pendingId, setPendingId] = useState<string>("");   // completion mode αν != ""
  const [pendingStatus, setPendingStatus] = useState<string>("");
  const [pendingTrial, setPendingTrial] = useState(false);   // completion για δωρεάν trial (χωρίς πληρωμή)
  const [bankSubmitted, setBankSubmitted] = useState(false); // τράπεζα → αναμονή έγκρισης
  const [afmErr, setAfmErr] = useState<string | null>(null); // διπλότυπο ΑΦΜ (ενεργή συνδρομή)
  const [reactivation, setReactivation] = useState(false);   // υπάρχων λογαριασμός με ληγμένο/trial → αγορά κανονικού πακέτου

  useEffect(() => {
    // Optional deep-link preselect from the marketing site: /register?package=pro (alias: ?plan=).
    const qp = new URLSearchParams(window.location.search);
    // Επιστροφή από Viva (ή email link τράπεζας): ?pending=<id> → μπες σε completion mode (κωδικός).
    const pend = (qp.get("pending") || "").trim() || (typeof window !== "undefined" ? window.localStorage.getItem("signup_pending") || "" : "");
    if (pend) setPendingId(pend);
    const wanted = (qp.get("package") || qp.get("plan") || "").trim().toLowerCase();
    api<{ packages: Pkg[]; sla: Sla[]; addons?: Addon[]; payment_methods?: { id: string; label: { el: string; en: string } }[] }>("/onboarding/packages")
      .then((r) => {
        setPkgs(r.packages || []); setSlaTiers(r.sla || []); setAddonCat(r.addons || []);
        const pm = r.payment_methods || [];
        setPayMethods(pm); if (pm.length) setPayChoice(pm[0].id);
        if (r.packages?.length) {
          const pre = r.packages.find((p) => p._id.toLowerCase() === wanted) || r.packages[0];
          setPkgCode(pre._id);
        }
        // Προτεινόμενο SLA από default = Basic (αλλιώς φθηνότερο/αργότερο tier)
        if (r.sla?.length) setSla(defaultSla(r.sla));
      })
      .catch(() => { /* leave empty → manual */ });
  }, []);

  const pkg = pkgs.find((p) => p._id === pkgCode);
  const slaObj = slaTiers.find((s) => s._id === sla);
  const yearly = billing === "yearly";
  const per = yearly ? "έτος" : "μήνα";
  const basePrice = (yearly ? pkg?.price_yearly : pkg?.price_monthly) ?? 0;
  // ΒΑΣΗ: 1 δωρεάν ταυτόχρονος χρήστης σε ΚΑΘΕ πλάνο. pkg.seats = το ΑΝΩΤΑΤΟ όριο («έως N»).
  const includedFree = 1;
  const maxSeats = Math.max(1, pkg?.seats ?? 1);      // ΜΕΓΙΣΤΟ όριο πλάνου («έως N»)
  const extraUsers = Math.max(0, seats - includedFree);   // έξτρα πάνω από τη βάση (1) → χρεώσιμα
  // κάθε card_* → ροή «card» (card-capture ανά ενεργό πάροχο)· bank_transfer → «bank» (τιμολόγιο IBAN)
  const payMethod: "card" | "bank" = payChoice.startsWith("card") ? "card" : "bank";
  const cardProviderName = payChoice === "card_viva" ? "Viva (κάρτα / IRIS)" : payChoice === "card_revolut" ? "Revolut" : payChoice === "card_alpha" ? "Alpha Bank" : "τον πάροχο πληρωμής";
  const extraRate = (yearly ? pkg?.extra_user_price_yearly : pkg?.extra_user_price) ?? 0;
  const extraTotal = extraUsers * extraRate;
  const slaPrice = (yearly ? slaObj?.price_yearly : slaObj?.price_monthly) ?? 0;
  // which billing cycles this package offers (default both)
  const cycles = (pkg?.billing_cycles && pkg.billing_cycles.length ? pkg.billing_cycles : ["monthly", "yearly"]) as ("monthly" | "yearly")[];
  // add-ons available to buy = the ones THIS package offers (legacy: all), minus those already in its plan
  const pkgAddonIds = pkg?.available_addons ?? addonCat.map((a) => a._id);
  const availAddons = addonCat.filter((a) => pkgAddonIds.includes(a._id) && !(pkg?.modules ?? []).includes(a._id));
  const addonsTotal = availAddons.filter((a) => selAddons.includes(a._id))
    .reduce((s, a) => s + ((yearly ? a.price_yearly : a.price_monthly) ?? 0), 0);
  const price = basePrice + slaPrice + extraTotal + addonsTotal;   // καθαρό σύνολο (αν οι τιμές είναι καθαρές)
  const isTrial = price === 0;   // δωρεάν trial πακέτο (μηδενικό κόστος) → καμία πληρωμή
  // ΦΠΑ: οι τιμές πακέτων είναι καθαρές → προσθέτουμε ΦΠΑ χώρας· η ΤΕΛΙΚΗ τιμή (gross) χρεώνεται στην κάρτα
  const vatRate = company.country === "CY" ? 19 : 24;
  const incVat = !!pkg?.price_includes_vat;
  const grossPrice = incVat ? price : Math.round(price * (1 + vatRate / 100));
  const netPrice = incVat ? Math.round(price / (1 + vatRate / 100)) : price;
  const vatAmount = grossPrice - netPrice;
  // when the package changes: default seats to 1 (base), drop add-ons now bundled in the plan,
  // and switch the billing cycle if not offered. Ο πελάτης ανεβάζει έξτρα χρήστες χειροκίνητα (χρεώσιμοι).
  useEffect(() => { setSeats(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pkgCode]);
  useEffect(() => { setSelAddons((sel) => sel.filter((id) => availAddons.some((a) => a._id === id))); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pkgCode]);
  useEffect(() => { if (!cycles.includes(billing)) setBilling(cycles[0]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pkgCode]);

  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
    let out = "";
    const rnd = typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(14)) : null;
    for (let i = 0; i < 14; i++) out += chars[(rnd ? rnd[i] : Math.floor(Math.random() * 1e9)) % chars.length];
    setAdmin((a) => ({ ...a, password: out })); setShowPw(true);
  }

  const C = (k: keyof Company) => ({ value: company[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setCompany((c) => ({ ...c, [k]: e.target.value })) });
  const A = (k: keyof Admin) => ({ value: admin[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAdmin((a) => ({ ...a, [k]: e.target.value })) });

  function choosePkg(code: string) {
    setPkgCode(code);
    // Δεν επιβάλλουμε το SLA του πακέτου — κρατάμε το προτεινόμενο (Basic) ή την επιλογή του χρήστη·
    // αν για κάποιο λόγο δεν έχει οριστεί SLA, επανάφερε στο Basic.
    if (!sla) setSla(defaultSla(slaTiers));
  }

  async function lookupAade() {
    const afm = company.afm.trim();
    if (!/^\d{9}$/.test(afm)) { setAade({ loading: false, msg: "Το ΑΦΜ πρέπει να έχει 9 ψηφία." }); return; }
    setAade({ loading: true, msg: null });
    try {
      const r = await api<Aade>(`/onboarding/aade/${afm}`);
      if (r.ok) {
        setCompany((c) => ({ ...c, name: r.name || c.name, title: r.title || c.title, doy: r.doy || c.doy, address: r.address || c.address, postal_code: r.postal_code || c.postal_code, city: r.city || c.city }));
        setAade({ loading: false, msg: r.active === false ? "⚠️ Η επιχείρηση εμφανίζεται ανενεργή στην ΑΑΔΕ." : "✓ Συμπληρώθηκαν τα στοιχεία από την ΑΑΔΕ." });
      } else {
        setAade({ loading: false, msg: r.error === "aade_not_configured" ? "Η σύνδεση ΑΑΔΕ δεν έχει ρυθμιστεί ακόμη — συμπλήρωσε χειροκίνητα." : r.error === "not_found" ? "Δεν βρέθηκε ΑΦΜ." : "Αποτυχία αναζήτησης — συμπλήρωσε χειροκίνητα." });
      }
    } catch { setAade({ loading: false, msg: "Αποτυχία σύνδεσης — συμπλήρωσε χειροκίνητα." }); }
  }

  const step0ok = company.name.trim().length > 1 && company.email.includes("@");
  const step1ok = !!pkgCode;
  const ownerInfoOk = !!admin.full_name.trim() && admin.email.includes("@");   // κωδικός ΟΧΙ εδώ
  const canNext = step === STEP.COMPANY ? step0ok : step === STEP.PACKAGE ? step1ok : step === STEP.OWNER ? ownerInfoOk : true;

  // completion mode: poll την κατάσταση της pending μέχρι «paid» (μετά την επιστροφή από Viva)
  useEffect(() => {
    if (!pendingId) return;
    let stop = false;
    const poll = async () => {
      try {
        const s = await api<{ status: string; owner_email?: string; owner_name?: string; is_trial?: boolean }>(`/onboarding/register-status/${pendingId}`);
        if (stop) return;
        setPendingStatus(s.status); setPendingTrial(!!s.is_trial);
        if (s.owner_email) setAdmin((a) => ({ ...a, email: s.owner_email!, full_name: a.full_name || s.owner_name || "" }));
        if (s.status !== "paid" && s.status !== "approved" && s.status !== "completed") setTimeout(poll, 2500);
      } catch { if (!stop) setTimeout(poll, 3000); }
    };
    poll();
    return () => { stop = true; };
  }, [pendingId]);

  // βήμα «Επόμενο» — στο βήμα εταιρείας ελέγχει διπλότυπο ΑΦΜ πριν προχωρήσει
  async function goNext() {
    setAfmErr(null);
    if (step === STEP.COMPANY) {
      const afm = company.afm.trim();
      if (/^\d{9}$/.test(afm)) {
        try {
          const r = await api<{ exists: boolean; blocked?: boolean; reactivation?: boolean }>(`/onboarding/check-afm/${afm}`);
          // ενεργή πληρωμένη συνδρομή → μπλοκ (σύνδεση). Ληγμένο/trial → επιτρέπεται (reactivation).
          if (r.blocked) { setAfmErr("Υπάρχει ήδη ενεργή συνδρομή για αυτό το ΑΦΜ."); return; }
          setReactivation(!!r.reactivation);
        } catch { /* μη-blocking: ο server ξαναελέγχει στο intent */ }
      }
    }
    setStep((s) => s + 1);
  }

  // ΠΛΗΡΩΜΗ-ΠΡΩΤΑ: δημιουργεί pending & πάει Viva (κάρτα) ή αναμονή έγκρισης (τράπεζα). ΚΑΝΕΝΑΣ λογαριασμός ακόμα.
  async function startPayment() {
    setErr(null); setBusy(true);
    try {
      const r = await api<{ pending_id: string; checkout_url?: string; status?: string; trial?: boolean; reactivation?: boolean }>("/onboarding/register-intent", {
        method: "POST",
        body: JSON.stringify({
          pharmacy_name: company.title || company.name, country: company.country,
          owner_email: admin.email, owner_name: admin.full_name,
          company, package_code: pkgCode || "standard", billing_cycle: billing, sla: sla || undefined,
          seats, payment_method: payMethod, addons: selAddons,
        }),
      });
      if (r.reactivation) setReactivation(true);
      if (r.checkout_url) {                                                    // κάρτα → Viva
        if (typeof window !== "undefined" && r.pending_id) window.localStorage.setItem("signup_pending", r.pending_id);
        window.location.href = r.checkout_url; return;
      }
      if (r.pending_id && (r.trial || r.status === "paid")) {                  // δωρεάν trial → κατευθείαν κωδικός
        setPendingTrial(!!r.trial); setPendingStatus("paid"); setPendingId(r.pending_id); setBusy(false); return;
      }
      setBankSubmitted(true); setBusy(false);                                  // (bank fallback — ανενεργό)
    } catch (e) {
      const detail = e instanceof ApiError ? ((e.problem as { detail?: { error?: string } })?.detail?.error) : "";
      setErr(detail === "already_had_trial" ? "Έχεις ήδη χρησιμοποιήσει τη δωρεάν δοκιμή — επίλεξε ένα πληρωμένο πακέτο για να συνεχίσεις."
        : detail === "afm_already_registered" ? "Υπάρχει ήδη ενεργή συνδρομή για αυτό το ΑΦΜ."
        : detail === "email_already_registered" ? "Υπάρχει ήδη ενεργή συνδρομή με αυτό το email. Συνδέσου στον λογαριασμό σου."
        : "Δεν ξεκίνησε η πληρωμή. Δοκίμασε ξανά.");
      setBusy(false);
    }
  }

  // ΤΕΛΙΚΟ ΒΗΜΑ (μετά την πληρωμή): ο πελάτης βάζει κωδικό → δημιουργείται ο λογαριασμός & μπαίνει.
  async function completeRegistration() {
    setErr(null); setBusy(true);
    try {
      const res = await api<RegisterResponse>("/onboarding/register-complete", {
        method: "POST",
        body: JSON.stringify({ pending_id: pendingId, password: admin.password, full_name: admin.full_name || undefined }),
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem("access_token", res.access_token);
        window.localStorage.setItem("refresh_token", res.refresh_token);
        window.localStorage.removeItem("signup_pending");
      }
      router.push("/onboarding");
    } catch (e) {
      const detail = e instanceof ApiError ? ((e.problem as { detail?: { error?: string } })?.detail?.error) : "";
      setErr(detail === "payment_not_confirmed" ? "Η πληρωμή δεν έχει επιβεβαιωθεί ακόμη — περίμενε λίγο."
        : detail === "already_completed" ? "Ο λογαριασμός δημιουργήθηκε ήδη — πήγαινε στη Σύνδεση."
        : "Η ολοκλήρωση απέτυχε. Δοκίμασε ξανά.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-4xl px-4 py-8">
        {/* header + progress */}
        <div className="mb-6 flex items-center justify-between">
          <a href="/login" className="text-sm text-slate-500 hover:text-slate-700">← Σύνδεση</a>
          <Logo subtitle={false} markClassName="h-8 w-8" />
        </div>
        {reactivation && (
          <div className="mx-auto mb-4 max-w-2xl rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
            <b>Καλώς ήρθες πάλι!</b> Βρήκαμε τον λογαριασμό σου με ληγμένη/δοκιμαστική συνδρομή. Επίλεξε ένα πληρωμένο πακέτο και μετά την πληρωμή <b>ο ΙΔΙΟΣ λογαριασμός σου ενεργοποιείται ξανά</b> (δεν δημιουργείται νέος). Η δωρεάν δοκιμή δεν είναι διαθέσιμη ξανά.
          </div>
        )}
        {pendingId ? (
          <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            {(pendingStatus === "paid" || pendingStatus === "approved") ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-emerald-700"><Check className="h-5 w-5" /><h2 className="text-xl font-bold">{pendingTrial ? "Σχεδόν έτοιμα!" : "Η πληρωμή ολοκληρώθηκε ✓"}</h2></div>
                <p className="text-sm text-slate-500">Όρισε τον κωδικό σου για να {pendingTrial ? "ξεκινήσει η δωρεάν δοκιμή" : "ενεργοποιηθεί ο λογαριασμός"}. Θα συνδέεσαι με το email <b>{admin.email || "—"}</b>.</p>
                {!admin.full_name && <div><label className={label}>Ονοματεπώνυμο *</label><input className={input} {...A("full_name")} autoComplete="name" /></div>}
                <div>
                  <div className="flex items-center justify-between"><label className={label}>Κωδικός *</label><button type="button" onClick={genPassword} className="mb-1 text-[11px] font-medium text-brand-600 hover:underline">Αυτόματη δημιουργία</button></div>
                  <div className="relative"><input className={`${input} pr-10`} {...A("password")} type={showPw ? "text" : "password"} autoComplete="new-password" /><button type="button" onClick={() => setShowPw((s) => !s)} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-slate-400">{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
                  <p className="mt-1 text-[11px] text-slate-400">Τουλάχιστον 8 χαρακτήρες — ή «Αυτόματη δημιουργία».</p>
                </div>
                {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
                <button type="button" disabled={admin.password.length < 8 || busy} onClick={completeRegistration} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Ολοκλήρωση & Είσοδος</button>
              </div>
            ) : pendingStatus === "completed" ? (
              <div className="space-y-3 py-4 text-center">
                <Check className="mx-auto h-8 w-8 text-emerald-600" />
                <h2 className="text-lg font-bold text-slate-900">Ο λογαριασμός δημιουργήθηκε ήδη</h2>
                <a href="/login" className="inline-block rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white">Σύνδεση</a>
              </div>
            ) : (
              <div className="space-y-3 py-6 text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand-600" />
                <h2 className="text-lg font-bold text-slate-900">Επιβεβαιώνουμε την πληρωμή…</h2>
                <p className="text-sm text-slate-500">Με κάρτα είναι άμεσο. Με <b>IRIS</b> μπορεί να χρειαστούν λίγα λεπτά — μπορείς να περιμένεις εδώ ή να κλείσεις: θα λάβεις <b>email με σύνδεσμο</b> για να ορίσεις τον κωδικό σου μόλις επιβεβαιωθεί.</p>
                <p className="text-xs text-slate-400">Ακύρωσες ή δεν ολοκλήρωσες την πληρωμή;</p>
                <button type="button" onClick={() => { if (typeof window !== "undefined") window.localStorage.removeItem("signup_pending"); window.location.href = "/register"; }} className="text-sm font-medium text-brand-600 hover:underline">Ξεκίνα ξανά</button>
              </div>
            )}
          </div>
        ) : (<>
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${((step + 1) / N) * 100}%` }} />
        </div>
        <div className="mb-6 flex justify-between text-[11px] text-slate-400"><span>Βήμα {step + 1} / {N}</span><span>{Math.round(((step + 1) / N) * 100)}%</span></div>

        <div className="grid gap-6 md:grid-cols-[220px_1fr]">
          {/* step rail */}
          <nav className="hidden space-y-1 md:block">
            {STEPS.map((s, i) => {
              const Icon = s.icon; const done = i < step; const cur = i === step;
              return (
                <div key={i} className={`flex items-start gap-3 rounded-xl p-3 ${cur ? "bg-brand-50 ring-1 ring-brand-200" : ""}`}>
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${done ? "bg-emerald-100 text-emerald-600" : cur ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-400"}`}>{done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}</span>
                  <div className="min-w-0"><div className={`text-sm font-semibold ${cur ? "text-brand-700" : "text-slate-700"}`}>{s.title}</div><div className="text-[11px] text-slate-400">{s.sub}</div></div>
                </div>
              );
            })}
          </nav>

          {/* step content */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            {step === 0 && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900">Στοιχεία Πελάτη</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><label className={label}>Επωνυμία *</label><input className={input} {...C("name")} placeholder="π.χ. ΦΑΡΜΑΚΕΙΟ Α.Ε." /></div>
                  <div><label className={label}>Διακριτικός Τίτλος</label><input className={input} {...C("title")} /></div>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-1">
                    <label className={label}>ΑΦΜ / VAT</label>
                    <div className="flex gap-1.5">
                      <input className={input} {...C("afm")} placeholder="999999999" inputMode="numeric" />
                      <Tooltip label="Αναζήτηση ΑΑΔΕ"><button type="button" onClick={lookupAade} disabled={aade.loading} className="shrink-0 rounded-lg border border-slate-300 px-2.5 text-slate-600 hover:bg-slate-50">{aade.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}</button></Tooltip>
                    </div>
                  </div>
                  <div><label className={label}>ΔΟΥ</label><input className={input} {...C("doy")} /></div>
                  <div><label className={label}>Χώρα *</label><select className={input} {...C("country")}><option value="GR">Ελλάδα</option><option value="CY">Κύπρος</option></select></div>
                </div>
                {aade.msg && <p className="text-xs text-slate-500">{aade.msg}</p>}
                {afmErr && (
                  <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    {afmErr} <a href="/login" className="font-semibold underline">Σύνδεση</a> · <a href="/forgot-password" className="font-semibold underline">Ξέχασα τον κωδικό</a>
                  </div>
                )}
                <p className="text-[11px] text-brand-600">Πληκτρολόγησε ΑΦΜ και πάτησε αναζήτηση για αυτόματη συμπλήρωση από ΑΑΔΕ.</p>
                <hr className="border-slate-100" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><label className={label}>Email Επικοινωνίας *</label><input className={input} {...C("email")} type="email" /></div>
                  <div><label className={label}>Τηλέφωνο</label><input className={input} {...C("phone")} /></div>
                  <div><label className={label}>Email Τιμολόγησης</label><input className={input} {...C("billing_email")} type="email" /></div>
                  <div><label className={label}>Website</label><input className={input} {...C("website")} placeholder="https://" /></div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><label className={label}>Διεύθυνση</label><input className={input} {...C("address")} /></div>
                  <div><label className={label}>ΤΚ</label><input className={input} {...C("postal_code")} /></div>
                  <div><label className={label}>Πόλη</label><input className={input} {...C("city")} /></div>
                  <div><label className={label}>Περιοχή</label><input className={input} {...C("region")} /></div>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-5">
                <h2 className="text-xl font-bold text-slate-900">Πακέτο Συνδρομής</h2>
                {pkgs.length === 0 ? (
                  <div className="rounded-xl border border-slate-200 p-4 text-sm text-slate-500">Φόρτωση πακέτων…</div>
                ) : (
                  <div>
                    <label className={label}>Επιλογή Πακέτου</label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {pkgs.map((p) => {
                        const pp = (billing === "yearly" ? p.price_yearly : p.price_monthly) ?? 0;
                        const sel = p._id === pkgCode;
                        return (
                          <button key={p._id} type="button" onClick={() => choosePkg(p._id)} className={`rounded-xl border-2 p-4 text-left transition ${sel ? "border-brand-400 bg-brand-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                            <div className="flex items-center justify-between"><div className="font-semibold text-slate-900">{p.name || p._id}</div>{sel && <Check className="h-4 w-4 text-brand-600" />}</div>
                            {p.description && <div className="mt-0.5 text-xs text-slate-500">{p.description}</div>}
                            <div className="mt-2 text-xl font-bold text-brand-700">{eur(pp)}<span className="text-xs font-normal text-slate-400">/{billing === "yearly" ? "έτος" : "μήνα"}{p.price_includes_vat ? "" : " + ΦΠΑ"}</span></div>
                            {(p.trial_days ?? 0) > 0 && <div className="mt-1 text-[11px] text-emerald-600">✓ {p.trial_days} ημέρες δωρεάν δοκιμή</div>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {cycles.length > 0 && (
                  <div>
                    <label className={label}>Κύκλος Τιμολόγησης</label>
                    <div className={`grid gap-3 ${cycles.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                      {cycles.map((bc) => (
                        <button key={bc} type="button" onClick={() => setBilling(bc)} className={`rounded-xl border-2 p-3 text-left ${billing === bc ? "border-brand-400 bg-brand-50/50" : "border-slate-200"}`}>
                          <div className="font-medium text-slate-800">{bc === "monthly" ? "Μηνιαία" : "Ετήσια"}</div>
                          <div className="text-xs text-slate-500">{bc === "monthly" ? eur(pkg?.price_monthly ?? 0) + "/μήνα" : eur(pkg?.price_yearly ?? 0) + "/έτος"}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {slaTiers.length > 0 && (
                  <div>
                    <label className={label}>SLA / Υποστήριξη</label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {slaTiers.map((s) => (
                        <button key={s._id} type="button" onClick={() => setSla(s._id)} className={`rounded-xl border-2 p-3 text-left ${sla === s._id ? "border-brand-400 bg-brand-50/50" : "border-slate-200"}`}>
                          <div className="font-medium text-slate-800">{s.name || s._id}</div>
                          <div className="text-xs text-slate-500">{s.description || (s.response_hours ? `Απόκριση ${s.response_hours}ω` : "")}{s.channels ? ` · ${s.channels}` : ""}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* add-ons (à-la-carte, optional) */}
                {availAddons.length > 0 && (
                  <div>
                    <label className={label}>Πρόσθετα (προαιρετικά)</label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {availAddons.map((a) => {
                        const on = selAddons.includes(a._id);
                        const ap = (yearly ? a.price_yearly : a.price_monthly) ?? 0;
                        return (
                          <button key={a._id} type="button" onClick={() => setSelAddons((s) => on ? s.filter((x) => x !== a._id) : [...s, a._id])}
                            className={`flex items-start gap-2 rounded-xl border-2 p-3 text-left transition ${on ? "border-brand-400 bg-brand-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                            <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300"}`}>{on && <Check className="h-3 w-3" />}</span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center justify-between gap-2"><span className="font-medium text-slate-800">{a.icon} {a.name}</span><span className="shrink-0 text-sm font-bold text-brand-700">+{eur(ap)}<span className="text-[10px] font-normal text-slate-400">/{per}</span></span></span>
                              {a.description && <span className="mt-0.5 block text-[11px] text-slate-500">{a.description}</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* concurrent users + cost breakdown */}
                <div>
                  <label className={label}>Ταυτόχρονοι χρήστες</label>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setSeats((n) => Math.max(1, n - 1))} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 text-lg text-slate-600 hover:bg-slate-50">−</button>
                    <input type="number" min={1} max={maxSeats} value={seats} onChange={(e) => setSeats(Math.min(maxSeats, Math.max(1, parseInt(e.target.value) || 1)))} className={`${input} w-20 text-center`} />
                    <button type="button" disabled={seats >= maxSeats} onClick={() => setSeats((n) => Math.min(maxSeats, n + 1))} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 text-lg text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">+</button>
                    <span className="text-xs text-slate-400">{extraUsers > 0 ? <>1 βάση + {extraUsers} έξτρα (έως {maxSeats})</> : <>1 χρήστης (έως {maxSeats} στο πακέτο)</>}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-2 text-xs font-semibold text-slate-500">Ανάλυση κόστους ({yearly ? "ετήσια" : "μηνιαία"})</div>
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><dt className="text-slate-600">{pkg?.name || "Πακέτο"}</dt><dd className="font-medium text-slate-800">{eur(basePrice)}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-600">SLA{slaObj?.name ? ` · ${slaObj.name}` : ""}</dt><dd className="font-medium text-slate-800">{slaPrice ? eur(slaPrice) : "—"}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-600">Έξτρα χρήστες {extraUsers > 0 ? `(${extraUsers} × ${eur(extraRate)})` : ""}</dt><dd className="font-medium text-slate-800">{extraTotal ? eur(extraTotal) : "—"}</dd></div>
                    {availAddons.filter((a) => selAddons.includes(a._id)).map((a) => (
                      <div key={a._id} className="flex justify-between"><dt className="text-slate-600">{a.icon} {a.name}</dt><dd className="font-medium text-slate-800">{eur((yearly ? a.price_yearly : a.price_monthly) ?? 0)}</dd></div>
                    ))}
                    {!isTrial && (
                      <>
                        <div className="flex justify-between border-t border-slate-200 pt-2"><dt className="text-slate-600">Καθαρή αξία</dt><dd className="font-medium text-slate-800">{eur(netPrice)}</dd></div>
                        <div className="flex justify-between"><dt className="text-slate-600">Φ.Π.Α {vatRate}%</dt><dd className="font-medium text-slate-800">{eur(vatAmount)}</dd></div>
                      </>
                    )}
                    <div className="mt-1 flex justify-between border-t border-slate-200 pt-2 text-base"><dt className="font-semibold text-slate-900">Τελική τιμή</dt><dd className="font-bold text-brand-700">{eur(isTrial ? 0 : grossPrice)}<span className="text-xs font-normal text-slate-400">/{per}</span></dd></div>
                  </dl>
                </div>
              </div>
            )}

            {step === STEP.OWNER && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900">Στοιχεία Owner</h2>
                <div className="rounded-xl bg-brand-50 p-3 text-sm text-brand-800"><b>Ο κύριος χρήστης (owner).</b> Ο κωδικός σύνδεσης ορίζεται <b>στο τελευταίο βήμα</b>.</div>
                <div><label className={label}>Ονοματεπώνυμο *</label><input className={input} {...A("full_name")} autoComplete="name" /></div>
                <div><label className={label}>Email (username) *</label><input className={input} {...A("email")} type="email" autoComplete="email" /><p className="mt-1 text-[11px] text-slate-400">Θα χρησιμοποιηθεί για σύνδεση & ειδοποιήσεις.</p></div>
              </div>
            )}

            {step === STEP.PAYMENT && isTrial && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900">Δωρεάν δοκιμή</h2>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                  Το πακέτο <b>{pkg?.name || "δοκιμής"}</b> είναι <b>δωρεάν</b> — καμία πληρωμή, καμία κάρτα. Έχεις <b>πλήρη πρόσβαση</b> σε όλο το πρόγραμμα. Στο επόμενο βήμα ορίζεις τον κωδικό σου και ξεκινάς.
                </div>
                {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
              </div>
            )}

            {step === STEP.PAYMENT && !isTrial && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900">Πληρωμή</h2>
                <p className="text-sm text-slate-500">Ο λογαριασμός <b>ενεργοποιείται μόλις ολοκληρωθεί η πληρωμή</b>. Ο κωδικός σύνδεσης ορίζεται αμέσως μετά.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {payMethods.map((m) => {
                    const card = m.id.startsWith("card"); const active = payChoice === m.id;
                    return (
                      <button key={m.id} type="button" onClick={() => setPayChoice(m.id)} className={`rounded-xl border-2 p-4 text-left ${active ? "border-brand-400 bg-brand-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                        <div className="flex items-center gap-2 font-semibold text-slate-900">{card ? <CreditCard className="h-4 w-4 text-brand-600" /> : <Landmark className="h-4 w-4 text-brand-600" />} {m.label.el} {active && <Check className="ml-auto h-4 w-4 text-brand-600" />}</div>
                        <div className="mt-1 text-xs text-slate-500">{card ? "Πληρωμή τώρα (κάρτα ή IRIS). Η κάρτα αποθηκεύεται για ανανεώσεις & χρεώσεις υπηρεσιών." : "Θα ελεγχθεί/πιστοποιηθεί η κατάθεση από εμάς και θα λάβεις link στο email για να ολοκληρώσεις."}</div>
                      </button>
                    );
                  })}
                </div>
                {payMethods.length === 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">Δεν υπάρχει διαθέσιμος τρόπος πληρωμής αυτή τη στιγμή — επικοινώνησε μαζί μας.</div>
                )}
                <div className="rounded-xl bg-brand-50/60 p-3 text-xs text-brand-800">
                  <b>Σύνοψη:</b> {company.title || company.name || "—"} · {pkg?.name || pkgCode} · {yearly ? "ετήσια" : "μηνιαία"} · {seats} χρήστες · SLA: {slaObj?.name || sla || "—"} · <b>Πληρωτέο τώρα: {eur(isTrial ? 0 : grossPrice)}</b> (με ΦΠΑ)
                </div>
                {payMethod === "card" && payChoice && (
                  <div className="rounded-xl border border-slate-200 p-3 text-xs text-slate-500">Θα μεταφερθείς σε ασφαλές περιβάλλον {cardProviderName} για την πληρωμή <b>{eur(price)}</b>. Μόλις ολοκληρωθεί, επιστρέφεις για να ορίσεις τον κωδικό σου.</div>
                )}
                {bankSubmitted && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">Το αίτημα καταχωρήθηκε. Μόλις <b>πιστοποιήσουμε την κατάθεση</b>, θα λάβεις email με link για να ολοκληρώσεις την εγγραφή.</div>
                )}
                {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
              </div>
            )}

            {/* nav */}
            {!bankSubmitted && (
            <div className="mt-6 flex items-center justify-between">
              <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} className={`inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 ${step === 0 ? "invisible" : ""}`}><ArrowLeft className="h-4 w-4" /> Προηγούμενο</button>
              {step < N - 1 ? (
                <button type="button" disabled={!canNext} onClick={goNext} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50">Επόμενο <ArrowRight className="h-4 w-4" /></button>
              ) : (
                <button type="button" disabled={(!isTrial && !payChoice) || busy} onClick={startPayment} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />} {isTrial ? "Ξεκίνα δωρεάν δοκιμή" : payMethod === "card" ? `Πλήρωσε ${eur(price)}` : "Καταχώρηση αιτήματος"}</button>
              )}
            </div>
            )}
          </div>
        </div>
        </>)}
        <div className="mt-8">
          <PoweredBy />
        </div>
      </div>
    </div>
  );
}
