"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Syringe, Lock } from "lucide-react";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useAddonState } from "@/components/layout/AddonSection";

// `module` = προαιρετικό add-on στο οποίο ανήκει η καρτέλα. Χωρίς αυτό, η καρτέλα φαινόταν
// σε όλους και όποιος την πατούσε έτρωγε οθόνη «κλειδωμένο».
const TABS: { href: string; el: string; en: string; module?: string }[] = [
  { href: "/vaccinations", el: "Επισκόπηση", en: "Overview" },
  { href: "/vaccinations/targets", el: "Λίστα στόχων", en: "Worklist" },
  { href: "/vaccinations/recall", el: "Επανάκληση", en: "Recall" },
  { href: "/vaccinations/programs", el: "Λίστα περιοδικών εμβολιασμών", en: "Periodic vaccinations",
    module: "vaccination_programs" },
  { href: "/vaccinations/registry", el: "Μητρώο", en: "Registry" },
  { href: "/vaccinations/settings", el: "Ρυθμίσεις", en: "Settings" },
];

export default function VaccinationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  // Ίδιος κανόνας με το μενού: ενεργό → κανονικά· αγοράσιμο → γκρι με λουκέτο· αλλιώς εξαφανίζεται.
  const periodic = useAddonState("vaccination_programs");
  return (
    <ModuleGuard module="prescription_analytics">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-sky-600 to-cyan-600 text-white shadow-lg"><Syringe className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Κύκλωμα Εμβολιασμών", "Vaccination Circuit")}</h1>
          <p className="text-sm text-slate-500">{t("Παρακολούθηση & πρόσκληση πελατών για εμβολιασμό — προτεραιότητα σε υψηλού κινδύνου και μεγαλύτερες ηλικίες.", "Track & invite customers for vaccination — priority to high-risk and older ages.")}</p>
        </div>
      </div>
      <nav className="mb-6 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200 dark:border-slate-700">
        {TABS.map((tab) => {
          const st = tab.module === "vaccination_programs" ? periodic.state : "on";
          if (st === "hide" || st === "unknown") return null;
          const active = tab.href === "/vaccinations" ? pathname === tab.href : pathname.startsWith(tab.href);
          if (st === "offer") {
            return (
              <Link key={tab.href} href="/settings/modules" title={t("Έξτρα δυνατότητα — δεν περιλαμβάνεται στο πακέτο σου", "Optional add-on — not in your plan")}
                className="-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-4 py-2 text-sm text-slate-300 hover:text-slate-400 dark:text-slate-600 dark:hover:text-slate-500">
                <Lock className="h-3.5 w-3.5" />{t(tab.el, tab.en)}
              </Link>
            );
          }
          return (
            <Link key={tab.href} href={tab.href}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${active ? "border-sky-600 font-semibold text-sky-700 dark:text-sky-400" : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"}`}>
              {t(tab.el, tab.en)}
            </Link>
          );
        })}
      </nav>
      {children}
    </ModuleGuard>
  );
}
