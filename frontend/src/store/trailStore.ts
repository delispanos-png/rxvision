import { create } from "zustand";

/**
 * «Νήμα επιστροφής» — από πού ήρθα, για να γυρίσω ακριβώς εκεί.
 *
 * ΓΙΑΤΙ: από την Εικόνα Πελάτη ο πάγκος πηδά σε άλλα κυκλώματα (δανεικό μέλους της οικογένειας,
 * συνταγή, …) με τον πελάτη ΜΠΡΟΣΤΑ του. Χωρίς νήμα, η επιστροφή σημαίνει μενού → Εικόνα Πελάτη →
 * ξανά αναζήτηση του ίδιου ανθρώπου. Εδώ κρατάμε τη διαδρομή (π.χ. ΔΡΟΣΑΚΗ → ΤΣΟΥΛΟΥΒΗΣ → δανεικό)
 * και η μπάρα επιστροφής (`TrailBar`) τη δείχνει πάνω από κάθε σελίδα.
 *
 * sessionStorage (όχι localStorage): η διαδρομή αφορά ΑΥΤΗ τη βάρδια σε ΑΥΤΗ την καρτέλα. Αύριο, ή σε
 * δεύτερη καρτέλα, ένα παλιό «↩ ΔΡΟΣΑΚΗ» θα ήταν θόρυβος. Κάθε πρόσβαση σε try — σε ιδιωτικό
 * παράθυρο μπορεί να πετάξει, και η πλοήγηση δεν πρέπει ποτέ να σπάει εξαιτίας του.
 */
export type TrailStep = { href: string; label: string };

const KEY = "rxv-trail";
const MAX = 6;

function load(): TrailStep[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.href === "string") : [];
  } catch {
    return [];
  }
}

function save(v: TrailStep[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* η πλοήγηση δεν σπάει ποτέ εξαιτίας της αποθήκευσης */
  }
}

/** Η τρέχουσα θέση ως href (διαδρομή + παράμετροι). */
export const currentHref = () =>
  typeof window === "undefined" ? "" : window.location.pathname + window.location.search;

type TrailState = {
  steps: TrailStep[];
  hydrate: () => void;
  /** Φεύγω ΑΠΟ εδώ — κράτα το ως σημείο επιστροφής. */
  leave: (label: string, href?: string) => void;
  /** Γύρισα στο βήμα `i` — ό,τι ήταν μετά από αυτό δεν ισχύει πια. */
  cutAt: (i: number) => void;
  clear: () => void;
};

export const useTrail = create<TrailState>((set, get) => ({
  steps: [],
  hydrate: () => set({ steps: load() }),
  leave: (label, href) => {
    const h = href ?? currentHref();
    if (!h) return;
    const steps = get().steps.filter((s) => s.href !== h);   // ίδιο σημείο δύο φορές = μία
    const next = [...steps, { href: h, label }].slice(-MAX);
    save(next);
    set({ steps: next });
  },
  cutAt: (i) => {
    const next = get().steps.slice(0, Math.max(0, i));
    save(next);
    set({ steps: next });
  },
  clear: () => { save([]); set({ steps: [] }); },
}));
