"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Sparkles, X, Search, Phone, PlayCircle, ArrowRight, Check, Cpu, Loader2,
} from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/store/prefStore";
import {
  activateFeatureTrial, requestCallback, recordAnnouncementAction, trackAnnouncement,
  markSeenLocally, type AnnouncementConfig,
} from "@/lib/featureAnnouncements";

/**
 * FeatureAnnouncementModal — ΕΠΑΝΑΧΡΗΣΙΜΟΠΟΙΗΣΙΜΟ παράθυρο ανακοίνωσης νέας δυνατότητας.
 *
 * Δεν γνωρίζει ΤΙΠΟΤΑ για συγκεκριμένη δυνατότητα: όλα έρχονται από το `config`. Το ίδιο
 * component σερβίρει «Σύμβουλο», «Κέντρο Επανακλήσεων», «Αποθήκη» κ.ο.κ.
 *
 * Επιχειρησιακή λογική ΔΕΝ ζει εδώ — μόνο στο service layer (`lib/featureAnnouncements`).
 * Προσβασιμότητα (role/aria/focus trap/ESC/επιστροφή εστίασης) έρχεται από το κοινό <Modal/>.
 */
type Choice = "interested" | "callback" | "trial";
const TONE: Record<string, string> = {
  rose: "border-rose-200 bg-rose-50/70", amber: "border-amber-200 bg-amber-50/70",
  sky: "border-sky-200 bg-sky-50/70", emerald: "border-emerald-200 bg-emerald-50/70",
};

