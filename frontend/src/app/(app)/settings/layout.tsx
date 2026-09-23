"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAddonState } from "@/components/layout/AddonSection";
import { useT } from "@/store/prefStore";

/* `module` = η καρτέλα ανήκει σε ΠΡΟΑΙΡΕΤΙΚΟ πρόσθετο.
   Χωρίς αυτό, οι καρτέλες των Ρυθμίσεων φαίνονταν σε ΟΛΟΥΣ και το λουκέτο το ανακάλυπτε ο
   πελάτης αφού πατούσε — ενώ τα κυκλώματα του κύριου μενού κρύβονται σωστά. Ακολουθεί τον ίδιο
   κανόνα: ενεργό ή αγοράσιμο → φαίνεται· μη προσφερόμενο → εξαφανίζεται. */
const TABS: { href: string; el: string; en: string; module?: string }[] = [
  { href: "/settings/users", el: "Χρήστες & Ρόλοι", en: "Users & Roles" },
  { href: "/settings/modules", el: "Modules / Πλάνο", en: "Modules / Plan" },
  { href: "/settings/roles", el: "Ρόλοι & Δικαιώματα", en: "Roles & Permissions" },
  { href: "/settings/menus", el: "Μενού ανά ρόλο", en: "Menu per role" },
  { href: "/settings/ingestion", el: "Διασύνδεση ΗΔΥΚΑ", en: "ΗΔΥΚΑ Connection" },
  { href: "/settings/closing", el: "Κλείσιμο Μήνα", en: "Month Closing" },
  { href: "/settings/catalog", el: "Ενημέρωση καταλόγου", en: "Catalog updates", module: "catalog_seed" },
  { href: "/settings/availability", el: "Ωράριο & Διαθεσιμότητα", en: "Hours & Availability" },
  { href: "/settings/communications", el: "Επικοινωνία", en: "Communications" },
  { href: "/settings/billing", el: "Χρέωση", en: "Billing" },
  { href: "/settings/gdpr", el: "GDPR / Απόρρητο", en: "GDPR / Privacy" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const tr = useT();
  const catalog = useAddonState("catalog_seed");
  const visible = (m?: string) => !m || ["on", "offer"].includes(catalog.state);
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-slate-900 dark:text-slate-100">{tr("Ρυθμίσεις", "Settings")}</h1>
      <nav className="mb-6 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200 dark:border-slate-700">
        {TABS.filter((tab) => visible(tab.module)).map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${
                active
                  ? "border-brand-600 font-medium text-brand-700 dark:text-brand-400"
                  : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {tr(tab.el, tab.en)}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
