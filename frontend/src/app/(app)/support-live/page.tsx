"use client";

import { useState } from "react";
import { Headset } from "lucide-react";

import { PanelCard } from "@/components/ui/Card";
import { toastError } from "@/store/toastStore";
import { useT } from "@/store/prefStore";
import { useSupportLive } from "@/store/supportLiveStore";

export default function SupportLivePage() {
  const t = useT();
  const { status, code, start, stop } = useSupportLive();
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setBusy(true);
    try {
      await start();
    } catch {
      toastError(t("Δεν ξεκίνησε η υποστήριξη. Δοκιμάστε ξανά.", "Support could not start. Please try again."));
    }
    setBusy(false);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-slate-900">{t("Ζωντανή υποστήριξη", "Live support")}</h1>
      <p className="mb-5 text-sm text-slate-500">
        {t("Μιλάτε στο τηλέφωνο με την υποστήριξή μας; Δείξτε της την οθόνη σας, για να δει ακριβώς αυτό που βλέπετε.",
           "On the phone with our support? Show them your screen so they see exactly what you see.")}
      </p>
      <PanelCard title={t("Κοινή χρήση οθόνης", "Screen sharing")}>
        {status === "idle" && (
          <div className="space-y-4 text-sm text-slate-600 dark:text-slate-300">
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("Βλέπει μόνο το RxVision, όχι άλλα προγράμματα του υπολογιστή σας.", "They see only RxVision, not other programs on your computer.")}</li>
              <li>{t("Δεν μπορεί να πατήσει ή να αλλάξει κάτι. Μπορεί μόνο να σας δείξει ένα σημείο στην οθόνη.", "They cannot click or change anything, only point at a spot on your screen.")}</li>
              <li>{t("Δεν γίνεται καταγραφή και οι κωδικοί δεν φαίνονται.", "Nothing is recorded and passwords are not shown.")}</li>
              <li>{t("Όσο σας βλέπει, εμφανίζεται πάνω στην οθόνη ποιος είναι και σταματάτε όποτε θέλετε με ένα πάτημα.", "While connected, the top of your screen shows who it is and you can stop at any time with one click.")}</li>
            </ul>
            <button type="button" onClick={begin} disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              <Headset className="h-4 w-4" />
              {t("Έναρξη", "Start")}
            </button>
          </div>
        )}
        {status === "waiting" && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-slate-600 dark:text-slate-300">{t("Πείτε αυτόν τον κωδικό στην υποστήριξη:", "Give this code to support:")}</p>
            <p className="text-4xl font-bold tracking-[0.3em] text-brand-700 dark:text-brand-300">{code ?? "······"}</p>
            <p className="text-xs text-slate-400">{t("Ισχύει για 10 λεπτά και για μία σύνδεση.", "Valid for 10 minutes and one connection.")}</p>
            <button type="button" onClick={() => stop()} className="text-sm font-medium text-slate-500 underline">{t("Ακύρωση", "Cancel")}</button>
          </div>
        )}
        {status === "live" && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("Η υποστήριξη βλέπει την οθόνη σας. Μπορείτε να πάτε σε όποια οθόνη θέλετε· την τερματίζετε από την πράσινη μπάρα.",
               "Support can see your screen. Go to any page you need; end it from the green bar.")}
          </p>
        )}
      </PanelCard>
    </div>
  );
}
