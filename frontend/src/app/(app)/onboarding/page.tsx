"use client";

import { appAlert } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Me = { modules: Record<string, "enabled" | "trial" | "locked"> } & Record<string, unknown>;

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
  const [pharmacyCode, setPharmacyCode] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(`${new Date().getFullYear() - 1}-01-01`);
  const [dateTo, setDateTo] = useState(today);
  const [queued, setQueued] = useState(false);

  const me = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api<Me>("/auth/me"),
  });

  const tenant = useQuery({
    queryKey: ["tenant"],
    queryFn: () => api<Tenant>("/tenant"),
  });

  const saveCreds = useMutation({
    mutationFn: (body: { username: string; password: string; pharmacy_code: string }) =>
      api<{ ok: boolean }>("/ingestion/credentials/hdika", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => setCredsSaved(true),
    onError: (e) =>
      appAlert(e instanceof ApiError ? t(`Σφάλμα (${e.status})`, `Error (${e.status})`) : t("Αποτυχία αποθήκευσης", "Save failed")),
  });

  const triggerBackfill = useMutation({
    mutationFn: () => api(`/ingestion/hdika/backfill?date_from=${dateFrom}&date_to=${dateTo}`, { method: "POST" }),
    onSuccess: () => setQueued(true),
    onError: (e) => appAlert(e instanceof ApiError ? t(`Σφάλμα (${e.status})`, `Error (${e.status})`) : t("Αποτυχία άντλησης", "Download failed")),
  });

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
              <h2 className="text-sm font-semibold text-slate-700">{t("Σύνδεση με ΗΔΙΚΑ", "Connect to ΗΔΙΚΑ")}</h2>
            </div>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveCreds.mutate({ username, password, pharmacy_code: pharmacyCode });
              }}
            >
              <div>
                <label className="mb-1 block text-sm text-slate-600">{t("Όνομα χρήστη", "Username")}</label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">{t("Κωδικός", "Password")}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">{t("Κωδικός φαρμακείου", "Pharmacy code")}</label>
                <input
                  value={pharmacyCode}
                  onChange={(e) => setPharmacyCode(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={saveCreds.isPending}
                className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
              >
                {saveCreds.isPending ? t("Αποθήκευση…", "Saving…") : t("Αποθήκευση", "Save")}
              </button>
              {credsSaved && (
                <p className="text-sm text-brand-700">{t("Τα στοιχεία αποθηκεύτηκαν με ασφάλεια.", "Your credentials were stored securely.")}</p>
              )}
            </form>
          </div>

          {credsSaved && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center gap-3">
                <StepBadge n={2} />
                <h2 className="text-sm font-semibold text-slate-700">{t("Άντληση ιστορικών δεδομένων", "Download historical data")}</h2>
              </div>
              <p className="mb-3 text-sm text-slate-500">{t("Διάλεξε από πότε μέχρι πότε να κατεβάσουμε τις εκτελέσεις συνταγών σου από την ΗΔΙΚΑ.", "Choose the date range to download your prescription executions from ΗΔΙΚΑ.")}</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">{t("Από", "From")}</label>
                  <input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">{t("Έως", "To")}</label>
                  <input type="date" value={dateTo} min={dateFrom} max={today} onChange={(e) => setDateTo(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>
              </div>
              <button
                type="button"
                onClick={() => triggerBackfill.mutate()}
                disabled={triggerBackfill.isPending || !dateFrom || !dateTo}
                className="mt-3 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
              >
                {triggerBackfill.isPending ? t("Έναρξη…", "Starting…") : t("Κατέβασμα δεδομένων", "Download data")}
              </button>
              {queued && (
                <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  {t(`✓ Η άντληση ${dateFrom} → ${dateTo} ξεκίνησε. Δες την πρόοδο στο «Ιστορικό συγχρονισμών» — μπορείς να συνεχίσεις στο Dashboard.`, `✓ Download ${dateFrom} → ${dateTo} started. Track progress in "Sync history" — you can continue to the Dashboard.`)}
                </div>
              )}
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
