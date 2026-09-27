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
