"use client";

import { useEffect, useRef, type ReactNode } from "react";

const SIZES = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg", xl: "max-w-2xl", "2xl": "max-w-4xl", "3xl": "max-w-6xl" } as const;

/** Accessible modal primitive: backdrop, Escape-to-close, focus trap, focus restore,
 *  and `max-h-[90vh]` scroll for small screens (U-12, R-5). Consolidates the ad-hoc
 *  overlay implementations. Render conditionally or pass `open`.
 *
 *    <Modal open={open} onClose={() => setOpen(false)} title="…" footer={…}>…</Modal>
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    // focus the first focusable element (or the dialog itself)
    const focusables = ref.current?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
    );
    (focusables && focusables.length ? focusables[0] : ref.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && ref.current) {
        const items = ref.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`max-h-[90vh] w-full ${SIZES[size]} overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl outline-none dark:bg-slate-900 sm:p-6`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && <h3 className="mb-3 text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3>}
        {children}
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
