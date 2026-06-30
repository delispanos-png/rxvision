"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutGrid, FileText, Newspaper, BookOpen, Users, UserCog, Mail,
  Server, Wrench, BarChart3, CreditCard, Receipt, LogOut, PlugZap,  Menu, X, Layers, Cloud,
  ScrollText, KeyRound, Boxes, Settings, ChevronDown, ChevronRight, Percent, Brain, Bell, Sparkles,
} from "lucide-react";
import { adminApi, adminTokens, ApiError } from "@/lib/adminClient";
import { LogoMark } from "@/components/brand/Logo";
import { Tooltip } from "@/components/ui/Tooltip";

// CloudOn console navigation. `href` = built (routable); otherwise "σύντομα".
const NAV = [
  { label: "Πίνακας", icon: LayoutGrid, href: "/admin", section: "dashboard" },
  { label: "Συνδρομητές", icon: Users, href: "/admin/subscribers", section: "subscribers" },
  { label: "Συνδρομές", icon: CreditCard, href: "/admin/subscriptions", section: "subscriptions" },
  { label: "Πακέτα & SLA", icon: Boxes, href: "/admin/packages", section: "subscriptions" },
  { label: "Add-ons", icon: Sparkles, href: "/admin/addons", section: "subscriptions" },
  { label: "Τιμολόγηση", icon: Receipt, href: "/admin/billing", section: "billing" },
  { label: "Ομάδες ταμείων", icon: Layers, href: "/admin/fund-groups", section: "fund_groups" },
  { label: "Newsletter", icon: Mail, href: "/admin/newsletter", section: "newsletter" },
  { label: "Επισκεψιμότητα", icon: BarChart3, href: "/admin/health", section: "health" },
];

// «Ρυθμίσεις Συστήματος» — collapsible group (system administration)
const SETTINGS_GROUP = {
  label: "Ρυθμίσεις Συστήματος", icon: Settings,
  items: [
    { label: "Χρήστες", icon: UserCog, href: "/admin/staff", section: "staff" },
    { label: "Πληρωμές & ΑΑΔΕ", icon: KeyRound, href: "/admin/integrations", section: "integrations" },
    { label: "Διασύνδεση ΗΔΥΚΑ", icon: PlugZap, href: "/admin/idika", section: "idika" },
    { label: "Διατίμηση / Κέρδος", icon: Percent, href: "/admin/markup", section: "markup" },
    { label: "PharmaCat — Βάση γνώσης", icon: Brain, href: "/admin/pharmacat-kb", section: "pharmacat" },
    { label: "Υποδομή / Cloud", icon: Cloud, href: "/admin/cloud", section: "cloud" },
    { label: "Ρυθμίσεις SMTP", icon: Server, href: "/admin/smtp", section: "smtp" },
    { label: "Ειδοποιήσεις", icon: Bell, href: "/admin/notifications", section: "notifications" },
    { label: "Συντήρηση", icon: Wrench, href: "/admin/maintenance", section: "maintenance" },
    { label: "Αρχείο ενεργειών", icon: ScrollText, href: "/admin/audit-logs", section: "audit" },
  ],
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [access, setAccess] = useState<{ super_admin: boolean; permissions: string[] } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isLogin = pathname === "/admin/login";

  useEffect(() => {
    if (isLogin) return;
    adminApi<{ email: string; super_admin: boolean; permissions: string[] }>("/platform/auth/me")
      .then((me) => { setEmail(me.email); setAccess({ super_admin: me.super_admin, permissions: me.permissions || [] }); })
      .catch((e) => { if (e instanceof ApiError) router.replace("/admin/login"); });
  }, [isLogin, pathname, router]);

  useEffect(() => { setMobileOpen(false); }, [pathname]);  // close drawer on navigate

  if (isLogin) return <div className="min-h-screen bg-slate-900">{children}</div>;

  const canSee = (section: string) => !access || access.super_admin || access.permissions.includes(section);
  const nav = NAV.filter((n) => canSee(n.section));
  const settingsItems = SETTINGS_GROUP.items.filter((n) => canSee(n.section));
  const settingsActive = settingsItems.some((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
  const settingsExpanded = settingsOpen || settingsActive;
  const SettingsIcon = SETTINGS_GROUP.icon;

  function logout() {
    adminTokens.clear();
    router.replace("/admin/login");
  }

  return (
    <div className="flex min-h-screen bg-slate-100 dark:bg-slate-950">
      {/* mobile backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* sidebar: slide-over drawer on mobile, static on desktop */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-200 dark:border-slate-800 dark:bg-slate-900 md:static md:w-60 md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center gap-2 px-5 py-4 font-bold text-slate-900">
          <LogoMark className="h-7 w-7" />
          RxVision Admin
          <button onClick={() => setMobileOpen(false)} className="ml-auto md:hidden" aria-label="Κλείσιμο">
            <X className="h-5 w-5 text-slate-400" />
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
          {nav.map((n, i) => {
            const active = !!n.href && pathname === n.href && nav.findIndex((x) => x.href === n.href) === i;
            const Icon = n.icon;
            const cls = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm";
            if (!n.href) {
              return (
                <Tooltip key={n.label} label="Σύντομα"><div className={`${cls} cursor-default text-slate-400`}>
                  <Icon className="h-4 w-4" /><span className="flex-1">{n.label}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">σύντομα</span>
                </div></Tooltip>
              );
            }
            return (
              <Link key={n.label} href={n.href} onClick={() => setMobileOpen(false)}
                className={`${cls} ${active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`}>
                <Icon className="h-4 w-4" />{n.label}
              </Link>
            );
          })}

          {/* Ρυθμίσεις Συστήματος — collapsible group */}
          {settingsItems.length > 0 && (
            <div className="pt-1">
              <button onClick={() => setSettingsOpen((v) => !v)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm ${settingsActive ? "font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`}>
                <SettingsIcon className="h-4 w-4" />
                <span className="flex-1 text-left">{SETTINGS_GROUP.label}</span>
                {settingsExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
              </button>
              {settingsExpanded && (
                <div className="ml-4 mt-0.5 space-y-0.5 border-l border-slate-200 pl-3">
                  {settingsItems.map((n) => {
                    const active = pathname === n.href || pathname.startsWith(n.href + "/");
                    const Icon = n.icon;
                    return (
                      <Link key={n.label} href={n.href} onClick={() => setMobileOpen(false)}
                        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`}>
                        <Icon className="h-4 w-4" />{n.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </nav>
        <div className="border-t border-slate-200 px-5 py-3 text-sm">
          {email && <div className="mb-2 truncate text-slate-500">{email}</div>}
          <button onClick={logout} className="flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <LogOut className="h-4 w-4" /> Αποσύνδεση
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile top bar with hamburger */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900 md:hidden">
          <button onClick={() => setMobileOpen(true)} aria-label="Μενού" className="grid h-9 w-9 place-items-center rounded-lg text-slate-600 hover:bg-slate-100">
            <Menu className="h-5 w-5" />
          </button>
          <span className="flex items-center gap-2 font-bold text-slate-900">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-indigo-500 text-[10px] text-white">Cl</span>
            CloudOn Admin
          </span>
        </div>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          {/* Cap content width on wide screens (R-1). */}
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
