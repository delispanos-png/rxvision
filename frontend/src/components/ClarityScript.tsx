"use client";

import { useEffect } from "react";

import { API_BASE } from "@/lib/apiClient";

/**
 * Microsoft Clarity — φορτώνεται ΜΟΝΟ αν ο ιδιοκτήτης έχει ορίσει project id στο adminpanel.
 *
 * ΓΙΑΤΙ ΔΥΝΑΜΙΚΑ ΚΑΙ ΟΧΙ ΣΤΟ BUILD: ο ιδιοκτήτης πρέπει να μπορεί να το ανάψει, να το σβήσει ή
 * να αλλάξει έργο ΧΩΡΙΣ deploy. Ένα `NEXT_PUBLIC_` θα απαιτούσε νέα εικόνα κάθε φορά.
 *
 * ⚠️ ΔΕΔΟΜΕΝΑ ΥΓΕΙΑΣ: το Clarity καταγράφει ΟΘΟΝΕΣ. Και οι δύο επιφάνειες δείχνουν ονόματα
 * ασθενών, ΑΜΚΑ και φάρμακα. Η προστασία ΔΕΝ γίνεται από εδώ — ρυθμίζεται στον πίνακα του
 * Clarity ως **Masking: Strict**. Το adminpanel το λέει ρητά δίπλα στο πεδίο.
 */
export function ClarityScript({ surface }: { surface: "app" | "portal" }) {
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/config/clarity/${surface}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { id?: string } | null) => {
        const id = (d?.id || "").trim();
        // δεύτερος έλεγχος: ποτέ δεν εμπιστευόμαστε τιμή που θα γίνει μέρος URL
        if (cancelled || !id || !/^[A-Za-z0-9-]{1,40}$/.test(id)) return;
        if (document.getElementById("ms-clarity")) return;     // idempotent σε navigation
        // Ο «σταθμός αναμονής» του επίσημου snippet της Microsoft: κλήσεις `clarity(...)` πριν
        // φορτώσει το script μπαίνουν σε ουρά αντί να χαθούν.
        const w = window as unknown as { clarity?: ((...a: unknown[]) => void) & { q?: unknown[] } };
        if (!w.clarity) {
          const f = ((...a: unknown[]) => { (f.q = f.q || []).push(a); }) as ((...a: unknown[]) => void) & { q?: unknown[] };
          w.clarity = f;
        }
        // ⚠ Η CSP (middleware.ts) πρέπει να επιτρέπει *.clarity.ms — αλλιώς ο browser το κόβει
        // ΣΙΩΠΗΛΑ (έτσι έμεινε νεκρό μέχρι 28/09/2026: 140 αναφορές CSP, μηδέν επισκέψεις).
        const s = document.createElement("script");
        s.id = "ms-clarity";
        s.async = true;
        s.src = `https://www.clarity.ms/tag/${id}`;
        document.head.appendChild(s);
      })
      .catch(() => { /* η παρακολούθηση ΠΟΤΕ δεν χαλάει τη σελίδα */ });
    return () => { cancelled = true; };
  }, [surface]);
  return null;
}
