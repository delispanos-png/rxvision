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
type Pkg = { _id: string; name?: string; description?: string; price_monthly?: number; price_yearly?: number; trial_days?: number; seats?: number; sla?: string; extra_user_price?: number; extra_user_price_yearly?: number; modules?: string[]; available_addons?: string[]; billing_cycles?: string[] };
type Sla = { _id: string; name?: string; description?: string; response_hours?: number; channels?: string; price_monthly?: number; price_yearly?: number };
type Addon = { _id: string; name?: string; description?: string; icon?: string; price_monthly?: number; price_yearly?: number; features?: string[] };

const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);
const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-500";
const label = "mb-1 block text-xs font-medium text-slate-600";

const STEPS = [
  { icon: Building2, title: "Στοιχεία Πελάτη", sub: "Επωνυμία, ΑΦΜ, επικοινωνία" },
  { icon: Package, title: "Πακέτο & Χρήστες", sub: "Πακέτο, SLA, χρήστες, κόστος" },
  { icon: CreditCard, title: "Τρόπος Πληρωμής", sub: "Κάρτα ή τραπεζικό έμβασμα" },
  { icon: UserCog, title: "Λογαριασμός Owner", sub: "Username, email & κωδικός" },
];
const N = STEPS.length;
const STEP = { COMPANY: 0, PACKAGE: 1, PAYMENT: 2, OWNER: 3 } as const;

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
  const [payMethod, setPayMethod] = useState<"card" | "bank">("card");

  useEffect(() => {
    // Optional deep-link preselect from the marketing site: /register?package=pro (alias: ?plan=).
    const qp = new URLSearchParams(window.location.search);
    const wanted = (qp.get("package") || qp.get("plan") || "").trim().toLowerCase();
    api<{ packages: Pkg[]; sla: Sla[]; addons?: Addon[] }>("/onboarding/packages")
      .then((r) => {
        setPkgs(r.packages || []); setSlaTiers(r.sla || []); setAddonCat(r.addons || []);
        if (r.packages?.length) {
          const pre = r.packages.find((p) => p._id.toLowerCase() === wanted) || r.packages[0];
          setPkgCode(pre._id); if (pre.sla) setSla(pre.sla);
        }
        if (!r.packages?.[0]?.sla && r.sla?.length) setSla(r.sla[0]._id);
      })
      .catch(() => { /* leave empty → manual */ });
  }, []);

  const pkg = pkgs.find((p) => p._id === pkgCode);
  const slaObj = slaTiers.find((s) => s._id === sla);
  const yearly = billing === "yearly";
  const per = yearly ? "έτος" : "μήνα";
  const basePrice = (yearly ? pkg?.price_yearly : pkg?.price_monthly) ?? 0;
  // pkg.seats = το ΑΝΩΤΑΤΟ όριο χρηστών του πακέτου («έως N»), όχι ελάχιστο: ο πελάτης διαλέγει 1…N.
  const maxIncluded = Math.max(1, pkg?.seats ?? 1);
  // extra concurrent users beyond the package max are only allowed when the package prices them.
  const extraAllowed = ((pkg?.extra_user_price ?? 0) > 0) || ((pkg?.extra_user_price_yearly ?? 0) > 0);
  const maxSeats = extraAllowed ? 999 : maxIncluded;
  const extraUsers = Math.max(0, seats - maxIncluded);
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
  const price = basePrice + slaPrice + extraTotal + addonsTotal;   // full subscription value
  const trialDays = pkg?.trial_days ?? 14;
  // when the package changes: default seats to the package's max allowance (the customer can lower to 1),
  // drop add-ons now bundled in the plan, and switch the billing cycle if not offered.
  useEffect(() => { setSeats(maxIncluded); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pkgCode, maxIncluded]);
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
    const p = pkgs.find((x) => x._id === code);
    if (p?.sla) setSla(p.sla);
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
  const ownerOk = !!admin.full_name.trim() && admin.email.includes("@") && admin.password.length >= 8;
  const canNext = step === STEP.COMPANY ? step0ok : step === STEP.PACKAGE ? step1ok : true;

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
          company, package_code: pkgCode || "standard", billing_cycle: billing, sla: sla || undefined,
          seats, payment_method: payMethod, addons: selAddons,
        }),
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem("access_token", res.access_token);
        window.localStorage.setItem("refresh_token", res.refresh_token);
      }
      // card → capture via Revolut if configured; bank → skip (invoice with IBAN follows). Trial proceeds either way.
      if (payMethod === "card") {
        try {
          const cc = await api<{ ok: boolean; token?: string; mode?: string }>("/billing/card-capture", { method: "POST" });
          if (cc.ok && cc.token) await payWithRevolut(cc.token, cc.mode || "sandbox");
        } catch { /* Revolut not configured → trial only */ }
      }
      router.push("/onboarding");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? "Το email χρησιμοποιείται ήδη." : "Η ενεργοποίηση απέτυχε. Δοκίμασε ξανά.");
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
                            <div className="mt-2 text-xl font-bold text-brand-700">{eur(pp)}<span className="text-xs font-normal text-slate-400">/{billing === "yearly" ? "έτος" : "μήνα"}</span></div>
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
                    <span className="text-xs text-slate-400">{extraAllowed && extraUsers > 0 ? <>Έως {maxIncluded} + {extraUsers} έξτρα</> : <>Έως {maxIncluded} χρήστες σε αυτό το πακέτο</>}</span>
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
                    <div className="mt-1 flex justify-between border-t border-slate-200 pt-2 text-base"><dt className="font-semibold text-slate-900">Σύνολο</dt><dd className="font-bold text-brand-700">{eur(price)}<span className="text-xs font-normal text-slate-400">/{per}</span></dd></div>
                  </dl>
                </div>
              </div>
            )}

            {step === STEP.OWNER && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900">Λογαριασμός Owner</h2>
                <div className="rounded-xl bg-brand-50 p-3 text-sm text-brand-800"><b>Στοιχεία σύνδεσης</b> — με αυτά θα μπαίνεις (owner) στην πλατφόρμα RxVision.</div>
                <div><label className={label}>Ονοματεπώνυμο *</label><input className={input} {...A("full_name")} autoComplete="name" /></div>
                <div><label className={label}>Email (username) *</label><input className={input} {...A("email")} type="email" autoComplete="email" /><p className="mt-1 text-[11px] text-slate-400">Θα χρησιμοποιηθεί για σύνδεση & ειδοποιήσεις.</p></div>
                <div>
                  <div className="flex items-center justify-between"><label className={label}>Κωδικός *</label><button type="button" onClick={genPassword} className="mb-1 text-[11px] font-medium text-brand-600 hover:underline">Αυτόματη δημιουργία</button></div>
                  <div className="relative"><input className={`${input} pr-10`} {...A("password")} type={showPw ? "text" : "password"} autoComplete="new-password" /><button type="button" onClick={() => setShowPw((s) => !s)} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-slate-400">{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
                  <p className="mt-1 text-[11px] text-slate-400">Τουλάχιστον 8 χαρακτήρες — ή πάτησε «Αυτόματη δημιουργία» για ισχυρό κωδικό.</p>
                </div>
                <div className="rounded-xl bg-brand-50/60 p-3 text-xs text-brand-800">
                  <b>Σύνοψη:</b> {company.title || company.name || "—"} · {pkg?.name || pkgCode} · {yearly ? "ετήσια" : "μηνιαία"} · {seats} χρήστες · <b>{eur(price)}/{per}</b> · SLA: {slaObj?.name || sla || "—"} · Πληρωμή: {payMethod === "card" ? "κάρτα" : "τράπεζα"}
                </div>
                {err && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
              </div>
            )}

            {step === STEP.PAYMENT && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-slate-900">Τρόπος Πληρωμής</h2>
                <p className="text-sm text-slate-500"><b>{trialDays} ημέρες δωρεάν.</b> Επίλεξε πώς θα πληρώνεις μετά τη δοκιμή — καμία χρέωση τώρα. Ακύρωση οποτεδήποτε.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button type="button" onClick={() => setPayMethod("card")} className={`rounded-xl border-2 p-4 text-left ${payMethod === "card" ? "border-brand-400 bg-brand-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                    <div className="flex items-center gap-2 font-semibold text-slate-900"><CreditCard className="h-4 w-4 text-brand-600" /> Κάρτα {payMethod === "card" && <Check className="ml-auto h-4 w-4 text-brand-600" />}</div>
                    <div className="mt-1 text-xs text-slate-500">Ασφαλής αποθήκευση μέσω Revolut. Αυτόματη χρέωση στη λήξη της δοκιμής.</div>
                  </button>
                  <button type="button" onClick={() => setPayMethod("bank")} className={`rounded-xl border-2 p-4 text-left ${payMethod === "bank" ? "border-brand-400 bg-brand-50/50" : "border-slate-200 hover:border-slate-300"}`}>
                    <div className="flex items-center gap-2 font-semibold text-slate-900"><Landmark className="h-4 w-4 text-brand-600" /> Τραπεζικό έμβασμα {payMethod === "bank" && <Check className="ml-auto h-4 w-4 text-brand-600" />}</div>
                    <div className="mt-1 text-xs text-slate-500">Θα λάβεις τιμολόγιο με IBAN στο email τιμολόγησης πριν τη λήξη της δοκιμής.</div>
                  </button>
                </div>

                {payMethod === "card" && (
                  <div className="rounded-xl border border-slate-200 p-3 text-xs text-slate-500">Στην «Ενεργοποίηση» θα ανοίξει ασφαλές παράθυρο Revolut για να καταχωρήσεις την κάρτα. Χρέωση {eur(price)}/{per} μόνο μετά τη λήξη της δωρεάν δοκιμής.</div>
                )}
                {payMethod === "bank" && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                    Θα σου σταλεί τιμολόγιο ({eur(price)}/{per}) με τα στοιχεία τραπεζικού λογαριασμού (IBAN) στο <b>{company.billing_email || company.email || "email τιμολόγησης"}</b>. Η δοκιμή ξεκινά αμέσως.
                  </div>
                )}
              </div>
            )}

            {/* nav */}
            <div className="mt-6 flex items-center justify-between">
              <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} className={`inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 ${step === 0 ? "invisible" : ""}`}><ArrowLeft className="h-4 w-4" /> Προηγούμενο</button>
              {step < N - 1 ? (
                <button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50">Επόμενο <ArrowRight className="h-4 w-4" /></button>
              ) : (
                <button type="button" disabled={!ownerOk || busy} onClick={activate} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Ενεργοποίηση & Έναρξη Δοκιμής</button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-8">
          <PoweredBy />
        </div>
      </div>
    </div>
  );
}
