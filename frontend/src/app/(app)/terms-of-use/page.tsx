"use client";

import { ScrollText, ShieldAlert, Sparkles } from "lucide-react";
import { useT } from "@/store/prefStore";

/**
 * Όροι Χρήσης (in-app κύκλωμα). Τονίζει ότι το RxVision είναι ΒΟΗΘΗΤΙΚΟ εργαλείο και ότι η ευθύνη
 * χρήσης & οι τελικές αποφάσεις — ιδίως η κατάθεση/υποβολή στα ταμεία — ανήκουν στον φαρμακοποιό.
 */
export default function TermsOfUsePage() {
  const t = useT();
  return (
    <div className="w-full max-w-4xl">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg"><ScrollText className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Όροι Χρήσης", "Terms of Use")}</h1>
          <p className="text-sm text-slate-500">{t("Φύση του εργαλείου, ευθύνες & όρια χρήσης του RxVision.", "The tool's nature, responsibilities & limits of use.")}</p>
        </div>
      </div>

      {/* Κεντρικό μήνυμα — ΒΟΗΘΗΤΙΚΟ εργαλείο & ευθύνη φαρμακοποιού */}
      <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-500/40 dark:bg-amber-500/10">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <div className="text-base font-bold">{t("Το RxVision είναι βοηθητικό εργαλείο.", "RxVision is an assistive tool.")}</div>
            <p className="mt-1 leading-relaxed">
              {t("Παρέχει υποστηρικτικούς ελέγχους, ενδείξεις, στατιστικά και υπολογισμούς που διευκολύνουν τη δουλειά του φαρμακείου. ",
                 "It provides supportive checks, indications, statistics and calculations that make the pharmacy's work easier. ")}
              <b>{t("Δεν υποκαθιστά την κρίση, τον έλεγχο και τις αποφάσεις του φαρμακοποιού.",
                    "It does not replace the pharmacist's judgment, review and decisions.")}</b>
              {" "}
              {t("Η ευθύνη ορθής χρήσης του εργαλείου και κάθε τελική απόφαση ανήκουν αποκλειστικά στον φαρμακοποιό/υπεύθυνο του φαρμακείου.",
                 "Responsibility for the correct use of the tool and every final decision rest solely with the pharmacist / person in charge of the pharmacy.")}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Section n="1" title={t("Φύση της υπηρεσίας", "Nature of the service")}>
          {t("Το RxVision είναι λογισμικό υποστήριξης λειτουργίας φαρμακείου (στατιστική ανάλυση εκτελέσεων, έλεγχοι, προβλέψεις, οργάνωση). Είναι εργαλείο υποβοήθησης και δεν αποτελεί ιατρική, φαρμακευτική, λογιστική ή νομική συμβουλή.",
             "RxVision is pharmacy-operations support software (statistical analysis of executions, checks, forecasts, organization). It is an assistive tool and does not constitute medical, pharmaceutical, accounting or legal advice.")}
        </Section>

        <Section n="2" title={t("Ευθύνη του φαρμακοποιού", "Pharmacist's responsibility")}>
          {t("Ο φαρμακοποιός/υπεύθυνος του φαρμακείου παραμένει ο μόνος υπεύθυνος για τον έλεγχο των συνταγών, την ορθότητα των στοιχείων και κάθε ενέργεια ή απόφαση. Οι ενδείξεις του RxVision είναι υποστηρικτικές και πρέπει πάντα να επαληθεύονται από τον χρήστη πριν από οποιαδήποτε ενέργεια.",
             "The pharmacist / person in charge remains solely responsible for checking prescriptions, the accuracy of data and every action or decision. RxVision's indications are supportive and must always be verified by the user before any action.")}
        </Section>

        {/* Έμφαση: έλεγχοι συνταγών & κλείσιμο μήνα — απόφαση κατάθεσης */}
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/40 dark:bg-emerald-500/10">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div className="text-sm text-emerald-900 dark:text-emerald-200">
              <div className="font-bold">{t("3. Έλεγχοι συνταγών & Κλείσιμο μήνα (κατάθεση στα ταμεία)", "3. Prescription checks & Monthly closing (submission to funds)")}</div>
              <p className="mt-1 leading-relaxed">
                {t("Οι λειτουργίες ελέγχου συνταγών, ημερήσιου/barcode ελέγχου, κλεισίματος μήνα, πρόβλεψης και υποβολής είναι ",
                   "The prescription-check, daily/barcode-check, monthly-closing, forecast and submission features are ")}
                <b>{t("αποκλειστικά υποβοηθητικές", "strictly assistive")}</b>
                {t(". Η ", ". The ")}
                <b>{t("τελική απόφαση για την κατάθεση/υποβολή των συνταγών στα ταμεία (ΕΟΠΥΥ κ.λπ.) ανήκει αποκλειστικά στον φαρμακοποιό",
                      "final decision to submit prescriptions to the funds (ΕΟΠΥΥ etc.) rests solely with the pharmacist")}</b>
                {t(", ο οποίος οφείλει να ελέγχει και να επιβεβαιώνει τα δεδομένα πριν από κάθε υποβολή. Το RxVision δεν φέρει ευθύνη για περικοπές, απορρίψεις ή διαφορές που προκύπτουν από την υποβολή.",
                   ", who must review and confirm the data before each submission. RxVision bears no responsibility for cuts, rejections or discrepancies arising from the submission.")}
              </p>
            </div>
          </div>
        </div>

        {/* Έμφαση: PharmaCat & τεχνητή νοημοσύνη — δεν υποκαθιστά φαρμακοποιό/ιατρό */}
        <div className="rounded-2xl border border-violet-300 bg-violet-50 p-4 dark:border-violet-500/40 dark:bg-violet-500/10">
          <div className="flex items-start gap-2.5">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-violet-600" />
            <div className="text-sm text-violet-900 dark:text-violet-200">
              <div className="font-bold">{t("4. PharmaCat & εργαλεία τεχνητής νοημοσύνης (AI)", "4. PharmaCat & artificial-intelligence (AI) tools")}</div>
              <p className="mt-1 leading-relaxed">
                {t("Το PharmaCat και κάθε λειτουργία τεχνητής νοημοσύνης (AI) του RxVision είναι ",
                   "PharmaCat and every artificial-intelligence (AI) feature of RxVision are ")}
                <b>{t("υποστηρικτικά εργαλεία", "supportive tools")}</b>
                {t(" που παράγουν πληροφορίες & συμβουλές αυτόματα και ενδέχεται να περιέχουν ανακρίβειες. ",
                   " that generate information & suggestions automatically and may contain inaccuracies. ")}
                <b>{t("Δεν αποτελούν ιατρική ή φαρμακευτική συμβουλή και δεν υποκαθιστούν τη συμβουλή και την κρίση του φαρμακοποιού και του ιατρού.",
                      "They are not medical or pharmaceutical advice and do not replace the advice and judgment of the pharmacist and the doctor.")}</b>
                {" "}
                {t("Κάθε πληροφορία πρέπει να επαληθεύεται από τον αρμόδιο επαγγελματία υγείας πριν χρησιμοποιηθεί.",
                   "All information must be verified by the responsible health professional before use.")}
              </p>
            </div>
          </div>
        </div>

        <Section n="5" title={t("Ακρίβεια δεδομένων", "Data accuracy")}>
          {t("Τα δεδομένα αντλούνται από εξωτερικές πηγές (π.χ. ΗΔΥΚΑ) και ενδέχεται να περιέχουν ελλείψεις, καθυστερήσεις ή σφάλματα εκτός του ελέγχου μας. Οι υπολογισμοί (π.χ. εκτιμήσεις κόστους/κέρδους) είναι ενδεικτικοί.",
             "Data is sourced from external systems (e.g. ΗΔΥΚΑ) and may contain gaps, delays or errors beyond our control. Calculations (e.g. cost/profit estimates) are indicative.")}
        </Section>

        <Section n="6" title={t("Προστασία δεδομένων (GDPR)", "Data protection (GDPR)")}>
          {t("Τα δεδομένα υγείας/PII υφίστανται επεξεργασία σύμφωνα με τον GDPR. Το κάθε φαρμακείο είναι ο υπεύθυνος επεξεργασίας των δικών του δεδομένων. Τα αναγνωριστικά ασθενών ψευδωνυμοποιούνται.",
             "Health/PII data is processed in accordance with the GDPR. Each pharmacy is the data controller of its own data. Patient identifiers are pseudonymized.")}
        </Section>

        <Section n="7" title={t("Περιορισμός ευθύνης", "Limitation of liability")}>
          {t("Το RxVision παρέχεται «ως έχει». Στον μέγιστο βαθμό που επιτρέπει ο νόμος, δεν φέρουμε ευθύνη για αποφάσεις, ενέργειες ή ζημίες που προκύπτουν από τη χρήση ή την εμπιστοσύνη στις ενδείξεις του εργαλείου.",
             "RxVision is provided “as is”. To the maximum extent permitted by law, we are not liable for decisions, actions or damages arising from use of, or reliance on, the tool's indications.")}
        </Section>

        <Section n="8" title={t("Αποδοχή", "Acceptance")}>
          {t("Με τη δημιουργία συνδρομής και τη χρήση του RxVision, το φαρμακείο δηλώνει ότι έχει διαβάσει, κατανοήσει και αποδέχεται τους παρόντες Όρους Χρήσης.",
             "By creating a subscription and using RxVision, the pharmacy declares that it has read, understood and accepts these Terms of Use.")}
        </Section>
      </div>
    </div>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rx-card p-4">
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{n}. {title}</div>
      <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{children}</p>
    </div>
  );
}
