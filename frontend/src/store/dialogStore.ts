import { create } from "zustand";

/** App-styled replacement for window.alert / confirm / prompt.
 * Call appAlert/appConfirm/appPrompt from anywhere (await for the result);
 * <DialogHost/> (mounted once in Providers) renders the modal. */

type DialogKind = "alert" | "confirm" | "prompt";

type DialogData = {
  open: boolean;
  kind: DialogKind;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
  // bumped every time a dialog opens → forces the input to reset
  seq: number;
  _resolve?: (v: unknown) => void;
};

type DialogStore = DialogData & {
  _show: (s: Partial<DialogData>) => void;
  _settle: (v: unknown) => void;
};

export const useDialogStore = create<DialogStore>((set, get) => ({
  open: false,
  kind: "alert",
  message: "",
  seq: 0,
  _show: (s) => set((st) => ({ ...st, ...s, open: true, seq: st.seq + 1 })),
  _settle: (v) => {
    const resolve = get()._resolve;
    set({ open: false, _resolve: undefined });
    resolve?.(v);
  },
}));

function show<T>(opts: Partial<DialogData>): Promise<T> {
  return new Promise<T>((resolve) => {
    useDialogStore.getState()._show({ ...opts, _resolve: resolve as (v: unknown) => void });
  });
}

export function appAlert(
  message: string,
  opts: { title?: string; confirmText?: string } = {}
): Promise<void> {
  return show<void>({ kind: "alert", message, ...opts });
}

export function appConfirm(
  message: string,
  opts: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean } = {}
): Promise<boolean> {
  return show<boolean>({ kind: "confirm", message, ...opts });
}

export function appPrompt(
  message: string,
  opts: { title?: string; defaultValue?: string; placeholder?: string; confirmText?: string } = {}
): Promise<string | null> {
  return show<string | null>({ kind: "prompt", message, ...opts });
}
