"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Compass, Check, BellOff, ArrowRight, Trophy, Flame, TrendingUp, Phone, PhoneOff, User, IdCard, FileText, ListChecks, Wallet, Droplets, Users2, SlidersHorizontal, CalendarRange, Target } from "lucide-react";
import { api } from "@/lib/apiClient";
import { appConfirm } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";
import { Celebrate } from "@/components/coach/Celebrate";
import { QueryState } from "@/components/ui/QueryState";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Tone = "soft" | "firm" | "hard";
type Who = { id: string | null; name: string | null; amka: string | null; mobile: string | null; phone: string | null; email: string | null };
type Link = { kind: "profile" | "card" | "rx" | "inbox"; label: string; href: string };
type Item = {
  key: string; signal: string; name: string | null; title: string; body: string; action: string;
  tone: Tone; streak: number; relapses: number; money_cents: number | null;
  who: Who; call: string | null; links: Link[]; emoji?: string | null;
};
type Win = { key: string; count: number; text: string; emoji?: string };
type Mood = "celebrate" | "calm" | "focus" | "work";
type Today = {
  day: string; greeting: string; items: Item[]; hidden: number; wins: Win[];
  closing: string; clean_streak: number; at_risk_cents: number;
  mood: Mood; milestone: string | null;
};
type Hist = { day: string; misses: number; wins: number };
type Bucket = { n: number; value_cents: number; profit_cents: number };
type Value = {
  days: number; acted: Bucket; passive: Bucket; lost: Bucket;
  by_signal: { signal: string; n: number; value: number; profit: number }[];
  recent: { name: string | null; signal: string; day: string; value_cents: number; acted: boolean; days_open: number }[];
};
type Leak = {
  months: { month: string; repeats_n: number; repeats_value: number; repeats_profit: number;
            items_n: number; items_value: number; items_profit: number;
            total_value: number; total_profit: number; partial?: boolean }[];
  total: Record<string, number>;
  trend: { before: number; after: number; better: boolean; worse: boolean } | null;
  full_months: number; this_month: string;
};
type Goal = { signal: string; label: string; target: number; active: boolean; hit_days: number; of_days: number; progress_text: string; achieved?: boolean; emoji?: string } | null;
type Week = {
  from: string; to: string; misses: number; misses_prev: number; closed: number;
  recovered: Bucket; daily: { day: string; misses: number; has_data: boolean }[];
  goal: Goal; narrative: string; days_with_data: number; prev_days_with_data: number;
};
type Team = { days: number; total_closed: number; stale: number;
  members: { user_id: string; name: string; closed: number; recovered: number; last: string }[] };
type Settings = {
  email_hour: number; email_enabled: boolean; email_to: string | null; max_items: number;
  escalate_owner: boolean; signals: Record<string, boolean>; labels: Record<string, string>;
};

type Tab = "today" | "week" | "value" | "leakage" | "team" | "settings";
const TABS: { key: Tab; el: string; en: string; icon: typeof Compass }[] = [
  { key: "today", el: "Σήμερα", en: "Today", icon: Compass },
  { key: "week", el: "Η εβδομάδα σου", en: "Your week", icon: CalendarRange },
  { key: "value", el: "Τι κέρδισες", en: "What you recovered", icon: Wallet },
  { key: "leakage", el: "Κρυφό κόστος", en: "Hidden cost", icon: Droplets },
  { key: "team", el: "Ομάδα", en: "Team", icon: Users2 },
  { key: "settings", el: "Ρυθμίσεις", en: "Settings", icon: SlidersHorizontal },
];
// Η «διάθεση» της ημέρας. Στη «δουλειά» (πολλά ή επαναλαμβανόμενα) ΔΕΝ μπαίνει εικονίδιο —
// εκεί η ελαφρότητα θα ακύρωνε το μήνυμα.
const MOOD: Record<Mood, { emoji: string | null; card: string }> = {
  celebrate: { emoji: "🎉", card: "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/30" },
  calm: { emoji: "☀️", card: "border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/25" },
  focus: { emoji: "☕", card: "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" },
  work: { emoji: null, card: "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" },
};
const DOW_EL = ["Κυ", "Δε", "Τρ", "Τε", "Πέ", "Πα", "Σά"];
const MONTH_EL = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"];
const mlabel = (m: string) => { const [y, mm] = m.split("-"); return `${MONTH_EL[Number(mm) - 1] ?? mm} ${y.slice(2)}`; };

const eur = (c: number) => `${((c || 0) / 100).toLocaleString("el-GR", { maximumFractionDigits: 0 })} €`;

