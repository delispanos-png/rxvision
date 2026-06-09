import { create } from "zustand";

function yearToDate(): { from: string; to: string } {
  // shared default for every page: 1 Jan → tomorrow (exclusive upper bound, includes today)
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { from: first.toISOString().slice(0, 10), to: tomorrow.toISOString().slice(0, 10) };
}

const defaults = yearToDate();

export type UiState = {
  dateFrom: string;
  dateTo: string;
  fundId: string | null;
  doctorId: string | null;
  icd10: string | null;
  setDateRange: (from: string, to: string) => void;
  setFund: (id: string | null) => void;
  setDoctor: (id: string | null) => void;
  setIcd10: (code: string | null) => void;
  reset: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  dateFrom: defaults.from,
  dateTo: defaults.to,
  fundId: null,
  doctorId: null,
  icd10: null,
  setDateRange: (from, to) => set({ dateFrom: from, dateTo: to }),
  setFund: (id) => set({ fundId: id }),
  setDoctor: (id) => set({ doctorId: id }),
  setIcd10: (code) => set({ icd10: code }),
  reset: () =>
    set({
      dateFrom: defaults.from,
      dateTo: defaults.to,
      fundId: null,
      doctorId: null,
      icd10: null,
    }),
}));

/** Builds a `?date_from&date_to[&fund_id&doctor_id&icd10]` query string from current filters. */
export function filtersToQuery(s: Pick<UiState, "dateFrom" | "dateTo" | "fundId" | "doctorId" | "icd10">): string {
  const p = new URLSearchParams();
  p.set("date_from", s.dateFrom);
  p.set("date_to", s.dateTo);
  if (s.fundId) p.set("fund_id", s.fundId);
  if (s.doctorId) p.set("doctor_id", s.doctorId);
  if (s.icd10) p.set("icd10", s.icd10);
  return p.toString();
}
