"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutGrid, Users, UserCog, Mail, Server, Wrench, BarChart3, CreditCard, Receipt,
  LogOut, PlugZap, Menu, X, Layers, Cloud, ScrollText, Boxes, Settings, ChevronDown,
  ChevronRight, Percent, Brain, Bell, Sparkles, MessageSquare, Activity, ArrowUpCircle,
  Landmark, Bot, Wallet, Smartphone, Network, Database,
} from "lucide-react";
import { adminApi, adminTokens, ApiError } from "@/lib/adminClient";
import { PoweredBy } from "@/components/brand/PoweredBy";
import { LogoMark } from "@/components/brand/Logo";
import { APP_VERSION } from "@/lib/version";

// Πίνακας — always visible, standalone entry above the grouped circuits.
const HOME = { label: "Πίνακας", icon: LayoutGrid, href: "/admin", section: "dashboard" };

// CloudOn console — organised into logical circuits (ομάδες συναφών ενοτήτων). Each group is
// collapsible; the one containing the active page auto-expands.
const GROUPS: { label: string; icon: typeof LayoutGrid; items: { label: string; icon: typeof LayoutGrid; href: string; section: string }[] }[] = [
  {
    label: "Πελάτες & Συνδρομές", icon: Users, items: [
      { label: "Συνδρομητές", icon: Users, href: "/admin/subscribers", section: "subscribers" },
      { label: "Δίκτυο φαρμακείων", icon: Network, href: "/admin/network", section: "subscribers" },
      { label: "Συνδρομές", icon: CreditCard, href: "/admin/subscriptions", section: "subscriptions" },
      { label: "Πακέτα & SLA", icon: Boxes, href: "/admin/packages", section: "subscriptions" },
      { label: "Add-ons", icon: Sparkles, href: "/admin/addons", section: "subscriptions" },
      { label: "Αιτήματα αναβάθμισης", icon: ArrowUpCircle, href: "/admin/plan-changes", section: "subscriptions" },
      { label: "Newsletter", icon: Mail, href: "/admin/newsletter", section: "newsletter" },
    ],
  },
  {
    label: "Χρεώσεις & Πληρωμές", icon: Wallet, items: [
      { label: "Τιμολόγηση", icon: Receipt, href: "/admin/billing", section: "billing" },
      { label: "Τρόποι πληρωμής", icon: Wallet, href: "/admin/payments", section: "integrations" },
      { label: "Διατίμηση / Κέρδος", icon: Percent, href: "/admin/markup", section: "markup" },
      { label: "Μηνύματα & Credits", icon: MessageSquare, href: "/admin/credit-packages", section: "subscriptions" },
    ],
  },
  {
    label: "Κρατικές διασυνδέσεις", icon: Landmark, items: [
      { label: "ΑΑΔΕ", icon: Landmark, href: "/admin/aade", section: "integrations" },
      { label: "Διασύνδεση ΗΔΥΚΑ", icon: PlugZap, href: "/admin/idika", section: "idika" },
    ],
  },
  {
    label: "AI & Κλινικά", icon: Brain, items: [
      { label: "AI Providers", icon: Bot, href: "/admin/ai-providers", section: "integrations" },
      { label: "PharmaCat — Βάση γνώσης", icon: Brain, href: "/admin/pharmacat-kb", section: "pharmacat" },
    ],
  },
  {
    label: "Λειτουργία & Παρακολούθηση", icon: Activity, items: [
      { label: "Επισκεψιμότητα", icon: BarChart3, href: "/admin/health", section: "health" },
      { label: "Συνδεδεμένοι", icon: Activity, href: "/admin/sessions", section: "health" },
      { label: "Ειδοποιήσεις", icon: Bell, href: "/admin/notifications", section: "notifications" },
      { label: "Αρχείο ενεργειών", icon: ScrollText, href: "/admin/audit-logs", section: "audit" },
    ],
  },
  {
    label: "Σύστημα", icon: Settings, items: [
      { label: "Χρήστες", icon: UserCog, href: "/admin/staff", section: "staff" },
      { label: "Ομάδες ταμείων", icon: Layers, href: "/admin/fund-groups", section: "fund_groups" },
      { label: "Υποδομή / Cloud", icon: Cloud, href: "/admin/cloud", section: "cloud" },
      { label: "Ρυθμίσεις SMTP", icon: Server, href: "/admin/smtp", section: "smtp" },
      { label: "Πύλη Πελατών", icon: Smartphone, href: "/admin/portal", section: "maintenance" },
      { label: "Διατήρηση δεδομένων", icon: Database, href: "/admin/data-retention", section: "maintenance" },
      { label: "Συντήρηση", icon: Wrench, href: "/admin/maintenance", section: "maintenance" },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [access, setAccess] = useState<{ super_admin: boolean; permissions: string[] } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
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
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  function logout() {
    adminTokens.clear();
    router.replace("/admin/login");
  }

  const itemCls = (active: boolean) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`;

  return (
    <div className="flex min-h-screen bg-slate-100 dark:bg-slate-950">
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} />}

      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-200 dark:border-slate-800 dark:bg-slate-900 md:static md:w-60 md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center gap-2 px-5 py-4 font-bold text-slate-900">
          <LogoMark className="h-7 w-7" />
          RxVision Admin
          <button onClick={() => setMobileOpen(false)} className="ml-auto md:hidden" aria-label="Κλείσιμο">
            <X className="h-5 w-5 text-slate-400" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {/* Πίνακας — standalone */}
          {canSee(HOME.section) && (
            <Link href={HOME.href} onClick={() => setMobileOpen(false)} className={itemCls(pathname === HOME.href)}>
              <HOME.icon className="h-4 w-4" />{HOME.label}
            </Link>
          )}

          {/* Circuits */}
          {GROUPS.map((g) => {
            const items = g.items.filter((n) => canSee(n.section));
            if (!items.length) return null;
            const groupActive = items.some((n) => isActive(n.href));
            const expanded = openGroups[g.label] ?? groupActive;
            const GroupIcon = g.icon;
            return (
              <div key={g.label} className="pt-1">
                <button onClick={() => setOpenGroups((s) => ({ ...s, [g.label]: !expanded }))}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm ${groupActive ? "font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`}>
                  <GroupIcon className="h-4 w-4" />
                  <span className="flex-1 text-left">{g.label}</span>
                  {expanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                </button>
                {expanded && (
                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-slate-200 pl-3">
                    {items.map((n) => {
                      const Icon = n.icon;
                      return (
                        <Link key={n.href} href={n.href} onClick={() => setMobileOpen(false)} className={itemCls(isActive(n.href))}>
                          <Icon className="h-4 w-4" />{n.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-slate-200 px-5 py-3 text-sm">
          {email && <div className="mb-2 truncate text-slate-500">{email}</div>}
          <button onClick={logout} className="flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <LogOut className="h-4 w-4" /> Αποσύνδεση
          </button>
        </div>
        <PoweredBy />
        <div className="shrink-0 pb-2 text-center text-[10px] text-slate-400">RxVision Admin v{APP_VERSION}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
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
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
