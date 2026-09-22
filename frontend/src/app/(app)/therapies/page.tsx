"use client";

/* Θεραπείες με Επανάληψη — ΔΙΚΟ ΤΟΥΣ κύκλωμα.

   ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΟ ΚΑΙ ΟΧΙ ΚΑΡΤΕΛΑ ΣΤΟΥΣ ΕΜΒΟΛΙΑΣΜΟΥΣ: ο μηχανισμός είναι όντως ο ίδιος, αλλά η
   ΓΛΩΣΣΑ δεν είναι. Όποιος παρακολουθεί Prolia διάβαζε «πρόγραμμα εμβολιασμού», «ποια εμβόλια
   παρακολουθώ», «αναμνηστική» — και μετέφραζε στο μυαλό του σε κάθε πεδίο. Όταν χρειάζεται να
   αλλάξεις τόσες λέξεις για να χωρέσει κάτι, δεν χωράει.

   ΤΙ ΔΕΝ ΚΑΝΟΥΜΕ: αντίγραφο του κυκλώματος. Η οθόνη ασθενών και η φόρμα παραμέτρων είναι ΟΙ
   ΙΔΙΕΣ — απλώς τους λέμε ποιο είδος να δείξουν. Δύο αντίγραφα σημαίνει δύο σημεία διόρθωσης,
   και το ένα ξεχνιέται. */

import { RefreshCw } from "lucide-react";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { ProgramPatients } from "@/components/vaccinations/ProgramPatients";
import { VaccineProgramsConfig } from "@/components/vaccinations/VaccineProgramsConfig";
import { useT } from "@/store/prefStore";

export default function TherapiesPage() {
  const t = useT();
  return (
    <ModuleGuard module="therapy_programs">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-lg">
          <RefreshCw className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t("Θεραπείες με Επανάληψη", "Repeat Therapies")}
          </h1>
          <p className="text-sm text-slate-500">
            {t("Θεραπείες που επαναλαμβάνονται κάθε λίγους μήνες — ποιος έχει καθυστερήσει και πόσο.",
               "Therapies repeating every few months — who is overdue, and by how much.")}
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <ProgramPatients kind="therapy" />
        <VaccineProgramsConfig kind="therapy" />
      </div>
    </ModuleGuard>
  );
}
