"use client";

import { useEffect, useRef, useState } from "react";
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
import { helpFor } from "@/lib/help";
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
  // Κλειδί ανά ΟΜΑΔΑ: το ίδιο όνομα («Ρυθμίσεις») υπάρχει σε πολλές ομάδες και δεν πρέπει
  // να ανοιγοκλείνουν μαζί.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const nodeKey = (group: string, label: string) => `${group}|${label}`;
  const sectionKey = (group: string, label: string) => `§${group}|${label}`;
  // Κλειστό μενού (μόνο εικονίδια, desktop): ΕΝΑ εικονίδιο ανά κύκλωμα· με hover/κλικ ανοίγει
  // πάνελ δίπλα με όλες τις επιλογές του. Πριν φαίνονταν ~40 εικονίδια χωρίς διαχωρισμό.
  const [fly, setFly] = useState<{ title: string; top: number } | null>(null);
  const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyKeep = () => { if (flyTimer.current) { clearTimeout(flyTimer.current); flyTimer.current = null; } };
  const flyClose = () => { flyKeep(); flyTimer.current = setTimeout(() => setFly(null), 180); };
  const flyOpen = (title: string, el: HTMLElement) => {
    flyKeep();
    const r = el.getBoundingClientRect();
    setFly({ title, top: r.top });
  };
  useEffect(() => { setFly(null); }, [pathname]);
  useEffect(() => {
    if (!fly) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFly(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fly]);
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
  const addonsQ = useQuery({ queryKey: ["addons"], queryFn: () => api<{ addons: { _id: string; status: string; offered?: boolean; no_trial?: boolean; can_trial?: boolean }[]; trial_used?: boolean }>("/addons"), retry: false });
  // Ποια πρόσθετα ΔΕΝ έχουν δωρεάν δοκιμή. Χωρίς αυτό, το μενού έδειχνε κουμπί «Δωρεάν δοκιμή»
  // που ήταν βέβαιο ότι θα αποτύχει — ο πελάτης το πατά, τρώει μήνυμα, ξαναπατά, τηλεφωνεί.
  // Πόσες σημειώσεις έκδοσης δεν έχει δει ακόμη — μικρό σήμα δίπλα στην έκδοση.
  const rnQ = useQuery({ queryKey: ["release-notes-badge"], retry: false, staleTime: 300_000,
    queryFn: () => api<{ unseen: number }>("/release-notes") });
  const newCount = rnQ.data?.unseen || 0;
  // ΠΟΤΕ δεύτερη 14ήμερη δοκιμή: ο διακομιστής απαντά `can_trial` ανά πρόσθετο (ίδια πηγή με το
  // start_trial). Η οθόνη ΔΕΝ ξανα-υπολογίζει τον κανόνα — αλλιώς θα πρότεινε δοκιμή που θα
  // απορριπτόταν, και ο πελάτης θα το μάθαινε πατώντας το κουμπί.
  const canTrial = (m?: string) => !!addonsQ.data?.addons?.find((a) => a._id === m)?.can_trial;
  const trialUsed = !!addonsQ.data?.trial_used;
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
    } catch (e) {
      // ΔΕΙΞΕ ΤΟΝ ΠΡΑΓΜΑΤΙΚΟ ΛΟΓΟ. Το «δοκίμασε ξανά» ήταν χειρότερο από άχρηστο: όταν ο
      // λόγος είναι «έχεις ήδη χρησιμοποιήσει τη δοκιμή», η επανάληψη ΔΕΝ πρόκειται να
      // δουλέψει ποτέ — ο πελάτης ξαναπατά, ξαναποτυγχάνει, και τηλεφωνεί.
      const d = (e as { problem?: { detail?: { message?: string; error?: string } } })?.problem?.detail;
      appAlert(d?.message
        || t("Δεν ήταν δυνατή η έναρξη δοκιμής. Επικοινώνησε μαζί μας.",
             "Could not start the trial. Please contact us."));
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
    ? n.children.filter((c) => visible(c.href) && allowedMod(c.module)).map((c) => ({ href: c.href, label: `${n.label} · ${c.label}`, en: `${n.en} · ${c.en}`, icon: n.icon }))
    : n.href && visible(n.href) ? [{ href: n.href, label: n.label, en: n.en, icon: n.icon }] : [];
  const groups = GROUPS
    .filter((g) => !hiddenGroups.has(g.title))
    .map((g) => ({
      ...g,
      items: g.items
        .filter((n) => allowedMod(n.module) || canUpsell(n.module))
        // Τα ΠΑΙΔΙΑ φιλτράρονται ΚΑΙ ως προς το module τους, όχι μόνο ως προς τις
        // προτιμήσεις. Αλλιώς, μόλις η ενότητα ανοίξει για ΕΝΑ πρόσθετο, θα φαίνονταν
        // και οι υπόλοιπες επιλογές της — σελίδες που ο πελάτης δεν έχει αγοράσει.
        // ⚠️ ΑΛΛΑ κρατάμε όσα είναι ΑΓΟΡΑΣΙΜΑ, ακριβώς όπως τα top-level (γρ. παραπάνω):
        // αλλιώς οι «Οικογένειες» ΕΞΑΦΑΝΙΖΟΝΤΑΝ, ενώ οι «Δομές Φροντίδας» — που τυχαίνει να
        // είναι top-level — έδειχναν λουκέτο. Πάγιος κανόνας: πληρωμένο module ΠΟΤΕ αόρατο.
        .map((n) => (n.children
          ? { ...n, children: n.children.filter(
              (c) => visible(c.href) && (allowedMod(c.module) || canUpsell(c.module))) }
          : n))
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
      const onPath = (href?: string) => {
        if (!href) return false;
        const base = href.split(/[?#]/)[0];
        return pathname === base || pathname.startsWith(base + "/");
      };
      for (const g of GROUPS) for (const n of g.items) {
        const here = onPath(n.href) || !!n.children?.some((c) => onPath(c.href));
        if (!here) continue;
        if (n.children) next.add(nodeKey(g.title, n.label));
        if (n.section) next.add(sectionKey(g.title, n.section.label));
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
  /** Tooltip μενού = η ίδια εξήγηση με τη βοήθεια «?» της σελίδας (μία πηγή: lib/help.ts). Μαζεμένο μενού →
   *  και το όνομα (αλλιώς δεν φαίνεται). `withName` για ομάδες όπου το όνομα κρύβεται πίσω από εικονίδιο. */
  const tip = (href: string, name: string, withName = false): string | undefined => {
    const h = helpFor(href.split(/[?#]/)[0]);
    const intro = h ? t(h.intro, h.intro_en || h.intro) : "";
    if (collapsed || withName) return intro ? `${name} — ${intro}` : name;
    return intro || undefined;
  };
  const linkCls = (active: boolean) =>
    `group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${collapsed ? "md:justify-center md:px-0" : ""} ${
      active ? "bg-brand-50 text-brand-700 dark:bg-brand-600/15 dark:text-brand-300"
             : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"}`;
  const iconCls = (active: boolean) =>
    `h-[18px] w-[18px] shrink-0 ${active ? "text-brand-600 dark:text-brand-300" : "text-slate-400 group-hover:text-slate-600 dark:text-slate-500"}`;

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[min(18rem,85vw)] shrink-0 flex-col border-r border-slate-200/70 bg-white transition-all duration-200 dark:border-slate-800 dark:bg-slate-900 md:sticky md:top-0 md:h-screen md:self-start md:w-72 md:translate-x-0 ${collapsed ? "md:w-[72px]" : "md:w-72"} ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className={`flex h-16 items-center px-5 ${collapsed ? "md:justify-center md:px-0" : ""}`}>
          {/* logo → marketing site (rxvision.gr) */}
          <a href="https://rxvision.gr" title="rxvision.gr" className="transition hover:opacity-80">
            <div className={collapsed ? "md:hidden" : ""}><Logo markClassName="h-9 w-9" /></div>
            {collapsed && <LogoMark className="hidden h-9 w-9 md:block" />}
          </a>
        </div>

        {/* ΕΚΔΟΣΗ ΠΑΝΩ, ΟΧΙ ΚΑΤΩ. Στο υποσέλιδο κανείς δεν κοιτάζει, οπότε μια νέα δυνατότητα
            περνούσε απαρατήρητη. Όταν υπάρχει κάτι νέο γίνεται πρόσκληση που κουνιέται·
            όταν δεν υπάρχει, ξαναγίνεται διακριτικός αριθμός έκδοσης. */}
        <div className={`px-3 pb-2 ${collapsed ? "md:hidden" : ""}`}>
          {newCount ? (
            <Link href="/whats-new"
              className="flex animate-pulse items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-600 px-3 py-2 text-white shadow-md transition hover:from-violet-600 hover:to-indigo-700">
              <Sparkles className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 text-xs font-semibold leading-tight">
                {t("Δες τις νέες δυνατότητες", "See what's new")}
              </span>
              <span className="rounded-full bg-white/25 px-1.5 text-[10px] font-bold">{newCount}</span>
            </Link>
          ) : (
            <Link href="/whats-new"
              className="block text-center text-[10px] text-slate-400 transition hover:text-brand-600">
              RxVision v{APP_VERSION}
            </Link>
          )}
        </div>

        <nav className={`flex-1 overflow-y-auto px-3 py-4 ${mode === "personal" ? "space-y-6" : "space-y-1"}`}>
          {/* ΔΙΑΚΟΠΤΗΣ: ή το κεντρικό μενού (όπως το ορίζει ο ρόλος του) ή ΜΟΝΟ τα δικά του.
              Όχι και τα δύο μαζί — αυτό ήταν το αρχικό λάθος: το «προσωπικό» απλώς πρόσθετε
              άλλη μια ενότητα σε ένα μενού που ήταν ήδη μεγάλο. */}
          <div className={`flex items-center gap-1.5 ${mode === "personal" ? "" : "!mb-4"} ${hide}`}>
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
                        ? <a key={l.href} href={l.href} title={tip(l.href, t(l.label, l.en))} className={linkCls(active)} onClick={() => setOpen(false)}>{inner}</a>
                        : <Link key={l.href} href={l.href} title={tip(l.href, t(l.label, l.en))} className={linkCls(active)}>{inner}</Link>;
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
                  <button key={g.title} onClick={() => openUpsell(n)} title={collapsed ? t(n.label, n.en) : undefined} className={`${linkCls(false)} w-full border border-blue-200 bg-blue-50/50 dark:border-blue-900/60 dark:bg-blue-950/20`}>
                    <Icon className={iconCls(false)} strokeWidth={2} />
                    <span className={`flex-1 text-left ${hide}`}>{t(n.label, n.en)}</span>
                    <span className={`ml-auto inline-flex shrink-0 items-center rounded-full bg-blue-100 p-1 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 ${hide}`}><Lock className="h-3 w-3" /></span>
                  </button>
                );
              }
              const inner = (<><Icon className={iconCls(active)} strokeWidth={2} /><span className={hide}>{t(n.label, n.en)}</span></>);
              return n.href!.includes("#")
                ? <a key={g.title} href={n.href!} title={tip(n.href!, t(n.label, n.en))} className={linkCls(active)} onClick={() => setOpen(false)}>{inner}</a>
                : <Link key={g.title} href={n.href!} title={tip(n.href!, t(n.label, n.en))} className={linkCls(active)}>{inner}</Link>;
            }
            const gCollapsed = collapsedGroups.has(g.title);
            const GroupIcon = g.icon;
            // κλειστή ομάδα που περιέχει την τρέχουσα σελίδα → τονίζεται, για να ξέρεις πού είσαι
            const gActive = gCollapsed && g.items.some(nodeActive);
            return (
            <div key={g.title}>
              {/* Επικεφαλίδα ομάδας = κουμπί πτύξης, ΙΔΙΑ εμφάνιση με τις απλές επιλογές πρώτου
                  επιπέδου (PharmaCat/Ρυθμίσεις/Chat) ώστε το μενού να διαβάζεται ως μία λίστα.
                  Κρύβεται όταν το sidebar είναι σε λειτουργία εικονιδίων. */}
              <button onClick={() => toggleGroup(g.title)} className={`${linkCls(gActive)} w-full font-semibold ${hide}`}>
                <GroupIcon className={iconCls(gActive)} strokeWidth={2} />
                <span className="flex-1 text-left leading-snug">{t(g.title, g.en)}</span>
                <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${gCollapsed ? "" : "rotate-90"}`} />
              </button>
              {collapsed && (
                <button onClick={(e) => (fly?.title === g.title ? setFly(null) : flyOpen(g.title, e.currentTarget))}
                  onMouseEnter={(e) => flyOpen(g.title, e.currentTarget)} onMouseLeave={flyClose}
                  aria-label={t(g.title, g.en)}
                  className={`${linkCls(g.items.some(nodeActive) || fly?.title === g.title)} hidden w-full md:flex`}>
                  <GroupIcon className={iconCls(g.items.some(nodeActive) || fly?.title === g.title)} strokeWidth={2} />
                </button>
              )}
              {!gCollapsed && (
              <div className={`mb-1 ml-5 mt-0.5 space-y-0.5 border-l border-slate-200 pl-2 dark:border-slate-700 ${collapsed ? "md:hidden" : ""}`}>
                {(() => {
                const renderNode = (n: Node) => {
                  const Icon = n.icon;
                  const active = nodeActive(n);
                  // locked circuit: keep in menu (dimmed + 🔒 + upsell) ONLY if it's a purchasable
                  // add-on offered by the package; otherwise hide it entirely.
                  if (!allowedMod(n.module)) {
                    if (!canUpsell(n.module)) return null;
                    return (
                      <button key={n.label} onClick={() => openUpsell(n)} title={collapsed ? t(n.label, n.en) : undefined}
                        className={`${linkCls(false)} w-full border border-blue-200 bg-blue-50/50 dark:border-blue-900/60 dark:bg-blue-950/20`}>
                        <Icon className={iconCls(false)} strokeWidth={2} />
                        <span className={`flex-1 text-left ${hide}`}>{t(n.label, n.en)}</span>
                        <span className={`ml-auto inline-flex shrink-0 items-center rounded-full bg-blue-100 p-1 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 ${hide}`}><Lock className="h-3 w-3" /></span>
                      </button>
                    );
                  }
                  // direct link (no children) — hash links (#tab) use <a>: Next <Link> uses pushState
                  // που ΔΕΝ πυροδοτεί `hashchange`, οπότε η σελίδα δεν θα άλλαζε καρτέλα.
                  if (!n.children) {
                    const inner = (<><Icon className={iconCls(active)} strokeWidth={2} /><span className={hide}>{t(n.label, n.en)}</span></>);
                    return n.href!.includes("#")
                      ? <a key={n.label} href={n.href!} title={tip(n.href!, t(n.label, n.en))} className={linkCls(active)} onClick={() => setOpen(false)}>{inner}</a>
                      : <Link key={n.label} href={n.href!} title={tip(n.href!, t(n.label, n.en))} className={linkCls(active)}>{inner}</Link>;
                  }
                  // expandable parent
                  const nk = nodeKey(g.title, n.label);
                  const isOpen = expanded.has(nk);
                  return (
                    <div key={n.label}>
                      <button onClick={() => toggle(nk)} className={`${linkCls(active)} w-full`}>
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
                            // κλειδωμένο παιδί: μένει ορατό, θαμπό, με 🔒 — το κλικ ανοίγει προσφορά
                            if (!allowedMod(c.module)) {
                              return (
                                <button key={c.href} onClick={() => openUpsell(c as Node)}
                                  className={`${cls} flex w-full items-center gap-2 border border-blue-200 bg-blue-50/50 dark:border-blue-900/60 dark:bg-blue-950/20`}>
                                  <span className="flex-1 text-left">{t(c.label, c.en)}</span>
                                  <span className="inline-flex shrink-0 items-center rounded-full bg-blue-100 p-1 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300"><Lock className="h-3 w-3" /></span>
                                </button>
                              );
                            }
                            return c.href.includes("#")
                              ? <a key={c.href} href={c.href} title={tip(c.href, t(c.label, c.en))} className={cls} onClick={() => setOpen(false)}>{t(c.label, c.en)}</a>
                              : <Link key={c.href} href={c.href} title={tip(c.href, t(c.label, c.en))} className={cls} onClick={() => setOpen(false)}>{t(c.label, c.en)}</Link>;
                          })}
                        </div>
                      )}
                    </div>
                  );
                };
                // Ενδιάμεσο επίπεδο (π.χ. «Ανάλυση εκτελέσεων»): συνεχόμενοι κόμβοι με την ίδια
                // `section` μπαίνουν κάτω από μια πτυσσόμενη υπο-επικεφαλίδα.
                const out: (JSX.Element | null)[] = [];
                for (let i = 0; i < g.items.length;) {
                  const sec = g.items[i].section;
                  if (!sec) { out.push(renderNode(g.items[i++])); continue; }
                  const members: Node[] = [];
                  while (i < g.items.length && g.items[i].section?.label === sec.label) members.push(g.items[i++]);
                  const sk = sectionKey(g.title, sec.label);
                  const sOpen = expanded.has(sk);
                  const sActive = members.some(nodeActive);
                  out.push(
                    <div key={sk}>
                      <button onClick={() => toggle(sk)} className={`${linkCls(sActive && !sOpen)} w-full`}>
                        <BarChart3 className={iconCls(sActive && !sOpen)} strokeWidth={2} />
                        <span className="flex-1 text-left">{t(sec.label, sec.en)}</span>
                        <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${sOpen ? "rotate-90" : ""}`} />
                      </button>
                      {sOpen && (
                        <div className="mt-1 ml-4 space-y-1 border-l border-slate-200 pl-2 dark:border-slate-700">
                          {members.map(renderNode)}
                        </div>
                      )}
                    </div>,
                  );
                }
                return out;
                })()}
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

      </aside>

      {/* Πάνελ κυκλώματος του κλειστού μενού — ΕΞΩ από το <aside>: το aside έχει transform και
          θα «έπιανε» το position:fixed. Ίδιο φιλτράρισμα (modules/ρόλος) με το ανοιχτό μενού. */}
      {collapsed && fly && (() => {
        const g = groups.find((x) => x.title === fly.title);
        if (!g) return null;
        const rowCls = (a: boolean) => `block rounded-lg px-3 py-1.5 text-sm transition-colors ${a
          ? "bg-brand-50 font-semibold text-brand-700 dark:bg-brand-600/15 dark:text-brand-300"
          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"}`;
        const lockCls = "flex w-full items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-1.5 text-left text-sm text-slate-500 dark:border-blue-900/60 dark:bg-blue-950/20";
        const go = (href: string, label: string, en: string, key: string) =>
          href.includes("#")
            ? <a key={key} href={href} title={tip(href, t(label, en))} className={rowCls(leafActive(href))} onClick={() => setFly(null)}>{t(label, en)}</a>
            : <Link key={key} href={href} title={tip(href, t(label, en))} className={rowCls(leafActive(href))} onClick={() => setFly(null)}>{t(label, en)}</Link>;
        const locked = (n: Node, key: string) => (
          <button key={key} onClick={() => { setFly(null); openUpsell(n); }} className={lockCls}>
            <span className="flex-1">{t(n.label, n.en)}</span><Lock className="h-3 w-3 text-blue-700 dark:text-blue-300" />
          </button>
        );
        const rows: JSX.Element[] = [];
        let lastSec: string | undefined;
        for (const n of g.items) {
          if (n.section?.label !== lastSec) {
            lastSec = n.section?.label;
            if (n.section) rows.push(<div key={`§${n.section.label}`} className="px-3 pb-0.5 pt-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">{t(n.section.label, n.section.en)}</div>);
          }
          if (!allowedMod(n.module)) { if (canUpsell(n.module)) rows.push(locked(n, n.label)); continue; }
          if (!n.children) { rows.push(go(n.href!, n.label, n.en, n.label)); continue; }
          rows.push(
            <div key={n.label}>
              <div className="px-3 pb-0.5 pt-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">{t(n.label, n.en)}</div>
              <div className="ml-3 space-y-0.5 border-l border-slate-200 pl-2 dark:border-slate-700">
                {n.children.map((c) => (allowedMod(c.module) ? go(c.href, c.label, c.en, c.href)
                  : locked({ ...c, icon: n.icon } as Node, c.href)))}
              </div>
            </div>,
          );
        }
        return (
          // Ξεκινά στο ύψος του εικονιδίου· αν δεν χωρά από κάτω, ανεβαίνει ώστε να φαίνεται ΟΛΟ.
          <div onMouseEnter={flyKeep} onMouseLeave={flyClose} style={{ top: fly.top }}
            ref={(el) => {
              if (!el) return;
              const room = window.innerHeight - el.offsetHeight - 8;
              el.style.top = `${Math.max(8, Math.min(fly.top, room))}px`;
            }}
            className="fixed left-[76px] z-50 hidden max-h-[calc(100vh-16px)] w-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900 md:block">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 pb-2 pt-1 text-sm font-bold text-slate-800 dark:border-slate-800 dark:text-slate-100">
              <g.icon className="h-4 w-4 text-brand-600" strokeWidth={2} />{t(g.title, g.en)}
            </div>
            <div className="mt-1 space-y-0.5">{rows}</div>
          </div>
        );
      })()}

      {upsell && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" onClick={() => setUpsell(null)}>
          <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setUpsell(null)} className="absolute right-4 top-4 text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg"><Sparkles className="h-6 w-6" /></div>
            <h3 className="mt-3 text-base font-bold text-slate-900 dark:text-slate-100">{t(upsell.label, upsell.en)}</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {canTrial(upsell.module)
                ? t("Δεν περιλαμβάνεται στο πακέτο σου. Δοκίμασέ το δωρεάν για 14 ημέρες ή αναβάθμισε το πλάνο σου.",
                     "Not included in your plan. Try it free for 14 days or upgrade your plan.")
                : trialUsed
                  ? t("Δεν περιλαμβάνεται στο πακέτο σου. Έχεις ήδη χρησιμοποιήσει τη δωρεάν δοκιμή δυνατοτήτων — ενεργοποιείται απευθείας.",
                       "Not included in your plan. You have already used your free feature trial — it is activated directly.")
                  : t("Δεν περιλαμβάνεται στο πακέτο σου. Ενεργοποιείται απευθείας, χωρίς δοκιμαστική περίοδο.",
                       "Not included in your plan. It is activated directly, with no trial period.")}
            </p>
            {canTrial(upsell.module) && (
              <button onClick={startTrial} disabled={trialBusy}
                className="mt-4 w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
                {trialBusy ? t("Έναρξη…", "Starting…") : t("✨ Δωρεάν δοκιμή 14 ημερών", "✨ Free 14-day trial")}
              </button>
            )}
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
