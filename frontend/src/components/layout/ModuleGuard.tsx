"use client";

import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";

type Me = { modules: Record<string, "enabled" | "trial" | "locked"> };

/** UI gating only — the backend always enforces module access on every request. */
export function ModuleGuard({ module, children }: { module: string; children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api<Me>("/auth/me"),
  });

  if (isLoading) return <div className="p-6 text-slate-400">Φόρτωση…</div>;

  const state = data?.modules?.[module] ?? "locked";
  if (state === "locked") {
    return (
      <div className="rounded-xl border border-teal-200 bg-teal-50 p-8 text-center">
        <h2 className="text-lg font-semibold text-teal-800">Κλειδωμένο module</h2>
        <p className="mt-2 text-teal-700">
          Το «{module}» δεν περιλαμβάνεται στο πλάνο σας. Αναβαθμίστε για πρόσβαση.
        </p>
        <a href="/settings/billing" className="mt-4 inline-block rounded-lg bg-teal-700 px-4 py-2 text-white">
          Αναβάθμιση
        </a>
      </div>
    );
  }
  return <>{children}</>;
}
