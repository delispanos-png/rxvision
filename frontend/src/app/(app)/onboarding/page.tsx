"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Loader2, CheckCircle2 } from "lucide-react";

type Job = { status?: string; type?: string; progress?: number; cursor_date?: string;
  stats?: { fetched?: number; inserted?: number; updated?: number };
  window?: { start?: string; end?: string } };

type Me = { modules: Record<string, "enabled" | "trial" | "locked"> } & Record<string, unknown>;

type Discovered = {
  pharmacy_name?: string; pharmacy_code?: string; pharmacy_id?: string; afm?: string;
  eopyy_registry?: string; address?: string; city?: string; county?: string; contracted_funds?: string;
};
type SetupRes = { status: string; discovered?: Discovered; window?: { from: string; to: string } };

type Tenant = {
  country?: string;
} & Record<string, unknown>;

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white">
      {n}
    </span>
  );
}

export default function OnboardingPage() {
  const t = useT();
  const router = useRouter();
  const [credsSaved, setCredsSaved] = useState(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [queued, setQueued] = useState(false);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [found, setFound] = useState<Discovered | null>(null);
  const [win, setWin] = useState<{ from: string; to: string } | null>(null);

  const me = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api<Me>("/auth/me"),
  });

  const tenant = useQuery({
    queryKey: ["tenant"],
    queryFn: () => api<Tenant>("/tenant"),
  });

  // ΕΝΑ βήμα: κωδικοί ΗΔΥΚΑ → στοιχεία φαρμακείου + περίοδος ιστορικού + έναρξη άντλησης, αυτόματα.
  const setup = useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      api<SetupRes>("/ingestion/hdika/setup", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (r) => { setCredsSaved(true); setFound(r.discovered ?? null); setWin(r.window ?? null); setQueued(true); setSetupErr(null); },
    onError: (e) => {
      const msg = e instanceof ApiError
        ? (typeof e.problem === "string" ? e.problem : (e.problem as { detail?: string })?.detail) || t(`Σφάλμα (${e.status})`, `Error (${e.status})`)
        : t("Αποτυχία σύνδεσης", "Connection failed");
      setSetupErr(String(msg));
    },
  });

  const jobs = useQuery({
    queryKey: ["onboarding-jobs"],
    queryFn: () => api<{ items: Job[] }>("/ingestion/jobs"),
    enabled: queued,
    refetchInterval: 3000,
    retry: false,
  });
  const job = jobs.data?.items?.[0];
  const jobRunning = job?.status === "running";
  const jobDone = job?.status === "completed" || job?.status === "success";
  const jobKnown = typeof job?.progress === "number" && job.progress > 0;
  const jobPct = Math.max(0, Math.min(100, Math.round((job?.progress ?? 0) * 100)));

  if (me.isLoading || tenant.isLoading) {
    return <div className="p-6 text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;
  }

  const country = tenant.data?.country ?? "GR";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-bold text-slate-900">{t("Καλώς ορίσατε στο RxVision", "Welcome to RxVision")}</h1>
      <p className="mb-6 text-sm text-slate-500">{t("Ολοκληρώστε τη ρύθμιση του φαρμακείου σας.", "Complete the setup of your pharmacy.")}</p>

      {country === "CY" ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-brand-200 bg-brand-50 p-5">
            <div className="flex items-start gap-3">
              <StepBadge n={1} />
              <div>
                <h2 className="text-sm font-semibold text-brand-800">
                  {t("ΓΕΣΥ / Κύπρος: έρχεται σύντομα (step 2)", "ΓΕΣΥ / Cyprus: coming soon (step 2)")}
                </h2>
                <p className="mt-1 text-sm text-brand-700">
                  {t("Η εισαγωγή δεδομένων ΓΕΣΥ θα είναι διαθέσιμη σε επόμενο βήμα.", "ΓΕΣΥ data import will be available in a later step.")}
                </p>
                <div className="mt-3">
                  <label className="mb-1 block text-sm text-slate-600">{t("Μεταφόρτωση ΓΕΣΥ XML", "Upload ΓΕΣΥ XML")}</label>
                  <input
                    type="file"
                    disabled
                    className="block w-full cursor-not-allowed rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-400"
                  />
                </div>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
          >
            {t("Μετάβαση στο Dashboard", "Go to Dashboard")}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-3">
              <StepBadge n={1} />
              <h2 className="text-sm font-semibold text-slate-700">{t("Οι κωδικοί σου στην ΗΔΥΚΑ", "Your ΗΔΥΚΑ credentials")}</h2>
            </div>
            <p className="mb-4 text-sm text-slate-500">
              {t("Αυτό είναι το μόνο που χρειαζόμαστε. Τα στοιχεία του φαρμακείου σου (επωνυμία, ΑΦΜ, κωδικός ΣΗΣ, ΑΜ ΕΟΠΥΥ, ταμεία) τα αντλούμε μόνοι μας από την ΗΔΥΚΑ και ξεκινάμε αμέσως το κατέβασμα των εκτελέσεών σου.", "That is all we need. We fetch your pharmacy details (name, VAT no., ΣΗΣ code, ΕΟΠΥΥ no., funds) from ΗΔΥΚΑ ourselves and start downloading your executions right away.")}
            </p>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setup.mutate({ username, password }); }}>
              <div>
                <label className="mb-1 block text-sm text-slate-600">{t("Όνομα χρήστη", "Username")}</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">{t("Κωδικός", "Password")}</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none" />
              </div>
              <button type="submit" disabled={setup.isPending || credsSaved}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50">
                {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {setup.isPending ? t("Σύνδεση με ΗΔΥΚΑ…", "Connecting to ΗΔΥΚΑ…") : t("Σύνδεση & έναρξη", "Connect & start")}
              </button>
              {setupErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{setupErr}</p>}
            </form>
          </div>

          {/* Ό,τι βρήκαμε μόνοι μας — ο φαρμακοποιός το βλέπει, δεν το πληκτρολογεί */}
          {found && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-800">
                <CheckCircle2 className="h-4 w-4" /> {t("Βρήκαμε το φαρμακείο σου", "We found your pharmacy")}
              </div>
              <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
                {([
                  [t("Επωνυμία", "Name"), found.pharmacy_name],
                  [t("ΑΦΜ", "VAT no."), found.afm],
                  [t("Κωδικός ΣΗΣ", "ΣΗΣ code"), found.pharmacy_code],
                  [t("ΑΜ ΕΟΠΥΥ", "ΕΟΠΥΥ no."), found.eopyy_registry],
                  [t("Διεύθυνση", "Address"), [found.address, found.city].filter(Boolean).join(", ")],
                  [t("Νομός", "County"), found.county],
                ] as const).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-emerald-100 py-1">
                    <dt className="shrink-0 text-emerald-700">{k}</dt>
                    <dd className="truncate font-medium text-slate-800">{v}</dd>
                  </div>
                ))}
              </dl>
              {found.contracted_funds && <p className="mt-2 text-xs text-emerald-700"><b>{t("Ταμεία", "Funds")}:</b> {found.contracted_funds}</p>}
            </div>
          )}

          {queued && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center gap-3">
                <StepBadge n={2} />
                <h2 className="text-sm font-semibold text-slate-700">{t("Κατεβάζουμε το ιστορικό σου", "Downloading your history")}</h2>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                    {jobDone ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Loader2 className="h-4 w-4 animate-spin text-brand-600" />}
                    {jobDone ? t("Η άντληση ολοκληρώθηκε", "Download complete") : jobRunning ? t("Άντληση σε εξέλιξη…", "Download in progress…") : t("Εκκίνηση άντλησης…", "Starting download…")}
                    {jobKnown && !jobDone && <span className="font-bold text-brand-700">{jobPct}%</span>}
                  </span>
                  <span className="text-xs text-slate-500">{(job?.stats?.fetched ?? 0)} {t("συνταγές", "rx")} · {(job?.stats?.inserted ?? 0)} {t("νέες", "new")}</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div className={`h-full rounded-full transition-[width] duration-700 ${jobDone ? "w-full bg-emerald-500" : jobKnown ? "bg-brand-500" : "w-1/3 animate-pulse bg-brand-500"}`} style={!jobDone && jobKnown ? { width: `${jobPct}%` } : undefined} />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {win
                    ? t(`Περίοδος ${win.from} → ${win.to} (τα δύο τελευταία έτη και το τρέχον). Μπορείς να συνεχίσεις στο Dashboard — τρέχει στο παρασκήνιο.`,
                        `Period ${win.from} → ${win.to} (the last two years plus the current one). You can continue to the Dashboard — it runs in the background.`)
                    : t("Τρέχει στο παρασκήνιο — μπορείς να συνεχίσεις.", "Running in the background — you can continue.")}
                </p>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
          >
            {t("Μετάβαση στο Dashboard", "Go to Dashboard")}
          </button>
        </div>
      )}
    </div>
  );
}
