"use client";

/* Καθολικός φύλακας σφαλμάτων.

   ΓΙΑΤΙ ΔΕΙΧΝΕΙ ΛΕΠΤΟΜΕΡΕΙΕΣ: η προηγούμενη εκδοχή πετούσε το `error` και έλεγε μόνο
   «επικοινωνήστε με την υποστήριξη». Ένα τέτοιο μήνυμα δεν βοηθά ούτε τον φαρμακοποιό ούτε
   εμάς — η διάγνωση γίνεται στα τυφλά. Τώρα το σφάλμα καταγράφεται στην κονσόλα και
   εμφανίζεται πτυσσόμενο, με κουμπί αντιγραφής για να μπορεί να το στείλει.

   ΞΕΧΩΡΙΣΤΗ ΠΕΡΙΠΤΩΣΗ — ΠΑΛΙΟ ΑΡΧΕΙΟ ΜΕΤΑ ΑΠΟ ΕΝΗΜΕΡΩΣΗ: όταν ανεβαίνει νέα έκδοση, ένας
   browser που έχει ανοιχτή την εφαρμογή κρατά τα παλιά αρχεία. Η πρώτη πλοήγηση σε ΝΕΑ σελίδα
   ζητά αρχείο που δεν υπάρχει πια → σφάλμα φόρτωσης. Δεν είναι βλάβη, θέλει σκληρή ανανέωση —
   και το λέμε με ανθρώπινα λόγια αντί να τρομάξουμε τον χρήστη. */

import { useEffect, useState } from "react";

/** Το σφάλμα οφείλεται σε αρχείο που δεν υπάρχει πια (νέα έκδοση ανέβηκε ενώ ήταν ανοιχτή). */
function isStaleBuild(e: Error): boolean {
  const s = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return s.includes("chunkloaderror")
    || s.includes("loading chunk")
    || s.includes("loading css chunk")
    || s.includes("failed to fetch dynamically imported module")
    || s.includes("importing a module script failed");
}

export default function Error({ error, reset }: {
  error: Error & { digest?: string }; reset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const stale = isStaleBuild(error);

  useEffect(() => {
    // Χωρίς αυτό, το σφάλμα χάνεται εντελώς και η μόνη ένδειξη είναι μια λευκή οθόνη.
    console.error("[RxVision] Σφάλμα σελίδας:", error);
  }, [error]);

  const details = [error?.name, error?.message, error?.digest && `digest: ${error.digest}`]
    .filter(Boolean).join(" · ");

  if (stale) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Η εφαρμογή ενημερώθηκε</h1>
        <p className="mt-2 max-w-md text-sm text-slate-500">
          Ανέβηκε νέα έκδοση όσο είχατε ανοιχτή τη σελίδα. Χρειάζεται μία ανανέωση για να
          φορτώσει — δεν έχει χαθεί τίποτα.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 inline-block rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Ανανέωση
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
      <h1 className="text-xl font-semibold text-slate-900">Κάτι πήγε στραβά</h1>
      <p className="mt-2 max-w-md text-sm text-slate-500">
        Παρουσιάστηκε ένα απρόσμενο σφάλμα. Δοκιμάστε ξανά — αν επιμείνει, στείλτε μας τις
        λεπτομέρειες παρακάτω.
      </p>
      <div className="mt-6 flex gap-2">
        <button
          onClick={() => reset()}
          className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Δοκιμή ξανά
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          {open ? "Απόκρυψη" : "Λεπτομέρειες"}
        </button>
      </div>
      {open && (
        <div className="mt-4 w-full max-w-xl">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-3 text-left text-xs text-slate-600">
            {details || "—"}
          </pre>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(details).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }).catch(() => undefined);
            }}
            className="mt-2 text-xs font-medium text-brand-700 hover:underline"
          >
            {copied ? "Αντιγράφηκε" : "Αντιγραφή"}
          </button>
        </div>
      )}
    </div>
  );
}
