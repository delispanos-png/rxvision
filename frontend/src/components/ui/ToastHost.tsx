"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useToastStore, type ToastKind } from "@/store/toastStore";
import { useT } from "@/store/prefStore";

const STYLE: Record<ToastKind, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-rose-200 bg-rose-50 text-rose-800",
  info: "border-slate-200 bg-white text-slate-800",
};
const ICON = { success: CheckCircle2, error: XCircle, info: Info };

/** Renders the active toasts (top-right, stacked). Mount once in Providers. */
export function ToastHost() {
  const { toasts, dismiss } = useToastStore();
  const tr = useT();
  if (!toasts.length) return null;
  return (
    <div
      className="fixed right-4 top-4 z-[200] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div key={t.id} className={`flex items-start gap-2 rounded-xl border p-3 text-sm shadow-pop ${STYLE[t.kind]}`}>
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1 break-words">{t.message}</span>
            <button onClick={() => dismiss(t.id)} aria-label={tr("Κλείσιμο", "Close")} className="shrink-0 opacity-60 hover:opacity-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
