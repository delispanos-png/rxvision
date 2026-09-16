"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles, X, PlayCircle, CalendarClock, ArrowRight, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Addon = {
  key: string; name: string; icon?: string; description?: string;
  features?: string[]; price_monthly?: number; price_yearly?: number;
};
type Ann = {
  _id: string; title: string; body?: string; kind?: string;
  cta?: { trial?: boolean; demo?: boolean; info_href?: string | null };
  addon?: Addon | null;
};

const eur = (c?: number | null) => (c ? `${(c / 100).toLocaleString("el-GR", { maximumFractionDigits: 0 })} €` : null);
// Εμφανίζεται ΜΙΑ φορά ανά συνεδρία, ακόμη κι αν η συχνότητα είναι «κάθε σύνδεση»: το ίδιο
// παράθυρο σε κάθε αλλαγή σελίδας θα ήταν βασανιστήριο.
const SEEN = "rxv_ann_seen_session";

/**
 * Το παράθυρο «τι καινούργιο υπάρχει για σένα».
 *
 * Σχεδιασμένο ώστε να ΜΗΝ είναι διαφήμιση: λέει τι κάνει η δυνατότητα, πόσο κοστίζει, και δίνει
 * τρεις τίμιες εξόδους — δοκιμή στη δική σου υποδομή, παρουσίαση, ή «όχι, μη μου το ξαναπείς».
 * Η τελευταία επιλογή είναι εξίσου εμφανής με τις άλλες· χωρίς αυτήν, το παράθυρο γίνεται παγίδα.
 */
export function AnnouncementPopup() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<"trial" | "demo" | null>(null);
  const [note, setNote] = useState("");

  const q = useQuery({
    queryKey: ["announcement-next"],
    queryFn: () => api<{ item: Ann | null }>("/announcements/next"),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const ann = q.data?.item ?? null;

  const act = useMutation({
    mutationFn: (v: { action: string; note?: string }) =>
      api(`/announcements/${encodeURIComponent(ann!._id)}/action`, {
        method: "POST", body: JSON.stringify(v),
      }),
  });

  useEffect(() => {
    if (!ann) return;
    let seen: string[] = [];
    try { seen = JSON.parse(window.sessionStorage.getItem(SEEN) || "[]"); } catch { /* ignore */ }
    if (seen.includes(ann._id)) return;
    try { window.sessionStorage.setItem(SEEN, JSON.stringify([...seen, ann._id])); } catch { /* ignore */ }
    setOpen(true);
    act.mutate({ action: "shown" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ann?._id]);

  if (!ann || !open) return null;
  const a = ann.addon;
  const price = eur(a?.price_monthly);

  const close = (action?: string) => {
    if (action) act.mutate({ action });
    setOpen(false);
  };
  const ask = (kind: "trial" | "demo") => {
    act.mutate({ action: kind, note: note.trim() || undefined });
    setDone(kind);
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-900/50 p-4 backdrop-blur-sm"
      role="dialog" aria-modal="true" aria-label={ann.title}>
      <div className="w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-slate-900">
        <div className="relative bg-gradient-to-br from-indigo-600 to-sky-600 px-6 py-5 text-white">
          <button onClick={() => close("dismissed")} aria-label={t("Κλείσιμο", "Close")}
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-white/80 hover:bg-white/15 hover:text-white">
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/80">
            <Sparkles className="h-3.5 w-3.5" />{t("Νέο στο RxVision", "New in RxVision")}
          </div>
          <h2 className="mt-1.5 pr-8 text-xl font-bold leading-snug">
            {a?.icon ? `${a.icon} ` : ""}{ann.title}
          </h2>
        </div>

        {done ? (
          <div className="px-6 py-8 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
              <Check className="h-6 w-6" />
            </div>
            <p className="mt-3 text-base font-semibold text-slate-800 dark:text-slate-100">
              {t("Το αίτημά σου στάλθηκε.", "Your request was sent.")}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
              {done === "trial"
                ? t("Θα το ενεργοποιήσουμε στο φαρμακείο σου για να το δουλέψεις κανονικά, και θα επικοινωνήσουμε μαζί σου.",
                    "We'll enable it in your pharmacy so you can use it properly, and we'll be in touch.")
                : t("Θα επικοινωνήσουμε μαζί σου για να το δούμε μαζί, με τα δικά σου δεδομένα.",
                    "We'll get in touch to walk through it with your own data.")}
            </p>
            <button onClick={() => setOpen(false)}
              className="mt-5 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900">
              {t("Εντάξει", "Got it")}
            </button>
          </div>
        ) : (
          <div className="px-6 py-5">
            {ann.body && (
              <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700 dark:text-slate-300">{ann.body}</p>
            )}
            {a?.description && !ann.body && (
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{a.description}</p>
            )}
            {!!a?.features?.length && (
              <ul className="mt-3 space-y-1.5">
                {a.features.slice(0, 4).map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-400">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />{f}
                  </li>
                ))}
              </ul>
            )}
            {price && (
              <p className="mt-3 text-xs text-slate-400">
                {t(`Έξτρα δυνατότητα — ${price}/μήνα, όποτε αποφασίσεις. Η δοκιμή δεν σε δεσμεύει.`,
                  `Optional add-on — ${price}/month whenever you decide. The trial commits you to nothing.`)}
              </p>
            )}

            {(ann.cta?.trial || ann.cta?.demo) && (
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                placeholder={t("Θέλεις να μας πεις κάτι; (προαιρετικό — π.χ. πότε σε βολεύει)",
                  "Anything to add? (optional — e.g. when suits you)")}
                className="mt-4 w-full resize-none rounded-xl border border-slate-200 p-2.5 text-sm focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-800" />
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {ann.cta?.trial !== false && (
                <button onClick={() => ask("trial")} disabled={act.isPending}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
                  <PlayCircle className="h-4 w-4" />{t("Θέλω να το δοκιμάσω", "I want to try it")}
                </button>
              )}
              {ann.cta?.demo !== false && (
                <button onClick={() => ask("demo")} disabled={act.isPending}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
                  <CalendarClock className="h-4 w-4" />{t("Δείξτε μου το", "Show me")}
                </button>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              {ann.cta?.info_href ? (
                <Link href={ann.cta.info_href} onClick={() => close("info")}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                  {t("Δες περισσότερα", "Learn more")}<ArrowRight className="h-3 w-3" />
                </Link>
              ) : <span />}
              <button onClick={() => close("never")}
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                {t("Δεν με ενδιαφέρει — μη μου το ξαναδείξεις", "Not interested — don't show again")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
