"use client";

import type { ReactNode } from "react";
import { useT } from "@/store/prefStore";

/** Standard loading / error / empty wrapper for data-backed sections.
 *  Replaces the silent `?? []` / `?? 0` pattern so a failed query is no longer
 *  indistinguishable from "no data" (U-1). Pass a TanStack Query's flags:
 *
 *    <QueryState isLoading={q.isLoading} isError={q.isError} isEmpty={!rows.length}
 *                onRetry={() => q.refetch()}>
 *      ...content...
 *    </QueryState>
 */
export function QueryState({
  isLoading,
  isError,
  isEmpty,
  onRetry,
  loading,
  error,
  empty,
  children,
}: {
  isLoading?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
  onRetry?: () => void;
  loading?: ReactNode;
  error?: ReactNode;
  empty?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const loadingText = loading ?? t("Φόρτωση δεδομένων…", "Loading data…");
  const errorText = error ?? t("Δεν ήταν δυνατή η φόρτωση των δεδομένων.", "Could not load data.");
  const emptyText = empty ?? t("Δεν υπάρχουν δεδομένα.", "No data.");
  if (isLoading) return <StateBox tone="muted">{loadingText}</StateBox>;
  if (isError)
    return (
      <StateBox tone="error">
        <span>{errorText}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="ml-1 rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            {t("Δοκιμή ξανά", "Try again")}
          </button>
        )}
      </StateBox>
    );
  if (isEmpty) return <StateBox tone="muted">{emptyText}</StateBox>;
  return <>{children}</>;
}

function StateBox({ tone, children }: { tone: "muted" | "error"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200/70 bg-white text-slate-400 dark:border-slate-700/60 dark:bg-slate-900 dark:text-slate-500";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={`flex flex-wrap items-center justify-center gap-2 rounded-2xl border p-8 text-center text-sm shadow-card ${cls}`}
    >
      {children}
    </div>
  );
}
