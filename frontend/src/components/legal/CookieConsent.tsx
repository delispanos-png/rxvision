"use client";

// Site-wide cookie-consent banner. RxVision currently sets only strictly-necessary cookies
// (session/auth) which do not require consent; this banner provides transparency and a
// stored choice so any future analytics/marketing cookie stays gated behind "Αποδοχή όλων".
// Contains NO personal/patient data — purely a UI preference stored in localStorage.

import { useEffect, useState } from "react";
import Link from "next/link";

const KEY = "rxvision_cookie_consent";

export function CookieConsent() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      /* localStorage unavailable → don't block the page */
    }
  }, []);

  function choose(choice: "all" | "essential") {
    try {
      localStorage.setItem(KEY, JSON.stringify({ choice, at: new Date().toISOString() }));
    } catch {
      /* ignore */
    }
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-600">
          Χρησιμοποιούμε μόνο <strong>απαραίτητα cookies</strong> για τη λειτουργία της εφαρμογής.
          Με την «Αποδοχή όλων» επιτρέπετε τυχόν προαιρετικά cookies στο μέλλον. Δες την{" "}
          <Link href="/privacy" className="font-medium text-brand-600 underline">
            Πολιτική Απορρήτου
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => choose("essential")}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Μόνο απαραίτητα
          </button>
          <button
            onClick={() => choose("all")}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Αποδοχή όλων
          </button>
        </div>
      </div>
    </div>
  );
}
