"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";
import { useNavStore } from "@/store/navStore";
import { usePref, useT } from "@/store/prefStore";
import { Logo, LogoMark } from "@/components/brand/Logo";
import {
  Activity, BarChart3, Boxes, CalendarClock, ClipboardCheck, LayoutDashboard,
  Mail, Salad, PackageSearch, Settings, Sparkles, Stethoscope, TrendingUp, Users,
  Brain, ShieldCheck, type LucideIcon,
} from "lucide-react";

// `module` gates visibility: an item is shown only when the tenant has that module
// enabled/trial. Items without a `module` are always shown (core navigation).
type Item = { href: string; label: string; en: string; icon: LucideIcon; module?: string };
type Group = { title: string; en: string; items: Item[] };
type Me = { modules?: Record<string, "enabled" | "trial" | "locked"> };

const GROUPS: Group[] = [
  { title: "Patient Intelligence", en: "Patient Intelligence", items: [
    { href: "/intelligence", label: "Patient Intelligence", en: "Patient Intelligence", icon: Brain, module: "patient_analytics" },
  ] },
  { title: "Reimbursement", en: "Reimbursement", items: [
    { href: "/reimbursement", label: "Έλεγχος Αποζημίωσης", en: "Reimbursement Audit", icon: ShieldCheck, module: "monthly_closing" },
  ] },
  { title: "Έξυπνοι Σύμβουλοι", en: "AI Advisors", items: [
    { href: "/advisor", label: "Σύμβουλος Επιχείρησης", en: "Business Advisor", icon: Sparkles },
    { href: "/order-advisor", label: "Σύμβουλος Παραγγελίας", en: "Order Advisor", icon: Sparkles, module: "order_suggestions" },
    { href: "/nutrition", label: "Σύμβουλος Διατροφής", en: "Nutrition Advisor", icon: Salad },
  ] },
  { title: "Αναλυτικά", en: "Analytics", items: [
    { href: "/dashboard", label: "Πίνακας Ελέγχου", en: "Dashboard", icon: LayoutDashboard },
    { href: "/prescriptions", label: "Συνταγές", en: "Prescriptions", icon: BarChart3, module: "prescription_analytics" },
    { href: "/doctors", label: "Ιατροί", en: "Doctors", icon: Stethoscope, module: "doctor_analytics" },
    { href: "/patients", label: "Ασφαλισμένοι", en: "Patients", icon: Users, module: "patient_analytics" },
    { href: "/icd10", label: "ICD-10", en: "ICD-10", icon: Activity, module: "icd10_analytics" },
    { href: "/profitability", label: "Κερδοφορία", en: "Profitability", icon: TrendingUp, module: "profitability" },
  ] },
  { title: "Λειτουργίες", en: "Operations", items: [
    { href: "/future", label: "Μελλοντικές", en: "Upcoming", icon: CalendarClock, module: "future_prescriptions" },
    { href: "/orders", label: "Παραγγελίες", en: "Orders", icon: PackageSearch, module: "order_suggestions" },
    { href: "/portal-admin", label: "Πύλη Πελατών", en: "Customer Portal", icon: Users, module: "patient_portal" },
    { href: "/communications", label: "Επικοινωνία", en: "Communications", icon: Mail },
    { href: "/closing", label: "Κλείσιμο μήνα", en: "Month closing", icon: ClipboardCheck, module: "monthly_closing" },
    { href: "/pharmacyone", label: "PharmacyOne", en: "PharmacyOne", icon: Boxes, module: "pharmacyone" },
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

  const { data: me } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false });
  const modules = me?.modules;
  // While /auth/me is loading we show everything (avoids a flash of missing nav);
  // once loaded, an item with a `module` is hidden unless it's enabled/trial.
  const allowed = (it: Item) =>
    !it.module || !modules || modules[it.module] === "enabled" || modules[it.module] === "trial";
  const groups = GROUPS
    .map((g) => ({ ...g, items: g.items.filter(allowed) }))
    .filter((g) => g.items.length > 0);

  const hide = collapsed ? "md:hidden" : "";

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[min(16rem,85vw)] shrink-0 flex-col border-r border-slate-200/70 bg-white transition-all duration-200 dark:border-slate-800 dark:bg-slate-900 md:static md:w-64 md:translate-x-0 ${collapsed ? "md:w-[72px]" : "md:w-64"} ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className={`flex h-16 items-center px-5 ${collapsed ? "md:justify-center md:px-0" : ""}`}>
          {/* full wordmark — always on mobile drawer; on desktop only when expanded */}
          <div className={collapsed ? "md:hidden" : ""}><Logo markClassName="h-9 w-9" /></div>
          {/* collapsed desktop → only the purple mark */}
          {collapsed && <LogoMark className="hidden h-9 w-9 md:block" />}
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {groups.map((g) => (
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

        {/* Powered by CloudOn */}
        <a
          href="https://cloudon.gr"
          target="_blank"
          rel="noopener noreferrer"
          title="Powered by CloudOn"
          className={`flex shrink-0 items-center justify-center gap-2 border-t border-slate-200/70 py-3 opacity-70 transition hover:opacity-100 dark:border-slate-800 ${collapsed ? "md:px-0" : "px-3"}`}
        >
          <span className={`text-[10px] font-medium uppercase tracking-wide text-slate-400 ${hide}`}>Powered by</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/cloudon-logo.png" alt="CloudOn" className="h-4 w-auto" />
        </a>
      </aside>
    </>
  );
}
