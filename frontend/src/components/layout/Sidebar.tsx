"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNavStore } from "@/store/navStore";
import { usePref, useT } from "@/store/prefStore";
import { Logo } from "@/components/brand/Logo";
import {
  Activity, BarChart3, Boxes, CalendarClock, ClipboardCheck, LayoutDashboard,
  Mail, Salad, PackageSearch, Settings, Sparkles, Stethoscope, TrendingUp, Users,
  type LucideIcon,
} from "lucide-react";

type Item = { href: string; label: string; en: string; icon: LucideIcon };
type Group = { title: string; en: string; items: Item[] };

const GROUPS: Group[] = [
  { title: "Έξυπνοι Σύμβουλοι", en: "AI Advisors", items: [
    { href: "/advisor", label: "Σύμβουλος Επιχείρησης", en: "Business Advisor", icon: Sparkles },
    { href: "/order-advisor", label: "Σύμβουλος Παραγγελίας", en: "Order Advisor", icon: Sparkles },
    { href: "/nutrition", label: "Σύμβουλος Διατροφής", en: "Nutrition Advisor", icon: Salad },
  ] },
  { title: "Αναλυτικά", en: "Analytics", items: [
    { href: "/dashboard", label: "Πίνακας Ελέγχου", en: "Dashboard", icon: LayoutDashboard },
    { href: "/prescriptions", label: "Συνταγές", en: "Prescriptions", icon: BarChart3 },
    { href: "/doctors", label: "Ιατροί", en: "Doctors", icon: Stethoscope },
    { href: "/patients", label: "Ασφαλισμένοι", en: "Patients", icon: Users },
    { href: "/icd10", label: "ICD-10", en: "ICD-10", icon: Activity },
    { href: "/profitability", label: "Κερδοφορία", en: "Profitability", icon: TrendingUp },
  ] },
  { title: "Λειτουργίες", en: "Operations", items: [
    { href: "/future", label: "Μελλοντικές", en: "Upcoming", icon: CalendarClock },
    { href: "/orders", label: "Παραγγελίες", en: "Orders", icon: PackageSearch },
    { href: "/communications", label: "Επικοινωνία", en: "Communications", icon: Mail },
    { href: "/closing", label: "Κλείσιμο μήνα", en: "Month closing", icon: ClipboardCheck },
    { href: "/pharmacyone", label: "PharmacyOne", en: "PharmacyOne", icon: Boxes },
  ] },
  { title: "Σύστημα", en: "System", items: [
    { href: "/settings/users", label: "Ρυθμίσεις", en: "Settings", icon: Settings },
  ] },
];

export function Sidebar() {
  const pathname = usePathname();
  const { open, setOpen } = useNavStore();
  const { collapsed } = usePref();
  const t = useT();
  useEffect(() => { setOpen(false); }, [pathname, setOpen]);

  const hide = collapsed ? "md:hidden" : "";

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white transition-all duration-200 dark:border-slate-800 dark:bg-slate-900 md:static md:translate-x-0 ${collapsed ? "md:w-[72px]" : "md:w-64"} ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className={`flex h-16 items-center ${collapsed ? "md:justify-center md:px-0" : ""} px-5`}>
          <Logo markClassName="h-9 w-9" />
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className={`px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 ${hide}`}>
                {t(g.title, g.en)}
              </div>
              <div className="space-y-1">
                {g.items.map((it) => {
                  const active = pathname === it.href || pathname.startsWith(it.href + "/");
                  const Icon = it.icon;
                  return (
                    <Link
                      key={it.href}
                      href={it.href}
                      title={collapsed ? t(it.label, it.en) : undefined}
                      className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${collapsed ? "md:justify-center md:px-0" : ""} ${
                        active
                          ? "bg-brand-50 text-brand-700 dark:bg-brand-600/15 dark:text-brand-300"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                      }`}
                    >
                      <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-brand-600 dark:text-brand-300" : "text-slate-400 group-hover:text-slate-600 dark:text-slate-500"}`} strokeWidth={2} />
                      <span className={hide}>{t(it.label, it.en)}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
