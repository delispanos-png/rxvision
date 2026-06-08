import { create } from "zustand";

/** Transient, auto-dismissing toast notifications (sibling of dialogStore).
 * Call toastSuccess/toastError/toastInfo from anywhere; <ToastHost/> (mounted once in
 * Providers) renders them. For confirmations/blocking prompts use the dialog* helpers. */

export type ToastKind = "success" | "error" | "info";
export type Toast = { id: number; kind: ToastKind; message: string };

type ToastStore = {
  toasts: Toast[];
  _push: (kind: ToastKind, message: string, duration: number) => void;
  dismiss: (id: number) => void;
};

let _seq = 0;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  _push: (kind, message, duration) => {
    const id = ++_seq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    if (duration > 0 && typeof window !== "undefined") {
      window.setTimeout(() => get().dismiss(id), duration);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

function push(kind: ToastKind, message: string, duration: number) {
  useToastStore.getState()._push(kind, message, duration);
}

export const toastSuccess = (message: string) => push("success", message, 4000);
export const toastError = (message: string) => push("error", message, 6000);
export const toastInfo = (message: string) => push("info", message, 4000);
