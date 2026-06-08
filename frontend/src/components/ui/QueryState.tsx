"use client";

import type { ReactNode } from "react";

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
  loading = "Φόρτωση δεδομένων…",
  error = "Δεν ήταν δυνατή η φόρτωση των δεδομένων.",
  empty = "Δεν υπάρχουν δεδομένα.",
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
  if (isLoading) return <StateBox tone="muted">{loading}</StateBox>;
  if (isError)
    return (
      <StateBox tone="error">
        <span>{error}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="ml-1 rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            Δοκιμή ξανά
          </button>
        )}
      </StateBox>
    );
  if (isEmpty) return <StateBox tone="muted">{empty}</StateBox>;
  return <>{children}</>;
}

function StateBox({ tone, children }: { tone: "muted" | "error"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200/70 bg-white text-slate-400";
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
