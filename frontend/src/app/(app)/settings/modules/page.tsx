"use client";

import { appAlert } from "@/store/dialogStore";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useT } from "@/store/prefStore";

type ModuleState = "enabled" | "trial" | "locked";
type ModulesResponse = { modules: Record<string, ModuleState> };

const LABELS: Record<string, { el: string; en: string }> = {
  dashboard: { el: "Πίνακας Ελέγχου", en: "Dashboard" },
  prescription_analytics: { el: "Ανάλυση Συνταγών", en: "Prescription analytics" },
  doctor_analytics: { el: "Ανάλυση Ιατρών", en: "Doctor analytics" },
  patient_analytics: { el: "Ανάλυση Ασφαλισμένων", en: "Patient analytics" },
  icd10_analytics: { el: "Ανάλυση ICD-10", en: "ICD-10 analytics" },
  profitability: { el: "Κερδοφορία", en: "Profitability" },
  future_prescriptions: { el: "Μελλοντικές Συνταγές", en: "Upcoming prescriptions" },
  order_suggestions: { el: "Προτάσεις Παραγγελίας", en: "Order suggestions" },
  monthly_closing: { el: "Κλείσιμο Μήνα", en: "Month closing" },
  pharmacyone: { el: "PharmacyOne", en: "PharmacyOne" },
  patient_portal: { el: "Πύλη Πελατών", en: "Customer portal" },
  pharmacat: { el: "PharmaCat", en: "PharmaCat" },
  ai_assistant: { el: "AI Βοηθός (Prescriptor/PharmaCat/Copilot)", en: "AI Assistant (Prescriptor/PharmaCat/Copilot)" },
  loyalty: { el: "Πιστότητα", en: "Loyalty" },
};

const BADGE: Record<ModuleState, string> = {
  enabled: "bg-brand-100 text-brand-800",
  trial: "bg-amber-100 text-amber-800",
  locked: "bg-slate-100 text-slate-500",
};

const STATE_LABEL: Record<ModuleState, { el: string; en: string }> = {
  enabled: { el: "Ενεργό", en: "Enabled" },
  trial: { el: "Δοκιμή", en: "Trial" },
  locked: { el: "Κλειδωμένο", en: "Locked" },
};

export default function ModulesSettingsPage() {
  const t = useT();
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
    onError: (e) => appAlert(e instanceof ApiError ? t(`Σφάλμα (${e.status})`, `Error (${e.status})`) : t("Αποτυχία ενημέρωσης", "Update failed")),
  });

  const entries = Object.entries(data?.modules ?? {});

  return (
    <ModuleGuard module="settings">
      {isLoading ? (
        <div className="text-slate-400">{t("Φόρτωση δεδομένων…", "Loading data…")}</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, state]) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3"
            >
              <div>
                <div className="text-sm font-medium text-slate-800">{LABELS[key] ? t(LABELS[key].el, LABELS[key].en) : key}</div>
                <div className="text-xs text-slate-400">{key}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[state]}`}>
                  {t(STATE_LABEL[state].el, STATE_LABEL[state].en)}
                </span>
                <button
                  type="button"
                  disabled={toggle.isPending}
                  onClick={() =>
                    toggle.mutate({ module: key, state: state === "enabled" ? "locked" : "enabled" })
                  }
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {state === "enabled" ? t("Απενεργοποίηση", "Disable") : t("Ενεργοποίηση", "Enable")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </ModuleGuard>
  );
}
