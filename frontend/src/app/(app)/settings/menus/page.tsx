"use client";

/* Μενού ανά ρόλο — ανά ΕΠΙΛΟΓΗ, όχι μόνο ανά ενότητα.

   Μια ενότητα σπάνια είναι «όλη ή τίποτα»: στις «Λειτουργίες» θες να μπαίνει στις οδηγίες
   και στους όρους, αλλά όχι στις Ρυθμίσεις. Στο eShop θες να βλέπει την Αποθήκη αλλά όχι
   τις Προμήθειες. Γι' αυτό κάθε ενότητα ανοίγει και δείχνει τις επιλογές της χωριστά.

   ⚠️ ΕΜΦΑΝΙΣΗ, ΟΧΙ ΑΣΦΑΛΕΙΑ. Κρύβοντας μια επιλογή μειώνεις τον θόρυβο· ΔΕΝ εμποδίζεις
   κανέναν να ανοίξει τη διεύθυνση. Αν κάτι πρέπει να απαγορεύεται, αφαιρείται δικαίωμα
   από τους Ρόλους. */

import { Fragment, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { NAV_GROUPS } from "@/components/layout/navCatalog";
import { Eye, EyeOff, ShieldAlert, Loader2, ChevronRight } from "lucide-react";

type Menu = { groups: string[]; items: string[] };
type Res = { roles: string[]; menus: Record<string, Menu> };
const ROLE_EL: Record<string, string> = {
  owner: "Ιδιοκτήτης", manager: "Διαχειριστής", pharmacist: "Φαρμακοποιός", staff: "Προσωπικό",
};

/** Κάθε ενότητα → η λίστα των προορισμών της (τα υπο-στοιχεία ξεδιπλώνονται). */
function leavesOf(g: (typeof NAV_GROUPS)[number]): { href: string; label: string; en: string }[] {
  return g.items.flatMap((n) => n.children
    ? n.children.map((c) => ({ href: c.href, label: `${n.label} · ${c.label}`, en: `${n.en} · ${c.en}` }))
    : n.href ? [{ href: n.href, label: n.label, en: n.en }] : []);
}

export default function MenusPage() {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const q = useQuery({ queryKey: ["nav", "role-menus"], queryFn: () => api<Res>("/nav/role-menus"), retry: false });

  const save = useMutation({
    mutationFn: (v: { role: string; body: Record<string, string[]> }) =>
      api(`/nav/role-menus/${encodeURIComponent(v.role)}`, { method: "PUT", body: JSON.stringify(v.body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["nav", "role-menus"] }); qc.invalidateQueries({ queryKey: ["nav", "prefs"] }); },
  });

  if (q.isLoading) return <div className="grid place-items-center p-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;
  if (!q.data) return <p className="p-6 text-sm text-slate-400">{t("Χρειάζεται δικαίωμα ρυθμίσεων.", "Settings permission required.")}</p>;

  const roles = q.data.roles.filter((r) => r !== "owner");   // ο ιδιοκτήτης βλέπει πάντα τα πάντα
  const menu = (r: string): Menu => q.data!.menus[r] ?? { groups: [], items: [] };

  /** Μια ενότητα είναι κρυφή είτε ρητά είτε επειδή κρύφτηκαν ΟΛΕΣ οι επιλογές της. */
  const groupState = (role: string, g: (typeof NAV_GROUPS)[number]): "on" | "off" | "some" => {
    const m = menu(role);
    if (m.groups.includes(g.title)) return "off";
    const ls = leavesOf(g);
    const hidden = ls.filter((l) => m.items.includes(l.href)).length;
    return hidden === 0 ? "on" : hidden === ls.length ? "off" : "some";
  };

  async function toggleGroup(role: string, g: (typeof NAV_GROUPS)[number]) {
    const m = menu(role);
    const state = groupState(role, g);
    const hrefs = leavesOf(g).map((l) => l.href);
    const groups = new Set(m.groups);
    const items = new Set(m.items);
    if (state === "on") { groups.add(g.title); hrefs.forEach((h) => items.add(h)); }
    else { groups.delete(g.title); hrefs.forEach((h) => items.delete(h)); }
    setBusy(`${role}|${g.title}`);
    try { await save.mutateAsync({ role, body: { hidden_groups: [...groups], hidden_items: [...items] } }); }
    finally { setBusy(null); }
  }

  async function toggleItem(role: string, g: (typeof NAV_GROUPS)[number], href: string) {
    const m = menu(role);
    const items = new Set(m.items);
    items.has(href) ? items.delete(href) : items.add(href);
    // Αν ξεκρύβεις μια επιλογή, η ενότητα δεν μπορεί να μένει «όλη κρυφή».
    const groups = new Set(m.groups);
    if (!items.has(href)) groups.delete(g.title);
    setBusy(`${role}|${href}`);
    try { await save.mutateAsync({ role, body: { hidden_groups: [...groups], hidden_items: [...items] } }); }
    finally { setBusy(null); }
  }

  const Btn = ({ state, k, onClick }: { state: "on" | "off" | "some"; k: string; onClick: () => void }) => (
    <button onClick={onClick} disabled={busy === k}
      title={state === "off" ? t("Κρυφό — πάτα για να φανεί", "Hidden — click to show")
        : state === "some" ? t("Μερικώς κρυφό — πάτα για να φανούν όλα", "Partly hidden — click to show all")
        : t("Ορατό — πάτα για να κρυφτεί", "Visible — click to hide")}
      className={`grid h-7 w-7 place-items-center rounded-lg transition ${
        state === "off" ? "bg-slate-100 text-slate-400 hover:bg-slate-200 dark:bg-slate-800"
        : state === "some" ? "bg-amber-50 text-amber-600 hover:bg-amber-100 dark:bg-amber-900/30"
        : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-900/30"}`}>
      {busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : state === "off" ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Μενού ανά ρόλο", "Menu per role")}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("Διάλεξε τι βλέπει κάθε ομάδα χειριστών — ολόκληρη ενότητα ή μεμονωμένες επιλογές. Άνοιξε μια ενότητα για να δεις τι περιέχει.",
             "Choose what each group sees — a whole section or individual items. Open a section to see what is in it.")}
        </p>
      </header>

      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {t("Αυτό καθαρίζει το μενού — δεν είναι ασφάλεια. Όποιος έχει το δικαίωμα μπορεί να ανοίξει τη σελίδα και από τη διεύθυνση. Αν κάτι πρέπει να απαγορεύεται, αφαίρεσε δικαίωμα από τους Ρόλους.",
             "This declutters the menu — it is not security. Anyone with the permission can still open the page by URL. To forbid something, remove the permission in Roles.")}
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800/60">
            <tr>
              <th className="px-4 py-2.5 text-left font-semibold">{t("Ενότητα / επιλογή", "Section / item")}</th>
              {/* Σταθερό πλάτος: η επικεφαλίδα κάθε ρόλου πρέπει να κάθεται ΑΚΡΙΒΩΣ πάνω από
                  τα ματάκια του. Με αυτόματο πλάτος, η πρώτη στήλη τραβούσε τον χώρο και οι
                  επικεφαλίδες έπεφταν δεξιά από τα κουμπιά. */}
              {roles.map((r) => <th key={r} className="w-28 px-0 py-2.5 text-center font-semibold">{ROLE_EL[r] ?? r}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {NAV_GROUPS.map((g) => {
              const isOpen = openGroups.has(g.title);
              const leaves = leavesOf(g);
              return (
                <Fragment key={g.title}>
                  <tr className="bg-slate-50/50 dark:bg-slate-800/30">
                    <td className="px-4 py-2">
                      <button onClick={() => setOpenGroups((p) => { const n = new Set(p); n.has(g.title) ? n.delete(g.title) : n.add(g.title); return n; })}
                        className="flex items-center gap-1.5 font-semibold text-slate-700 hover:text-brand-600 dark:text-slate-200">
                        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                        {t(g.title, g.en)}
                        <span className="text-[11px] font-normal text-slate-400">({leaves.length})</span>
                      </button>
                    </td>
                    {roles.map((r) => (
                      <td key={r} className="w-28 px-0 py-2">
                        <div className="flex justify-center"><Btn state={groupState(r, g)} k={`${r}|${g.title}`} onClick={() => toggleGroup(r, g)} /></div>
                      </td>
                    ))}
                  </tr>
                  {isOpen && leaves.map((l) => (
                    <tr key={`${g.title}|${l.href}`}>
                      <td className="py-1.5 pl-12 pr-4 text-slate-600 dark:text-slate-300">{t(l.label, l.en)}</td>
                      {roles.map((r) => {
                        const off = menu(r).items.includes(l.href) || menu(r).groups.includes(g.title);
                        return (
                          <td key={r} className="w-28 px-0 py-1.5">
                            <div className="flex justify-center"><Btn state={off ? "off" : "on"} k={`${r}|${l.href}`} onClick={() => toggleItem(r, g, l.href)} /></div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        {t("Ο Ιδιοκτήτης βλέπει πάντα τα πάντα. Κάθε χειριστής μπορεί επιπλέον να φτιάξει το δικό του «Τα δικά μου» από το μενού.",
           "The Owner always sees everything. Each operator can also build their own shortcuts from the menu.")}
      </p>
    </div>
  );
}
