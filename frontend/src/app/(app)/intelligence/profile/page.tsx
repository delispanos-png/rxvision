"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, User, Wallet, Repeat, Stethoscope, Pill, Sparkles, AlertTriangle, Salad, Target, Eye, Crown, Syringe, ChevronRight, ScanLine, Calendar, CalendarRange } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum, fmtEur, fmtDec } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { ContactCard } from "@/components/patients/ContactCard";
import { PatientCommentsCard } from "@/components/patients/PatientCommentsCard";
import { BarChart } from "@/components/charts/BarChart";

type Seg = { key: string; label: string };
type Cond = { code: string; title: string | null; times: number };
type Med = { name: string; atc: string | null; substance: string | null; times: number; value: number };
type Doc = { name: string; specialty: string | null; times: number };
type Renewal = { root: string; medicines: string[]; count: number; value: number; last_executed: string | null; due?: string | null; until?: string | null };
type Flu = { season: string; vaccinated: boolean; date: string | null; vaccine: string | null };
type Exec = { kind?: string; barcode: string; executed_at: string | null; amount_total: number; patient_share: number; doctor: string | null; cancelled?: boolean; medicines: string[] };
type Profile = {
  found: boolean;
  patient?: { id: string; name: string; amka: string; age_group: string; sex: string; area: string; birth_year: number; lifecycle: string; deceased: boolean; first_seen: string; last_seen: string; gap_days: number | null };
  contact?: { mobile: string | null; phone: string | null; email: string | null; consent: boolean; active: boolean; has_contact: boolean };
  financials?: { rx_count: number; value: number; claimed: number; paid: number; profit: number; avg_per_visit: number };
  vip?: { tier: string; rank: number; of: number; percentile: number; value: number };
  adherence?: { compliance: number | null; band: string | null; executed: number; expected: number; missed: number; available: number; lost_value: number; next_open: string | null };
  missed_items?: Renewal[];
  available_items?: Renewal[];
  flu?: Flu;
  segments?: Seg[];
  conditions?: Cond[];
  medicines?: Med[];
  doctors?: Doc[];
  executions?: Exec[];
  clinical?: { g6pd_deficiency: boolean };
};
type Advice = { ok: boolean; summary?: string; approach?: string[]; lifestyle?: string[]; opportunities?: string[]; watch?: string[] };

const TIER: Record<string, { label: string; cls: string }> = {
  platinum: { label: "Platinum", cls: "bg-violet-100 text-violet-700" },
  gold: { label: "Gold", cls: "bg-amber-100 text-amber-700" },
  silver: { label: "Silver", cls: "bg-slate-200 text-slate-600" },
  bronze: { label: "Bronze", cls: "bg-orange-100 text-orange-700" },
};
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString("el-GR") : "—");

function AdviceList({ icon: Icon, title, items, accent }: { icon: typeof Salad; title: string; items?: string[]; accent: string }) {
  if (!items?.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <h4 className={`mb-2 flex items-center gap-1.5 text-sm font-semibold ${accent}`}><Icon className="h-4 w-4" />{title}</h4>
      <ul className="space-y-1.5">{items.map((x, i) => <li key={i} className="flex gap-2 text-sm text-slate-600 dark:text-slate-300"><span className="text-slate-300">•</span><span>{x}</span></li>)}</ul>
    </div>
  );
}