// Ο τόνος δεν είναι διακόσμηση — είναι η πληροφορία. Κόκκινο = το λέμε πολλές μέρες.
const TONE: Record<Tone, { bar: string; chip: string; label: [string, string] }> = {
  soft: { bar: "bg-sky-400", chip: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300", label: ["Το πρόσεξα", "Noticed"] },
  firm: { bar: "bg-amber-500", chip: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300", label: ["Επιμένει", "Recurring"] },
  hard: { bar: "bg-rose-600", chip: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300", label: ["Επαναλαμβάνεται", "Repeated"] },
};

const LINK_ICON = { profile: User, card: IdCard, rx: FileText, inbox: ListChecks } as const;

// Ελληνικά ονόματα σημάτων (ίδια με το backend) — για πίνακες & στόχους.
const SIGNAL_EL: Record<string, string> = {
  unexecuted: "Ανεκτέλεστα είδη",
  repeat_expiring: "Επαναλήψεις που λήγουν",
  idle_request: "Αιτήματα χωρίς απάντηση",
  no_contact: "Πελάτες χωρίς στοιχεία",
  vaccine_missed: "Χαμένοι εμβολιασμοί",
  lapsed_chronic: "Χρόνιοι που σταμάτησαν",
};
// Ίδια εικονίδια με το backend, ώστε το ίδιο θέμα να φαίνεται ίδιο παντού.
const SIGNAL_EMOJI: Record<string, string> = {
  unexecuted: "💊", repeat_expiring: "⏳", idle_request: "💬",
  no_contact: "📇", vaccine_missed: "💉", lapsed_chronic: "🚶",
};
// Οι στόχοι που έχει νόημα να βάλει κάποιος — διατυπωμένοι ως δέσμευση, όχι ως μετρικό.
const SIGNAL_GOALS: Record<string, string> = {
  idle_request: "💬 Κανένα αίτημα χωρίς απάντηση",
  unexecuted: "💊 Κανένα ανεκτέλεστο να μείνει αναπάντητο",
  repeat_expiring: "⏳ Καμία επανάληψη να λήξει αχρησιμοποίητη",
  no_contact: "📇 Κανένας πελάτης χωρίς τηλέφωνο",
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className={`text-lg font-bold ${tone === "good" ? "text-emerald-600 dark:text-emerald-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-slate-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 rounded-full transition ${on ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-700"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export default function CoachPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("today");
  const q = useQuery({ queryKey: ["coach-today"], queryFn: () => api<Today>("/coach/today"), refetchInterval: 600_000 });
  const h = useQuery({ queryKey: ["coach-history"], queryFn: () => api<{ items: Hist[] }>("/coach/history?days=21") });
  // Κάθε καρτέλα φορτώνει ΜΟΝΟ όταν την ανοίξεις — οι αναφορές είναι βαριές (μήνες δεδομένων).
  const wk = useQuery({ queryKey: ["coach-week"], queryFn: () => api<Week>("/coach/week"), enabled: tab === "week" });
  const val = useQuery({ queryKey: ["coach-value"], queryFn: () => api<Value>("/coach/value?days=90"), enabled: tab === "value" });
  const leak = useQuery({ queryKey: ["coach-leak"], queryFn: () => api<Leak>("/coach/leakage?months=6"), enabled: tab === "leakage" });
  const team = useQuery({ queryKey: ["coach-team"], queryFn: () => api<Team>("/coach/team?days=30"), enabled: tab === "team" });
  const cfg = useQuery({ queryKey: ["coach-settings"], queryFn: () => api<Settings>("/coach/settings"), enabled: tab === "settings" });

  const saveCfg = useMutation({
    mutationFn: (patch: Partial<Settings>) => api<Settings>("/coach/settings", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => { cfg.refetch(); q.refetch(); },
  });
  const saveGoal = useMutation({
    mutationFn: (v: { signal: string | null; target: number }) => api("/coach/goal", { method: "PUT", body: JSON.stringify(v) }),
    onSuccess: () => wk.refetch(),
  });

  // Γιορτάζουμε ΜΟΝΟ στη μετάβαση «είχα θέματα» → «κανένα». Μια γιορτή που παίζει σε κάθε
  // φόρτωση σελίδας παύει να είναι γιορτή.
  const [party, setParty] = useState(0);
  const had = useRef(false);
  useEffect(() => {
    const n = q.data?.items.length;
    if (n === undefined) return;
    if (n === 0 && had.current) setParty((p) => p + 1);
    had.current = n > 0;
  }, [q.data?.items.length]);

  const mark = useMutation({
    mutationFn: (v: { key: string; action: string }) =>
      api(`/coach/findings/${encodeURIComponent(v.key)}/mark`, { method: "POST", body: JSON.stringify({ action: v.action }) }),
    onSuccess: () => { q.refetch(); h.refetch(); },
  });

  async function dismiss(it: Item) {
    if (await appConfirm(t(`Να μη σου το ξαναπώ για «${it.title}»; Θα σωπάσω για έναν μήνα.`,
      `Stop mentioning "${it.title}"? I'll stay quiet for a month.`))) mark.mutate({ key: it.key, action: "dismiss" });
  }

  /* ΣΕΛΙΔΟΠΟΙΗΣΗ: ο Σύμβουλος βγάζει δεκάδες κάρτες και η σελίδα γινόταν ατέλειωτη — έχανες
     το μενού και δεν ήξερες πού είσαι.

     5 ΚΑΙ ΟΧΙ 10: οι κάρτες του Συμβούλου είναι μεγάλες (όνομα, ΑΜΚΑ, τηλέφωνο, παράγραφος
     εξήγησης, κουμπιά). Με 10 η σελίδα έμενε ατέλειωτη και με 9 θέματα δεν εμφανιζόταν καν
     πλοήγηση — δηλαδή η σελιδοποίηση δεν φαινόταν να υπάρχει. */
  const PAGE = 5;
  const [page, setPage] = useState(0);
  const allItems = q.data?.items ?? [];
  const pages = Math.max(1, Math.ceil(allItems.length / PAGE));
  const shown = allItems.slice(page * PAGE, page * PAGE + PAGE);
  useEffect(() => { setPage(0); }, [allItems.length]);

  const hist = h.data?.items ?? [];
  const trend = useMemo(() => {
    if (hist.length < 6) return null;
    const half = Math.floor(hist.length / 2);
    const avg = (a: Hist[]) => a.reduce((s, x) => s + x.misses, 0) / (a.length || 1);
    const before = avg(hist.slice(0, half)), after = avg(hist.slice(half));
    return { before, after, better: after < before - 0.4, worse: after > before + 0.4 };
  }, [hist]);
  const maxMiss = Math.max(1, ...hist.map((x) => x.misses));

  return (
    <ModuleGuard module="daily_coach">
      <Celebrate fire={party > 0} key={party} />
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-600 text-white shadow-lg"><Compass className="h-6 w-6" /></span>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Ο Σύμβουλός σου", "Your Advisor")}</h1>
            <p className="text-xs text-slate-500">{t("Τι έπρεπε να είχες προσέξει σήμερα — και τι έκανες σωστά.", "What deserved your attention today — and what you got right.")}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-slate-800">
          {TABS.map((tb) => {
            const Ico = tb.icon;
            return (
              <button key={tb.key} onClick={() => setTab(tb.key)}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  tab === tb.key
                    ? "bg-indigo-600 text-white"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"}`}>
                <Ico className="h-3.5 w-3.5" />{t(tb.el, tb.en)}
              </button>
            );
          })}
        </div>

        {tab === "today" && (
        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
          {q.data && (
            <>
              {/* Η καλημέρα — ο σύμβουλος μιλάει πρώτος. Το χρώμα & το εικονίδιο ακολουθούν
                  τη διάθεση της ημέρας· στις κακές μέρες δεν μπαίνει εικονίδιο καθόλου. */}
              <div className={`rounded-2xl border p-5 shadow-sm ${MOOD[q.data.mood ?? "focus"].card}`}>
                <div className="flex items-start gap-3">
                  {MOOD[q.data.mood ?? "focus"].emoji && (
                    <span className="text-2xl leading-none" aria-hidden>{MOOD[q.data.mood ?? "focus"].emoji}</span>
                  )}
                  <p className="text-base leading-relaxed text-slate-800 dark:text-slate-200">{q.data.greeting}</p>
                </div>
                {q.data.milestone && (
                  <p className="mt-2.5 rounded-xl bg-white/70 px-3 py-2 text-sm font-semibold text-emerald-700 dark:bg-slate-900/50 dark:text-emerald-300">
                    🏅 {q.data.milestone}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  {q.data.clean_streak > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <Flame className="h-3.5 w-3.5" />{t(`${q.data.clean_streak} καθαρές μέρες σερί`, `${q.data.clean_streak}-day clean streak`)}
                    </span>
                  )}
                  {q.data.at_risk_cents > 0 && (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {t(`Σε εκκρεμότητα: ${eur(q.data.at_risk_cents)}`, `At stake: ${eur(q.data.at_risk_cents)}`)}
                    </span>
                  )}
                </div>
              </div>

              {/* Τι ξέφυγε */}
              <div className="space-y-3">
                {shown.map((it) => {
                  const tn = TONE[it.tone];
                  const links = it.links ?? [];
                  // Στον «πελάτη παρουσίασης» τα τηλέφωνα είναι μασκαρισμένα («****») — δείχνουμε
                  // το chip για ρεαλισμό, αλλά ΔΕΝ φτιάχνουμε tel: σύνδεσμο που δεν καλεί κανέναν.
                  const dial = it.call && /\d{6,}/.test(it.call) ? it.call.replace(/\s/g, "") : null;
                  // Η ετικέτα ενός κουμπιού πρέπει να λέει ΤΗΝ ΑΛΗΘΕΙΑ για το πού πάει. Όταν
                  // υπάρχει αριθμός, το κουμπί ΚΑΛΕΙ. Όταν δεν υπάρχει, δεν γράφουμε «πάρ' τον
                  // τηλέφωνο» σε σύνδεσμο που ανοίγει καρτέλα — γράφουμε «βρες τηλέφωνο».
                  const primary = dial ? null : (links.find((l) => l.kind === "card") ?? links[0] ?? null);
                  const noPhone = !it.call && !!it.who?.id;
                  const primaryLabel = primary
                    ? (noPhone ? t("Βρες τηλέφωνο", "Find a phone number") : primary.label)
                    : "";
                  const PrimaryIco = noPhone ? PhoneOff : (primary ? LINK_ICON[primary.kind] ?? ArrowRight : ArrowRight);
                  const rest = links.filter((l) => l !== primary);
                  return (
                    <div key={it.key} className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
                      <span className={`absolute inset-y-0 left-0 w-1.5 ${tn.bar}`} />
                      <div className="p-4 pl-6">
                        <div className="flex flex-wrap items-center gap-2">
                          {it.emoji && <span className="text-base leading-none" aria-hidden>{it.emoji}</span>}
                          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{it.title}</h3>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tn.chip}`}>{t(tn.label[0], tn.label[1])}</span>
                          {it.streak > 1 && (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {t(`${it.streak}η μέρα`, `day ${it.streak}`)}
                            </span>
                          )}
                        </div>

                        {/* Ταυτότητα: ΠΟΙΟΝ ακριβώς αφορά + πώς τον βρίσκεις. Χωρίς αυτό η γραμμή
                            είναι παρατήρηση· με αυτό είναι ενέργεια. */}
                        {(it.who?.amka || it.call || it.who?.email) && (
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                            {it.who?.amka && <span>{t("ΑΜΚΑ", "ΑΜΚΑ")} {it.who.amka}</span>}
                            {it.call ? (
                              dial ? (
                                <a href={`tel:${dial}`}
                                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300">
                                  <Phone className="h-3 w-3" />{it.call}
                                </a>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                                  <Phone className="h-3 w-3" />{it.call}
                                </span>
                              )
                            ) : it.who?.id ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                                <PhoneOff className="h-3 w-3" />{t("χωρίς τηλέφωνο", "no phone")}
                              </span>
                            ) : null}
                            {it.who?.email && <span className="truncate max-w-[220px]">{it.who.email}</span>}
                          </div>
                        )}

                        <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{it.body}</p>

                        {/* Γραμμή 1 — ΠΟΥ πάω τώρα. Κάθε κουμπί οδηγεί σε υπαρκτή οθόνη
                            φορτωμένη με ΑΥΤΟΝ τον πελάτη. */}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {dial ? (
                            <a href={`tel:${dial}`}
                              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
                              <Phone className="h-3.5 w-3.5" />{it.action}
                            </a>
                          ) : primary ? (
                            <Link href={primary.href}
                              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
                              <PrimaryIco className="h-3.5 w-3.5" />{primaryLabel}
                            </Link>
                          ) : null}
                          {rest.map((l) => {
                            const Ico = LINK_ICON[l.kind] ?? ArrowRight;
                            return (
                              <Link key={l.kind + l.href} href={l.href}
                                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                                <Ico className="h-3.5 w-3.5" />{l.label}
                              </Link>
                            );
                          })}

                {/* Πλοήγηση — μόνο όταν χρειάζεται. Επιστροφή στην κορυφή με την αλλαγή
                    σελίδας, αλλιώς ο χρήστης μένει στο τέλος και νομίζει ότι δεν άλλαξε. */}
                {pages > 1 && (
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                    <button onClick={() => { setPage((p) => Math.max(0, p - 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                      disabled={page === 0}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:text-slate-300">
                      ← {t("Προηγούμενα", "Previous")}
                    </button>
                    <span className="text-sm text-slate-500">
                      {t(`${page * PAGE + 1}–${Math.min(allItems.length, (page + 1) * PAGE)} από ${allItems.length}`,
                         `${page * PAGE + 1}–${Math.min(allItems.length, (page + 1) * PAGE)} of ${allItems.length}`)}
                    </span>
                    <button onClick={() => { setPage((p) => Math.min(pages - 1, p + 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                      disabled={page >= pages - 1}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:text-slate-300">
                      {t("Επόμενα", "Next")} →
                    </button>
                  </div>
                )}
                        </div>

                        {/* Γραμμή 2 — τι κάνω με το ίδιο το εύρημα. Πάντα χωριστά, ώστε να μη
                            χοροπηδάει η διάταξη ανάλογα με το πλήθος των συνδέσμων. */}
                        <div className="mt-2 flex items-center justify-end gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
                          <button onClick={() => mark.mutate({ key: it.key, action: "done" })}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                            <Check className="h-3.5 w-3.5" />{t("Το έκανα", "Done")}
                          </button>
                          <button onClick={() => dismiss(it)}
                            className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                            <BellOff className="h-3.5 w-3.5" />{t("Δεν με αφορά", "Not relevant")}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {q.data.items.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/40 p-8 text-center dark:border-emerald-900 dark:bg-emerald-950/20">
                    <div className="text-4xl" aria-hidden>🧹</div>
                    <p className="mt-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                      {t("Καθαρό ταμπλό.", "All clear.")}
                    </p>
                    <p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-400/80">
                      {t("Τίποτα δεν περιμένει εσένα αυτή τη στιγμή.", "Nothing is waiting on you right now.")}
                    </p>
                  </div>
                )}
                {q.data.hidden > 0 && (
                  <p className="px-1 text-xs text-slate-500">
                    {t(`Υπάρχουν κι άλλα ${q.data.hidden}, αλλά δεν σου τα λέω σήμερα — κλείσε πρώτα αυτά.`,
                      `${q.data.hidden} more found, but not today — clear these first.`)}
                  </p>
                )}
              </div>

              {/* Τι πήγε καλά — το μισό της δουλειάς */}
              {q.data.wins.length > 0 && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-emerald-800 dark:text-emerald-300">
                    <Trophy className="h-4 w-4" />{t("Αυτά τα πήγες σωστά", "What you got right")}
                  </h2>
                  <ul className="mt-3 space-y-2.5">
                    {q.data.wins.map((w) => (
                      <li key={w.key} className="flex items-start gap-2 text-sm leading-relaxed text-emerald-900 dark:text-emerald-200">
                        <span className="leading-none" aria-hidden>{w.emoji || "✅"}</span><span>{w.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Το κλείσιμο */}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm italic text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                {q.data.closing}
              </div>

              {/* Η γραμμή αυτοβελτίωσης */}
              {hist.length >= 3 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-200">
                    <TrendingUp className="h-4 w-4" />{t("Πώς πας", "How you're doing")}
                  </h2>
                  <div className="mt-4 flex h-20 items-end gap-1">
                    {hist.map((d) => (
                      <div key={d.day} className="group relative flex-1" title={`${d.day}: ${d.misses}`}>
                        <div className={`w-full rounded-t ${d.misses === 0 ? "bg-emerald-400" : d.misses <= 3 ? "bg-sky-400" : "bg-amber-400"}`}
                          style={{ height: `${Math.max(6, (d.misses / maxMiss) * 76)}px` }} />
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {trend?.better
                      ? t("Πριν από δύο εβδομάδες σου έλεγα περισσότερα απ' όσα σου λέω τώρα. Κάτι αλλάζει στον τρόπο που δουλεύεις — συνέχισε.",
                        "Two weeks ago I had more to tell you than I do now. Something is changing in how you work — keep going.")
                      : trend?.worse
                        ? t("Τις τελευταίες μέρες μου ξεφεύγουν περισσότερα από πριν. Δεν σε κατηγορώ — ίσως έχεις περισσότερη δουλειά. Αλλά να το ξέρεις.",
                          "More has been slipping lately than before. Not blaming you — maybe you're busier. But you should know.")
                        : t("Σταθερή πορεία. Κάθε πράσινη στήλη είναι μια μέρα που δεν ξέφυγε τίποτα.",
                          "Steady. Every green bar is a day when nothing slipped.")}
                  </p>
                </div>
              )}
            </>
          )}
        </QueryState>
        )}

        {/* ── Η ΕΒΔΟΜΑΔΑ ΣΟΥ ─────────────────────────────────────────────────────── */}
        {tab === "week" && (
          <QueryState isLoading={wk.isLoading} isError={wk.isError} onRetry={() => wk.refetch()}>
            {wk.data && (
              <div className="space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <p className="text-base leading-relaxed text-slate-800 dark:text-slate-200">{wk.data.narrative}</p>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Stat label={t("Θέματα", "Findings")} value={String(wk.data.misses)}
                      sub={wk.data.prev_days_with_data >= 4 ? t(`προηγ. ${wk.data.misses_prev}`, `prev ${wk.data.misses_prev}`) : undefined} />
                    <Stat label={t("Έκλεισαν", "Closed")} value={String(wk.data.closed)} />
                    <Stat label={t("Επιβεβαιωμένα", "Confirmed")} value={String(wk.data.recovered.n)} />
                    <Stat label={t("Αξία", "Value")} value={eur(wk.data.recovered.value_cents)} tone="good" />
                  </div>
                  {/* Μέρα χωρίς δεδομένα = γκρι διακεκομμένη βάση, ΟΧΙ πράσινη στήλη. Το πράσινο
                      σημαίνει «καθαρή μέρα» και πρέπει να το εννοεί. */}
                  <div className="mt-4 flex h-20 items-end gap-1.5">
                    {wk.data.daily.map((d) => {
                      const mx = Math.max(1, ...wk.data!.daily.filter((x) => x.has_data).map((x) => x.misses));
                      const dt = new Date(d.day + "T12:00:00");
                      return (
                        <div key={d.day} className="flex flex-1 flex-col items-center gap-1"
                          title={d.has_data ? `${d.day}: ${d.misses}` : t(`${d.day}: χωρίς δεδομένα`, `${d.day}: no data`)}>
                          <div className="flex w-full flex-1 items-end">
                            {d.has_data ? (
                              <div className={`w-full rounded-t ${d.misses === 0 ? "bg-emerald-400" : d.misses <= 3 ? "bg-sky-400" : "bg-amber-400"}`}
                                style={{ height: `${Math.max(5, (d.misses / mx) * 56)}px` }} />
                            ) : (
                              <div className="h-1 w-full rounded-full border-b-2 border-dashed border-slate-300 dark:border-slate-700" />
                            )}
                          </div>
                          <span className="text-[10px] text-slate-400">{DOW_EL[dt.getDay()]}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Ο ΕΝΑΣ στόχος. Παραπάνω από έναν δεν τον κυνηγά κανείς. */}
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-200">
                    <Target className="h-4 w-4" />{t("Ο στόχος σου", "Your goal")}
                  </h2>
                  {wk.data.goal ? (
                    <>
                      <div className="mt-2 flex items-start gap-2.5">
                        <span className="text-xl leading-none" aria-hidden>
                          {wk.data.goal.achieved ? "🎯" : wk.data.goal.emoji || "•"}
                        </span>
                        <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{wk.data.goal.progress_text}</p>
                      </div>
                      {/* Επτά τελείες = επτά μέρες. Πιο ανθρώπινο από μια μπάρα ποσοστού. */}
                      <div className="mt-3 flex items-center gap-1.5">
                        {Array.from({ length: 7 }).map((_, i) => (
                          <span key={i} className={`h-2.5 w-2.5 rounded-full transition ${
                            i < wk.data!.goal!.hit_days ? "bg-emerald-500" : "bg-slate-200 dark:bg-slate-700"}`} />
                        ))}
                        {wk.data.goal.achieved && (
                          <span className="ml-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            {t("Πέτυχε 🎉", "Achieved 🎉")}
                          </span>
                        )}
                      </div>
                      <button onClick={() => saveGoal.mutate({ signal: null, target: 0 })}
                        className="mt-3 text-xs font-semibold text-slate-400 hover:text-slate-600">{t("Άλλαξε στόχο", "Change goal")}</button>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                        {t("Διάλεξε ΕΝΑ πράγμα να βελτιώσεις αυτόν τον μήνα. Θα το παρακολουθώ και θα σου λέω κάθε εβδομάδα πού πας.",
                          "Pick ONE thing to improve this month. I'll track it and tell you weekly how it's going.")}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {Object.entries(SIGNAL_GOALS).map(([sig, el]) => (
                          <button key={sig} onClick={() => saveGoal.mutate({ signal: sig, target: 0 })}
                            className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                            {el}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </QueryState>
        )}

        {/* ── ΤΙ ΚΕΡΔΙΣΕΣ ────────────────────────────────────────────────────────── */}
        {tab === "value" && (
          <QueryState isLoading={val.isLoading} isError={val.isError} onRetry={() => val.refetch()}>
            {val.data && (
              <div className="space-y-5">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30">
                  <h2 className="text-sm font-bold text-emerald-800 dark:text-emerald-300">
                    {val.data.acted.n > 0 ? "💚 " : ""}{t("Επιβεβαιωμένη ανάκτηση — τελευταίες 90 μέρες", "Confirmed recovery — last 90 days")}
                  </h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-emerald-900 dark:text-emerald-200">
                    {val.data.acted.n > 0
                      ? t(`Σε ${val.data.acted.n} θέματα που σου επισήμανα ενήργησες, και τα δεδομένα δείχνουν ότι ο άνθρωπος όντως γύρισε ή το αίτημα όντως απαντήθηκε. Αξία ${eur(val.data.acted.value_cents)}.`,
                        `You acted on ${val.data.acted.n} findings and the data confirms the outcome. Value ${eur(val.data.acted.value_cents)}.`)
                      : t("Δεν έχει καταγραφεί ακόμα επιβεβαιωμένη ανάκτηση. Χρειάζονται λίγες μέρες λειτουργίας για να μετρηθεί.",
                        "No confirmed recovery recorded yet — this needs a few days of use to measure.")}
                  </p>
                  {val.data.passive.n > 0 && (
                    <p className="mt-2 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
                      {t(`Άλλα ${val.data.passive.n} θέματα λύθηκαν χωρίς να τα σημειώσεις (αξία ${eur(val.data.passive.value_cents)}) — δεν τα χρεώνω στον Σύμβουλο.`,
                        `Another ${val.data.passive.n} resolved without being marked (${eur(val.data.passive.value_cents)}) — not credited to the advisor.`)}
                    </p>
                  )}
                </div>

                {val.data.lost.n > 0 && (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5 dark:border-rose-900 dark:bg-rose-950/30">
                    <h2 className="text-sm font-bold text-rose-800 dark:text-rose-300">{t("Και τι χάθηκε", "And what was lost")}</h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-rose-900 dark:text-rose-200">
                      {t(`${val.data.lost.n} θέματα έκλεισαν χωρίς να λυθούν — ο άνθρωπος δεν γύρισε, η συνταγή έληξε. Αξία ${eur(val.data.lost.value_cents)}. Το λέω για να ξέρεις πού πηγαίνει ο χρόνος που δεν βρέθηκε.`,
                        `${val.data.lost.n} findings closed unresolved. Value ${eur(val.data.lost.value_cents)}.`)}
                    </p>
                  </div>
                )}

                {val.data.recent.length > 0 && (
                  <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-400 dark:bg-slate-800/50">
                        <tr>
                          <th className="px-4 py-2 font-semibold">{t("Πελάτης", "Patient")}</th>
                          <th className="px-4 py-2 font-semibold">{t("Θέμα", "Finding")}</th>
                          <th className="px-4 py-2 text-right font-semibold">{t("Αξία", "Value")}</th>
                          <th className="px-4 py-2 text-right font-semibold">{t("Μέρες", "Days")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {val.data.recent.map((r, i) => (
                          <tr key={r.signal + i}>
                            <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">
                              {r.name || "—"}
                              {r.acted && <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{t("ενήργησες", "acted")}</span>}
                            </td>
                            <td className="px-4 py-2.5 text-slate-500">
                              <span className="mr-1" aria-hidden>{SIGNAL_EMOJI[r.signal] ?? ""}</span>{SIGNAL_EL[r.signal] ?? r.signal}
                            </td>
                            <td className="px-4 py-2.5 text-right text-slate-700 dark:text-slate-300">{eur(r.value_cents)}</td>
                            <td className="px-4 py-2.5 text-right text-slate-400">{r.days_open}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </QueryState>
        )}

        {/* ── ΚΡΥΦΟ ΚΟΣΤΟΣ ───────────────────────────────────────────────────────── */}
        {tab === "leakage" && (
          <QueryState isLoading={leak.isLoading} isError={leak.isError} onRetry={() => leak.refetch()}>
            {leak.data && (
              <div className="space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <p className="text-base leading-relaxed text-slate-800 dark:text-slate-200">
                    {t(`Τους τελευταίους ${leak.data.months.length} μήνες (ο τρέχων ακόμη τρέχει), ${leak.data.total.repeats_n} επαναλαμβανόμενες συνταγές έληξαν με αχρησιμοποίητες εκτελέσεις και ${leak.data.total.items_n} είδη έφυγαν ανεκτέλεστα. Σε τζίρο είναι ${eur(leak.data.total.total_value)}· σε δικό σου κέρδος ${eur(leak.data.total.total_profit)}.`,
                      `Over ${leak.data.months.length} months, ${leak.data.total.repeats_n} repeat prescriptions expired unused and ${leak.data.total.items_n} items went unfilled: ${eur(leak.data.total.total_value)} turnover, ${eur(leak.data.total.total_profit)} gross profit.`)}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-slate-500">
                    {t("Να είμαστε ειλικρινείς: αυτά δεν ανακτώνται όλα. Κάποιοι άλλαξαν αγωγή, μετακόμισαν ή δεν είναι πια στη ζωή. Είναι το μέγεθος της διαρροής — όχι υπόσχεση εσόδων. Ακόμα κι ένα δέκατο όμως αλλάζει τη χρονιά.",
                      "To be honest: not all of this is recoverable. Some changed therapy, moved, or passed away. It's the size of the leak — not a revenue promise.")}
                  </p>
                </div>

                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-400 dark:bg-slate-800/50">
                      <tr>
                        <th className="px-4 py-2 font-semibold">{t("Μήνας", "Month")}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t("Ληγμένες επαναλ.", "Expired repeats")}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t("Ανεκτέλεστα", "Unfilled")}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t("Χαμένος τζίρος", "Lost turnover")}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t("Χαμένο κέρδος", "Lost profit")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {leak.data.months.map((m) => (
                        <tr key={m.month}>
                          <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">
                            {mlabel(m.month)}
                            {m.partial && <span className="ml-1.5 text-[11px] font-normal text-slate-400">{t("(τρέχων)", "(current)")}</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right text-slate-500">{m.repeats_n}</td>
                          <td className="px-4 py-2.5 text-right text-slate-500">{m.items_n}</td>
                          <td className="px-4 py-2.5 text-right text-slate-700 dark:text-slate-300">{eur(m.total_value)}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-rose-600 dark:text-rose-400">{eur(m.total_profit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {leak.data.trend && (
                  <p className="px-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {leak.data.trend.better
                      ? t("Η διαρροή μικραίνει σε σχέση με τους προηγούμενους μήνες. Ό,τι κάνεις, δουλεύει.", "The leak is shrinking. Whatever you're doing, it works.")
                      : leak.data.trend.worse
                        ? t("Η διαρροή μεγαλώνει σε σχέση με τους προηγούμενους μήνες. Αξίζει να δεις ποιο σήμα φταίει περισσότερο.", "The leak is growing. Worth checking which signal drives it.")
                        : t("Η διαρροή μένει σταθερή. Ένας στόχος τον μήνα είναι ο πιο ρεαλιστικός τρόπος να τη μικρύνεις.", "The leak is steady. One goal per month is the realistic way to shrink it.")}
                  </p>
                )}
              </div>
            )}
          </QueryState>
        )}

        {/* ── ΟΜΑΔΑ ──────────────────────────────────────────────────────────────── */}
        {tab === "team" && (
          <QueryState isLoading={team.isLoading} isError={team.isError} onRetry={() => team.refetch()}>
            {team.data && (
              <div className="space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <p className="text-base leading-relaxed text-slate-800 dark:text-slate-200">
                    {team.data.total_closed > 0
                      ? t(`Τον τελευταίο μήνα έκλεισαν ${team.data.total_closed} θέματα. Δεν είναι βαθμολογία — είναι για να ξέρεις ότι η λίστα δεν μένει να σε κοιτάζει.`,
                        `${team.data.total_closed} findings were closed in the last month.`)
                      : t("Κανείς δεν έχει σημειώσει θέμα ως «Το έκανα» αυτόν τον μήνα. Ίσως δεν χρειάστηκε — ίσως όμως κανείς δεν ανοίγει τη λίστα.",
                        "Nobody has marked a finding as done this month.")}
                  </p>
                  {team.data.stale > 0 && (
                    <p className="mt-2 text-sm leading-relaxed text-amber-700 dark:text-amber-400">
                      {t(`${team.data.stale} θέματα μένουν ανοιχτά πάνω από μία εβδομάδα. Αυτά φεύγουν με email στον ιδιοκτήτη — μία φορά, όχι κάθε μέρα.`,
                        `${team.data.stale} findings have been open for over a week; the owner gets one email about them.`)}
                    </p>
                  )}
                </div>
                {team.data.members.length > 0 && (
                  <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-400 dark:bg-slate-800/50">
                        <tr>
                          <th className="px-4 py-2 font-semibold">{t("Χρήστης", "User")}</th>
                          <th className="px-4 py-2 text-right font-semibold">{t("Έκλεισε", "Closed")}</th>
                          <th className="px-4 py-2 text-right font-semibold">{t("Επιβεβαιωμένα", "Confirmed")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {team.data.members.map((m, i) => (
                          <tr key={m.user_id}>
                            <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">
                              {i === 0 && m.closed > 0 && <span className="mr-1.5" aria-hidden title={t("Έκλεισε τα περισσότερα", "Closed the most")}>👏</span>}
                              {m.name}
                            </td>
                            <td className="px-4 py-2.5 text-right text-slate-700 dark:text-slate-300">{m.closed}</td>
                            <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400">{m.recovered}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </QueryState>
        )}

        {/* ── ΡΥΘΜΙΣΕΙΣ ──────────────────────────────────────────────────────────── */}
        {tab === "settings" && (
          <QueryState isLoading={cfg.isLoading} isError={cfg.isError} onRetry={() => cfg.refetch()}>
            {cfg.data && (
              <div className="space-y-4">
                <Row label={t("Πρωινό email", "Morning email")}
                  hint={t("Ένα μήνυμα με τα 3 σημαντικότερα. Αν δεν υπάρχει τίποτα, δεν στέλνεται.", "One email with the top 3. Nothing to say, nothing sent.")}>
                  <Toggle on={cfg.data.email_enabled} onChange={(v) => saveCfg.mutate({ email_enabled: v })} />
                </Row>
                <Row label={t("Ώρα αποστολής", "Send time")} hint={t("Ώρα Ελλάδας.", "Greek time.")}>
                  <select value={cfg.data.email_hour} onChange={(e) => saveCfg.mutate({ email_hour: Number(e.target.value) })}
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
                    {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>)}
                  </select>
                </Row>
                <Row label={t("Πόσα θέματα την ημέρα", "Findings per day")}
                  hint={t("Πάνω από δέκα δεν διαβάζονται — αγνοούνται.", "More than ten and nobody reads them.")}>
                  <input type="number" min={3} max={25} defaultValue={cfg.data.max_items}
                    onBlur={(e) => saveCfg.mutate({ max_items: Number(e.target.value) })}
                    className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
                </Row>
                <Row label={t("Κλιμάκωση στον ιδιοκτήτη", "Escalate to owner")}
                  hint={t("Ό,τι μένει ανοιχτό πάνω από μία εβδομάδα, φεύγει μία φορά με email.", "Anything open over a week gets one email.")}>
                  <Toggle on={cfg.data.escalate_owner} onChange={(v) => saveCfg.mutate({ escalate_owner: v })} />
                </Row>

                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200">{t("Τι να παρακολουθώ", "What to watch")}</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    {t("Κλείσε ό,τι δεν σε αφορά. Δεν θα ξαναεμφανιστεί πουθενά — ούτε στη λίστα, ούτε στο ταμείο.",
                      "Turn off what doesn't apply to you.")}
                  </p>
                  <div className="mt-3 space-y-2.5">
                    {Object.entries(cfg.data.labels).map(([k, label]) => (
                      <div key={k} className="flex items-center justify-between gap-3">
                        <span className="text-sm text-slate-700 dark:text-slate-300">{label}</span>
                        <Toggle on={cfg.data!.signals[k]} onChange={(v) => saveCfg.mutate({ signals: { ...cfg.data!.signals, [k]: v } })} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </QueryState>
        )}
      </div>
    </ModuleGuard>
  );
}
