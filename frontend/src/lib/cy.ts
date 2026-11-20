import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";

/** Κοινά βοηθητικά των κυπριακών οθονών (ΓεΣΥ). Οι καταστάσεις συνταγών ορίζονται στον backend
 *  (services/cy/chains.py)· εδώ μόνο οι ετικέτες/χρώματα τους. */

export type ChainStatus = "soon" | "upcoming" | "late" | "lost";

export const STATUS_STYLE: Record<ChainStatus, { el: string; en: string; cls: string }> = {
  late: { el: "Καθυστερεί", en: "Late", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  soon: { el: "Έρχεται σύντομα", en: "Due soon", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  upcoming: { el: "Αναμένεται", en: "Upcoming", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  lost: { el: "Χάθηκε", en: "Lost", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
};

/** Ηλικία από ημερομηνία γέννησης (YYYY-MM-DD). */
export const ageOf = (dob: string | null) => {
  if (!dob) return null;
  const b = new Date(dob), n = new Date();
  return n.getFullYear() - b.getFullYear() - (n < new Date(n.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
};


/** Χώρα του φαρμακείου ("GR" | "CY") από το /auth/me — ίδιο cache με Sidebar/CountryGate. */
export function useCountry(): string | undefined {
  const { data } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<{ country?: string }>("/auth/me"), retry: false });
  return data?.country;
}

/** Συντελεστές ΦΠΑ ανά χώρα. Κύπρος: φάρμακα 5%, αναλώσιμα/λοιπά 19% (όπως το PharmacyOne Κύπρου). */
export const VAT_OPTIONS: Record<string, { rates: number[]; def: number }> = {
  GR: { rates: [6, 13, 24, 0], def: 6 },
  CY: { rates: [5, 9, 19, 0], def: 5 },
};

/** Ο προσωπικός κωδικός που δείχνουν οι κοινές οθόνες: ΑΜΚΑ στην Ελλάδα, κωδικός ΟΑΥ στην Κύπρο
 *  (το backend τον στέλνει στο ίδιο πεδίο `amka` — βλ. repositories/cy_intelligence.py). */
export function useIdLabel(): string {
  return useCountry() === "CY" ? "Κωδ. ΟΑΥ" : "ΑΜΚΑ";
}
