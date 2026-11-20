"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgePercent, Gift, ListChecks, Pencil, Plus, Trash2, Users, X } from "lucide-react";

import { ApiError, adminApi } from "@/lib/adminClient";
import { DateInput } from "@/components/ui/DateInput";
import { appAlert, appConfirm } from "@/store/dialogStore";

type Effect = { type: "discount_pct" | "discount_amount" | "free_module" | "addon_discount"; value?: number | null;
  on?: "package" | "total"; module?: string | null; days?: number | null; months?: number | null;
  to?: "buyer" | "referrer" | "both"; referral_only?: boolean };
type Promotion = {
  _id?: string; name: string; public_text: string; active: boolean; starts_on: string; ends_on: string;
  starts_at?: string; ends_at?: string; packages: string[]; cycles: ("monthly" | "yearly")[];
  customer: "new" | "returning" | "any"; code: string | null; requires_referral: boolean; exclusive: boolean;
  max_redemptions: number | null; effects: Effect[]; redeemed?: number;
  lock: { kind: "none" | "years" | "until" | "months"; years?: number | null; until_on?: string | null; months?: number | null } | null;
  show_on_site: boolean;
  // Ειδική προσφορά: μόνο για τα ΑΦΜ της λίστας, μία φορά ανά ΑΦΜ, ΕΝΑ πακέτο, κλειδωμένο για offer_months
  audience: "all" | "afm_list"; offer_months: number | null;
  payer?: "pharmacy" | "sponsor" | "split"; sponsor_id?: string | null; sponsor_pct?: number | null;
  afm_counts?: { total: number; invited: number; redeemed: number; verified?: number };
};
type AfmRow = { _id: string; afm: string; status: "invited" | "redeemed" | "verified"; added_at: string;
  email?: string | null; invite_sent_at?: string | null; invite_to?: string | null; invite_count?: number; mode?: "existing";
  starts_at?: string | null;
  redeemed_at?: string | null; verified_at?: string | null; tenant_name?: string | null;
  rejections?: { tenant_id: string; tenant_name?: string | null; reason: "afm_mismatch" | "not_verified"; hdika_afm?: string | null; at: string }[] };
type Option = { id: string; name?: string };
type Data = { items: Promotion[]; packages: Option[]; modules: Option[]; sponsors?: Option[] };
type Grant = { tenant_id: string; role: string; module: string; kind?: string; pct?: number; months?: number; days?: number; status: string; from?: string | null };
type Redemption = { _id: string; at: string; tenant_name?: string; referrer_name?: string; package?: string;
  cycle?: string; discount_net: number; grants: Grant[] };
type Gift = { kind?: "free" | "discount"; module: string; days?: number; pct?: number; months?: number; to: string };
type Preview = { promotions: { id: string; name: string; discount_net: number; inactive: boolean;
  gifts: Gift[] }[]; gross_before: number; gross_after: number };

const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";
const eur = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const day = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "—");
const today = () => new Date().toISOString().slice(0, 10);
const span = (days: number) => (days > 0 && days % 30 === 0 ? `${days / 30} ${days === 30 ? "μήνα" : "μήνες"}` : `${days} ημέρες`);
const TO = { buyer: "στον νέο πελάτη", referrer: "σε όποιον τον σύστησε", both: "και στους δύο" };

const ERRORS: Record<string, string> = {
  name_required: "Δώστε όνομα.", dates_invalid: "Η λήξη πρέπει να είναι μετά την έναρξη.",
  unknown_package: "Άγνωστο πακέτο.", code_invalid: "Ο κωδικός θέλει 3–24 λατινικά γράμματα, αριθμούς ή παύλα.",
  code_taken: "Αυτός ο κωδικός υπάρχει ήδη.", effects_required: "Προσθέστε τουλάχιστον ένα όφελος.",
  unknown_module: "Διαλέξτε δυνατότητα για το δώρο.", days_invalid: "Οι ημέρες του δώρου πρέπει να είναι 1–1095.",
  pct_invalid: "Η έκπτωση % πρέπει να είναι 1–95 (στην ειδική προσφορά έως 100 = δωρεάν).", addon_pct_invalid: "Η έκπτωση στο πρόσθετο πρέπει να είναι 1–100%.",
  months_invalid: "Οι μήνες πρέπει να είναι 1–36.", amount_invalid: "Βάλτε ποσό έκπτωσης.",
  referrer_gift_needs_referral: "Δώρο σε όποιον σύστησε χρειάζεται τη συνθήκη «Μόνο με σύσταση».",
  lock_years_invalid: "Το κλείδωμα θέλει 1–10 χρόνια.", lock_until_invalid: "Το κλείδωμα πρέπει να λήγει μετά το τέλος της ενέργειας.",
  special_one_package: "Η ειδική προσφορά αφορά ακριβώς ένα πακέτο.", offer_months_invalid: "Η διάρκεια της προσφοράς πρέπει να είναι 1–36 μήνες.",
  special_buyer_only: "Στην ειδική προσφορά τα οφέλη δίνονται μόνο στο ίδιο το φαρμακείο.",
  sponsor_required: "Διαλέξτε χορηγό (Προωθητικές ενέργειες → Χορηγοί).", sponsor_pct_invalid: "Το μερίδιο του χορηγού πρέπει να είναι 1–99%.",
  free_or_sponsored_yearly_12: "Δωρεάν προσφορά ή προσφορά με χορηγό: μόνο ετήσια χρέωση και διάρκεια 12 μήνες.",
};

