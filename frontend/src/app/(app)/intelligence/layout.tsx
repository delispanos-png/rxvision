"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brain } from "lucide-react";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

const TABS = [
  { href: "/intelligence", el: "Dashboard", en: "Dashboard" },
  { href: "/intelligence/today", el: "Σήμερα", en: "Today" },
  { href: "/intelligence/profile", el: "Εικόνα Πελάτη", en: "Patient 360" },
  { href: "/intelligence/patients", el: "Ασθενείς", en: "Patients" },
  { href: "/intelligence/compliance", el: "Συμμόρφωση", en: "Compliance" },
  { href: "/intelligence/recall", el: "Recall", en: "Recall" },
  { href: "/intelligence/winback", el: "Win-Back", en: "Win-Back" },
  { href: "/intelligence/returns", el: "Επιστροφές", en: "Returns" },
  { href: "/intelligence/vip", el: "VIP", en: "VIP" },
  { href: "/intelligence/risk", el: "Ρίσκο", en: "Risk" },
  { href: "/intelligence/segments", el: "Segments", en: "Segments" },
];

export default function IntelligenceLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-violet-600 text-white shadow-lg"><Brain className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Patient Intelligence</h1>
          <p className="text-sm text-slate-500">{t("Από δεδομένα συνταγών → επιχειρηματική γνώση & ενέργειες ανάπτυξης", "From prescription data → business intelligence & growth actions")}</p>
        </div>
      </div>
      <nav className="mb-6 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200 dark:border-slate-700">
        {TABS.map((tab) => {
          const active = tab.href === "/intelligence" ? pathname === tab.href : pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${active ? "border-brand-600 font-semibold text-brand-700 dark:text-brand-400" : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"}`}>
              {t(tab.el, tab.en)}
            </Link>
          );
        })}
      </nav>
      {children}
    </ModuleGuard>
  );
}
