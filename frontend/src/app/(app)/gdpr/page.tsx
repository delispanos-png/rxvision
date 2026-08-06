"use client";

import Link from "next/link";
import { ShieldCheck, Lock } from "lucide-react";
import { useT } from "@/store/prefStore";

/**
 * GDPR / Προστασία Δεδομένων (in-app κύκλωμα). Επιχειρησιακή αναφορά για το φαρμακείο ως ΥΠΕΥΘΥΝΟ
 * ΕΠΕΞΕΡΓΑΣΙΑΣ: ρόλοι, δεδομένα υγείας, ψευδωνυμοποίηση, απομόνωση, δικαιώματα ασφαλισμένων & υποχρεώσεις.
 */
export default function GdprPage() {
  const t = useT();
  return (
    <div className="w-full max-w-4xl">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-lg"><ShieldCheck className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Προστασία Δεδομένων (GDPR)", "Data Protection (GDPR)")}</h1>
          <p className="text-sm text-slate-500">{t("Πώς προστατεύονται τα δεδομένα υγείας & ποιες οι υποχρεώσεις του φαρμακείου.", "How health data is protected & the pharmacy's obligations.")}</p>
        </div>
      </div>

      {/* Κεντρικό μήνυμα — δεδομένα υγείας, ειδική κατηγορία, ψευδωνυμοποίηση */}
      <div className="mb-5 rounded-2xl border border-emerald-300 bg-emerald-50 p-5 dark:border-emerald-500/40 dark:bg-emerald-500/10">
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />
          <div className="text-sm text-emerald-900 dark:text-emerald-200">
            <div className="text-base font-bold">{t("Τα δεδομένα υγείας προστατεύονται με τον σχεδιασμό.", "Health data is protected by design.")}</div>
            <p className="mt-1 leading-relaxed">
              {t("Τα δεδομένα συνταγών/εκτελέσεων είναι ειδική κατηγορία (Άρθρο 9 ΓΚΠΔ). Ο ΑΜΚΑ ",
                 "Prescription/execution data is a special category (Art. 9 GDPR). The national ID (ΑΜΚΑ) is ")}
              <b>{t("ψευδωνυμοποιείται (HMAC-SHA256) πριν αποθηκευτεί", "pseudonymized (HMAC-SHA256) before storage")}</b>
              {t(", τα δεδομένα κάθε φαρμακείου είναι πλήρως ", ", each pharmacy's data is fully ")}
              <b>{t("απομονωμένα", "isolated")}</b>
              {t(" από κάθε άλλο, και δεν κοινοποιούνται σε μη εξουσιοδοτημένους.",
                 " from every other, and are not shared with unauthorized parties.")}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Section n="1" title={t("Ρόλοι — ποιος είναι υπεύθυνος", "Roles — who is responsible")}>
          {t("Το κάθε φαρμακείο είναι ο ΥΠΕΥΘΥΝΟΣ ΕΠΕΞΕΡΓΑΣΙΑΣ των δεδομένων των ασφαλισμένων/πελατών του. Η πλατφόρμα RxVision (CloudOn) ενεργεί ως ΕΚΤΕΛΩΝ ΤΗΝ ΕΠΕΞΕΡΓΑΣΙΑ, αποκλειστικά για λογαριασμό και βάσει των οδηγιών του φαρμακείου.",
             "Each pharmacy is the DATA CONTROLLER of its insured persons'/customers' data. The RxVision platform (CloudOn) acts as the DATA PROCESSOR, solely on behalf of and per the instructions of the pharmacy.")}
        </Section>

        <Section n="2" title={t("Ποια δεδομένα επεξεργαζόμαστε", "What data we process")}>
          {t("• Ψευδωνυμοποιημένη ταυτότητα ασφαλισμένου (ΑΜΚΑ με HMAC-SHA256). • Δεδομένα συνταγών/εκτελέσεων (φάρμακα, ICD-10, ποσά, ημερομηνίες) — δεδομένα υγείας. • Στοιχεία επικοινωνίας που καταχωρεί το φαρμακείο. • Συγκαταθέσεις επικοινωνίας & αρχείο ενεργειών (audit).",
             "• Pseudonymized insured-person identity (ΑΜΚΑ via HMAC-SHA256). • Prescription/execution data (medicines, ICD-10, amounts, dates) — health data. • Contact details entered by the pharmacy. • Communication consents & audit log.")}
        </Section>

        <Section n="3" title={t("Ποιος βλέπει τα δεδομένα", "Who sees the data")}>
          {t("Πρόσβαση έχει μόνο εξουσιοδοτημένο προσωπικό του φαρμακείου, βάσει ρόλων & δικαιωμάτων (RBAC). Η απομόνωση ανά φαρμακείο επιβάλλεται εκ κατασκευής (tenant isolation) σε κάθε ερώτημα στη βάση.",
             "Only authorized pharmacy staff have access, based on roles & permissions (RBAC). Per-pharmacy isolation is enforced by construction (tenant isolation) on every database query.")}
        </Section>

        <Section n="4" title={t("Σκοποί & νομική βάση", "Purposes & legal basis")}>
          {t("Στατιστική ανάλυση & νόμιμη τήρηση φαρμακευτικών αρχείων. Νομική βάση: Άρθρο 6 ΓΚΠΔ (νομική υποχρέωση / έννομο συμφέρον / συγκατάθεση για επικοινωνία) και Άρθρο 9.2 για τα δεδομένα υγείας.",
             "Statistical analysis & lawful keeping of pharmaceutical records. Legal basis: Art. 6 GDPR (legal obligation / legitimate interest / consent for communications) and Art. 9.2 for health data.")}
        </Section>

        <Section n="5" title={t("Αποδέκτες / Υπο-εκτελούντες", "Recipients / Sub-processors")}>
          {t("Φιλοξενία σε ευρωπαϊκά πιστοποιημένα Data Centers Tier IV (εντός ΕΕ), SMS/Viber/email (Apifon), CDN/DNS (Cloudflare), πληρωμές (Viva). Τα δεδομένα παραμένουν εντός ΕΕ· οι υπο-εκτελούντες δεσμεύονται με συμβάσεις επεξεργασίας.",
             "Hosting in European certified Tier IV data centers (within the EU), SMS/Viber/email (Apifon), CDN/DNS (Cloudflare), payments (Viva). Data stays within the EU; sub-processors are bound by processing agreements.")}
        </Section>

        <Section n="6" title={t("Χρόνος διατήρησης", "Retention")}>
          {t("Τα κλινικά αρχεία συνταγών διατηρούνται όσο απαιτεί η φαρμακευτική/φορολογική νομοθεσία και το ρυθμιζόμενο κυλιόμενο παράθυρο διατήρησης του φαρμακείου. Στη διαγραφή αφαιρούνται τα στοιχεία ταυτοποίησης και διατηρείται μόνο το ψευδωνυμοποιημένο, νομικά απαιτούμενο αρχείο.",
             "Clinical prescription records are kept for as long as pharmaceutical/tax law and the pharmacy's configured rolling retention window require. On deletion, identifying details are removed and only the pseudonymized, legally required record is retained.")}
        </Section>

        <Section n="7" title={t("Αποχώρηση πελάτη — παράδοση & διαγραφή δεδομένων", "Customer exit — data handover & deletion")}>
          {t("Με τη λήξη ή τη διακοπή της συνδρομής, το φαρμακείο δικαιούται να λάβει ΕΞΑΓΩΓΗ όλων των δεδομένων του σε δομημένη, μηχαναγνώσιμη μορφή (αρχεία CSV/JSON: εκτελέσεις συνταγών, ασφαλισμένοι/πελάτες, παραστατικά, ρυθμίσεις) — και προαιρετικά συνοδευτικές αναφορές σε PDF. Η εξαγωγή διατίθεται κατόπιν αιτήματος πριν ή αμέσως μετά την αποχώρηση.\n\nΜετά την παράδοση, τα δεδομένα του φαρμακείου ΔΙΑΓΡΑΦΟΝΤΑΙ οριστικά από τα ενεργά μας συστήματα εντός 30 ημερών από το αίτημα (ή από τη λήξη της περιόδου χάριτος). Τυχόν κρυπτογραφημένα αντίγραφα ασφαλείας λήγουν και διαγράφονται στον κανονικό τους κύκλο (έως 30 ημέρες). Διατηρείται ΜΟΝΟ το ελάχιστο ψευδωνυμοποιημένο αρχείο που επιβάλλει ο νόμος (π.χ. παραστατικά για φορολογικούς λόγους), χωρίς στοιχεία ταυτοποίησης ασφαλισμένων.",
             "On expiry or termination of the subscription, the pharmacy is entitled to an EXPORT of all its data in a structured, machine-readable format (CSV/JSON files: prescription executions, insured persons/customers, invoices, settings) — and optionally accompanying PDF reports. The export is provided upon request, before or immediately after departure.\n\nAfter handover, the pharmacy's data is permanently DELETED from our active systems within 30 days of the request (or of the end of the grace period). Any encrypted backups expire and are deleted in their normal rotation cycle (up to 30 days). Only the minimum pseudonymized record required by law is retained (e.g. invoices for tax purposes), with no insured-person identifying details.")}
        </Section>

        <Section n="8" title={t("Δικαιώματα ασφαλισμένων & υποχρεώσεις φαρμακείου", "Insured-person rights & pharmacy obligations")}>
          {t("Οι ασφαλισμένοι έχουν δικαίωμα πρόσβασης, διόρθωσης, διαγραφής, περιορισμού, φορητότητας, εναντίωσης & ανάκλησης συγκατάθεσης. Ως Υπεύθυνος Επεξεργασίας, το φαρμακείο οφείλει να ανταποκρίνεται στα αιτήματα αυτά — το RxVision παρέχει εργαλεία εξαγωγής, διόρθωσης & διαγραφής δεδομένων. Οι ασφαλισμένοι μπορούν επίσης να απευθυνθούν στην Αρχή Προστασίας Δεδομένων (ΑΠΔΠΧ).",
             "Insured persons have the right of access, rectification, erasure, restriction, portability, objection & withdrawal of consent. As Data Controller, the pharmacy must respond to such requests — RxVision provides data export, rectification & deletion tools. Insured persons may also contact the Data Protection Authority.")}
        </Section>

        <Section n="9" title={t("Ασφάλεια", "Security")}>
          {t("Ψευδωνυμοποίηση, κρυπτογράφηση επικοινωνιών (TLS), έλεγχος πρόσβασης βάσει ρόλων, απομόνωση ανά φαρμακείο, διαχείριση μυστικών σε ασφαλές θησαυροφυλάκιο (Vault) και πλήρες αρχείο ενεργειών (audit).",
             "Pseudonymization, encrypted communications (TLS), role-based access control, per-pharmacy isolation, secrets management in a secure vault, and a full audit log.")}
        </Section>

        <Section n="10" title={t("Παραβιάσεις δεδομένων", "Data breaches")}>
          {t("Σε περίπτωση παραβίασης, το RxVision (Εκτελών) ενημερώνει χωρίς καθυστέρηση το φαρμακείο (Υπεύθυνο), το οποίο φέρει την υποχρέωση γνωστοποίησης στην ΑΠΔΠΧ εντός 72 ωρών όπου απαιτείται.",
             "In case of a breach, RxVision (Processor) notifies the pharmacy (Controller) without undue delay; the pharmacy bears the obligation to notify the Authority within 72 hours where required.")}
        </Section>
      </div>

      <p className="mt-6 text-sm text-slate-500">
        {t("Δείτε επίσης τους ", "See also the ")}
        <Link href="/terms-of-use" className="font-semibold text-brand-600 underline">{t("Όρους Χρήσης", "Terms of Use")}</Link>.
      </p>
    </div>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rx-card p-4">
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{n}. {title}</div>
      <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">{children}</p>
    </div>
  );
}