export default function PatientProfilePage() {
  const t = useT();
  const router = useRouter();
  const [amka, setAmka] = useState("");
  const [scan, setScan] = useState("");
  const [open, setOpen] = useState(false);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [show, setShow] = useState<"missed" | "available" | null>(null);
  const [showExecs, setShowExecs] = useState(false);
  const [g6pd, setG6pd] = useState(false);
  const [showPortal, setShowPortal] = useState(false);
  const [portalEmail, setPortalEmail] = useState("");
  const [portalResult, setPortalResult] = useState<{ email: string; temp_password: string } | null>(null);
  // περίοδος για Διαγνώσεις & Φάρμακα (μήνες· 0 = όλα). Default 12μ ώστε το AI/διαγνώσεις να εστιάζουν στο πρόσφατο.
  const [rangeMonths, setRangeMonths] = useState(12);
  const [identity, setIdentity] = useState<string | null>(null);   // πώς φορτώθηκε ο πελάτης (amka/patient_id/barcode)

  // date_from ISO για το επιλεγμένο παράθυρο μηνών (κενό όταν «Όλα»)
  const monthsAgoISO = (m: number) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString(); };
  const rangeParam = (m: number) => (m ? `&date_from=${encodeURIComponent(monthsAgoISO(m))}` : "");

  const search = useMutation({
    mutationFn: (qs: string) => api<Profile>(`/patient-intelligence/profile?${qs}`),
    onSuccess: (d) => { setAdvice(null); setShow(null); setShowExecs(false); setOpen(false); setShowPortal(false); setPortalResult(null); setG6pd(!!(d.found && d.clinical?.g6pd_deficiency)); },
  });
  const ask = useMutation({
    mutationFn: (a: string) => api<Advice>("/patient-intelligence/profile/advice", { method: "POST", body: JSON.stringify({ amka: a, date_from: rangeMonths ? monthsAgoISO(rangeMonths) : null }) }),
    onSuccess: (d) => setAdvice(d),
  });
  const g6pdMut = useMutation({
    mutationFn: (v: boolean) => api("/patient-intelligence/profile/g6pd", { method: "POST", body: JSON.stringify({ amka: search.data?.patient?.amka, g6pd_deficiency: v }) }),
  });
  const createAcc = useMutation({
    mutationFn: () => api<{ email: string; temp_password: string }>("/patient-intelligence/profile/portal-account", { method: "POST", body: JSON.stringify({ amka: search.data?.patient?.amka, email: portalEmail.trim() }) }),
    onSuccess: (d) => setPortalResult(d),
  });

  // live αναζήτηση με όνομα Ή ΑΜΚΑ (το /patients/search ψάχνει name/amka/τηλ/email & είναι demo-masked)
  type Hit = { patient_id: string; name: string | null; amka: string | null };
  const term = amka.trim();
  const sug = useQuery({
    queryKey: ["pi-patient-search", term],
    queryFn: () => api<{ items: Hit[] }>(`/patients/search?q=${encodeURIComponent(term)}`),
    enabled: open && term.length >= 2,
  });

  // φόρτωση προφίλ + θυμάμαι το identity, ώστε η αλλαγή περιόδου να ξαναφορτώνει τον ίδιο πελάτη
  const load = (id: string, m = rangeMonths) => { setIdentity(id); search.mutate(`${id}${rangeParam(m)}`); };
  const changeRange = (m: number) => { setRangeMonths(m); if (identity) search.mutate(`${identity}${rangeParam(m)}`); };
  const pick = (h: Hit) => { setAmka(h.name || h.amka || ""); setOpen(false); load(`patient_id=${encodeURIComponent(h.patient_id)}`); };
  const go = () => { const a = amka.trim(); if (a.length >= 3) load(`amka=${encodeURIComponent(a)}`); };
  // σάρωση συνταγής (ο σαρωτής «πληκτρολογεί» το barcode + Enter) → φόρτωση πελάτη ΧΩΡΙΣ ΑΜΚΑ
  const scanGo = () => { const c = scan.trim(); if (c.length >= 4) { load(`barcode=${encodeURIComponent(c)}`); setScan(""); } };
  const p = search.data?.found ? search.data : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-500">{t("Όνομα ή ΑΜΚΑ πελάτη", "Patient name or ΑΜΚΑ")}
          <div className="relative mt-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={amka} onChange={(e) => { setAmka(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
              onKeyDown={(e) => e.key === "Enter" && go()} placeholder={t("π.χ. ΠΑΠΑΔΟΠΟΥΛΟΣ ή 01015087875", "e.g. surname or 01015087875")}
              className="w-80 rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
            {open && term.length >= 2 && (sug.data?.items?.length ? (
              <div className="absolute z-20 mt-1 max-h-72 w-80 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {sug.data.items.map((h) => (
                  <button key={h.patient_id} onClick={() => pick(h)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-brand-50 dark:hover:bg-slate-800">
                    <span className="truncate font-medium text-slate-800 dark:text-slate-200">{h.name || "—"}</span>
                    <span className="shrink-0 font-mono text-[11px] text-slate-400">{h.amka || ""}</span>
                  </button>
                ))}
              </div>
            ) : (!sug.isPending && (
              <div className="absolute z-20 mt-1 w-80 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-400 shadow-lg dark:border-slate-700 dark:bg-slate-900">{t("Καμία αντιστοιχία", "No matches")}</div>
            )))}
          </div>
        </label>
        <button onClick={go} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">{t("Αναζήτηση", "Search")}</button>

        <span className="self-center text-xs text-slate-400">{t("ή", "or")}</span>

        {/* Σάρωση συνταγής: ο πελάτης μπαίνει στο φαρμακείο, ο φαρμακοποιός σκανάρει μια συνταγή του
            και βλέπει αμέσως τη συνολική του εικόνα — χωρίς να ρωτήσει ΑΜΚΑ. */}
        <label className="text-xs font-medium text-slate-500">{t("Σάρωση συνταγής", "Scan prescription")}
          <div className="relative mt-1">
            <ScanLine className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-500" />
            <input value={scan} autoFocus onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => e.key === "Enter" && scanGo()}
              placeholder={t("σκανάρετε το barcode…", "scan the barcode…")}
              className="w-64 rounded-lg border border-brand-300 bg-brand-50/40 py-2 pl-8 pr-3 text-sm focus:border-brand-500 focus:outline-none dark:border-brand-700 dark:bg-slate-800" />
          </div>
        </label>
      </div>

      {search.isPending && <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div>}
      {search.data && !search.data.found && <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("Δεν βρέθηκε πελάτης.", "No patient found.")}</div>}

      {p && p.patient && (
        <>
          {/* header */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center gap-3">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-600"><User className="h-6 w-6" /></span>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">{p.patient.name || "—"}</h2>
                  {p.vip && <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TIER[p.vip.tier]?.cls}`}><Crown className="h-3 w-3" />{TIER[p.vip.tier]?.label}</span>}
                  {p.patient.deceased && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-600">{t("Θανών", "Deceased")}</span>}
                  {p.contact && p.contact.active === false && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] text-rose-700">{t("Ανενεργός", "Inactive")}</span>}
                </div>
                <div className="text-xs text-slate-500">ΑΜΚΑ {p.patient.amka} · {p.patient.age_group} · {p.patient.sex === "M" ? t("Άνδρας", "Male") : p.patient.sex === "F" ? t("Γυναίκα", "Female") : "—"} · {p.patient.area || "—"}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("Τελευταία επίσκεψη", "Last visit")}</div>
              <div className="mt-0.5 flex items-center justify-end gap-2">
                <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{fmtDate(p.patient.last_seen)}</span>
                {p.patient.gap_days != null && (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p.patient.gap_days > 90 ? "bg-rose-100 text-rose-700" : p.patient.gap_days > 30 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                    {p.patient.gap_days === 0 ? t("σήμερα", "today") : `${p.patient.gap_days}${t("η πριν", "d ago")}`}
                  </span>
                )}
              </div>
              {p.vip && <div className="mt-1 text-xs text-slate-500">{t("Κατάταξη αξίας", "Value rank")}: #{p.vip.rank}/{fmtNum(p.vip.of)} ({t("top", "top")} {(p.vip.rank / p.vip.of * 100).toFixed(1)}%)</div>}
            </div>
          </div>

          {/* financial KPIs */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label={t("Αξία πελάτη (LTV)", "Lifetime value")} value={fmtEur(p.financials!.value)} icon={Wallet} accent="green" help={t("Συνολική λιανική αξία όλων των εκτελέσεων.", "Total retail value of all executions.")} />
            <KpiCard label={t("Αριθμός εκτελέσεων", "Executions")} value={fmtNum(p.financials!.rx_count)} icon={Repeat} accent="indigo" sub={t(`μ.ο. ${fmtEur(p.financials!.avg_per_visit)}/εκτέλεση · κλικ για λίστα`, `avg ${fmtEur(p.financials!.avg_per_visit)}/exec · click for list`)} onClick={() => p.executions?.length && setShowExecs(true)} />
            <KpiCard label={t("Μικτό κέρδος", "Gross profit")} value={fmtEur(p.financials!.profit)} icon={Wallet} accent="violet" help={t("Λιανική − κόστος αγοράς.", "Retail − cost of goods.")} />
            <KpiCard label={t("Συμμόρφωση", "Adherence")} value={p.adherence!.compliance != null ? `${p.adherence!.compliance}%` : "—"} icon={Target} accent={p.adherence!.compliance != null && p.adherence!.compliance < 50 ? "rose" : "amber"} sub={p.adherence!.band ?? undefined} help={t("Εκτελεσμένες / αναμενόμενες ανανεώσεις επαναλαμβανόμενης θεραπείας.", "Executed / expected repeat renewals.")} />
          </div>

          {/* μηνιαία KPIs — μ.ο. εκτελέσεων/μήνα, εκτελέσεις τρέχοντος μήνα, μ.ο. αξίας/μήνα */}
          {(() => {
            const execs = (p.executions || []).filter((e) => !e.cancelled && e.executed_at);
            const now = new Date();
            const curKey = `${now.getFullYear()}-${now.getMonth()}`;
            const curMonthCount = execs.filter((e) => {
              const d = new Date(e.executed_at!);
              return `${d.getFullYear()}-${d.getMonth()}` === curKey;
            }).length;
            const curMonthValue = execs.reduce((s, e) => {
              const d = new Date(e.executed_at!);
              return `${d.getFullYear()}-${d.getMonth()}` === curKey ? s + (e.amount_total || 0) : s;
            }, 0);
            // ενεργό εύρος σε μήνες: ΠΑΛΑΙΟΤΕΡΗ πραγματική εκτέλεση → τώρα (≥1). ΟΧΙ το first_seen_at,
            // που μπαίνει με τη σειρά ΛΗΨΗΣ (μπορεί να είναι πιο πρόσφατο από την 1η εκτέλεση).
            const fsTs = execs.length ? Math.min(...execs.map((e) => new Date(e.executed_at!).getTime()))
              : p.patient!.first_seen ? new Date(p.patient!.first_seen).getTime() : now.getTime();
            const fs = new Date(fsTs);
            const months = Math.max(1, (now.getFullYear() - fs.getFullYear()) * 12 + (now.getMonth() - fs.getMonth()) + 1);
            const avgExec = p.financials!.rx_count / months;
            const avgValue = Math.round(p.financials!.value / months);
            return (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <KpiCard label={t("Εκτελέσεις / μήνα", "Executions / month")} value={fmtDec(avgExec, 1)} icon={CalendarRange} accent="indigo"
                  help={t("Μέσος όρος εκτελέσεων ανά μήνα από την 1η εκτέλεση.", "Average executions per month since first execution.")} />
                <KpiCard label={t("Εκτελέσεις τρέχοντος μήνα", "Executions this month")} value={fmtNum(curMonthCount)} icon={Calendar} accent="sky"
                  sub={curMonthValue > 0 ? fmtEur(curMonthValue) : undefined}
                  help={t("Εκτελέσεις μέσα στον τρέχοντα ημερολογιακό μήνα.", "Executions within the current calendar month.")} />
                <KpiCard label={t("Αξία / μήνα", "Value / month")} value={fmtEur(avgValue)} icon={Wallet} accent="green"
                  help={t("Μέση μηνιαία αξία (τζίρος) του πελάτη.", "Average monthly value (turnover) of the patient.")} />
              </div>
            );
          })()}

          {/* εκτελέσεις του πελάτη ανά μήνα (τελευταίοι 12 μήνες· συνταγές + εμβολιασμοί) */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Repeat className="h-4 w-4 text-brand-600" /> {t("Εκτελέσεις ανά μήνα", "Executions per month")}</h3>
            <p className="mb-3 text-xs text-slate-400">{t("Τελευταίοι 12 μήνες — συνταγές & εμβολιασμοί", "Last 12 months — prescriptions & vaccinations")}</p>
            {(() => {
              const now = new Date();
              const keys: { k: string; label: string }[] = [];
              for (let i = 11; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                keys.push({
                  k: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
                  label: `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`,
                });
              }
              const cnt: Record<string, number> = {};
              for (const e of p.executions || []) {
                if (e.cancelled || !e.executed_at) continue;
                const d = new Date(e.executed_at);
                const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                cnt[k] = (cnt[k] || 0) + 1;
              }
              return <BarChart labels={keys.map((x) => x.label)} data={keys.map((x) => cnt[x.k] || 0)}
                name={t("Εκτελέσεις", "Executions")} height={240}
                ariaLabel={t("Εκτελέσεις ανά μήνα", "Executions per month")} />;
            })()}
          </div>

          {/* lost / opportunity strip — clickable to drill into the actual prescriptions */}
          {(p.adherence!.missed > 0 || p.adherence!.available > 0) && (
            <div className="rounded-2xl border border-rose-100 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-950/20">
              <div className="flex flex-wrap items-center gap-4 px-5 py-3 text-sm">
                <AlertTriangle className="h-5 w-5 text-rose-500" />
                <button onClick={() => setShow(show === "missed" ? null : "missed")} disabled={!p.missed_items?.length}
                  className={`inline-flex items-center gap-1 text-slate-700 hover:underline disabled:no-underline dark:text-slate-200 ${show === "missed" ? "font-semibold" : ""}`}>
                  {t("Φάρμακα που δεν έχει πάρει", "Medicines not picked up")}: <b className="text-rose-600">{p.adherence!.missed}</b>
                  {!!p.missed_items?.length && <ChevronRight className={`h-3.5 w-3.5 transition ${show === "missed" ? "rotate-90" : ""}`} />}
                </button>
                <button onClick={() => setShow(show === "available" ? null : "available")} disabled={!p.available_items?.length}
                  className={`inline-flex items-center gap-1 text-slate-700 hover:underline disabled:no-underline dark:text-slate-200 ${show === "available" ? "font-semibold" : ""}`}>
                  {t("Διαθέσιμες τώρα", "Available now")}: <b className="text-amber-600">{p.adherence!.available}</b>
                  {!!p.available_items?.length && <ChevronRight className={`h-3.5 w-3.5 transition ${show === "available" ? "rotate-90" : ""}`} />}
                </button>
                <span className="text-slate-700 dark:text-slate-200">{t("Αξία προς ανάκτηση", "Recoverable value")}: <b className="text-rose-600">{fmtEur(p.adherence!.lost_value)}</b></span>
                {p.adherence!.next_open && <span className="ml-auto text-slate-500">{t("Επόμενη ανανέωση", "Next renewal")}: {fmtDate(p.adherence!.next_open)}</span>}
              </div>
              {show && (
                <div className="border-t border-rose-100 px-5 py-3 dark:border-rose-900/40">
                  {(show === "missed" ? p.missed_items! : p.available_items!).map((x, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 border-b border-rose-100/60 py-1.5 text-sm last:border-0 dark:border-rose-900/30">
                      <div className="min-w-0">
                        <div className="truncate text-slate-700 dark:text-slate-200">{x.medicines.join(", ") || "—"}</div>
                        <div className="text-xs text-slate-400">
                          {x.root && <span className="font-mono text-slate-500">{t("Συνταγή", "Rx")} {x.root}</span>}
                          {x.root && " · "}
                          {show === "missed"
                            ? t(`${x.count} χαμένες · τελευταία εκτέλεση ${fmtDate(x.last_executed)}`, `${x.count} missed · last ${fmtDate(x.last_executed)}`)
                            : t(`διαθέσιμη έως ${fmtDate(x.until)}`, `available until ${fmtDate(x.until)}`)}
                        </div>
                      </div>
                      <b className="shrink-0 text-rose-600">{fmtEur(x.value)}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* flu vaccination — current season */}
          {p.flu && (
            <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-sm ${p.flu.vaccinated ? "border-emerald-100 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/20" : "border-amber-100 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20"}`}>
              <Syringe className={`h-4 w-4 ${p.flu.vaccinated ? "text-emerald-600" : "text-amber-600"}`} />
              <span className="font-medium text-slate-700 dark:text-slate-200">{t("Εμβόλιο γρίπης", "Flu vaccine")} {p.flu.season}:</span>
              {p.flu.vaccinated
                ? <span className="text-emerald-700 dark:text-emerald-400">✓ {t("Εμβολιάστηκε", "Vaccinated")} {p.flu.date ? `(${fmtDate(p.flu.date)}${p.flu.vaccine ? ` · ${p.flu.vaccine}` : ""})` : ""}</span>
                : <span className="text-amber-700 dark:text-amber-500">✗ {t("Δεν έχει εμβολιαστεί φέτος", "Not vaccinated this season")}</span>}
            </div>
          )}

          {/* περίοδος για Διαγνώσεις & Φάρμακα — εστιάζει & το AI στο πρόσφατο πρόβλημα (όχι παλιές διαγνώσεις) */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500">{t("Διαγνώσεις & Φάρμακα — περίοδος", "Diagnoses & medicines — period")}:</span>
            {([[3, "3μ"], [6, "6μ"], [12, "12μ"], [24, "24μ"], [0, t("Όλα", "All")]] as [number, string][]).map(([m, label]) => (
              <button key={m} onClick={() => changeRange(m)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${rangeMonths === m ? "bg-brand-600 text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* segments + conditions */}
            <div className="rx-card p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Stethoscope className="h-4 w-4 text-brand-600" /> {t("Θεραπευτικό προφίλ", "Therapeutic profile")}</h3>
              {p.segments!.length > 0 && <div className="mb-3 flex flex-wrap gap-2">{p.segments!.map((s) => <span key={s.key} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">{s.label}</span>)}</div>}
              <div className="space-y-1.5">
                {p.conditions!.length === 0 && <div className="text-sm text-slate-400">—</div>}
                {p.conditions!.map((c) => (
                  <div key={c.code} className="flex items-center justify-between text-sm">
                    <span className="text-slate-600 dark:text-slate-300"><span className="font-mono text-xs text-slate-400">{c.code}</span> {c.title || ""}</span>
                    <span className="text-xs text-slate-400">×{c.times}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* top medicines */}
            <div className="rx-card p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Pill className="h-4 w-4 text-brand-600" /> {t("Συχνότερα φάρμακα", "Top medicines")}</h3>
              <div className="space-y-1.5">
                {p.medicines!.slice(0, 8).map((m, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="truncate pr-2 text-slate-600 dark:text-slate-300" title={`${m.name}${m.atc ? ` · ${m.atc}` : ""}`}>{m.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">×{m.times} · {fmtEur(m.value)}</span>
                  </div>
                ))}
              </div>
              {p.doctors!.length > 0 && (
                <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div className="mb-1 text-xs font-semibold text-slate-400">{t("Συνταγογράφοι", "Prescribers")}</div>
                  {p.doctors!.map((d, i) => <div key={i} className="flex justify-between text-sm text-slate-600 dark:text-slate-300"><span>{d.name} {d.specialty && <span className="text-xs text-slate-400">· {d.specialty}</span>}</span><span className="text-xs text-slate-400">×{d.times}</span></div>)}
                </div>
              )}
            </div>
          </div>

          {/* contact — κλειστή σύνοψη· το κουμπί λογαριασμού my.rxvision ζει στο header της κάρτας */}
          <ContactCard patientId={p.patient.id} collapsible extraAction={
            <button onClick={() => { setPortalEmail(p.contact?.email || ""); setPortalResult(null); setShowPortal(true); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/30">
              <User className="h-3.5 w-3.5" /> {t("Λογαριασμός my.rxvision", "my.rxvision account")}
            </button>
          } />

          {/* Κλινικό flag G6PD */}
          <div className={`flex flex-wrap items-center gap-3 rounded-2xl border p-4 ${g6pd ? "border-rose-200 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={g6pd} onChange={(e) => { setG6pd(e.target.checked); g6pdMut.mutate(e.target.checked); }}
                className="h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-400" />
              <span className="font-medium text-slate-700 dark:text-slate-200">⚠️ {t("Έλλειψη ενζύμου G6PD", "G6PD enzyme deficiency")}</span>
              <span className="text-xs text-slate-400">{t("προσοχή σε οξειδωτικά φάρμακα · λαμβάνεται υπόψη από το AI", "oxidative-drug caution · used by AI")}</span>
            </label>
          </div>

          {/* Σχόλια — log χρονολογημένων σχολίων φαρμακοποιού */}
          <PatientCommentsCard amka={p.patient.amka} />

          {/* AI advice */}
          <div className="rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-5 dark:border-brand-900/40 dark:from-brand-950/20 dark:to-slate-900">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-brand-700 dark:text-brand-300"><Sparkles className="h-4 w-4" /> {t("Συμβουλές AI — πώς να τον φροντίσω", "AI advice — how to care for them")}</h3>
              {!advice && <button onClick={() => ask.mutate(p.patient!.amka)} disabled={ask.isPending} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{ask.isPending ? t("Ανάλυση…", "Analyzing…") : t("Δημιουργία συμβουλών", "Generate")}</button>}
            </div>
            {ask.isError && <div className="mt-3 text-sm text-rose-600">{t("Η AI δεν είναι διαθέσιμη/ρυθμισμένη. Ρύθμισε το κλειδί στο admin.", "AI not available/configured. Set the key in admin.")}</div>}
            {advice?.ok && (
              <div className="mt-3 space-y-3">
                {advice.summary && <p className="rounded-xl bg-white/70 px-4 py-3 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">{advice.summary}</p>}
                <div className="grid gap-3 md:grid-cols-2">
                  <AdviceList icon={Eye} title={t("Πώς να τον προσεγγίσω", "Approach")} items={advice.approach} accent="text-brand-700 dark:text-brand-300" />
                  <AdviceList icon={Salad} title={t("Διατροφή & τρόπος ζωής", "Lifestyle & nutrition")} items={advice.lifestyle} accent="text-emerald-700 dark:text-emerald-400" />
                  <AdviceList icon={Target} title={t("Ευκαιρίες φροντίδας", "Care opportunities")} items={advice.opportunities} accent="text-violet-700 dark:text-violet-400" />
                  <AdviceList icon={AlertTriangle} title={t("Σημεία προσοχής", "Watch")} items={advice.watch} accent="text-amber-700 dark:text-amber-500" />
                </div>
                <p className="text-[11px] text-slate-400">{t("Γενικές συμβουλές — δεν υποκαθιστούν την ιατρική γνώμη.", "General guidance — not a substitute for medical advice.")}</p>
              </div>
            )}
          </div>
          {showExecs && p.executions && (
            <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={() => setShowExecs(false)}>
              <div className="mt-8 w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Εκτελέσεις πελάτη", "Patient executions")} <span className="text-sm font-normal text-slate-400">({p.executions.length})</span></h3>
                  <button onClick={() => setShowExecs(false)} className="text-slate-400 hover:text-slate-600">✕</button>
                </div>
                <div className="max-h-[70vh] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500 dark:bg-slate-800"><tr>
                      <th className="px-3 py-2 text-left">{t("Ημ/νία", "Date")}</th>
                      <th className="px-3 py-2 text-left">Barcode</th>
                      <th className="px-3 py-2 text-left">{t("Φάρμακα", "Medicines")}</th>
                      <th className="px-3 py-2 text-left">{t("Ιατρός", "Doctor")}</th>
                      <th className="px-3 py-2 text-right">{t("Αξία", "Amount")}</th>
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {p.executions.map((e, i) => (
                        <tr key={i} onClick={() => router.push(e.kind === "vaccine" ? `/vaccinations?barcode=${encodeURIComponent(e.barcode)}` : `/prescriptions/${encodeURIComponent(e.barcode)}`)} className={`cursor-pointer hover:bg-brand-50/50 dark:hover:bg-slate-800 ${e.cancelled ? "opacity-50" : ""}`}>
                          <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{fmtDate(e.executed_at)}</td>
                          <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{e.barcode.split(":")[0]}</td>
                          <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
                            <span className="inline-flex items-center gap-1.5">
                              {e.kind === "vaccine" && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-semibold text-sky-700">💉 ΕΜΒΟΛΙΟ</span>}
                              <span className="line-clamp-1">{e.medicines.join(", ") || "—"}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">{e.doctor || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{e.amount_total ? fmtEur(e.amount_total) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">{t("Κλικ σε γραμμή για τη λεπτομέρεια της συνταγής.", "Click a row for the prescription detail.")}</p>
              </div>
            </div>
          )}

          {showPortal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowPortal(false)}>
              <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Λογαριασμός my.rxvision", "my.rxvision account")}</h3>
                  <button onClick={() => setShowPortal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
                </div>
                <div className="mb-3 text-sm text-slate-600 dark:text-slate-300">{p.patient.name} · <span className="font-mono text-xs">{p.patient.amka}</span></div>
                {portalResult ? (
                  <div className="space-y-3">
                    <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{t("Ο λογαριασμός δημιουργήθηκε! Δώσε στον πελάτη τα παρακάτω στοιχεία:", "Account created! Give the patient these credentials:")}</div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
                      <div>{t("Σύνδεση", "Login")}: <b>my.rxvision.gr</b></div>
                      <div>Email: <b className="font-mono">{portalResult.email}</b></div>
                      <div>{t("Προσωρινός κωδικός", "Temp password")}: <b className="font-mono">{portalResult.temp_password}</b></div>
                    </div>
                    <button onClick={() => navigator.clipboard?.writeText(`my.rxvision.gr\nEmail: ${portalResult.email}\n${t("Κωδικός", "Password")}: ${portalResult.temp_password}`)} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">{t("Αντιγραφή στοιχείων", "Copy credentials")}</button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-slate-500">{t("Δημιουργείται λογαριασμός πελάτη· θα δοθεί προσωρινός κωδικός να τον δώσεις στον πελάτη.", "Creates a patient account; a temp password will be shown to hand to the patient.")}</p>
                    <label className="block text-xs font-medium text-slate-500">Email
                      <input type="email" value={portalEmail} onChange={(e) => setPortalEmail(e.target.value)} placeholder="patient@email.gr"
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
                    </label>
                    {createAcc.isError && <div className="text-sm text-rose-600">{t("Αποτυχία — ίσως υπάρχει ήδη λογαριασμός με αυτό το ΑΜΚΑ ή email.", "Failed — an account with this ΑΜΚΑ or email may already exist.")}</div>}
                    <button onClick={() => portalEmail.includes("@") && createAcc.mutate()} disabled={createAcc.isPending || !portalEmail.includes("@")}
                      className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                      {createAcc.isPending ? t("Δημιουργία…", "Creating…") : t("Δημιουργία λογαριασμού", "Create account")}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
