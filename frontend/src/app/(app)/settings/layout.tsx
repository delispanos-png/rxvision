"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/users", label: "Χρήστες & Ρόλοι" },
  { href: "/settings/modules", label: "Modules / Πλάνο" },
  { href: "/settings/ingestion", label: "Διασύνδεση ΗΔΙΚΑ" },
  { href: "/settings/billing", label: "Χρέωση" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-slate-900">Ρυθμίσεις</h1>
      <nav className="mb-6 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200">
        {TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${
                active
                  ? "border-brand-600 font-medium text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
