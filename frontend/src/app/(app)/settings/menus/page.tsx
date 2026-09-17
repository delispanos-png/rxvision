"use client";

/* Μενού ανά ρόλο — ο ιδιοκτήτης αποφασίζει τι βλέπει κάθε ομάδα χειριστών.

   ⚠️ ΕΜΦΑΝΙΣΗ, ΟΧΙ ΑΣΦΑΛΕΙΑ. Κρύβοντας μια ενότητα μειώνεις τον θόρυβο· ΔΕΝ εμποδίζεις
   κανέναν να ανοίξει τη διεύθυνση. Αν κάτι πρέπει να απαγορεύεται, αφαιρείται δικαίωμα
   από τους Ρόλους — δεν κρύβεται μενού. */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { NAV_GROUPS } from "@/components/layout/navCatalog";
import { Eye, EyeOff, ShieldAlert, Loader2 } from "lucide-react";

type Res = { roles: string[]; menus: Record<string, string[]> };
const ROLE_EL: Record<string, string> = {
  owner: "Ιδιοκτήτης", manager: "Διαχειριστής", pharmacist: "Φαρμακοποιός", staff: "Προσωπικό",
};

export default function MenusPage() {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["nav", "role-menus"], queryFn: () => api<Res>("/nav/role-menus"), retry: false });

  const save = useMutation({
    mutationFn: (v: { role: string; hidden: string[] }) =>
      api(`/nav/role-menus/${encodeURIComponent(v.role)}`, { method: "PUT", body: JSON.stringify({ hidden_groups: v.hidden }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["nav", "role-menus"] }); qc.invalidateQueries({ queryKey: ["nav", "prefs"] }); },
  });

  async function toggle(role: string, group: string) {
    const cur = new Set(q.data?.menus[role] ?? []);
    cur.has(group) ? cur.delete(group) : cur.add(group);
    setBusy(`${role}|${group}`);
    try { await save.mutateAsync({ role, hidden: [...cur] }); } finally { setBusy(null); }
  }

  if (q.isLoading) return <div className="grid place-items-center p-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;
  if (!q.data) return <p className="p-6 text-sm text-slate-400">{t("Χρειάζεται δικαίωμα ρυθμίσεων.", "Settings permission required.")}</p>;

  const roles = q.data.roles.filter((r) => r !== "owner");   // ο ιδιοκτήτης βλέπει πάντα τα πάντα

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Μενού ανά ρόλο", "Menu per role")}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("Διάλεξε τι βλέπει κάθε ομάδα χειριστών. Λιγότερες ενότητες σημαίνει λιγότερο ψάξιμο για ανθρώπους που κάνουν συγκεκριμένη δουλειά.",
             "Choose what each group of operators sees. Fewer sections means less searching for people with a specific job.")}
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
        <table className="w-full min-w-[620px] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800/60">
            <tr>
              <th className="px-4 py-2.5 text-left font-semibold">{t("Ενότητα μενού", "Menu section")}</th>
              {roles.map((r) => <th key={r} className="px-3 py-2.5 text-center font-semibold">{ROLE_EL[r] ?? r}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {NAV_GROUPS.map((g) => (
              <tr key={g.title}>
                <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">{t(g.title, g.en)}</td>
                {roles.map((r) => {
                  const hidden = (q.data!.menus[r] ?? []).includes(g.title);
                  const k = `${r}|${g.title}`;
                  return (
                    <td key={r} className="px-3 py-2 text-center">
                      <button onClick={() => toggle(r, g.title)} disabled={busy === k}
                        title={hidden ? t("Κρυμμένο — πάτα για να φανεί", "Hidden — click to show") : t("Ορατό — πάτα για να κρυφτεί", "Visible — click to hide")}
                        className={`grid h-7 w-7 place-items-center rounded-lg transition ${hidden ? "bg-slate-100 text-slate-400 hover:bg-slate-200 dark:bg-slate-800" : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-900/30"}`}>
                        {busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
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
