"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Καθολική σελίδα επιστροφής από Viva (success/fail URL της πηγής πληρωμών).
 * - Εγγραφή «πληρωμή-πρώτα» (localStorage.signup_pending): επιτυχία → /register?pending=<id>
 *   (βήμα κωδικού)· αποτυχία → /register (retry).
 * - Πληρωμή συνδεδεμένου χρήστη (top-up/συνδρομή): πίσω στην εφαρμογή.
 */
export default function PayReturn() {
  const router = useRouter();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const failed = new URLSearchParams(window.location.search).get("failed");
    const pend = window.localStorage.getItem("signup_pending");
    if (pend) {
      if (failed) { window.localStorage.removeItem("signup_pending"); router.replace("/register"); }
      else router.replace(`/register?pending=${encodeURIComponent(pend)}`);
      return;
    }
    router.replace(failed ? "/settings/billing?pay=fail" : "/settings/billing?pay=ok");
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 text-center">
      <div className="space-y-3">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand-600" />
        <p className="text-sm text-slate-500">Επιστροφή από την πληρωμή…</p>
      </div>
    </div>
  );
}
