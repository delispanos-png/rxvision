"use client";

import Link from "next/link";
import { useT } from "@/store/prefStore";

/**
 * Διακριτική παραπομπή στους Όρους Χρήσης — εμφανίζεται κάτω από κάθε οθόνη ελέγχου συνταγών/κλεισίματος.
 * (Πλήρες κείμενο αποποίησης ευθύνης → σελίδα «Όροι Χρήσης».)
 */
export function ReimbursementDisclaimer() {
  const t = useT();
  return (
    <div className="mt-8 text-center text-[11px] text-slate-400">
      {t("Βοηθητικό εργαλείο — η τελική ευθύνη ελέγχου & η απόφαση κατάθεσης ανήκουν στον φαρμακοποιό.",
         "Assistive tool — final responsibility for checks & submission rests with the pharmacist.")}{" "}
      <Link href="/terms-of-use" className="font-semibold text-slate-500 underline hover:text-slate-700 dark:hover:text-slate-300">
        {t("Όροι Χρήσης →", "Terms of Use →")}
      </Link>
    </div>
  );
}
