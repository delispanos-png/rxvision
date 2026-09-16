/**
 * Ενιαία κλίμακα προτεραιότητας ασθενή — ΜΟΝΑΔΙΚΗ ΠΗΓΗ ΑΛΗΘΕΙΑΣ.
 *
 * Πριν από αυτό, κάθε σελίδα εφηύρισκε τα δικά της χρώματα: η Συμμόρφωση είχε σωστή
 * 5-βάθμια κλίμακα, το Ρίσκο έβαφε ΟΛΟΥΣ με το ίδιο κόκκινο (άρα καμία διαβάθμιση),
 * και οι Εμβολιασμοί δεν είχαν καθόλου χρώμα. Εδώ ορίζεται μία κλίμακα και τα
 * κριτήρια κάθε κυκλώματος, ώστε το ίδιο χρώμα να σημαίνει παντού το ίδιο πράγμα.
 *
 * ΠΡΟΣΟΧΗ (προσβασιμότητα): το χρώμα ΔΕΝ αρκεί — ~8% των ανδρών δεν διακρίνει
 * κόκκινο/πράσινο. Κάθε badge συνοδεύεται ΠΑΝΤΑ από κείμενο (βλ. PriorityBadge).
 */

export type Priority = "critical" | "high" | "medium" | "low" | "ok";

/** Σειρά έντασης — για ταξινόμηση «οι κρίσιμοι πρώτοι». */
export const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0, high: 1, medium: 2, low: 3, ok: 4,
};

export const PRIORITY_LABEL: Record<Priority, { el: string; en: string }> = {
  critical: { el: "Κρίσιμο", en: "Critical" },
  high: { el: "Υψηλό", en: "High" },
  medium: { el: "Μέτριο", en: "Medium" },
  low: { el: "Χαμηλό", en: "Low" },
  ok: { el: "Εντάξει", en: "OK" },
};

/** Τι σημαίνει πρακτικά για τον φαρμακοποιό — μπαίνει σε tooltip. */
export const PRIORITY_ACTION: Record<Priority, { el: string; en: string }> = {
  critical: { el: "Ενέργεια σήμερα", en: "Act today" },
  high: { el: "Μέσα στη βδομάδα", en: "This week" },
  medium: { el: "Παρακολούθηση", en: "Monitor" },
  low: { el: "Καμία ενέργεια", en: "No action needed" },
  ok: { el: "Σταθερός", en: "Stable" },
};

/** Χρώμα κειμένου+φόντου για badge (light & dark). */
export const PRIORITY_CLS: Record<Priority, string> = {
  critical: "text-rose-700 bg-rose-100 dark:text-rose-200 dark:bg-rose-900/45",
  high: "text-orange-700 bg-orange-100 dark:text-orange-200 dark:bg-orange-900/45",
  medium: "text-amber-700 bg-amber-100 dark:text-amber-200 dark:bg-amber-900/45",
  low: "text-lime-700 bg-lime-100 dark:text-lime-200 dark:bg-lime-900/45",
  ok: "text-emerald-700 bg-emerald-100 dark:text-emerald-200 dark:bg-emerald-900/45",
};

/** Συμπαγές χρώμα (κουκκίδα, μπάρα κατανομής). */
export const PRIORITY_SOLID: Record<Priority, string> = {
  critical: "bg-rose-500", high: "bg-orange-500", medium: "bg-amber-500",
  low: "bg-lime-500", ok: "bg-emerald-500",
};

// ── Κριτήρια ανά κύκλωμα ────────────────────────────────────────────────────────────────────
// Κρατιούνται ΕΔΩ (όχι στις σελίδες) ώστε να αλλάζουν σε ένα σημείο.

/** Ρίσκο διακοπής θεραπείας: compliance + ημέρες χωρίς επίσκεψη + χαμένες ανανεώσεις. */
export function riskPriority(r: { compliance?: number | null; gap_days?: number; missed?: number }): Priority {
  const c = r.compliance ?? 100;
  const gap = r.gap_days ?? 0;
  const missed = r.missed ?? 0;
  if (c < 25 || gap >= 180 || missed >= 3) return "critical";
  if (c < 50 || gap >= 120 || missed >= 2) return "high";
  if (c < 70 || gap >= 90 || missed >= 1) return "medium";
  return "low";
}

/** Ζώνη συμμόρφωσης (υπάρχον backend band) → κοινή κλίμακα. */
export function compliancePriority(band: string): Priority {
  return ({ critical: "critical", risk: "high", medium: "medium", good: "low", excellent: "ok" } as
    Record<string, Priority>)[band] ?? "medium";
}

/** Recall: καθυστερημένες (missed) βαραίνουν περισσότερο από τις απλά διαθέσιμες. */
export function recallPriority(r: { missed?: number; available?: number }): Priority {
  const missed = r.missed ?? 0;
  if (missed >= 3) return "critical";
  if (missed >= 1) return "high";
  if ((r.available ?? 0) >= 1) return "medium";
  return "low";
}

/** Εμβολιασμοί — εκκρεμείς στόχοι: προτεραιότητα στους υψηλού κινδύνου. */
export function vaccinationPriority(r: { vaccinated?: boolean; open?: boolean; high_risk?: boolean }): Priority {
  if (r.vaccinated) return "ok";
  if (r.high_risk) return "critical";
  if (r.open) return "high";
  return "medium";
}

/** Εμβολιασμοί — επανάκληση περσινών: ήρθε φέτος; αλλιώς πόσο επείγει. */
export function vaccinationRecallPriority(r: { came_this_season?: boolean; high_risk?: boolean }): Priority {
  if (r.came_this_season) return "ok";
  return r.high_risk ? "critical" : "high";
}

/**
 * Win-Back ανά ημέρες αδράνειας. ΑΝΤΙΣΤΡΟΦΗ λογική από ό,τι περιμένει κανείς:
 * ο 60ήμερος είναι ο ΠΙΟ επείγων (γυρίζει ακόμα), ο 365ήμερος σχεδόν χαμένος.
 */
export function winbackPriority(bucketDays: number): Priority {
  if (bucketDays <= 60) return "critical";
  if (bucketDays <= 90) return "high";
  if (bucketDays <= 180) return "medium";
  return "low";
}

/** Ταξινόμηση λίστας: οι κρίσιμοι πρώτοι (σταθερή — ισοπαλίες κρατούν τη σειρά τους). */
export function byPriority<T>(rows: T[], of: (row: T) => Priority): T[] {
  return [...rows].sort((a, b) => PRIORITY_RANK[of(a)] - PRIORITY_RANK[of(b)]);
}
