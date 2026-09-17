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
import { CLOUDON_LOGO_DATA_URI } from "@/components/brand/cloudonLogo";
import { APP_VERSION } from "@/lib/version";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  Activity, BarChart3, Boxes, Warehouse, Layers, CalendarClock, ChevronRight, LayoutDashboard,
  Mail, Megaphone, Salad, PackageSearch, Settings, Sparkles, Stethoscope, TrendingUp, Target, Users,
  Brain, ShieldCheck, Tags, Syringe, Bot, Gift, BookOpen, ScrollText, Truck, Lock, X, UserPlus, Ticket, SlidersHorizontal, Heart, FileText, MessageSquare, PackageCheck, Receipt, ArrowRightLeft, Compass, Star, Pencil, Check, type LucideIcon,
} from "lucide-react";

import { NAV_GROUPS as GROUPS, type Group, type Node, type Me } from "./navCatalog";

/** Συντόμευση του χειριστή. Ζει εδώ (όχι στον κατάλογο): είναι επιλογή ανθρώπου, όχι μενού. */
type Pin = { href: string; label?: string; en?: string };


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

  // Προσωπικό μενού & μενού ανά ρόλο. ΕΜΦΑΝΙΣΗ μόνο — τα δικαιώματα επιβάλλονται στον server.
  const [picking, setPicking] = useState(false);
  const prefsQ = useQuery({
    queryKey: ["nav", "prefs"],
    queryFn: () => api<{ pinned: Pin[]; pinned_groups: string[]; mode: "central" | "personal"; hidden_groups: string[]; hidden_items: string[]; max_pinned: number }>("/nav/prefs"),
    retry: false,
  });
  const pinned = prefsQ.data?.pinned ?? [];
  const mode = prefsQ.data?.mode ?? "central";      // «central» = κεντρικό μενού · «personal» = μόνο τα δικά μου
  const setMode = async (m: "central" | "personal") => {
    await api("/nav/mode", { method: "PUT", body: JSON.stringify({ mode: m }) });
    qc.invalidateQueries({ queryKey: ["nav", "prefs"] });
  };
  const hiddenGroups = new Set(prefsQ.data?.hidden_groups ?? []);
  const hiddenItems = new Set(prefsQ.data?.hidden_items ?? []);
  const savePins = async (items: Pin[], groups: string[] = []) => {
    await api("/nav/pinned", { method: "PUT", body: JSON.stringify({ items, groups }) });
    qc.invalidateQueries({ queryKey: ["nav", "prefs"] });
  };

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
  // Δύο επίπεδα απόκρυψης από τον ρόλο: ΟΛΗ η ενότητα ή ΜΕΜΟΝΩΜΕΝΕΣ επιλογές. Μια ενότητα
  // σπάνια είναι «όλη ή τίποτα» — στις «Λειτουργίες» θες οδηγίες και όρους, όχι Ρυθμίσεις.
  const visible = (href?: string) => !href || !hiddenItems.has(href);
  /** Ένα φύλλο = ένας προορισμός, με το εικονίδιο του γονιού του. */
  const leavesOfNode = (n: Node) => n.children
    ? n.children.filter((c) => visible(c.href)).map((c) => ({ href: c.href, label: `${n.label} · ${c.label}`, en: `${n.en} · ${c.en}`, icon: n.icon }))
    : n.href && visible(n.href) ? [{ href: n.href, label: n.label, en: n.en, icon: n.icon }] : [];
  const groups = GROUPS
    .filter((g) => !hiddenGroups.has(g.title))
    .map((g) => ({
      ...g,
      items: g.items
        .filter((n) => allowedMod(n.module) || canUpsell(n.module))
        .map((n) => (n.children ? { ...n, children: n.children.filter((c) => visible(c.href)) } : n))
        // γονέας που έμεινε χωρίς παιδιά δεν έχει πού να οδηγήσει → φεύγει
        .filter((n) => (n.children ? n.children.length > 0 : visible(n.href))),
    }))
    .filter((g) => g.items.length > 0);

  // «Τα δικά μου» ΜΕ ΔΟΜΗ: ίδια σειρά κυκλωμάτων με το κεντρικό, μόνο με ό,τι διάλεξε.
  // Ολόκληρο κύκλωμα = ΟΜΑΔΑ, όχι φωτογραφία των σημερινών επιλογών της: αν αύριο μπει νέα
  // επιλογή στην «Ανάλυση», τη βλέπει αμέσως.
  const hasPicks = pinned.length > 0 || (prefsQ.data?.pinned_groups ?? []).length > 0;
  const pinnedHrefs = new Set(pinned.map((p) => p.href));
  const pinnedGroups = new Set(prefsQ.data?.pinned_groups ?? []);
  const myGroups = groups
    .map((g) => {
      const all = g.items.flatMap(leavesOfNode);
      return { ...g, leaves: pinnedGroups.has(g.title) ? all : all.filter((l) => pinnedHrefs.has(l.href)) };
    })
    .filter((g) => g.leaves.length > 0);

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

  // Πτυσσόμενες ΟΜΑΔΕΣ (Ανάλυση/Σύμβουλοι/eShop/Λειτουργίες…) — άνοιγμα/κλείσιμο & μνήμη ανά χρήστη.
  // Οι ενότητες ξεκινούν ΟΛΕΣ ΚΛΕΙΣΤΕΣ σε κάθε άνοιγμα — ο χρήστης ανοίγει όποια θέλει.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(GROUPS.map((g) => g.title)));
  useEffect(() => {
    try { const raw = localStorage.getItem("rxv-nav-groups"); if (raw) setCollapsedGroups(new Set(JSON.parse(raw) as string[])); } catch { /* ignore */ }
  }, []);
  const toggleGroup = (title: string) => setCollapsedGroups((prev) => {
    const next = new Set(prev); next.has(title) ? next.delete(title) : next.add(title);
    try { localStorage.setItem("rxv-nav-groups", JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
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
          {/* ΔΙΑΚΟΠΤΗΣ: ή το κεντρικό μενού (όπως το ορίζει ο ρόλος του) ή ΜΟΝΟ τα δικά του.
              Όχι και τα δύο μαζί — αυτό ήταν το αρχικό λάθος: το «προσωπικό» απλώς πρόσθετε
              άλλη μια ενότητα σε ένα μενού που ήταν ήδη μεγάλο. */}
          <div className={`flex items-center gap-1.5 ${hide}`}>
          <div className="flex flex-1 rounded-xl bg-slate-100 p-0.5 dark:bg-slate-800">
            <button onClick={() => setMode("central")}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition ${mode === "central" ? "bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100" : "text-slate-500 hover:text-slate-700 dark:text-slate-400"}`}>
              {t("Κεντρικό", "Full menu")}
            </button>
            <button onClick={() => setMode("personal")} disabled={!hasPicks}
              title={!hasPicks ? t("Διάλεξε πρώτα τις δικές σου δουλειές", "Pick your own tasks first") : undefined}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition disabled:opacity-40 ${mode === "personal" ? "bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100" : "text-slate-500 hover:text-slate-700 dark:text-slate-400"}`}>
              {t("Τα δικά μου", "Mine")}
            </button>
          </div>
          <button onClick={() => setPicking(true)} title={t("Διάλεξε τις δικές σου δουλειές", "Pick your own tasks")}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          </div>

          {/* ΤΑ ΔΙΚΑ ΜΟΥ — με την ΙΔΙΑ δομή με το κεντρικό: επικεφαλίδα κυκλώματος και από
              κάτω μόνο όσα διάλεξε. Μια πλακέ λίστα με αστεράκια χάνει το πλαίσιο — δεν
              φαίνεται ότι «από τους Συμβούλους κρατάω δύο πράγματα». */}
          {mode === "personal" ? (
            <>
              {myGroups.map((g) => (
                <div key={g.title}>
                  <div className={`flex items-center gap-2 px-3 pb-2 text-[13px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${hide}`}>
                    <g.icon className="h-4 w-4 shrink-0 text-brand-500" strokeWidth={2} />{t(g.title, g.en)}
                  </div>
                  <div className="space-y-1">
                    {g.leaves.map((l) => {
                      const active = leafActive(l.href);
                      const inner = (<><l.icon className={iconCls(active)} strokeWidth={2} /><span className={hide}>{t(l.label, l.en)}</span></>);
                      return l.href.includes("#")
                        ? <a key={l.href} href={l.href} title={collapsed ? l.label : undefined} className={linkCls(active)} onClick={() => setOpen(false)}>{inner}</a>
                        : <Link key={l.href} href={l.href} title={collapsed ? l.label : undefined} className={linkCls(active)}>{inner}</Link>;
                    })}
                  </div>
                </div>
              ))}
              {!myGroups.length && (
                <button onClick={() => setPicking(true)} className={`w-full rounded-xl border border-dashed border-slate-300 px-3 py-2 text-left text-xs text-slate-400 hover:border-brand-300 hover:text-brand-600 dark:border-slate-700 ${hide}`}>
                  {t("Διάλεξε τις δουλειές που κάνεις κάθε μέρα", "Pick the tasks you do every day")}
                </button>
              )}
            </>
          ) : groups.map((g) => {
            // Ομάδα με ΕΝΑ φύλλο (χωρίς υπο-στοιχεία) → ανεξάρτητο top-level link (χωρίς επικεφαλίδα/πτύξη).
            if (g.items.length === 1 && !g.items[0].children) {
              const n = g.items[0];
              const Icon = n.icon;
              const active = nodeActive(n);
              if (!allowedMod(n.module)) {
                return (
                  <button key={g.title} onClick={() => openUpsell(n)} title={collapsed ? t(n.label, n.en) : undefined} className={`${linkCls(false)} w-full opacity-55`}>
                    <Icon className={iconCls(false)} strokeWidth={2} />
                    <span className={`flex-1 text-left ${hide}`}>{t(n.label, n.en)}</span>
                    <Lock className={`h-3.5 w-3.5 shrink-0 text-slate-300 ${hide}`} />
                  </button>
                );
              }
              const inner = (<><Icon className={iconCls(active)} strokeWidth={2} /><span className={hide}>{t(n.label, n.en)}</span></>);
              return n.href!.includes("#")
                ? <a key={g.title} href={n.href!} title={collapsed ? t(n.label, n.en) : undefined} className={linkCls(active)} onClick={() => setOpen(false)}>{inner}</a>
                : <Link key={g.title} href={n.href!} title={collapsed ? t(n.label, n.en) : undefined} className={linkCls(active)}>{inner}</Link>;
            }
            const gCollapsed = collapsedGroups.has(g.title);
            const GroupIcon = g.icon;
            return (
            <div key={g.title}>
              {/* Επικεφαλίδα ομάδας = κουμπί πτύξης (κρύβεται όταν το sidebar είναι σε λειτουργία εικονιδίων) */}
              <button onClick={() => toggleGroup(g.title)}
                className={`flex w-full items-center justify-between px-3 pb-2 text-[13px] font-bold uppercase tracking-wide text-slate-500 transition-colors hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 ${hide}`}>
                <span className="flex items-center gap-2">
                  <GroupIcon className="h-4 w-4 shrink-0 text-brand-500" strokeWidth={2} />
                  {t(g.title, g.en)}
                </span>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${gCollapsed ? "" : "rotate-90"}`} />
              </button>
              {(collapsed || !gCollapsed) && (
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
                  // direct link (no children) — hash links (#tab) use <a>: Next <Link> uses pushState
                  // που ΔΕΝ πυροδοτεί `hashchange`, οπότε η σελίδα δεν θα άλλαζε καρτέλα.
                  if (!n.children) {
                    const inner = (<><Icon className={iconCls(active)} strokeWidth={2} /><span className={hide}>{t(n.label, n.en)}</span></>);
                    return n.href!.includes("#")
                      ? <a key={n.label} href={n.href!} title={collapsed ? t(n.label, n.en) : undefined} className={linkCls(active)} onClick={() => setOpen(false)}>{inner}</a>
                      : <Link key={n.label} href={n.href!} title={collapsed ? t(n.label, n.en) : undefined} className={linkCls(active)}>{inner}</Link>;
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
              )}
            </div>
            );
          })}
        </nav>

        <Tooltip label="Powered by CloudOn">
          <a href="https://cloudon.gr" target="_blank" rel="noopener noreferrer"
            className={`flex shrink-0 items-center justify-center gap-2 border-t border-slate-200/70 py-3 opacity-70 transition hover:opacity-100 dark:border-slate-800 ${collapsed ? "md:px-0" : "px-3"}`}>
            <span className={`text-[10px] font-medium uppercase tracking-wide text-slate-400 ${hide}`}>Powered by</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={CLOUDON_LOGO_DATA_URI} alt="CloudOn" className="h-4 w-auto" />
          </a>
        </Tooltip>
        <div className={`shrink-0 pb-2 text-center text-[10px] text-slate-400 ${hide}`}>RxVision v{APP_VERSION}</div>
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
      {picking && (
        <PickerModal groups={groups} pinned={pinned} pinnedGroups={[...pinnedGroups]} t={t}
          onClose={() => setPicking(false)}
          onSave={async (items, gs) => { await savePins(items, gs); setPicking(false); }} />
      )}
    </>
  );
}

/** Επιλογή «δικών μου»: ΟΛΟΙ οι προορισμοί που βλέπει αυτός ο χειριστής, σε μία λίστα.
 *  Γιατί λίστα και όχι αστεράκια στο μενού: σε κινητό το hover δεν υπάρχει, και το να
 *  βλέπεις τα πάντα μαζί κάνει την επιλογή μία δουλειά αντί για δέκα. */
function PickerModal({ groups, pinned, pinnedGroups, t, onClose, onSave }: {
  groups: Group[]; pinned: Pin[]; pinnedGroups: string[];
  t: (el: string, en: string) => string;
  onClose: () => void; onSave: (items: Pin[], groups: string[]) => Promise<void>;
}) {
  const [sel, setSel] = useState<Pin[]>(pinned);
  const [selG, setSelG] = useState<string[]>(pinnedGroups);
  const [busy, setBusy] = useState(false);

  const rows = groups.map((g) => ({
    title: g.title, en: g.en, icon: g.icon,
    items: g.items.flatMap((n) => n.children
      ? n.children.map((c) => ({ href: c.href, label: `${n.label} · ${c.label}`, en: `${n.en} · ${c.en}` }))
      : n.href ? [{ href: n.href, label: n.label, en: n.en }] : []),
  })).filter((r) => r.items.length);

  const groupOn = (title: string) => selG.includes(title);
  const itemOn = (title: string, href: string) => groupOn(title) || sel.some((x) => x.href === href);

  const toggleGroup = (r: (typeof rows)[number]) => {
    if (groupOn(r.title)) {
      setSelG((p) => p.filter((x) => x !== r.title));
      setSel((p) => p.filter((x) => !r.items.some((i) => i.href === x.href)));   // καθάρισε και τα επιμέρους
    } else {
      setSelG((p) => [...p, r.title]);
      setSel((p) => p.filter((x) => !r.items.some((i) => i.href === x.href)));   // η ομάδα τα καλύπτει
    }
  };

  /** Ξετσεκάροντας ΜΙΑ επιλογή ενώ είναι διαλεγμένο όλο το κύκλωμα, το κύκλωμα «σπάει» στις
   *  υπόλοιπες επιλογές του — αλλιώς ή θα έχανες όλο το κύκλωμα ή δεν θα γινόταν τίποτα. */
  const toggleItem = (r: (typeof rows)[number], it: Pin) => {
    if (groupOn(r.title)) {
      setSelG((p) => p.filter((x) => x !== r.title));
      setSel((p) => [...p, ...r.items.filter((i) => i.href !== it.href)]);
      return;
    }
    setSel((p) => p.some((x) => x.href === it.href) ? p.filter((x) => x.href !== it.href) : [...p, it]);
  };

  const count = selG.reduce((n, tt) => n + (rows.find((r) => r.title === tt)?.items.length ?? 0), 0) + sel.length;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-white dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-100 p-5 dark:border-slate-800">
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{t("Τα δικά μου", "My menu")}</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {t("Διάλεξε ολόκληρα κυκλώματα ή μεμονωμένες δουλειές — όσες θέλεις.",
                 "Pick whole sections or individual tasks — as many as you want.")}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500 dark:bg-slate-800">{count}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {rows.map((r) => {
            const gOn = groupOn(r.title);
            const GIcon = r.icon;
            return (
              <div key={r.title} className="mb-3">
                {/* Επικεφαλίδα κυκλώματος = ΕΠΙΛΕΞΙΜΗ: «όλη η Ανάλυση» με ένα κλικ. */}
                <button onClick={() => toggleGroup(r)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide transition ${gOn ? "bg-brand-600 text-white" : "text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"}`}>
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${gOn ? "border-white bg-white/25 text-white" : "border-slate-300 dark:border-slate-600"}`}>
                    {gOn && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  <GIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                  {t(r.title, r.en)}
                  <span className={`ml-auto font-normal normal-case ${gOn ? "text-white/70" : "text-slate-400"}`}>
                    {gOn ? t("όλο το κύκλωμα", "whole section") : `${r.items.length}`}
                  </span>
                </button>
                {r.items.map((it) => {
                  const on = itemOn(r.title, it.href);
                  return (
                    <button key={it.href} onClick={() => toggleItem(r, it)}
                      className={`flex w-full items-center gap-2 rounded-lg py-1.5 pl-6 pr-2.5 text-left text-sm transition ${on ? "font-semibold text-brand-700 dark:text-brand-300" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"}`}>
                      <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? "border-brand-500 bg-brand-500 text-white" : "border-slate-300 dark:border-slate-600"}`}>
                        {on && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      {t(it.label || it.href, it.en || it.label || it.href)}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 p-4 dark:border-slate-800">
          <button onClick={onClose} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 dark:border-slate-600 dark:text-slate-300">{t("Άκυρο", "Cancel")}</button>
          <button onClick={async () => { setBusy(true); try { await onSave(sel, selG); } finally { setBusy(false); } }} disabled={busy}
            className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {t("Αποθήκευση", "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