const blank = (): Promotion => ({
  name: "", public_text: "", active: false, starts_on: today(), ends_on: today(), packages: [], cycles: [],
  customer: "any", code: null, requires_referral: false, exclusive: false, max_redemptions: null,
  effects: [{ type: "discount_pct", value: 10, on: "package" }], lock: { kind: "none" }, show_on_site: false,
  audience: "all", offer_months: null, payer: "pharmacy", sponsor_id: null, sponsor_pct: null,
});

function phase(p: Promotion): { label: string; cls: string } {
  if (!p.active) return { label: "Ανενεργή", cls: "bg-slate-100 text-slate-600" };
  const now = Date.now();
  if (p.ends_at && new Date(p.ends_at).getTime() < now) return { label: "Έληξε", cls: "bg-slate-100 text-slate-500" };
  if (p.starts_at && new Date(p.starts_at).getTime() > now) return { label: "Προγραμματισμένη", cls: "bg-amber-100 text-amber-800" };
  return { label: "Σε εξέλιξη", cls: "bg-emerald-100 text-emerald-800" };
}

function describe(p: Promotion, data: Data): string[] {
  const pk = (id: string) => data.packages.find((x) => x.id === id)?.name || id;
  const md = (id?: string | null) => data.modules.find((x) => x.id === id)?.name || id || "";
  const special = p.audience === "afm_list";
  const who = special ? [
    `ειδική προσφορά στο πακέτο ${p.packages.map(pk).join(", ")}`,
    p.payer === "sponsor" ? `πληρώνει ο χορηγός ${data.sponsors?.find((x) => x.id === p.sponsor_id)?.name || ""}`
      : p.payer === "split" ? `ο χορηγός ${data.sponsors?.find((x) => x.id === p.sponsor_id)?.name || ""} πληρώνει ${p.sponsor_pct}%` : null,
    p.cycles.length === 1 ? (p.cycles[0] === "yearly" ? "μόνο ετήσια" : "μόνο μηνιαία") : null,
    `${p.afm_counts?.total ?? 0} ΑΦΜ στη λίστα (${p.afm_counts?.redeemed ?? 0} την πήραν, ${p.afm_counts?.verified ?? 0} επιβεβαιώθηκαν από ΗΔΥΚΑ)`,
    p.max_redemptions ? `έως ${p.max_redemptions} φορές` : null,
  ].filter(Boolean).join(" · ") : [
    p.packages.length ? `πακέτα ${p.packages.map(pk).join(", ")}` : "όλα τα πακέτα",
    p.cycles.length === 1 ? (p.cycles[0] === "yearly" ? "μόνο ετήσια" : "μόνο μηνιαία") : null,
    p.customer === "new" ? "μόνο νέοι πελάτες" : p.customer === "returning" ? "μόνο παλιοί πελάτες" : null,
    p.requires_referral ? "μόνο με σύσταση" : null,
    p.code ? `με κωδικό ${p.code}` : null,
    p.max_redemptions ? `έως ${p.max_redemptions} φορές` : null,
  ].filter(Boolean).join(" · ");
  const what = p.effects.map((e) => (e.referral_only ? "[με σύσταση] " : "") + (e.type === "discount_pct" ? `−${e.value}% ${e.on === "total" ? "στο σύνολο" : "στο πακέτο"}`
    : e.type === "discount_amount" ? `−${eur(e.value || 0)} ${e.on === "total" ? "στο σύνολο" : "στο πακέτο"}`
    : e.type === "addon_discount" ? `${md(e.module)} ${(e.value ?? 0) >= 100 ? "δωρεάν" : `−${e.value}%`} για ${e.months} μήνες ${TO[e.to || "buyer"]}`
    : `${md(e.module)} δωρεάν ${span(e.days ?? 0)} ${TO[e.to || "buyer"]}`));
  const lock = p.lock?.kind === "years" ? ` · τιμή κλειδωμένη ${p.lock.years} ${p.lock.years === 1 ? "χρόνο" : "χρόνια"}`
    : p.lock?.kind === "until" ? ` · τιμή κλειδωμένη έως ${day(p.lock.until_on || "")}`
    : special ? ` · τιμή και πακέτο κλειδωμένα ${p.offer_months} μήνες` : "";
  return [who + (p.show_on_site ? " · στο site" : ""), what.join(" + ") + lock];
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-slate-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
      {children}
    </label>
  );
}

const RECIPIENT_OPTIONS = (
  <>
    <option value="buyer">στον νέο πελάτη</option>
    <option value="referrer">σε όποιον τον σύστησε</option>
    <option value="both">και στους δύο</option>
  </>
);

