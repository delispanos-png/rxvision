"use client";

import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";

type Me = { modules: Record<string, "enabled" | "trial" | "locked"> };

/** UI gating only — the backend always enforces module access on every request. */
export function ModuleGuard({ module, children }: { module: string; children: React.ReactNode }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api<Me>("/auth/me"),
  });

  if (isLoading) return <div className="p-6 text-slate-400">Φόρτωση…</div>;

  // Distinguish a transient load error from an actually-locked module — otherwise an
  // /auth/me failure would wrongly show the upsell screen on every page (U-2).
  if (isError) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-8 text-center">
        <p className="text-rose-700">Δεν ήταν δυνατή η φόρτωση. Ελέγξτε τη σύνδεσή σας.</p>
        <button
          onClick={() => refetch()}
          className="mt-3 rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
        >
          Δοκιμή ξανά
        </button>
      </div>
    );
  }

  const state = data?.modules?.[module] ?? "locked";
  if (state === "locked") {
    return (
      <div className="rounded-xl border border-brand-200 bg-brand-50 p-8 text-center">
        <h2 className="text-lg font-semibold text-brand-800">Κλειδωμένο module</h2>
        <p className="mt-2 text-brand-700">
          Το «{module}» δεν περιλαμβάνεται στο πλάνο σας. Αναβαθμίστε για πρόσβαση.
        </p>
        <a href="/settings/billing" className="mt-4 inline-block rounded-lg bg-brand-700 px-4 py-2 text-white">
          Αναβάθμιση
        </a>
      </div>
    );
  }
  return <>{children}</>;
}
