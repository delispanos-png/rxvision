"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, refreshSession } from "@/lib/apiClient";
import { appAlert } from "@/store/dialogStore";
import { useNavStore } from "@/store/navStore";
import { usePref, useT } from "@/store/prefStore";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  Activity, BarChart3, Boxes, CalendarClock, ChevronRight, LayoutDashboard,
  Mail, Salad, PackageSearch, Settings, Sparkles, Stethoscope, TrendingUp, Users,
  Brain, ShieldCheck, Tags, Syringe, Bot, Gift, BookOpen, Truck, Lock, X, type LucideIcon,
} from "lucide-react";

// A leaf (direct link). `module` gates visibility (shown only when enabled/trial).
type Leaf = { href: string; label: string; en: string; module?: string | string[] };
// A node is either a direct link (href) or an expandable parent (children).
type Node = { label: string; en: string; icon: LucideIcon; href?: string; module?: string | string[]; children?: Leaf[] };
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
    { label: "AI σύμβουλος", en: "AI Assistant", icon: Bot, href: "/copilot", module: "ai_assistant" },
    { label: "Διατροφή", en: "Nutrition", icon: Salad, href: "/nutrition", module: ["nutrition", "ai_assistant"] },
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

  const router = useRouter();
  const qc = useQueryClient();
  const [upsell, setUpsell] = useState<{ label: string; en: string; module: string; href: string } | null>(null);
  const [trialBusy, setTrialBusy] = useState(false);

  const { data: me } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false });
  const modules = me?.modules;
  const allowedMod = (m?: string | string[]) => {
    if (!m || !modules) return true;
    const keys = Array.isArray(m) ? m : [m];
    return keys.some((k) => modules[k] === "enabled" || modules[k] === "trial");
  };
  // A locked circuit stays in the menu (with 🔒 + upsell) ONLY if it's a purchasable add-on offered by
  // this tenant's package. Plain unselected modules (e.g. pharmacyone) just disappear from the menu.
  const addonsQ = useQuery({ queryKey: ["addons"], queryFn: () => api<{ addons: { _id: string; status: string; offered?: boolean }[] }>("/addons"), retry: false });
  const upsellable = new Set((addonsQ.data?.addons ?? []).filter((a) => a.status === "available" && a.offered).map((a) => a._id));
  const canUpsell = (m?: string | string[]) => {
    const keys = Array.isArray(m) ? m : m ? [m] : [];
    return keys.some((k) => upsellable.has(k));
  };

  // Locked circuits STAY visible in the menu — clicking opens an upsell prompt instead of navigating.
  function openUpsell(n: Node) {
    const mod = Array.isArray(n.module) ? n.module[0] : n.module!;
    const href = n.href ?? n.children?.[0]?.href ?? "/dashboard";
    setUpsell({ label: n.label, en: n.en, module: mod, href });
    setOpen(false);
  }
  async function startTrial() {
    if (!upsell) return;
    setTrialBusy(true);
    try {
      await api(`/addons/${upsell.module}/trial`, { method: "POST" });
      await refreshSession();
      await qc.invalidateQueries({ queryKey: queryKeys.me() });
      const href = upsell.href;
      setUpsell(null);
      router.push(href);
    } catch {
      appAlert(t("Δεν ήταν δυνατή η έναρξη δοκιμής. Δοκίμασε ξανά.", "Could not start the trial. Please try again."));
    } finally {
      setTrialBusy(false);
    }
  }

  // show enabled circuits + locked-but-offerable (upsell); hide plain unavailable ones + empty groups
  const groups = GROUPS
    .map((g) => ({ ...g, items: g.items.filter((n) => allowedMod(n.module) || canUpsell(n.module)) }))
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
          {/* logo → marketing site (rxvision.gr) */}
          <a href="https://rxvision.gr" title="rxvision.gr" className="transition hover:opacity-80">
            <div className={collapsed ? "md:hidden" : ""}><Logo markClassName="h-9 w-9" /></div>
            {collapsed && <LogoMark className="hidden h-9 w-9 md:block" />}
          </a>
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
                  // locked circuit: keep in menu (dimmed + 🔒 + upsell) ONLY if it's a purchasable
                  // add-on offered by the package; otherwise hide it entirely.
                  if (!allowedMod(n.module)) {
                    if (!canUpsell(n.module)) return null;
                    return (
                      <button key={n.label} onClick={() => openUpsell(n)} title={collapsed ? t(n.label, n.en) : undefined}
                        className={`${linkCls(false)} w-full opacity-55`}>
                        <Icon className={iconCls(false)} strokeWidth={2} />
                        <span className={`flex-1 text-left ${hide}`}>{t(n.label, n.en)}</span>
                        <Lock className={`h-3.5 w-3.5 shrink-0 text-slate-300 ${hide}`} />
                      </button>
                    );
                  }
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

      {upsell && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" onClick={() => setUpsell(null)}>
          <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setUpsell(null)} className="absolute right-4 top-4 text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg"><Sparkles className="h-6 w-6" /></div>
            <h3 className="mt-3 text-base font-bold text-slate-900 dark:text-slate-100">{t(upsell.label, upsell.en)}</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {t("Δεν περιλαμβάνεται στο πακέτο σου. Δοκίμασέ το δωρεάν για 14 ημέρες ή αναβάθμισε το πλάνο σου.",
                 "Not included in your plan. Try it free for 14 days or upgrade your plan.")}
            </p>
            <button onClick={startTrial} disabled={trialBusy}
              className="mt-4 w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
              {trialBusy ? t("Έναρξη…", "Starting…") : t("✨ Δωρεάν δοκιμή 14 ημερών", "✨ Free 14-day trial")}
            </button>
            <button onClick={() => { setUpsell(null); router.push("/settings/billing"); }}
              className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">
              {t("Αναβάθμιση πλάνου", "Upgrade plan")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
