"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Lock, ArrowRight } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Me = { modules?: Record<string, "enabled" | "trial" | "locked"> };
type Addon = { _id: string; name: string; icon?: string; description?: string;
               price_monthly?: number; status: string; offered?: boolean };

/**
 * Τμήμα ρυθμίσεων που ανήκει σε ΠΡΟΑΙΡΕΤΙΚΟ add-on.
 *
 * Το πρόβλημα που λύνει: ρυθμίσεις ενός κυκλώματος που ο πελάτης ΔΕΝ έχει αγοράσει έμεναν
 * ορατές και λειτουργικές — έγραφε παραμέτρους που δεν επρόκειτο να χρησιμοποιηθούν ποτέ, και
 * κάθε κλήση γύριζε 403 στο παρασκήνιο.
 *
 * Ακολουθεί ΤΟΝ ΙΔΙΟ κανόνα με το μενού (Sidebar):
 *   · ενεργό            → κανονικά
 *   · κλειδωμένο ΑΛΛΑ αγοράσιμο από το πακέτο του → γκριζαρισμένο, με λουκέτο & πρόσκληση
 *   · κλειδωμένο & μη προσφερόμενο                → εξαφανίζεται τελείως
 */
/**
 * Η κατάσταση ενός προαιρετικού add-on για το UI:
 *   "on"      → ενεργό, δείξ' το κανονικά
 *   "offer"   → κλειδωμένο αλλά αγοράσιμο → γκριζάρισε με λουκέτο
 *   "hide"    → δεν πωλείται σ' αυτόν τον πελάτη → εξαφάνισέ το
 *   "unknown" → δεν ξέρουμε ακόμη → μη δείξεις τίποτα (καλύτερα κενό παρά αναβόσβημα)
 */
/** Ένα ή ΠΕΡΙΣΣΟΤΕΡΑ modules ξεκλειδώνουν την ίδια οθόνη.
 *
 *  ΓΙΑΤΙ: ο ίδιος κινητήρας πουλιέται ως δύο προϊόντα (Περιοδικός Εμβολιασμός / Θεραπείες με
 *  Επανάληψη). Όποιος αγόρασε ΤΟ ΕΝΑ πρέπει να βλέπει την οθόνη. Με έλεγχο ενός μόνο module,
 *  όποιος είχε μόνο τις Θεραπείες έβλεπε κενό μενού και νόμιζε ότι δεν ενεργοποιήθηκε τίποτα.
 */
export function useAddonState(module: string | string[]): { state: "on" | "offer" | "hide" | "unknown"; addon?: Addon } {
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false, staleTime: 300_000 });
  const addons = useQuery({
    queryKey: ["addons"],
    queryFn: () => api<{ addons: Addon[] }>("/addons"),
    retry: false,
    staleTime: 300_000,
  });
  const keys = Array.isArray(module) ? module : [module];
  if (keys.some((k) => ["enabled", "trial"].includes(me.data?.modules?.[k] ?? "")))
    return { state: "on" };
  if (me.isLoading || addons.isLoading) return { state: "unknown" };
  // Καμία κατοχή → προσφέρουμε το ΠΡΩΤΟ της λίστας (το «κύριο» προϊόν της οθόνης).
  const addon = addons.data?.addons?.find((x) => x._id === keys[0]);
  if (!addon || !addon.offered || addon.status === "included") return { state: "hide" };
  return { state: "offer", addon };
}

export function AddonSection({ module, children }: { module: string | string[]; children: React.ReactNode }) {
  const t = useT();
  const { state, addon: a } = useAddonState(module);
  if (state === "on") return <>{children}</>;
  if (state !== "offer" || !a) return null;

  const price = a.price_monthly ? `${(a.price_monthly / 100).toLocaleString("el-GR", { maximumFractionDigits: 0 })} €` : null;

  return (
    <section className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-800/40 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
            <Lock className="h-3.5 w-3.5" />
            {a.icon ? `${a.icon} ` : ""}{a.name}
          </h3>
          {a.description && (
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">{a.description}</p>
          )}
          <p className="mt-1.5 text-xs text-slate-400">
            {price
              ? t(`Έξτρα δυνατότητα — δεν περιλαμβάνεται στο πακέτο σου (${price}/μήνα).`,
                  `Optional add-on — not included in your plan (${price}/month).`)
              : t("Έξτρα δυνατότητα — δεν περιλαμβάνεται στο πακέτο σου.",
                  "Optional add-on — not included in your plan.")}
          </p>
        </div>
        <Link href="/settings/modules"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-white dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800">
          {t("Δες τι κάνει", "See what it does")}<ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}
