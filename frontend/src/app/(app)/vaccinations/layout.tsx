"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Syringe } from "lucide-react";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

const TABS = [
  { href: "/vaccinations", el: "Επισκόπηση", en: "Overview" },
  { href: "/vaccinations/targets", el: "Λίστα στόχων", en: "Worklist" },
  { href: "/vaccinations/registry", el: "Μητρώο", en: "Registry" },
  { href: "/vaccinations/settings", el: "Ρυθμίσεις", en: "Settings" },
];

export default function VaccinationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();
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
          const active = tab.href === "/vaccinations" ? pathname === tab.href : pathname.startsWith(tab.href);
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