function EffectRow({ e, modules, special, onChange, onRemove }: { e: Effect; modules: Option[]; special: boolean;
  onChange: (e: Effect) => void; onRemove: () => void }) {
  const sel = "rounded-lg border border-slate-300 px-2 py-1.5 text-sm";
  const num = "rounded border border-slate-300 px-1.5 py-1";
  const months = e.type === "free_module" && (e.days ?? 0) > 0 && (e.days ?? 0) % 30 === 0;
  const fresh = (type: Effect["type"]): Effect => type === "discount_pct" ? { type, value: 10, on: "package" }
    : type === "discount_amount" ? { type, value: 1000, on: "package" }
    : type === "free_module" ? { type, module: modules[0]?.id, days: 90, to: "buyer" }
    : { type, module: modules[0]?.id, value: 20, months: 5, to: "buyer" };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
      <select value={e.type} onChange={(ev) => onChange(fresh(ev.target.value as Effect["type"]))} className={sel}>
        <option value="discount_pct">Έκπτωση % στη συνδρομή</option>
        <option value="discount_amount">Έκπτωση σε € στη συνδρομή</option>
        <option value="free_module">Δωρεάν δυνατότητα</option>
        <option value="addon_discount">Έκπτωση σε πρόσθετο</option>
      </select>
      {e.type === "discount_pct" && (
        <span className="inline-flex items-center gap-1 text-sm">−<input type="number" min={1} max={special ? 100 : 95} value={e.value ?? ""}
          onChange={(ev) => onChange({ ...e, value: parseInt(ev.target.value) || 0 })} className={`w-16 ${num}`} />%</span>
      )}
      {e.type === "discount_amount" && (
        <span className="inline-flex items-center gap-1 text-sm">−<input type="number" min={0} step="0.01" value={(e.value ?? 0) / 100}
          onChange={(ev) => onChange({ ...e, value: Math.round((parseFloat(ev.target.value) || 0) * 100) })} className={`w-24 ${num}`} />€ καθαρά</span>
      )}
      {(e.type === "discount_pct" || e.type === "discount_amount") && (
        <select value={e.on || "package"} onChange={(ev) => onChange({ ...e, on: ev.target.value as Effect["on"] })} className={sel}>
          <option value="package">στην τιμή του πακέτου</option>
          <option value="total">σε όλο το ποσό (με πρόσθετα/χρήστες)</option>
        </select>
      )}
      {(e.type === "free_module" || e.type === "addon_discount") && (
        <select value={e.module || ""} onChange={(ev) => onChange({ ...e, module: ev.target.value })} className={sel}>
          {modules.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
        </select>
      )}
      {e.type === "free_module" && (
        <span className="inline-flex items-center gap-1 text-sm">δωρεάν για
          <input type="number" min={1} max={months ? 36 : 1095} value={months ? (e.days ?? 0) / 30 : e.days ?? ""}
            onChange={(ev) => onChange({ ...e, days: (parseInt(ev.target.value) || 0) * (months ? 30 : 1) })} className={`w-16 ${num}`} />
          <select value={months ? "m" : "d"} onChange={(ev) => onChange({ ...e, days: ev.target.value === "m" ? Math.max(1, Math.round((e.days ?? 30) / 30)) * 30 : Math.max(1, (e.days ?? 30) - 1) })} className={sel}>
            <option value="m">μήνες</option><option value="d">ημέρες</option>
          </select>
        </span>
      )}
      {e.type === "addon_discount" && (
        <span className="inline-flex items-center gap-1 text-sm">−<input type="number" min={1} max={100} value={e.value ?? ""}
          onChange={(ev) => onChange({ ...e, value: parseInt(ev.target.value) || 0 })} className={`w-16 ${num}`} />% για
          <input type="number" min={1} max={36} value={e.months ?? ""}
            onChange={(ev) => onChange({ ...e, months: parseInt(ev.target.value) || 0 })} className={`w-14 ${num}`} /> μήνες</span>
      )}
      {!special && (e.type === "free_module" || e.type === "addon_discount") && (
        <select value={e.to || "buyer"} onChange={(ev) => onChange({ ...e, to: ev.target.value as Effect["to"] })} className={sel}>
          {RECIPIENT_OPTIONS}
        </select>
      )}
      {!special && (
        <label className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-700" title="Αυτό το όφελος δίνεται μόνο όταν ο νέος πελάτης έρχεται με κωδικό σύστασης. Τα υπόλοιπα ισχύουν για όλους.">
          <input type="checkbox" checked={!!e.referral_only} onChange={(ev) => onChange({ ...e, referral_only: ev.target.checked })} className="h-4 w-4 rounded border-slate-300" />
          μόνο με σύσταση
        </label>
      )}
      <button type="button" onClick={onRemove} aria-label="Αφαίρεση" className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-rose-600"><X className="h-4 w-4" /></button>
    </div>
  );
}

