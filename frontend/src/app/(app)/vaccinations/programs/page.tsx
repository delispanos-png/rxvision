"use client";

/* Λίστα περιοδικών εμβολιασμών.

   Το σώμα της οθόνης ζει σε component (ProgramPatients) και ΟΧΙ εδώ: αρχείο `page.tsx` στο
   Next.js επιτρέπεται να εξάγει ΜΟΝΟ τη σελίδα — ένα named export σπάει το build με
   «does not match the required types of a Next.js Page». Το ίδιο component το ξαναχρησιμοποιεί
   αυτούσιο το κύκλωμα «Θεραπείες με Επανάληψη». */

import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { ProgramPatients } from "@/components/vaccinations/ProgramPatients";

export default function PeriodicVaccinationListPage() {
  return (
    <ModuleGuard module="vaccination_programs">
      <ProgramPatients kind="vaccine" />
    </ModuleGuard>
  );
}
