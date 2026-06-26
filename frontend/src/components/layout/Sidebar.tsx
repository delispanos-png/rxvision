"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";
import { useNavStore } from "@/store/navStore";
import { usePref, useT } from "@/store/prefStore";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  Activity, BarChart3, Boxes, CalendarClock, ChevronRight, LayoutDashboard,
  Mail, Salad, PackageSearch, Settings, Sparkles, Stethoscope, TrendingUp, Users,
  Brain, ShieldCheck, Tags, Syringe, Bot, Gift, BookOpen, Truck, type LucideIcon,
} from "lucide-react";

// A leaf (direct link). `module` gates visibility (shown only when enabled/trial).
type Leaf = { href: string; label: string; en: string; module?: string };
// A node is either a direct link (href) or an expandable parent (children).
type Node = { label: string; en: string; icon: LucideIcon; href?: string; module?: string; children?: Leaf[] };
type Group = { title: string; en: string; items: Node[] };
type Me = { modules?: Record<string, "enabled" | "trial" | "locked"> };

const GROUPS: Group[] = [
  { title: "Patient Intelligence", en: "Patient Intelligence", items: [
    { label: "Patient Intelligence", en: "Patient Intelligence", icon: Brain, href: "/intelligence", module: "patient_analytics" },
  ] },
  { title: "Ανάλυση", en: "Analysis", items: [
    { label: "Dashboard", en: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
    { label: "Συνταγές", en: "Prescriptions", icon: BarChart3, module: "prescription_analytics", children: [
      { href: "/prescriptions", label: "Λίστα", en: "List" },
      { href: "/rx-types", label: "Δείκτες", en: "Indicators" },
    ] },
    { label: "Κύκλωμα Εμβολιασμών", en: "Vaccinations", icon: Syringe, href: "/vaccinations", module: "prescription_analytics" },
    { label: "Μελλοντικές", en: "Upcoming", icon: CalendarClock, module: "future_prescriptions", children: [
      { href: "/future#coverage", label: "Κάλυψη περιόδου", en: "Period coverage" },
      { href: "/future#forecast", label: "Πρόβλεψη κάλυψης", en: "Coverage forecast" },
    ] },
    { label: "Ασφαλισμένοι", en: "Patients", icon: Users, module: "patient_analytics", children: [
      { href: "/patients#list", label: "Λίστα", en: "List" },
      { href: "/patients#kpi", label: "Δείκτες", en: "Indicators" },
    ] },
    { label: "Ιατροί", en: "Doctors", icon: Stethoscope, module: "doctor_analytics", children: [
      { href: "/doctors#list", label: "Λίστα", en: "List" },
      { href: "/doctors#kpi", label: "Δείκτες", en: "Indicators" },
    ] },
    { label: "ICD-10", en: "ICD-10", icon: Activity, module: "icd10_analytics", children: [
      { href: "/icd10#list", label: "Λίστα", en: "List" },
      { href: "/icd10#kpi", label: "Δείκτες", en: "Indicators" },
    ] },
  ] },
  { title: "Σύμβουλοι", en: "Advisors", items: [
    { label: "Επιχειρησιακά", en: "Business", icon: Sparkles, href: "/advisor" },
    { label: "Παραγγελία", en: "Ordering", icon: PackageSearch, module: "order_suggestions", children: [
      { href: "/orders", label: "βάσει εκτελέσεων", en: "by executions" },
      { href: "/order-advisor", label: "βάσει πρόβλεψης", en: "by forecast" },
    ] },
    { label: "AI σύμβουλος", en: "AI Assistant", icon: Bot, href: "/copilot" },
    { label: "Διατροφή", en: "Nutrition", icon: Salad, href: "/nutrition" },
    { label: "Κερδοφορία", en: "Profitability", icon: TrendingUp, href: "/profitability", module: "profitability" },
  ] },
  { title: "Λειτουργίες", en: "Operations", items: [
    { label: "Έλεγχος συνταγών", en: "Rx Audit", icon: ShieldCheck, href: "/reimbursement", module: "monthly_closing" },
    { label: "Πύλη πελατών", en: "Customer Portal", icon: Users, href: "/portal-admin", module: "patient_portal" },
    { label: "Πιστότητα", en: "Loyalty", icon: Gift, href: "/loyalty", module: "loyalty" },
    { label: "Κατάλογος ειδών", en: "Product Catalog", icon: Boxes, href: "/catalog", module: "order_delivery" },
    { label: "Παραγγελίες & Αποστολή", en: "Orders & Delivery", icon: Truck, href: "/orders-delivery", module: "order_delivery" },
    { label: "PharmacyOne", en: "PharmacyOne", icon: Boxes, href: "/pharmacyone", module: "pharmacyone" },
    { label: "Επικοινωνία", en: "Communications", icon: Mail, href: "/communications" },
    { label: "Οδηγός δεικτών", en: "Indicators guide", icon: BookOpen, href: "/guide" },
    { label: "Ρυθμίσεις", en: "Settings", icon: Settings, href: "/settings/users" },
  ] },
];

export function Sidebar() {
  const pathname = usePathname();
  const { open, setOpen } = useNavStore();
  const { collapsed } = usePref();
  const t = useT();
  const [loc, setLoc] = useState("");   // current search + hash (for active highlighting of #/​? leaves)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => { setOpen(false); }, [pathname, setOpen]);
  useEffect(() => {
    const read = () => setLoc(window.location.search + window.location.hash);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [pathname]);

  const { data: me } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false });
  const modules = me?.modules;
  const allowedMod = (m?: string) => !m || !modules || modules[m] === "enabled" || modules[m] === "trial";

  const groups = GROUPS
    .map((g) => ({ ...g, items: g.items.filter((n) => allowedMod(n.module)) }))
    .filter((g) => g.items.length > 0);

  const leafActive = (href: string) => {
    const base = href.split(/[?#]/)[0];
    if (pathname !== base && !pathname.startsWith(base + "/")) return false;
    const frag = href.slice(base.length).replace(/^[?#]/, "");  // "view=list" | "kpi" | "coverage" | ""
    return frag ? loc.includes(frag) : true;
  };
  const nodeActive = (n: Node) =>
    n.href ? leafActive(n.href) : !!n.children?.some((c) => leafActive(c.href));

  // auto-open the parent that contains the active route
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const g of GROUPS) for (const n of g.items) {
        if (n.children && n.children.some((c) => {
          const base = c.href.split(/[?#]/)[0];
          return pathname === base || pathname.startsWith(base + "/");
        })) next.add(n.label);
      }
      return next;
    });
  }, [pathname]);

  const toggle = (label: string) => setExpanded((prev) => {
    const next = new Set(prev); next.has(label) ? next.delete(label) : next.add(label); return next;
  });

  const hide = collapsed ? "md:hidden" : "";
  const linkCls = (active: boolean) =>
    `group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${collapsed ? "md:justify-center md:px-0" : ""} ${
      active ? "bg-brand-50 text-brand-700 dark:bg-brand-600/15 dark:text-brand-300"
             : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"}`;
  const iconCls = (active: boolean) =>
    `h-[18px] w-[18px] shrink-0 ${active ? "text-brand-600 dark:text-brand-300" : "text-slate-400 group-hover:text-slate-600 dark:text-slate-500"}`;

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[min(16rem,85vw)] shrink-0 flex-col border-r border-slate-200/70 bg-white transition-all duration-200 dark:border-slate-800 dark:bg-slate-900 md:static md:w-64 md:translate-x-0 ${collapsed ? "md:w-[72px]" : "md:w-64"} ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className={`flex h-16 items-center px-5 ${collapsed ? "md:justify-center md:px-0" : ""}`}>
          <div className={collapsed ? "md:hidden" : ""}><Logo markClassName="h-9 w-9" /></div>
          {collapsed && <LogoMark className="hidden h-9 w-9 md:block" />}
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {groups.map((g) => (
            <div key={g.title}>
              <div className={`px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 ${hide}`}>
                {t(g.title, g.en)}
              </div>
              <div className="space-y-1">
                {g.items.map((n) => {
                  const Icon = n.icon;
                  const active = nodeActive(n);
                  // direct link (no children)
                  if (!n.children) {
                    return (
                      <Link key={n.label} href={n.href!} title={collapsed ? t(n.label, n.en) : undefined} className={linkCls(active)}>
                        <Icon className={iconCls(active)} strokeWidth={2} />
                        <span className={hide}>{t(n.label, n.en)}</span>
                      </Link>
                    );
                  }
                  // collapsed desktop → parent acts as a link to its first child (no nesting)
                  if (collapsed) {
                    const cls = `${linkCls(active)} md:justify-center md:px-0`;
                    const inner = (<><Icon className={iconCls(active)} strokeWidth={2} /><span className="md:hidden">{t(n.label, n.en)}</span></>);
                    return n.children[0].href.includes("#")
                      ? <a key={n.label} href={n.children[0].href} title={t(n.label, n.en)} className={cls} onClick={() => setOpen(false)}>{inner}</a>
                      : <Link key={n.label} href={n.children[0].href} title={t(n.label, n.en)} className={cls}>{inner}</Link>;
                  }
                  // expandable parent
                  const isOpen = expanded.has(n.label);
                  return (
                    <div key={n.label}>
                      <button onClick={() => toggle(n.label)} className={`${linkCls(active)} w-full`}>
                        <Icon className={iconCls(active)} strokeWidth={2} />
                        <span className="flex-1 text-left">{t(n.label, n.en)}</span>
                        <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                      </button>
                      {isOpen && (
                        <div className="mt-1 space-y-0.5 border-l border-slate-200 pl-3 ml-5 dark:border-slate-700">
                          {n.children.map((c) => {
                            const ca = leafActive(c.href);
                            const cls = `block rounded-lg px-3 py-1.5 text-sm transition-colors ${ca ? "font-semibold text-brand-700 dark:text-brand-300" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800"}`;
                            // hash leaves (#list/#kpi…) use a plain <a>: Next <Link> uses pushState which
                            // does NOT fire `hashchange`, so the page's view toggle would never update.
                            return c.href.includes("#")
                              ? <a key={c.href} href={c.href} className={cls} onClick={() => setOpen(false)}>{t(c.label, c.en)}</a>
                              : <Link key={c.href} href={c.href} className={cls} onClick={() => setOpen(false)}>{t(c.label, c.en)}</Link>;
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <Tooltip label="Powered by CloudOn">
          <a href="https://cloudon.gr" target="_blank" rel="noopener noreferrer"
            className={`flex shrink-0 items-center justify-center gap-2 border-t border-slate-200/70 py-3 opacity-70 transition hover:opacity-100 dark:border-slate-800 ${collapsed ? "md:px-0" : "px-3"}`}>
            <span className={`text-[10px] font-medium uppercase tracking-wide text-slate-400 ${hide}`}>Powered by</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cloudon-logo.png" alt="CloudOn" className="h-4 w-auto" />
          </a>
        </Tooltip>
      </aside>
    </>
  );
}
