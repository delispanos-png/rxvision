"use client";

// In-app pop-ups (toast + confirm) για την πύλη πελατών — αντικαθιστούν τα browser alert()/confirm().
// Χρήση από παντού: `import { toast, confirmDialog } from "@/components/portal/Toaster"`.
import { useEffect, useState } from "react";

type Toast = { id: number; msg: string; kind: "info" | "success" | "error" };
type Confirm = { id: number; msg: string; resolve: (v: boolean) => void };

let _id = 1;
const _toastSubs = new Set<(t: Toast[]) => void>();
const _confirmSubs = new Set<(c: Confirm | null) => void>();
let _toasts: Toast[] = [];
let _confirm: Confirm | null = null;

function _emitToasts() { _toastSubs.forEach((f) => f([..._toasts])); }
function _emitConfirm() { _confirmSubs.forEach((f) => f(_confirm)); }

export function toast(msg: string, kind: "info" | "success" | "error" = "success") {
  const t: Toast = { id: _id++, msg, kind };
  _toasts = [..._toasts, t];
  _emitToasts();
  setTimeout(() => { _toasts = _toasts.filter((x) => x.id !== t.id); _emitToasts(); }, 3400);
}

export function confirmDialog(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (_confirm) _confirm.resolve(false);   // μόνο ένα confirm τη φορά
    _confirm = { id: _id++, msg, resolve };
    _emitConfirm();
  });
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  useEffect(() => {
    const ft = (t: Toast[]) => setToasts(t); const fc = (c: Confirm | null) => setConfirm(c);
    _toastSubs.add(ft); _confirmSubs.add(fc);
    return () => { _toastSubs.delete(ft); _confirmSubs.delete(fc); };
  }, []);
  const done = (v: boolean) => { if (_confirm) { _confirm.resolve(v); _confirm = null; _emitConfirm(); } };
  return (
    <>
      {/* toasts — πάνω από την κάτω μπάρα */}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto max-w-sm rounded-2xl px-4 py-3 text-sm font-medium text-white shadow-lg ${t.kind === "error" ? "bg-rose-600" : t.kind === "info" ? "bg-slate-800" : "bg-emerald-600"}`}>
            {t.msg}
          </div>
        ))}
      </div>
      {/* confirm modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => done(false)}>
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-slate-800 p-5 shadow-2xl">
            <div className="text-sm text-slate-700 dark:text-slate-200">{confirm.msg}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => done(false)} className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">Άκυρο</button>
              <button onClick={() => done(true)} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Ναι</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
