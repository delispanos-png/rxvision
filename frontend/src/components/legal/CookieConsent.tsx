"use client";

// Site-wide cookie-consent banner. RxVision currently sets only strictly-necessary cookies
// (session/auth) which do not require consent; this banner provides transparency and a
// stored choice so any future analytics/marketing cookie stays gated behind "Αποδοχή όλων".
// Contains NO personal/patient data — purely a UI preference stored in localStorage.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/store/prefStore";

const KEY = "rxvision_cookie_consent";

export function CookieConsent() {
  const t = useT();
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
          {t("Χρησιμοποιούμε μόνο", "We use only")}{" "}
          <strong>{t("απαραίτητα cookies", "essential cookies")}</strong>{" "}
          {t("για τη λειτουργία της εφαρμογής.", "for the app to work.")}{" "}
          {t(
            "Με την «Αποδοχή όλων» επιτρέπετε τυχόν προαιρετικά cookies στο μέλλον. Δες την",
            "By choosing “Accept all” you allow any optional cookies in the future. See the",
          )}{" "}
          <Link href="/privacy" className="font-medium text-brand-600 underline">
            {t("Πολιτική Απορρήτου", "Privacy Policy")}
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => choose("essential")}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("Μόνο απαραίτητα", "Essential only")}
          </button>
          <button
            onClick={() => choose("all")}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t("Αποδοχή όλων", "Accept all")}
          </button>
        </div>
      </div>
    </div>
  );
}
