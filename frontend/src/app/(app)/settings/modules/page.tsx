"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type ModuleState = "enabled" | "trial" | "locked";
type ModulesResponse = { modules: Record<string, ModuleState> };

const LABELS: Record<string, string> = {
  dashboard: "Πίνακας Ελέγχου",
  prescription_analytics: "Ανάλυση Συνταγών",
  doctor_analytics: "Ανάλυση Ιατρών",
  patient_analytics: "Ανάλυση Ασφαλισμένων",
  icd10_analytics: "Ανάλυση ICD-10",
  profitability: "Κερδοφορία",
  future_prescriptions: "Μελλοντικές Συνταγές",
  order_suggestions: "Προτάσεις Παραγγελίας",
  monthly_closing: "Κλείσιμο Μήνα",
  pharmacyone: "PharmacyOne",
};

const BADGE: Record<ModuleState, string> = {
  enabled: "bg-teal-100 text-teal-800",
  trial: "bg-amber-100 text-amber-800",
  locked: "bg-slate-100 text-slate-500",
};

const STATE_LABEL: Record<ModuleState, string> = {
  enabled: "Ενεργό",
  trial: "Δοκιμή",
  locked: "Κλειδωμένο",
};

export default function ModulesSettingsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.tenantModules(),
    queryFn: () => api<ModulesResponse>(`/tenant/modules`),
  });

  const toggle = useMutation({
    mutationFn: (body: { module: string; state: ModuleState }) =>
      api<ModulesResponse>(`/tenant/modules`, {
        method: "PATCH",
        body: JSON.stringify({ modules: { [body.module]: body.state } }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tenantModules() }),
    onError: (e) => alert(e instanceof ApiError ? `Σφάλμα (${e.status})` : "Αποτυχία ενημέρωσης"),
  });

  const entries = Object.entries(data?.modules ?? {});

  return (
    <ModuleGuard module="settings">
      {isLoading ? (
        <div className="text-slate-400">Φόρτωση δεδομένων…</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, state]) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3"
            >
              <div>
                <div className="text-sm font-medium text-slate-800">{LABELS[key] ?? key}</div>
                <div className="text-xs text-slate-400">{key}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[state]}`}>
                  {STATE_LABEL[state]}
                </span>
                <button
                  type="button"
                  disabled={toggle.isPending}
                  onClick={() =>
                    toggle.mutate({ module: key, state: state === "enabled" ? "locked" : "enabled" })
                  }
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {state === "enabled" ? "Απενεργοποίηση" : "Ενεργοποίηση"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </ModuleGuard>
  );
}
