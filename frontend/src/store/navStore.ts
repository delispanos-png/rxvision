import { create } from "zustand";

/** Mobile sidebar drawer open-state, shared between Topbar (hamburger) and Sidebar. */
type NavState = {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
};

export const useNavStore = create<NavState>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
