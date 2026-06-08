"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogStore } from "@/store/dialogStore";

/** Renders the current app dialog (alert/confirm/prompt). Mount once in Providers. */
export function DialogHost() {
  const { open, kind, title, message, confirmText, cancelText, danger, defaultValue, placeholder, seq, _settle } =
    useDialogStore();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // reset + focus input each time a new dialog opens
  useEffect(() => {
    if (!open) return;
    setValue(defaultValue ?? "");
    if (kind === "prompt") setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, seq, kind, defaultValue]);

  // Escape closes (cancel)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const cancel = () => _settle(kind === "prompt" ? null : false);
  const accept = () => _settle(kind === "alert" ? undefined : kind === "prompt" ? value : true);

  const okLabel = confirmText ?? (kind === "alert" ? "Εντάξει" : "OK");
  const okCls = danger
    ? "bg-rose-600 hover:bg-rose-700"
    : "bg-brand-600 hover:bg-brand-700";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={cancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && <h3 className="mb-1 text-base font-bold text-slate-900">{title}</h3>}
        <p className="whitespace-pre-line text-sm text-slate-600">{message}</p>

        {kind === "prompt" && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                accept();
              }
            }}
            className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
        )}

        <div className="mt-6 flex justify-end gap-2">
          {kind !== "alert" && (
            <button
              onClick={cancel}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {cancelText ?? "Άκυρο"}
            </button>
          )}
          <button
            onClick={accept}
            autoFocus={kind !== "prompt"}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${okCls}`}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
