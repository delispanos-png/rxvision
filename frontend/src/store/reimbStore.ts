import { create } from "zustand";
import { persist } from "zustand/middleware";

function curMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Shared closing period for the whole Reimbursement module — pick once, persists across all
 * sub-sections (and reloads), so the pharmacist can't accidentally audit the wrong month. */
type ReimbState = { period: string; setPeriod: (p: string) => void };

export const useReimbPeriod = create<ReimbState>()(
  persist(
    (set) => ({ period: curMonth(), setPeriod: (p) => set({ period: p }) }),
    { name: "rx-reimb-period" },
  ),
);
