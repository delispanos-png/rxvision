"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, CalendarRange } from "lucide-react";
import { useT } from "@/store/prefStore";
import { useReimbPeriod } from "@/store/reimbStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

function curMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }

const TABS = [
  { href: "/reimbursement", el: "Executive", en: "Executive" },
  { href: "/reimbursement/closing", el: "Κλείσιμο Μήνα", en: "Monthly Closing" },
  { href: "/reimbursement/forecast", el: "Πρόβλεψη", en: "Forecast" },
  { href: "/reimbursement/risk", el: "Ρίσκο & Περικοπές", en: "Risk & Cuts" },
  { href: "/reimbursement/submission", el: "Υποβολή", en: "Submission" },
  { href: "/reimbursement/reconciliation", el: "Συμφωνία", en: "Reconciliation" },
  { href: "/reimbursement/optical", el: "Optical Audit", en: "Optical Audit" },
];

export default function ReimbursementLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  const { period, setPeriod } = useReimbPeriod();
  return (
    <ModuleGuard module="monthly_closing">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-lg"><ShieldCheck className="h-6 w-6" /></span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Reimbursement Intelligence</h1>
            <p className="text-sm text-slate-500">{t("Ψηφιακός ελεγκτής ΕΟΠΥΥ — έλεγχος, πρόβλεψη & μείωση περικοπών πριν την υποβολή", "Digital ΕΟΠΥΥ auditor — control, forecast & cut-prevention before submission")}</p>
          </div>
        </div>
        <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
          <CalendarRange className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-medium text-slate-500">{t("Μήνας", "Month")}</span>
          <input type="month" value={period} max={curMonth()} onChange={(e) => setPeriod(e.target.value)} className="bg-transparent text-sm font-semibold text-slate-800 focus:outline-none dark:text-slate-100" />
        </label>
      </div>
      <nav className="mb-6 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200 dark:border-slate-700">
        {TABS.map((tab) => {
          const active = tab.href === "/reimbursement" ? pathname === tab.href : pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${active ? "border-emerald-600 font-semibold text-emerald-700 dark:text-emerald-400" : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"}`}>
              {t(tab.el, tab.en)}
            </Link>
          );
        })}
      </nav>
      {children}
    </ModuleGuard>
  );
}
