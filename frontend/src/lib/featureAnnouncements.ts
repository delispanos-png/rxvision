/**
 * Feature announcements — service layer.
 *
 * Το UI ΔΕΝ μιλάει ποτέ απευθείας στο API ούτε στο localStorage: όλα περνούν από εδώ, ώστε
 * (α) να αλλάζει η υλοποίηση χωρίς να πειραχτεί το component, και (β) να υπάρχει ΕΝΑ σημείο
 * όπου φαίνεται τι ακριβώς καταγράφεται για τον πελάτη.
 *
 * Πηγή αλήθειας είναι ο SERVER (`announcement_events`): εκεί ζει το «μη μου το ξαναδείξεις»,
 * η συχνότητα και τα στατιστικά, και ισχύουν σε κάθε υπολογιστή του φαρμακείου. Το localStorage
 * είναι ΜΟΝΟ γρήγορο τοπικό φρένο για να μην αναβοσβήνει το παράθυρο πριν απαντήσει το δίκτυο.
 */

import { api } from "@/lib/apiClient";

export type FeatureAction =
  | "shown" | "dismissed" | "never" | "interested" | "callback" | "trial";

/** Τι στέλνει το UI ⇄ τι καταλαβαίνει το backend. */
const WIRE: Record<FeatureAction, string> = {
  shown: "shown", dismissed: "dismissed", never: "never",
  interested: "info", callback: "callback", trial: "trial",
};

export type FeatureItem = { icon: string; title: string; text: string };

/** Το configuration object της ανακοίνωσης — ό,τι χρειάζεται το modal, τίποτα παραπάνω. */
export type AnnouncementConfig = {
  announcementId: string;
  version: string;
  badge?: string;
  title: string;
  subtitle?: string;
  description?: string;
  features?: FeatureItem[];
  quote?: string;
  /** Το πλαίσιο «AI» κάτω από τα χαρακτηριστικά. */
  aiCallout?: { title: string; text: string };
  /** Στιγμιότυπα που μπαίνουν στο δεξί «παράθυρο» της εικόνας. */
  preview?: { title: string; subtitle?: string; rows: { icon: string; text: string; who?: string; cta?: string; tone?: "rose" | "amber" | "sky" | "emerald" }[] };
  informationUrl?: string;
  enableTrial?: boolean;
  allowCallback?: boolean;
  trialDays?: number;
  price?: string | null;
};

// ── «το είδα» τοπικά ────────────────────────────────────────────────────────────────────────
export const seenKey = (id: string, version: string) =>
  `rxvision_announcement_${id}_v${version}_seen`;

export function markSeenLocally(id: string, version: string, value: "seen" | "never" = "seen") {
  try { window.localStorage.setItem(seenKey(id, version), value); } catch { /* private mode */ }
}
export function isDismissedLocally(id: string, version: string): boolean {
  try { return window.localStorage.getItem(seenKey(id, version)) === "never"; } catch { return false; }
}

// ── analytics ───────────────────────────────────────────────────────────────────────────────
/**
 * Το project δεν έχει (ακόμη) analytics framework — και δεν εγκαθιστούμε ένα για αυτό.
 * Κάθε γεγονός (α) καταγράφεται στον server μαζί με την ενέργεια, και (β) εκπέμπεται ως
 * DOM CustomEvent ώστε ό,τι μπει αύριο (GA, PostHog, δικό μας) να το ακούσει χωρίς αλλαγή εδώ.
 */
export type AnnouncementEvent =
  | "announcement_viewed" | "announcement_closed" | "announcement_interested"
  | "announcement_callback_requested" | "announcement_trial_requested"
  | "announcement_trial_activated" | "announcement_dismissed";

export function trackAnnouncement(event: AnnouncementEvent, payload: Record<string, unknown> = {}) {
  try {
    window.dispatchEvent(new CustomEvent("rxvision:analytics", { detail: { event, ...payload } }));
  } catch { /* SSR / χωρίς DOM */ }
}

// ── ενέργειες ───────────────────────────────────────────────────────────────────────────────
type ActionResult = { ok?: boolean; activated?: boolean; days?: number; already?: boolean };

async function post(id: string, body: Record<string, unknown>): Promise<ActionResult> {
  return api<ActionResult>(`/announcements/${encodeURIComponent(id)}/action`, {
    method: "POST", body: JSON.stringify(body),
  });
}

/** Καταγραφή «το είδε / το έκλεισε / μη ξαναδείξεις». Ποτέ δεν ρίχνει το UI. */
export async function recordAnnouncementAction(
  id: string, action: FeatureAction, extra: Record<string, unknown> = {},
): Promise<ActionResult> {
  try { return await post(id, { action: WIRE[action], ...extra }); }
  catch { return { ok: false }; }
}

/** «Θέλω να το δοκιμάσω». Ανάλογα με τη ρύθμιση της ανακοίνωσης, είτε ανοίγει ΤΩΡΑ είτε
 *  καταγράφεται ως αίτημα — το `activated` λέει τι από τα δύο έγινε. */
export async function activateFeatureTrial(id: string): Promise<ActionResult> {
  trackAnnouncement("announcement_trial_requested", { id });
  const res = await recordAnnouncementAction(id, "trial");
  if (res.activated) trackAnnouncement("announcement_trial_activated", { id, days: res.days });
  return res;
}

/** «Να με καλέσει κάποιος» — η μικρή φόρμα επικοινωνίας. */
export async function requestCallback(
  id: string, form: { name: string; phone: string; when?: string },
): Promise<ActionResult> {
  trackAnnouncement("announcement_callback_requested", { id });
  return recordAnnouncementAction(id, "callback", {
    callback_name: form.name, callback_phone: form.phone, callback_when: form.when,
  });
}