function Editor({ initial, data, onClose, onSaved }: { initial: Promotion; data: Data; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState<Promotion>({ ...initial, lock: initial.lock || { kind: "none" },
    audience: initial.audience || "all", offer_months: initial.offer_months ?? null });
  const special = p.audience === "afm_list";
  const lk = p.lock || { kind: "none" as const };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Promotion>) => setP((x) => ({ ...x, ...patch }));
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  const save = async () => {
    setBusy(true); setError("");
    try {
      const body = JSON.stringify({ ...p, code: p.code?.trim() || null, max_redemptions: p.max_redemptions || null });
      await adminApi(p._id ? `/admin/promotions/${p._id}` : "/admin/promotions", { method: p._id ? "PUT" : "POST", body });
      onSaved();
    } catch (e) {
      const code = e instanceof ApiError ? ((e.problem as { detail?: { error?: string } })?.detail?.error ?? "") : "";
      setError(ERRORS[code] || "Δεν αποθηκεύτηκε. Ελέγξτε τα πεδία.");
    }
    setBusy(false);
  };

  return (
    <div className="space-y-4 rounded-xl border border-indigo-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-900">{p._id ? "Επεξεργασία ενέργειας" : "Νέα ενέργεια"}{special ? " · ειδική προσφορά" : ""}</h2>
        <button type="button" onClick={onClose} aria-label="Κλείσιμο" className="rounded p-1 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm text-slate-600">Όνομα (το βλέπει ο πελάτης)
          <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="Black Friday 2026" className={inp} /></label>
        <label className="text-sm text-slate-600">Μήνυμα προς τον πελάτη (προαιρετικό)
          <input value={p.public_text} onChange={(e) => set({ public_text: e.target.value })} placeholder="Μόνο αυτή την εβδομάδα" className={inp} /></label>
        <label className="text-sm text-slate-600">Από<DateInput value={p.starts_on} onChange={(v) => set({ starts_on: v })} className={inp} /></label>
        <label className="text-sm text-slate-600">Έως (μέχρι 23:59)<DateInput value={p.ends_on} onChange={(v) => set({ ends_on: v })} className={inp} /></label>
      </div>

      <div className="flex flex-wrap gap-2">
        {([["all", "Δημόσια ενέργεια", "σε όσους ταιριάζουν οι παρακάτω συνθήκες"],
           ["afm_list", "Ειδική προσφορά", "μόνο σε συγκεκριμένα ΑΦΜ, μία φορά το καθένα"]] as const).map(([v, title, sub]) => (
          <button key={v} type="button" disabled={!!p._id} onClick={() => set(v === "afm_list"
            ? { audience: v, offer_months: p.offer_months || 12, packages: p.packages.slice(0, 1), code: null, requires_referral: false, customer: "any", show_on_site: false, lock: { kind: "none" },
                effects: p.effects.map((e) => ({ ...e, to: "buyer" as const, referral_only: false })) }
            : { audience: v, offer_months: null })}
            className={`rounded-lg border px-3 py-2 text-left text-sm disabled:cursor-not-allowed ${p.audience === v ? "border-indigo-500 bg-indigo-50 text-indigo-900" : "border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"}`}>
            <b>{title}</b><span className="block text-xs text-slate-500">{sub}</span>
          </button>
        ))}
      </div>

      {special ? (
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold text-slate-800">Πακέτο και διάρκεια</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-sm text-slate-500">Πακέτο:</span>
          {data.packages.map((pk) => (
            <label key={pk.id} className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-slate-700">
              <input type="radio" name="special-package" checked={p.packages[0] === pk.id} onChange={() => set({ packages: [pk.id] })} className="h-4 w-4 border-slate-300" />{pk.name || pk.id}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-sm text-slate-500">Χρέωση:</span>
          <Check checked={p.cycles.includes("monthly")} onChange={(v) => set({ cycles: toggle(p.cycles, "monthly", v) })}>Μηνιαία</Check>
          <Check checked={p.cycles.includes("yearly")} onChange={(v) => set({ cycles: toggle(p.cycles, "yearly", v) })}>Ετήσια</Check>
          <span className="text-xs text-slate-400">(κανένα = και τα δύο)</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="text-sm text-slate-500">Διάρκεια προσφοράς:{" "}
            <input type="number" min={1} max={36} value={p.offer_months ?? ""} onChange={(e) => set({ offer_months: parseInt(e.target.value) || null })} className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm" /> μήνες</label>
          <label className="text-sm text-slate-500">Μέγιστες χρήσεις:{" "}
            <input type="number" min={1} value={p.max_redemptions ?? ""} onChange={(e) => set({ max_redemptions: parseInt(e.target.value) || null })} placeholder="απεριόριστες" className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm" /></label>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="text-sm text-slate-500">Ποιος πληρώνει:{" "}
            <select value={p.payer || "pharmacy"} onChange={(e) => {
              const payer = e.target.value as "pharmacy" | "sponsor" | "split";
              set(payer === "pharmacy" ? { payer, sponsor_id: null, sponsor_pct: null }
                : { payer, sponsor_id: p.sponsor_id || data.sponsors?.[0]?.id || null, sponsor_pct: payer === "split" ? (p.sponsor_pct && p.sponsor_pct < 100 ? p.sponsor_pct : 50) : 100,
                    cycles: ["yearly"], offer_months: 12 });
            }} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
              <option value="pharmacy">το φαρμακείο</option>
              <option value="sponsor">ο χορηγός, όλο το πακέτο</option>
              <option value="split">μοιρασμένα</option>
            </select></label>
          {p.payer && p.payer !== "pharmacy" && (
            <>
              <label className="text-sm text-slate-500">Χορηγός:{" "}
                <select value={p.sponsor_id || ""} onChange={(e) => set({ sponsor_id: e.target.value || null })} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
                  <option value="">— διαλέξτε —</option>
                  {(data.sponsors ?? []).map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
                </select></label>
              {p.payer === "split" && (
                <label className="text-sm text-slate-500">Ο χορηγός πληρώνει{" "}
                  <input type="number" min={1} max={99} value={p.sponsor_pct ?? ""} onChange={(e) => set({ sponsor_pct: parseInt(e.target.value) || null })} className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm" />% του πακέτου</label>
              )}
              {(data.sponsors ?? []).length === 0 && <a href="/admin/sponsors" className="text-sm font-medium text-indigo-700 underline">Προσθέστε πρώτα χορηγό</a>}
            </>
          )}
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-500">
          <li>Τη βλέπει μόνο όποιος γράψει στην εγγραφή ΑΦΜ της λίστας. Τη λίστα τη συμπληρώνετε μετά την αποθήκευση, με το κουμπί «ΑΦΜ».</li>
          <li>Κάθε ΑΦΜ την παίρνει <b>μία φορά</b>. Για όσους μήνες ορίσετε, η τιμή μένει ίδια και το φαρμακείο <b>δεν αλλάζει πακέτο</b>. Πρόσθετα μπορεί να αγοράσει κανονικά.</li>
          <li>Όταν λήξει, η συνδρομή ανανεώνεται με την κανονική τιμή και το φαρμακείο μπορεί πια να αλλάξει πακέτο.</li>
          <li><b>Χορηγός:</b> πληρώνει την τιμή προσφοράς του πακέτου (μετά την έκπτωση), όλη ή το ποσοστό που ορίζετε. Χρεώνεται <b>μόνο αφού η ΗΔΥΚΑ επιβεβαιώσει το ΑΦΜ</b>, με ένα παραστατικό ανά φαρμακείο. Πρόσθετα, επιπλέον χρήστες και SLA τα πληρώνει πάντα το φαρμακείο.</li>
          <li><b>Δωρεάν ή με χορηγό:</b> μόνο ετήσια, 12 μήνες. Αν το φαρμακείο δεν έχει τίποτα να πληρώσει, ολοκληρώνει την εγγραφή χωρίς κάρτα.</li>
        </ul>
      </fieldset>
      ) : (
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold text-slate-800">Σε ποιους ισχύει</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-sm text-slate-500">Πακέτα:</span>
          {data.packages.map((pk) => (
            <Check key={pk.id} checked={p.packages.includes(pk.id)} onChange={(v) => set({ packages: toggle(p.packages, pk.id, v) })}>{pk.name || pk.id}</Check>
          ))}
          <span className="text-xs text-slate-400">(κανένα επιλεγμένο = όλα)</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-sm text-slate-500">Χρέωση:</span>
          <Check checked={p.cycles.includes("monthly")} onChange={(v) => set({ cycles: toggle(p.cycles, "monthly", v) })}>Μηνιαία</Check>
          <Check checked={p.cycles.includes("yearly")} onChange={(v) => set({ cycles: toggle(p.cycles, "yearly", v) })}>Ετήσια</Check>
          <span className="text-xs text-slate-400">(κανένα = και τα δύο)</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="text-sm text-slate-500">Πελάτες:{" "}
            <select value={p.customer} onChange={(e) => set({ customer: e.target.value as Promotion["customer"] })} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
              <option value="any">όλοι</option><option value="new">μόνο νέοι</option><option value="returning">μόνο όσοι είχαν λογαριασμό που έληξε</option>
            </select></label>
          <Check checked={p.requires_referral} onChange={(v) => set({ requires_referral: v })}>Όλη η ενέργεια μόνο με σύσταση</Check>
          <span className="text-xs text-slate-400">(ή τσεκάρετε «μόνο με σύσταση» σε όποιο όφελος θέλετε)</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="text-sm text-slate-500">Κωδικός προσφοράς:{" "}
            <input value={p.code || ""} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="π.χ. BF2026 (προαιρετικό)" className="w-48 rounded-lg border border-slate-300 px-2 py-1 text-sm" /></label>
          <label className="text-sm text-slate-500">Μέγιστες χρήσεις:{" "}
            <input type="number" min={1} value={p.max_redemptions ?? ""} onChange={(e) => set({ max_redemptions: parseInt(e.target.value) || null })} placeholder="απεριόριστες" className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm" /></label>
        </div>
      </fieldset>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold text-slate-800">Τι δίνει</legend>
        {p.effects.map((e, i) => (
          <EffectRow key={i} e={e} modules={data.modules} special={special}
            onChange={(ne) => set({ effects: p.effects.map((x, j) => (j === i ? ne : x)) })}
            onRemove={() => set({ effects: p.effects.filter((_, j) => j !== i) })} />
        ))}
        <button type="button" onClick={() => set({ effects: [...p.effects, { type: "free_module", module: data.modules[0]?.id, days: 90, to: "buyer" }] })}
          className="inline-flex items-center gap-1 text-sm font-medium text-indigo-700 hover:underline"><Plus className="h-4 w-4" /> Προσθήκη οφέλους</button>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-500">
          <li><b>Έκπτωση στη συνδρομή:</b> μειώνει την πρώτη πληρωμή του νέου πελάτη (και τις ανανεώσεις, αν κλειδώσετε την τιμή).</li>
          <li><b>Δωρεάν δυνατότητα:</b> ανοίγει μόλις ενεργοποιηθεί ο λογαριασμός και κλείνει μόνη της στη λήξη, χωρίς χρέωση. Αν θέλει να την κρατήσει, την αγοράζει.</li>
          <li><b>Έκπτωση σε πρόσθετο:</b> ισχύει σε κάθε χρέωση του προσθέτου μέσα στους μήνες που ορίζετε, όταν ο πελάτης το ενεργοποιήσει μόνος του από τις Ρυθμίσεις → Δυνατότητες (ή το αγοράσει μαζί με τη συνδρομή). Με 100% είναι δωρεάν, αλλά ζητείται κάρτα για όταν λήξει.</li>
        </ul>
      </fieldset>

      {!special && <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold text-slate-800">Κλείδωμα τιμής</legend>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
          <select value={lk.kind} onChange={(e) => set({ lock: { kind: e.target.value as "none" | "years" | "until",
            years: e.target.value === "years" ? 2 : null, until_on: e.target.value === "until" ? `${new Date().getFullYear() + 1}-12-31` : null } })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
            <option value="none">Όχι: από την ανανέωση ισχύει ο τιμοκατάλογος</option>
            <option value="years">Για ορισμένα χρόνια από την αγορά</option>
            <option value="until">Έως συγκεκριμένη ημερομηνία</option>
          </select>
          {lk.kind === "years" && (
            <span className="inline-flex items-center gap-1"><input type="number" min={1} max={10} value={lk.years ?? ""}
              onChange={(e) => set({ lock: { ...lk, years: parseInt(e.target.value) || null } })} className="w-16 rounded border border-slate-300 px-1.5 py-1" /> χρόνια</span>
          )}
          {lk.kind === "until" && (
            <span className="inline-flex items-center gap-1">έως<DateInput value={lk.until_on || ""} onChange={(v) => set({ lock: { ...lk, until_on: v } })} className="w-36 rounded-lg border border-slate-300 px-2 py-1" /></span>
          )}
        </div>
        <p className="text-xs text-slate-500">Όποιος αγοράσει όσο τρέχει η ενέργεια κρατά την τιμή του πακέτου που πλήρωσε και στις ανανεώσεις, ως το τέλος του κλειδώματος. Π.χ. «έως 31/12 του επόμενου έτους» = φέτος και του χρόνου. Αν αλλάξει πακέτο ή κύκλο χρέωσης, το κλείδωμα λήγει.</p>
      </fieldset>}

      <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3">
        <Check checked={p.exclusive} onChange={(v) => set({ exclusive: v })}>Δεν συνδυάζεται με άλλες ενέργειες</Check>
        {!special && <Check checked={p.show_on_site} onChange={(v) => set({ show_on_site: v })}>Εμφάνιση στο site (rxvision.gr)</Check>}
        <Check checked={p.active} onChange={(v) => set({ active: v })}><b>Ενεργή</b></Check>
        {error && <span className="text-sm text-rose-600">{error}</span>}
        <button type="button" onClick={save} disabled={busy} className="ml-auto rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">Αποθήκευση</button>
      </div>
    </div>
  );
}

function Redemptions({ id, data }: { id: string; data: Data }) {
  const q = useQuery({ queryKey: ["admin", "promotions", id, "redemptions"],
    queryFn: () => adminApi<{ items: Redemption[] }>(`/admin/promotions/${id}/redemptions`) });
  const md = (m: string) => data.modules.find((x) => x.id === m)?.name || m;
  const rows = q.data?.items ?? [];
  if (q.isLoading) return <p className="text-sm text-slate-500">Φόρτωση…</p>;
  if (!rows.length) return <p className="text-sm text-slate-500">Δεν έχει χρησιμοποιηθεί ακόμη.</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-slate-500"><th className="py-1">Ημερομηνία</th><th>Πελάτης</th><th>Σύσταση από</th><th>Έκπτωση</th><th>Δώρα</th></tr></thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r._id}>
            <td className="py-1.5">{new Date(r.at).toLocaleDateString("el-GR")}</td>
            <td>{r.tenant_name || "—"}</td>
            <td>{r.referrer_name || "—"}</td>
            <td>{r.discount_net ? `${eur(r.discount_net)} καθαρά` : "—"}</td>
            <td>{r.grants.map((g, i) => (
              <span key={i} className={`mr-1 inline-block rounded px-1.5 py-0.5 text-xs ${["ok", "banked"].includes(g.status) ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
                {md(g.module)}{g.kind === "discount" ? ` −${g.pct}%` : ""} → {g.role === "buyer" ? "πελάτης" : "σύσταση"}{g.status === "ok" ? "" : g.status === "banked" ? ` (το πληρώνει ήδη: δωρεάν από την ανανέωση ${g.from ? new Date(g.from).toLocaleDateString("el-GR") : ""})` : ` (${g.status === "included_in_plan" ? "το έχει στο πακέτο" : g.status === "already_enabled" ? "το είχε ήδη" : "δεν δόθηκε"})`}
              </span>))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AfmPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const q = useQuery({ queryKey: ["admin", "promotions", id, "afms"],
    queryFn: () => adminApi<{ items: AfmRow[] }>(`/admin/promotions/${id}/afms`) });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const rows = (q.data?.items ?? []).filter((r) => !filter || r.afm.includes(filter.trim()) || (r.tenant_name || "").toLowerCase().includes(filter.trim().toLowerCase()));
  const reload = () => { q.refetch(); onChanged(); };

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await adminApi<{ added: number; existing: number; invalid: string[]; with_email: number }>(`/admin/promotions/${id}/afms`, { method: "POST", body: JSON.stringify({ afms: text }) });
      setText("");
      reload();
      await appAlert([`Προστέθηκαν ${r.added} ΑΦΜ.`, r.existing ? `${r.existing} υπήρχαν ήδη στη λίστα.` : "",
        r.with_email ? `${r.with_email} με email για την πρόσκληση.` : "",
        r.invalid.length ? `${r.invalid.length} δεν είναι έγκυρα ΑΦΜ και δεν μπήκαν: ${r.invalid.slice(0, 20).join(", ")}${r.invalid.length > 20 ? "…" : ""}` : ""].filter(Boolean).join("\n"),
        { title: "Λίστα ΑΦΜ" });
    } catch { await appAlert("Δεν αποθηκεύτηκε η λίστα. Δοκιμάστε ξανά.", { title: "Λίστα ΑΦΜ" }); }
    setBusy(false);
  };

  const invite = async (resend: boolean, afms?: string[]) => {
    const msg = afms ? `Αποστολή πρόσκλησης στο ΑΦΜ ${afms[0]};`
      : resend ? "Αποστολή πρόσκλησης ΞΑΝΑ σε όλα τα ΑΦΜ της λίστας που δεν την έχουν πάρει ακόμη;"
      : "Αποστολή πρόσκλησης σε όσα ΑΦΜ της λίστας δεν έχουν λάβει ακόμη; Παραλήπτης είναι το email της γραμμής ή, αν είναι ήδη πελάτης, το email χρέωσής του.";
    if (!(await appConfirm(msg, { title: "Προσκλήσεις", confirmText: "Αποστολή" }))) return;
    setBusy(true);
    try {
      const r = await adminApi<{ sent: number; skipped_no_email: number; failed: number }>(`/admin/promotions/${id}/invite`, { method: "POST", body: JSON.stringify({ resend: resend || !!afms, afms: afms ?? null }) });
      reload();
      await appAlert([`Στάλθηκαν ${r.sent} προσκλήσεις.`, r.skipped_no_email ? `${r.skipped_no_email} ΑΦΜ χωρίς email: προσθέστε το δίπλα στο ΑΦΜ και ξαναπατήστε.` : "",
        r.failed ? `${r.failed} απέτυχαν (λάθος διεύθυνση ή πρόβλημα email).` : ""].filter(Boolean).join("\n"), { title: "Προσκλήσεις" });
    } catch { await appAlert("Δεν στάλθηκαν οι προσκλήσεις.", { title: "Προσκλήσεις" }); }
    setBusy(false);
  };

  const remove = async (r: AfmRow) => {
    if (!(await appConfirm(`Αφαίρεση του ΑΦΜ ${r.afm} από την προσφορά;`, { title: "Αφαίρεση", danger: true, confirmText: "Αφαίρεση" }))) return;
    try { await adminApi(`/admin/promotions/${id}/afms/${r.afm}`, { method: "DELETE" }); reload(); }
    catch { await appAlert("Δεν αφαιρέθηκε.", { title: "Λίστα ΑΦΜ" }); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
          placeholder="Επικολλήστε ΑΦΜ: ένα ανά γραμμή (προαιρετικά με το email δίπλα, π.χ. «123456789;info@farmakeio.gr»), ή χωρισμένα με κόμμα"
          className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-sm focus:border-indigo-500 focus:outline-none" />
        <button type="button" onClick={add} disabled={busy || !text.trim()} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">Προσθήκη</button>
      </div>
      <p className="text-xs text-slate-500">Κάθε ΑΦΜ ελέγχεται με τον αλγόριθμο της ΑΑΔΕ. Αν το Excel έκοψε το αρχικό 0, συμπληρώνεται αυτόματα. Όταν το φαρμακείο συνδέσει ΗΔΥΚΑ, το ΑΦΜ επιβεβαιώνεται. Αν δεν ταιριάζει ή δεν συνδεθεί σε 30 ημέρες, η προσφορά ανακαλείται και το ΑΦΜ ξαναγίνεται διαθέσιμο.</p>
      {q.isLoading ? <p className="text-sm text-slate-500">Φόρτωση…</p> : (q.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-500">Η λίστα είναι άδεια. Κανείς δεν βλέπει ακόμη την προσφορά.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Αναζήτηση ΑΦΜ ή φαρμακείου" className="w-64 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
            <button type="button" onClick={() => invite(false)} disabled={busy} className="ml-auto rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">Αποστολή προσκλήσεων (όσοι δεν έλαβαν)</button>
            <button type="button" onClick={() => invite(true)} disabled={busy} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">Ξανά σε όλους</button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500"><th className="py-1">ΑΦΜ</th><th>Κατάσταση</th><th>Φαρμακείο</th><th>Πρόσκληση</th><th>Ημερομηνία</th><th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r._id}>
                    <td className="py-1.5 font-mono">{r.afm}</td>
                    <td>{r.status === "verified"
                      ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">Επιβεβαιώθηκε από ΗΔΥΚΑ</span>
                      : r.status === "redeemed"
                      ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800" title="Την πήρε· περιμένουμε να συνδέσει ΗΔΥΚΑ για να επιβεβαιωθεί το ΑΦΜ. Αν δεν γίνει σε 30 ημέρες, ανακαλείται.">Την πήρε · αναμονή ΗΔΥΚΑ</span>
                      : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">Σε αναμονή</span>}
                      {(r.rejections ?? []).map((x, i) => (
                        <span key={i} className="mt-0.5 block text-xs text-rose-700">
                          Ανακλήθηκε {new Date(x.at).toLocaleDateString("el-GR")} από «{x.tenant_name || x.tenant_id}»: {x.reason === "afm_mismatch" ? `η ΗΔΥΚΑ έδωσε ΑΦΜ ${x.hdika_afm || "άλλο"}` : "δεν συνδέθηκε ΗΔΥΚΑ σε 30 ημέρες"}
                        </span>))}</td>
                    <td>{r.tenant_name || "—"}{r.mode === "existing" && r.starts_at && <span className="block text-xs text-slate-500">υπάρχων πελάτης · ξεκινά {new Date(r.starts_at).toLocaleDateString("el-GR")}</span>}</td>
                    <td className="text-xs">{r.invite_sent_at
                      ? <span title={r.invite_to || ""}>Στάλθηκε {new Date(r.invite_sent_at).toLocaleDateString("el-GR")}{(r.invite_count ?? 0) > 1 ? ` (×${r.invite_count})` : ""}</span>
                      : r.status === "invited" ? (r.email ? <span className="text-slate-500">{r.email}</span> : <span className="text-slate-400">χωρίς email</span>) : "—"}
                      {r.status === "invited" && (r.email || r.invite_sent_at) && <button type="button" onClick={() => invite(true, [r.afm])} className="ml-1 text-indigo-700 hover:underline">αποστολή</button>}</td>
                    <td>{new Date(r.verified_at || r.redeemed_at || r.added_at).toLocaleDateString("el-GR")}</td>
                    <td className="text-right">{r.status === "invited" && (
                      <button type="button" onClick={() => remove(r)} aria-label="Αφαίρεση" className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X className="h-4 w-4" /></button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function PreviewBox({ data }: { data: Data }) {
  const [pkg, setPkg] = useState(data.packages[data.packages.length - 1]?.id || "");
  const [cycle, setCycle] = useState<"monthly" | "yearly">("yearly");
  const [referral, setReferral] = useState(false);
  const [returning, setReturning] = useState(false);
  const [code, setCode] = useState("");
  const [listed, setListed] = useState(false);
  const [onDate, setOnDate] = useState(today());
  const [res, setRes] = useState<Preview | null>(null);
  const md = (m: string) => data.modules.find((x) => x.id === m)?.name || m;
  const run = async () => setRes(await adminApi<Preview>("/admin/promotions/preview", { method: "POST", body: JSON.stringify({
    package_code: pkg, billing_cycle: cycle, with_referral: referral, returning, promo_code: code || null, on_date: onDate, listed_afm: listed }) }));
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Δοκιμή: τι θα πάρει ένας πελάτης</h2>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select value={pkg} onChange={(e) => setPkg(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5">
          {data.packages.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
        </select>
        <select value={cycle} onChange={(e) => setCycle(e.target.value as "monthly" | "yearly")} className="rounded-lg border border-slate-300 px-2 py-1.5">
          <option value="yearly">Ετήσια</option><option value="monthly">Μηνιαία</option>
        </select>
        <Check checked={referral} onChange={setReferral}>με σύσταση</Check>
        <Check checked={returning} onChange={setReturning}>παλιός πελάτης</Check>
        <Check checked={listed} onChange={setListed}>ΑΦΜ σε λίστα ειδικής προσφοράς</Check>
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="κωδικός" className="w-28 rounded-lg border border-slate-300 px-2 py-1.5" />
        <span className="inline-flex items-center gap-1">στις<DateInput value={onDate} onChange={setOnDate} className="w-36 rounded-lg border border-slate-300 px-2 py-1.5" /></span>
        <button type="button" onClick={run} className="rounded-lg border border-indigo-300 px-3 py-1.5 font-medium text-indigo-700 hover:bg-indigo-50">Δοκιμή</button>
      </div>
      {res && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          {res.promotions.length === 0 ? <p>Καμία ενέργεια δεν ισχύει. Πληρώνει {eur(res.gross_before)}.</p> : (
            <>
              <p>Πληρώνει <b>{eur(res.gross_after)}</b> αντί {eur(res.gross_before)} (με ΦΠΑ, μόνο το πακέτο).</p>
              <ul className="mt-1 list-disc pl-5">
                {res.promotions.map((p) => (
                  <li key={p.id}>{p.name}{p.inactive && <span className="text-amber-700"> (ανενεργή ακόμη)</span>}
                    {p.discount_net > 0 && ` · −${eur(p.discount_net)} καθαρά`}
                    {p.gifts.map((g, i) => <span key={i}> · {md(g.module)} {g.kind === "discount" ? `−${g.pct}% για ${g.months} μήνες` : `δωρεάν ${span(g.days ?? 0)}`} {TO[g.to as keyof typeof TO]}</span>)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function PromotionsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "promotions"], queryFn: () => adminApi<Data>("/admin/promotions") });
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [open, setOpen] = useState<string | null>(null);         // "<id>" = χρήσεις · "afms:<id>" = λίστα ΑΦΜ
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
  const data = q.data;

  const remove = async (p: Promotion) => {
    const used = (p.redeemed ?? 0) > 0;
    if (!(await appConfirm(used ? `Η «${p.name}» έχει ήδη δοθεί σε πελάτες, οπότε θα απενεργοποιηθεί αντί να διαγραφεί, για να μείνει το ιστορικό.`
      : `Διαγραφή της «${p.name}»;`, { title: used ? "Απενεργοποίηση" : "Διαγραφή", danger: true, confirmText: used ? "Απενεργοποίηση" : "Διαγραφή" }))) return;
    await adminApi(`/admin/promotions/${p._id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900"><BadgePercent className="h-5 w-5 text-indigo-600" /> Προωθητικές ενέργειες</h1>
          <p className="text-sm text-slate-500">Εκπτώσεις και δώρα στις νέες συνδρομές, για όσο διάστημα ορίσετε. Ισχύουν αυτόματα στη σελίδα εγγραφής. Οι ειδικές προσφορές απευθύνονται μόνο σε όσα ΑΦΜ βάλετε στη λίστα τους.</p>
        </div>
        {data && !editing && (
          <button type="button" onClick={() => setEditing(blank())} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><Plus className="h-4 w-4" /> Νέα ενέργεια</button>
        )}
      </div>

      {data && editing && <Editor key={editing._id || "new"} initial={editing} data={data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}

      {q.isLoading && <p className="text-sm text-slate-500">Φόρτωση…</p>}
      {data && data.items.length === 0 && !editing && <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">Δεν υπάρχει καμία ενέργεια ακόμη.</p>}
      <div className="space-y-2">
        {data?.items.map((p) => {
          const ph = phase(p);
          const [who, what] = describe(p, data);
          return (
            <div key={p._id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{p.name}</span>
                    {p.audience === "afm_list" && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-800">Ειδική · ανά ΑΦΜ</span>}
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${ph.cls}`}>{ph.label}</span>
                    <span className="text-xs text-slate-500">{day(p.starts_on)} – {day(p.ends_on)}</span>
                  </div>
                  <p className="mt-1 flex items-start gap-1.5 text-sm text-slate-700"><Gift className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />{what}</p>
                  <p className="text-xs text-slate-500">{who}{p.exclusive ? " · δεν συνδυάζεται" : ""}</p>
                </div>
                {p.audience === "afm_list" && (
                  <button type="button" onClick={() => setOpen(open === `afms:${p._id}` ? null : `afms:${p._id}`)} className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"><ListChecks className="h-3.5 w-3.5" /> {p.afm_counts?.total ?? 0} ΑΦΜ</button>
                )}
                <button type="button" onClick={() => setOpen(open === p._id ? null : p._id!)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Users className="h-3.5 w-3.5" /> {p.redeemed ?? 0} χρήσεις</button>
                <button type="button" onClick={() => setEditing(p)} aria-label="Επεξεργασία" className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50"><Pencil className="h-4 w-4" /></button>
                <button type="button" onClick={() => remove(p)} aria-label="Διαγραφή" className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
              </div>
              {open === p._id && <div className="mt-3 border-t border-slate-100 pt-3"><Redemptions id={p._id!} data={data} /></div>}
              {open === `afms:${p._id}` && <div className="mt-3 border-t border-slate-100 pt-3"><AfmPanel id={p._id!} onChanged={refresh} /></div>}
            </div>
          );
        })}
      </div>

      {data && data.packages.length > 0 && <PreviewBox data={data} />}
    </div>
  );
}
