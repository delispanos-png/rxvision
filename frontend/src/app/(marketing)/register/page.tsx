"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Package, UserCog, Search, Check, ArrowRight, ArrowLeft, Eye, EyeOff, Loader2, CreditCard } from "lucide-react";
import { api, ApiError } from "@/lib/apiClient";

type Company = {
  name: string; title: string; afm: string; doy: string; country: "GR" | "CY";
  email: string; billing_email: string; phone: string; website: string;
  address: string; postal_code: string; city: string; region: string;
};
type Admin = { full_name: string; email: string; password: string };
type RegisterResponse = { access_token: string; refresh_token: string; tenant_id: string };
type Aade = { ok: boolean; error?: string; name?: string; title?: string; doy?: string; address?: string; postal_code?: string; city?: string; active?: boolean };

const PRICE = { monthly: 4500, yearly: 38000 };
const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(c / 100);
const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-500";
const label = "mb-1 block text-xs font-medium text-slate-600";

const STEPS = [
  { icon: Building2, title: "Στοιχεία Πελάτη", sub: "Επωνυμία, ΑΦΜ, επικοινωνία" },
  { icon: Package, title: "Προϊόν & Πακέτο", sub: "Επιλογή πακέτου, billing, SLA" },
  { icon: UserCog, title: "Διαχειριστής & Ενεργοποίηση", sub: "Λογαριασμός + πληρωμή" },
];

