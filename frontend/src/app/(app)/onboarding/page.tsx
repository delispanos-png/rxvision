"use client";

import { appAlert } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, queryKeys, ApiError } from "@/lib/apiClient";

type Me = { modules: Record<string, "enabled" | "trial" | "locked"> } & Record<string, unknown>;

type Tenant = {
  country?: string;
} & Record<string, unknown>;

type SyncStats = {
  inserted: number;
  duplicates: number;
};

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-700 text-sm font-semibold text-white">
      {n}
    </span>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [credsSaved, setCredsSaved] = useState(false);
  const [syncStats, setSyncStats] = useState<SyncStats | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pharmacyCode, setPharmacyCode] = useState("");

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
      appAlert(e instanceof ApiError ? `Σφάλμα (${e.status})` : "Αποτυχία αποθήκευσης"),
  });

  const triggerSync = useMutation({
    mutationFn: () => api<SyncStats>("/ingestion/hdika/sync", { method: "POST" }),
    onSuccess: (data) => setSyncStats(data),
    onError: (e) => appAlert(e instanceof ApiError ? `Σφάλμα (${e.status})` : "Αποτυχία συγχρονισμού"),
  });

  if (me.isLoading || tenant.isLoading) {
    return <div className="p-6 text-slate-400">Φόρτωση…</div>;
  }

  const country = tenant.data?.country ?? "GR";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-bold text-slate-900">Καλώς ορίσατε στο RxVision</h1>
      <p className="mb-6 text-sm text-slate-500">Ολοκληρώστε τη ρύθμιση του φαρμακείου σας.</p>

      {country === "CY" ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-teal-200 bg-teal-50 p-5">
            <div className="flex items-start gap-3">
              <StepBadge n={1} />
              <div>
                <h2 className="text-sm font-semibold text-teal-800">
                  ΓΕΣΥ / Κύπρος: έρχεται σύντομα (step 2)
                </h2>
                <p className="mt-1 text-sm text-teal-700">
                  Η εισαγωγή δεδομένων ΓΕΣΥ θα είναι διαθέσιμη σε επόμενο βήμα.
                </p>
                <div className="mt-3">
                  <label className="mb-1 block text-sm text-slate-600">Μεταφόρτωση ΓΕΣΥ XML</label>
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
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
          >
            Μετάβαση στο Dashboard
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-3">
              <StepBadge n={1} />
              <h2 className="text-sm font-semibold text-slate-700">Σύνδεση με ΗΔΙΚΑ</h2>
            </div>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveCreds.mutate({ username, password, pharmacy_code: pharmacyCode });
              }}
            >
              <div>
                <label className="mb-1 block text-sm text-slate-600">Όνομα χρήστη</label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">Κωδικός</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">Κωδικός φαρμακείου</label>
                <input
                  value={pharmacyCode}
                  onChange={(e) => setPharmacyCode(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={saveCreds.isPending}
                className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
              >
                {saveCreds.isPending ? "Αποθήκευση…" : "Αποθήκευση"}
              </button>
              {credsSaved && (
                <p className="text-sm text-teal-700">Τα στοιχεία αποθηκεύτηκαν με ασφάλεια.</p>
              )}
            </form>
          </div>

          {credsSaved && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center gap-3">
                <StepBadge n={2} />
                <h2 className="text-sm font-semibold text-slate-700">Πρώτος συγχρονισμός</h2>
              </div>
              <button
                type="button"
                onClick={() => triggerSync.mutate()}
                disabled={triggerSync.isPending}
                className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
              >
                {triggerSync.isPending ? "Συγχρονισμός…" : "Πρώτος συγχρονισμός"}
              </button>
              {syncStats && (
                <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  <div>Νέες εγγραφές: {syncStats.inserted}</div>
                  <div>Διπλότυπα: {syncStats.duplicates}</div>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
          >
            Μετάβαση στο Dashboard
          </button>
        </div>
      )}
    </div>
  );
}
