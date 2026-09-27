"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpen, Search, X } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import { useT } from "@/store/prefStore";

/** Εγχειρίδιο χρήσης — ΜΕΣΑ στην εφαρμογή.
 *
 * ΓΙΑΤΙ ΥΠΑΡΧΕΙ: το εγχειρίδιο ζούσε μόνο στο repo (`docs/USER_MANUAL.md`) — ο πελάτης δεν είχε
 * ΚΑΝΕΝΑΝ τρόπο να το δει. Το αρχείο αντιγράφεται στο `public/user-manual.md` στο build, ώστε να
 * μένει ΜΙΑ πηγή αλήθειας: γράφουμε στο docs/, το διαβάζει ο πελάτης εδώ.
 */
export default function ManualPage() {
  const t = useT();
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/user-manual.md")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("not found"))))
      .then(setMd)
      .catch(() => setErr(true));
  }, []);

  // Φιλτράρισμα ΑΝΑ ΕΝΟΤΗΤΑ (##): κρατάμε όποια ενότητα περιέχει τον όρο — έτσι το αποτέλεσμα
  // παραμένει διαβάσιμο κείμενο, όχι σκόρπιες γραμμές χωρίς συμφραζόμενα.
  const filtered = useMemo(() => {
    if (!md) return "";
    const term = q.trim().toLowerCase();
    if (!term) return md;
    const parts = md.split(/\n(?=## )/);
    const keep = parts.filter((p) => p.toLowerCase().includes(term));
    return keep.length ? keep.join("\n") : "";
  }, [md, q]);

  const { body, headings } = useMemo(() => renderMarkdown(filtered), [filtered]);

  if (err) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
        {t("Το εγχειρίδιο δεν είναι διαθέσιμο αυτή τη στιγμή. Δοκίμασε ξανά σε λίγο.",
           "The manual is not available right now. Please try again shortly.")}
      </div>
    );
  }
  if (md === null) {
    return <div className="text-sm text-slate-500">{t("Φόρτωση εγχειριδίου…", "Loading manual…")}</div>;
  }

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <BookOpen className="h-6 w-6 text-sky-600" />
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          {t("Εγχειρίδιο χρήσης", "User manual")}
        </h1>
        <div className="relative ms-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={t("Αναζήτηση στο εγχειρίδιο…", "Search the manual…")}
            className="w-full rounded-xl border border-slate-300 bg-white py-2 ps-9 pe-8 text-sm dark:border-slate-600 dark:bg-slate-900"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label={t("Καθαρισμός", "Clear")}
              className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {q && !filtered && (
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          {t(`Καμία ενότητα δεν περιέχει «${q}».`, `No section contains “${q}”.`)}
        </p>
      )}

      <div className="flex gap-8">
        {/* Ευρετήριο — κολλημένο, μόνο σε μεγάλη οθόνη */}
        {headings.length > 2 && (
          <nav className="sticky top-20 hidden h-[calc(100vh-7rem)] w-64 shrink-0 overflow-y-auto border-e border-slate-200 pe-4 lg:block dark:border-slate-800">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t("Περιεχόμενα", "Contents")}
            </p>
            <ul className="space-y-1">
              {headings.filter((h) => h.level <= 3).map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`}
                    className={`block rounded px-2 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${
                      h.level === 2 ? "font-medium text-slate-700 dark:text-slate-200"
                                    : "ms-3 text-slate-500 dark:text-slate-400"}`}>
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <article className="min-w-0 flex-1 pb-16">{body}</article>
      </div>
    </div>
  );
}