export default function RegisterWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [company, setCompany] = useState<Company>({ name: "", title: "", afm: "", doy: "", country: "GR", email: "", billing_email: "", phone: "", website: "", address: "", postal_code: "", city: "", region: "" });
  const [pkg, setPkg] = useState({ billing_cycle: "yearly" as "monthly" | "yearly", sla: "basic" as "basic" | "professional" });
  const [admin, setAdmin] = useState<Admin>({ full_name: "", email: "", password: "" });
  const [showPw, setShowPw] = useState(false);
  const [aade, setAade] = useState<{ loading: boolean; msg: string | null }>({ loading: false, msg: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const C = (k: keyof Company) => ({ value: company[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setCompany((c) => ({ ...c, [k]: e.target.value })) });
  const A = (k: keyof Admin) => ({ value: admin[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAdmin((a) => ({ ...a, [k]: e.target.value })) });

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

  const step1ok = company.name.trim().length > 1 && company.email.includes("@");
  const step3ok = admin.full_name.trim() && admin.email.includes("@") && admin.password.length >= 8;

  async function payWithRevolut(token: string, mode: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const w = window as unknown as { RevolutCheckout?: (t: string, m: string) => Promise<{ payWithPopup: (o: Record<string, () => void>) => void }> };
      const run = () => {
        if (!w.RevolutCheckout) return resolve();
        w.RevolutCheckout(token, mode === "live" ? "prod" : "sandbox")
          .then((rc) => rc.payWithPopup({ onSuccess: resolve, onError: resolve, onCancel: resolve }))
          .catch(() => resolve());
      };
      if (w.RevolutCheckout) return run();
      const s = document.createElement("script");
      s.src = mode === "live" ? "https://merchant.revolut.com/embed.js" : "https://sandbox-merchant.revolut.com/embed.js";
      s.onload = run; s.onerror = () => resolve();
      document.body.appendChild(s);
    });
  }

  async function activate() {
    setErr(null); setBusy(true);
    try {
      const res = await api<RegisterResponse>("/onboarding/register", {
        method: "POST",
        body: JSON.stringify({
          pharmacy_name: company.title || company.name, country: company.country,
          email: admin.email, password: admin.password, full_name: admin.full_name,
          company, package_code: "standard", billing_cycle: pkg.billing_cycle, sla: pkg.sla,
        }),
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem("access_token", res.access_token);
        window.localStorage.setItem("refresh_token", res.refresh_token);
      }
      // capture the card via Revolut if configured; trial proceeds regardless
      try {
        const cc = await api<{ ok: boolean; token?: string; mode?: string }>("/billing/card-capture", { method: "POST" });
        if (cc.ok && cc.token) await payWithRevolut(cc.token, cc.mode || "sandbox");
      } catch { /* Revolut not configured → trial only */ }
      router.push("/onboarding");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? "Το email χρησιμοποιείται ήδη." : "Η ενεργοποίηση απέτυχε. Δοκίμασε ξανά.");
      setBusy(false);
    }
  }

  const price = PRICE[pkg.billing_cycle];

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-4xl px-4 py-8">
        {/* header + progress */}
        <div className="mb-6 flex items-center justify-between">
          <a href="/login" className="text-sm text-slate-500 hover:text-slate-700">← Σύνδεση</a>
          <div className="flex items-center gap-1.5 text-lg font-bold"><span className="text-brand-700">℞</span> RxVision</div>
        </div>
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${((step + 1) / 3) * 100}%` }} />
        </div>
        <div className="mb-6 flex justify-between text-[11px] text-slate-400"><span>Βήμα {step + 1} / 3</span><span>{Math.round(((step + 1) / 3) * 100)}%</span></div>

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
                      <button type="button" onClick={lookupAade} disabled={aade.loading} title="Αναζήτηση ΑΑΔΕ" className="shrink-0 rounded-lg border border-slate-300 px-2.5 text-slate-600 hover:bg-slate-50">{aade.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}</button>
                    </div>
                  </div>
                  <div><label className={label}>ΔΟΥ</label><input className={input} {...C("doy")} /></div>
                  <div><label className={label}>Χώρα *</label><select className={input} {...C("country")}><option value="GR">Ελλάδα</option><option value="CY">Κύπρος</option></select></div>
                </div>
                {aade.msg && <p className="text-xs text-slate-500">{aade.msg}</p>}
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
                <h2 className="text-xl font-bold text-slate-900">Προϊόν & Πακέτο</h2>
                <div>
                  <label className={label}>Επιλογή Προϊόντος</label>
                  <div className="flex items-center gap-3 rounded-xl border-2 border-brand-300 bg-brand-50/50 p-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white">℞</span><div><div className="font-semibold text-slate-900">RxVision</div><div className="text-xs text-slate-500">Ανάλυση εκτελέσεων συνταγών</div></div><Check className="ml-auto h-5 w-5 text-brand-600" /></div>
                </div>
                <div>
                  <label className={label}>Πακέτο Συνδρομής</label>
                  <div className="rounded-xl border border-slate-200 p-4"><div className="font-semibold text-slate-900">RxVision Standard</div><div className="mt-1 text-2xl font-bold text-brand-700">{eur(price)}<span className="text-sm font-normal text-slate-400">/{pkg.billing_cycle === "yearly" ? "έτος" : "μήνα"}</span></div><div className="mt-1 text-xs text-emerald-600">✓ 14 ημέρες δωρεάν δοκιμή</div></div>
                </div>
                <div>
                  <label className={label}>Κύκλος Τιμολόγησης</label>
                  <div className="grid grid-cols-2 gap-3">
                    {(["monthly", "yearly"] as const).map((bc) => (
                      <button key={bc} type="button" onClick={() => setPkg((p) => ({ ...p, billing_cycle: bc }))} className={`rounded-xl border-2 p-3 text-left ${pkg.billing_cycle === bc ? "border-brand-400 bg-brand-50/50" : "border-slate-200"}`}>
                        <div className="font-medium text-slate-800">{bc === "monthly" ? "Μηνιαία" : "Ετήσια"}</div>
                        <div className="text-xs text-slate-500">{bc === "monthly" ? eur(PRICE.monthly) + "/μήνα" : eur(PRICE.yearly) + "/έτος · έκπτωση ~30%"}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={label}>SLA / Υποστήριξη</label>
                  <div className="grid grid-cols-2 gap-3">
                    {([["basic", "Basic", "Email support, απόκριση 24ω"], ["professional", "Professional", "Τηλ. + email, απόκριση 4ω"]] as const).map(([v, t, d]) => (
                      <button key={v} type="button" onClick={() => setPkg((p) => ({ ...p, sla: v }))} className={`rounded-xl border-2 p-3 text-left ${pkg.sla === v ? "border-brand-400 bg-brand-50/50" : "border-slate-200"}`}><div className="font-medium text-slate-800">{t}</div><div className="text-xs text-slate-500">{d}</div></button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900">Διαχειριστής & Ενεργοποίηση</h2>
                <div className="rounded-xl bg-brand-50 p-3 text-sm text-brand-800"><b>Λογαριασμός Διαχειριστή</b> — θα τον χρησιμοποιείς για σύνδεση στο RxVision.</div>
                <div><label className={label}>Ονοματεπώνυμο *</label><input className={input} {...A("full_name")} autoComplete="name" /></div>
                <div><label className={label}>Email *</label><input className={input} {...A("email")} type="email" autoComplete="email" /><p className="mt-1 text-[11px] text-slate-400">Θα χρησιμοποιηθεί για σύνδεση & ειδοποιήσεις.</p></div>
                <div>
                  <label className={label}>Κωδικός *</label>
                  <div className="relative"><input className={`${input} pr-10`} {...A("password")} type={showPw ? "text" : "password"} autoComplete="new-password" /><button type="button" onClick={() => setShowPw((s) => !s)} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-slate-400">{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
                  <p className="mt-1 text-[11px] text-slate-400">Τουλάχιστον 8 χαρακτήρες.</p>
                </div>
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><CreditCard className="h-4 w-4 text-brand-600" /> Τρόπος Πληρωμής</div>
                  <p className="mt-1 text-xs text-slate-500"><b>14 ημέρες δωρεάν.</b> Η κάρτα θα ζητηθεί ασφαλώς μέσω Revolut· καμία χρέωση πριν λήξει η δοκιμή ({eur(price)}/{pkg.billing_cycle === "yearly" ? "έτος" : "μήνα"}). Ακύρωση οποτεδήποτε.</p>
                </div>
                {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
              </div>
            )}

            {/* nav */}
            <div className="mt-6 flex items-center justify-between">
              <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} className={`inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 ${step === 0 ? "invisible" : ""}`}><ArrowLeft className="h-4 w-4" /> Προηγούμενο</button>
              {step < 2 ? (
                <button type="button" disabled={step === 0 && !step1ok} onClick={() => setStep((s) => s + 1)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50">Επόμενο <ArrowRight className="h-4 w-4" /></button>
              ) : (
                <button type="button" disabled={!step3ok || busy} onClick={activate} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Ενεργοποίηση & Έναρξη Δοκιμής</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