export function FeatureAnnouncementModal({
  config, open, onClose, preview = false,
}: {
  config: AnnouncementConfig; open: boolean;
  onClose: (reason: "dismissed" | "never" | "done") => void;
  /** Προεπισκόπηση στο adminpanel: δείχνει ΑΚΡΙΒΩΣ το ίδιο παράθυρο αλλά δεν γράφει τίποτα.
   *  Δύο λόγοι: (α) οι δοκιμές του διαχειριστή χάλαγαν τους μετρητές «εμφανίσεις» της
   *  πραγματικής ανακοίνωσης· (β) τα endpoints είναι του ΠΕΛΑΤΗ — στο adminpanel γύριζαν 401
   *  και ο apiClient πετούσε τον διαχειριστή στο /login, κλείνοντας όλη τη σελίδα. */
  preview?: boolean;
}) {
  const t = useT();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [never, setNever] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activated, setActivated] = useState(false);
  const [sent, setSent] = useState<null | "callback" | "trial">(null);
  const [form, setForm] = useState({ name: "", phone: "", when: "" });
  const viewed = useRef(false);
  // Χωρίς στιγμιότυπο, μια δεύτερη στήλη θα ήταν μισή άδεια οθόνη.
  const hasVisual = !!(config.preview || config.aiCallout);

  useEffect(() => {
    if (!open || viewed.current || preview) return;
    viewed.current = true;
    markSeenLocally(config.announcementId, config.version);
    trackAnnouncement("announcement_viewed", { id: config.announcementId, version: config.version });
    void recordAnnouncementAction(config.announcementId, "shown");
  }, [open, preview, config.announcementId, config.version]);

  const close = (reason: "dismissed" | "never" | "done" = "dismissed") => {
    if (preview) { onClose(reason); return; }
    if (never || reason === "never") {
      markSeenLocally(config.announcementId, config.version, "never");
      trackAnnouncement("announcement_dismissed", { id: config.announcementId });
      void recordAnnouncementAction(config.announcementId, "never");
    } else if (reason === "dismissed") {
      trackAnnouncement("announcement_closed", { id: config.announcementId });
      void recordAnnouncementAction(config.announcementId, "dismissed");
    }
    onClose(never ? "never" : reason);
  };

  const options = useMemo(() => ([
    { key: "interested" as Choice, icon: Search, show: !!config.informationUrl,
      title: t("Με ενδιαφέρει", "I'm interested"),
      text: t("Θέλω να δω περισσότερες πληροφορίες.", "I want to see more information.") },
    { key: "callback" as Choice, icon: Phone, show: config.allowCallback !== false,
      title: t("Να με καλέσει κάποιος", "Have someone call me"),
      text: t("Θα ήθελα μια σύντομη παρουσίαση.", "I'd like a short walkthrough.") },
    { key: "trial" as Choice, icon: PlayCircle, show: config.enableTrial !== false,
      title: t("Ενεργοποίηση δοκιμαστικής περιόδου", "Start a trial"),
      text: t("Θέλω να το δοκιμάσω για μια περίοδο.", "I want to try it for a while.") },
  ].filter((o) => o.show)), [config, t]);

  // Σε προεπισκόπηση τα κουμπιά δείχνουν το ίδιο αποτέλεσμα ΧΩΡΙΣ να ζητήσουν τίποτα: ο
  // διαχειριστής βλέπει τι θα δει ο πελάτης, χωρίς να ανοίξει δοκιμή ή να ζητήσει τηλέφωνο.
  async function submitCallback() {
    if (!form.name.trim() || !form.phone.trim()) return;
    if (preview) { setSent("callback"); return; }
    setBusy(true);
    await requestCallback(config.announcementId, form);
    setBusy(false);
    setSent("callback");
  }
  async function confirmTrial() {
    if (preview) { setActivated(true); setSent("trial"); return; }
    setBusy(true);
    const res = await activateFeatureTrial(config.announcementId);
    setBusy(false);
    setActivated(!!res.activated);
    setSent("trial");
  }

  return (
    <Modal open={open} onClose={() => close("dismissed")} size="announcement" padded={false}
      dim="bg-[rgba(10,20,40,0.55)]">
      <div className="relative">
        <button onClick={() => close("dismissed")} aria-label={t("Κλείσιμο", "Close")}
          className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">
          <X className="h-5 w-5" />
        </button>

        <div className={`grid gap-0 ${hasVisual ? "lg:grid-cols-[1.05fr_0.95fr]" : ""}`}>
          {/* ── αριστερά: τι είναι ─────────────────────────────────────────── */}
          <div className="p-6 sm:p-8">
            <Logo subtitle={false} markClassName="h-8 w-8" />
            {config.badge && (
              <span className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
                <Sparkles className="h-3.5 w-3.5" />{config.badge}
              </span>
            )}
            <h2 className="mt-3 text-2xl font-extrabold leading-tight text-slate-900 dark:text-slate-50 sm:text-3xl">
              {config.title}
            </h2>
            {config.subtitle && (
              <p className="mt-2 text-base leading-relaxed text-slate-500 dark:text-slate-400">{config.subtitle}</p>
            )}
            {config.description && (
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">{config.description}</p>
            )}

            {!!config.features?.length && (
              <ul className="mt-6 space-y-4">
                {config.features.map((f) => (
                  <li key={f.title} className="flex gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-50 text-xl dark:bg-brand-900/40" aria-hidden>{f.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-slate-900 dark:text-slate-100">{f.title}</span>
                      <span className="block text-sm leading-relaxed text-slate-500 dark:text-slate-400">{f.text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {config.quote && (
              <blockquote className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm italic leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300">
                <span className="mr-1 text-lg not-italic text-slate-300">“</span>{config.quote}
              </blockquote>
            )}
          </div>

          {/* ── δεξιά: πώς φαίνεται ────────────────────────────────────────── */}
          {hasVisual && (
          <div className="relative flex flex-col justify-center gap-4 bg-gradient-to-br from-brand-50/70 to-sky-50/60 p-6 dark:from-slate-800/60 dark:to-slate-900 sm:p-8">
            {config.preview && (
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-pop dark:border-slate-700 dark:bg-slate-900">
                <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                  <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{config.preview.title}</p>
                  {config.preview.subtitle && <p className="text-[11px] text-slate-400">{config.preview.subtitle}</p>}
                </div>
                <ul className="space-y-2 p-3">
                  {config.preview.rows.map((r, i) => (
                    <li key={i} className={`flex items-center gap-2.5 rounded-xl border p-2.5 ${TONE[r.tone ?? "sky"]} dark:border-slate-700 dark:bg-slate-800/50`}>
                      <span className="text-base" aria-hidden>{r.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-semibold leading-snug text-slate-800 dark:text-slate-100">{r.text}</span>
                        {r.who && <span className="block truncate text-[11px] text-slate-400">{r.who}</span>}
                      </span>
                      {r.cta && <span className="shrink-0 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-slate-500 shadow-sm dark:bg-slate-900">{r.cta} →</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {config.aiCallout && (
              <div className="flex items-center gap-3 rounded-2xl border border-brand-200 bg-white/80 p-3.5 shadow-sm dark:border-brand-900 dark:bg-slate-900/70">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-600 text-white"><Cpu className="h-5 w-5" /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-slate-900 dark:text-slate-100">{config.aiCallout.title}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">{config.aiCallout.text}</span>
                </span>
              </div>
            )}
            {config.price && (
              <p className="text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {t(`Έξτρα δυνατότητα — ${config.price}/μήνα, όποτε αποφασίσεις.`,
                  `Optional add-on — ${config.price}/month, whenever you decide.`)}
                {config.enableTrial !== false && config.trialDays
                  ? " " + t(`Η δοκιμή των ${config.trialDays} ημερών δεν σε δεσμεύει.`,
                      `The ${config.trialDays}-day trial commits you to nothing.`)
                  : ""}
              </p>
            )}
          </div>
          )}
        </div>

        {/* ── κάτω: πώς θέλεις να προχωρήσουμε ──────────────────────────────── */}
        <div className="border-t border-slate-100 p-6 dark:border-slate-800 sm:p-8">
          {sent ? (
            <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                  {sent === "callback"
                    ? t("Ευχαριστούμε! Ένας συνεργάτης μας θα επικοινωνήσει μαζί σας.",
                        "Thank you! A colleague will be in touch.")
                    : activated
                      ? t("Η δοκιμαστική περίοδος ενεργοποιήθηκε.", "Your trial is active.")
                      : t("Το αίτημά σου στάλθηκε — θα το ενεργοποιήσουμε και θα σε ειδοποιήσουμε.",
                          "Request sent — we'll enable it and let you know.")}
                </p>
                {sent === "trial" && activated && config.trialDays && (
                  <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                    {t(`Είναι ήδη διαθέσιμο στο μενού σου, για ${config.trialDays} ημέρες.`,
                      `It's already in your menu, for ${config.trialDays} days.`)}
                  </p>
                )}
              </div>
              <button onClick={() => close("done")}
                className="ml-auto shrink-0 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900">
                {activated && sent === "trial" ? t("✓ Ενεργό", "✓ Active") : t("Εντάξει", "Got it")}
              </button>
            </div>
          ) : (
            <>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                {t("Θέλεις να μάθεις περισσότερα;", "Want to know more?")}
              </h3>
              <p className="mt-0.5 text-sm text-slate-500">
                {t("Επίλεξε πώς θέλεις να προχωρήσουμε:", "Choose how you'd like to proceed:")}
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {options.map((o) => {
                  const Ico = o.icon;
                  const on = choice === o.key;
                  const body = (
                    <>
                      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${on ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-600 dark:bg-slate-800"}`}>
                        <Ico className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-slate-900 dark:text-slate-100">{o.title}</span>
                        <span className="block text-xs leading-relaxed text-slate-500 dark:text-slate-400">{o.text}</span>
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-brand-500" />
                    </>
                  );
                  const cls = `group flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition hover:-translate-y-0.5 hover:shadow-pop ${
                    on ? "border-brand-500 bg-brand-50/60 shadow-pop dark:bg-brand-900/20"
                       : "border-slate-200 bg-white hover:border-brand-300 hover:bg-slate-50/80 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"}`;
                  // Σε προεπισκόπηση ο σύνδεσμος ΔΕΝ πλοηγεί: ο διαχειριστής δεν είναι στην
                  // εφαρμογή του πελάτη και θα έφευγε από τη σελίδα του adminpanel.
                  return o.key === "interested" && config.informationUrl && !preview ? (
                    <Link key={o.key} href={config.informationUrl} className={cls} aria-label={o.title}
                      onClick={() => {
                        trackAnnouncement("announcement_interested", { id: config.announcementId });
                        void recordAnnouncementAction(config.announcementId, "interested");
                      }}>
                      {body}
                    </Link>
                  ) : (
                    <button key={o.key} type="button" className={cls} aria-pressed={on} aria-label={o.title}
                      onClick={() => setChoice(on ? null : o.key)}>
                      {body}
                    </button>
                  );
                })}
              </div>

              {/* Φόρμα επικοινωνίας — ανοίγει μέσα στο ίδιο παράθυρο, χωρίς να σε πετάξει αλλού. */}
              {choice === "callback" && (
                <div className="mt-4 grid gap-3 rounded-2xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-900 dark:bg-slate-800/40 sm:grid-cols-3">
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t("Όνομα", "Name")}
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
                  </label>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t("Τηλέφωνο", "Phone")}
                    <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" required
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
                  </label>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t("Προτιμώμενη ώρα", "Preferred time")}
                    <input value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })}
                      placeholder={t("π.χ. Τρίτη πρωί", "e.g. Tue morning")}
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800" />
                  </label>
                  <div className="sm:col-span-3">
                    <button onClick={submitCallback} disabled={busy || !form.name.trim() || !form.phone.trim()}
                      className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("Ζήτησε επικοινωνία", "Request a call")}
                    </button>
                  </div>
                </div>
              )}

              {/* Επιβεβαίωση δοκιμής — μια ενεργοποίηση δεν γίνεται κατά λάθος. */}
              {choice === "trial" && (
                <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-900 dark:bg-slate-800/40">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {t(`Θέλεις να ενεργοποιήσεις «${config.title.replace(/[!.]$/, "")}» για δοκιμαστική περίοδο;`,
                      `Enable a trial of "${config.title.replace(/[!.]$/, "")}"?`)}
                  </p>
                  {config.trialDays && (
                    <p className="mt-0.5 text-xs text-slate-500">
                      {t(`Θα είναι διαθέσιμο ${config.trialDays} ημέρες και σταματά μόνο του. Καμία χρέωση, καμία δέσμευση.`,
                        `Available for ${config.trialDays} days, ends by itself. No charge, no commitment.`)}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={confirmTrial} disabled={busy}
                      className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("Ενεργοποίηση δοκιμής", "Start trial")}
                    </button>
                    <button onClick={() => setChoice(null)}
                      className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">
                      {t("Ακύρωση", "Cancel")}
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <label className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                  <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
                  {t("Να μην εμφανιστεί ξανά αυτό το μήνυμα", "Don't show this message again")}
                </label>
                <button onClick={() => close(never ? "never" : "dismissed")}
                  className="text-sm font-semibold text-slate-400 underline-offset-4 hover:text-slate-600 hover:underline dark:hover:text-slate-300">
                  {t("Ίσως αργότερα", "Maybe later")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
