"use client";

/* Ομάδες & Δικαιώματα (back-office) — ίδιο μοτίβο με τα «Ρόλοι & Δικαιώματα» της πλευράς
   φαρμακείου: περιοχές που ανοίγουν, μία στήλη ανά ομάδα, ένα κλικ ανά κελί, αυτόματη
   αποθήκευση. Καμία φόρμα, κανένα modal — 84 δικαιώματα δεν χωράνε σε διάλογο.

   ⚠️ Αυτό ΕΙΝΑΙ ασφάλεια, όχι εμφάνιση: ό,τι αφαιρείς εδώ το μπλοκάρει ο διακομιστής σε
   κάθε αίτημα, ακόμη κι αν κάποιος γράψει τη διεύθυνση απευθείας. */

import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import {
  Check, ChevronRight, Loader2, Plus, Search, ShieldAlert, ShieldCheck, Trash2, Users,
} from "lucide-react";

type Perm = { _id: string; section: string; label: string; sensitive: boolean };
type Area = { key: string; label: string; permissions: Perm[] };
type Catalog = { sections: Area[]; sensitive: string[] };
type Group = {
  id: string; key: string | null; name: string; description: string;
  permissions: string[]; is_system: boolean; members: number;
};

export default function GroupsPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  const catalogQ = useQuery({ queryKey: ["admin", "permissions"], queryFn: () => adminApi<Catalog>("/admin/permissions"), retry: false });
  const groupsQ = useQuery({ queryKey: ["admin", "groups"], queryFn: () => adminApi<{ items: Group[] }>("/admin/groups"), retry: false });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["admin", "groups"] });
    qc.invalidateQueries({ queryKey: ["admin", "staff"] });
  };
  const save = useMutation({
    mutationFn: (v: { id: string; permissions: string[] }) =>
      adminApi(`/admin/groups/${v.id}`, { method: "PATCH", body: JSON.stringify({ permissions: v.permissions }) }),
    onSuccess: inv,
  });

  const catalog = catalogQ.data;
  const groups = useMemo(
    () => [...(groupsQ.data?.items ?? [])].sort((a, b) =>
      Number(!!b.is_system) - Number(!!a.is_system) || a.name.localeCompare(b.name, "el")),
    [groupsQ.data]);

  // Αναζήτηση: κρατά τις περιοχές που έχουν ταίριασμα και τις ανοίγει αυτόματα, ώστε να
  // βρίσκεις μια ενέργεια χωρίς να ξέρεις σε ποια ενότητα ανήκει.
  const areas: Area[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!catalog) return [];
    if (!needle) return catalog.sections;
    return catalog.sections
      .map((a) => ({ ...a, permissions: a.permissions.filter((p) =>
        p.label.toLowerCase().includes(needle) || p._id.toLowerCase().includes(needle)) }))
      .filter((a) => a.permissions.length > 0);
  }, [catalog, q]);
  const searching = q.trim().length > 0;

  if (catalogQ.isLoading || groupsQ.isLoading)
    return <div className="grid place-items-center p-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;
  if (!catalog || !groupsQ.data)
    return <p className="p-6 text-sm text-slate-400">Χρειάζεται δικαίωμα διαχείρισης χρηστών.</p>;

  const has = (g: Group, key: string) => g.permissions.includes("*") || g.permissions.includes(key);

  async function apply(g: Group, keys: string[], on: boolean) {
    const sensitive = keys.filter((k) => catalog!.sensitive.includes(k));
    if (on && sensitive.length) {
      const names = sensitive
        .map((k) => catalog!.sections.flatMap((a) => a.permissions).find((p) => p._id === k)?.label ?? k);
      const ok = await appConfirm(
        `Η ομάδα «${g.name}» θα αποκτήσει επικίνδυνη πρόσβαση:\n\n• ${names.join("\n• ")}\n\nΚάθε χρήση καταγράφεται στο Αρχείο ενεργειών.`,
        { title: "Επικίνδυνο δικαίωμα", danger: true, confirmText: "Ναι, δώσε το" });
      if (!ok) return;
    }
    const next = new Set(g.permissions);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    setBusy(`${g.id}|${keys[0]}`);
    try { await save.mutateAsync({ id: g.id, permissions: [...next] }); }
    catch { appAlert("Η αλλαγή δεν αποθηκεύτηκε."); }
    finally { setBusy(null); }
  }

  async function addGroup() {
    const name = (await appPrompt("Όνομα νέας ομάδας (π.χ. «Υποστήριξη βάρδιας», «Λογιστής»)",
      { title: "Νέα ομάδα", confirmText: "Δημιουργία" }))?.trim();
    if (!name) return;
    try {
      await adminApi("/admin/groups", { method: "POST", body: JSON.stringify({ name, description: "", permissions: [] }) });
      inv();
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: string })?.detail : null;
      appAlert(d === "name_in_use" ? "Υπάρχει ήδη ομάδα με αυτό το όνομα." : "Δεν δημιουργήθηκε η ομάδα.");
    }
  }

  async function removeGroup(g: Group) {
    if (!(await appConfirm(`Διαγραφή της ομάδας «${g.name}»;`,
      { title: "Διαγραφή ομάδας", danger: true, confirmText: "Διαγραφή" }))) return;
    try { await adminApi(`/admin/groups/${g.id}`, { method: "DELETE" }); inv(); }
    catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: { error?: string; members?: number } })?.detail : null;
      appAlert(d?.error === "group_in_use"
        ? `Η ομάδα «${g.name}» έχει ${d.members} μέλη. Βγάλ' τα πρώτα από την ομάδα.`
        : "Δεν διαγράφηκε η ομάδα.");
    }
  }

  async function rename(g: Group) {
    const name = (await appPrompt("Νέο όνομα", { title: `Ομάδα «${g.name}»`, confirmText: "Αποθήκευση" }))?.trim();
    if (!name || name === g.name) return;
    try { await adminApi(`/admin/groups/${g.id}`, { method: "PATCH", body: JSON.stringify({ name }) }); inv(); }
    catch { appAlert("Δεν αποθηκεύτηκε το όνομα."); }
  }

  const Cell = ({ g, keys, on, danger }: { g: Group; keys: string[]; on: boolean | "some"; danger?: boolean }) => {
    const k = `${g.id}|${keys[0]}`;
    const isBusy = busy === k;
    return (
      <button
        onClick={() => apply(g, keys, on !== true)}
        disabled={isBusy}
        title={on === true ? "Έχει πρόσβαση — πάτα για να αφαιρεθεί"
          : on === "some" ? "Μερική πρόσβαση — πάτα για όλα"
          : "Χωρίς πρόσβαση — πάτα για να δοθεί"}
        className={`grid h-7 w-7 place-items-center rounded-lg transition ${
          on === true
            ? danger
              ? "bg-rose-100 text-rose-600 hover:bg-rose-200"
              : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
            : on === "some" ? "bg-amber-50 text-amber-600 hover:bg-amber-100"
            : "bg-slate-100 text-slate-300 hover:bg-slate-200"}`}>
        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-4 w-4" strokeWidth={3} />}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Ομάδες & Δικαιώματα</h1>
          <p className="mt-1 text-sm text-slate-500">
            Φτιάξε ομάδες για τους υπαλλήλους σου και δώσε στην καθεμία ακριβώς όση πρόσβαση
            χρειάζεται. Άνοιξε μια περιοχή για να δεις τι περιλαμβάνει. Οι αλλαγές
            αποθηκεύονται αμέσως.
          </p>
        </div>
        <button onClick={addGroup}
          className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
          <Plus className="h-4 w-4" />Νέα ομάδα
        </button>
      </header>

      <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-900">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Αυτό ΕΙΝΑΙ ασφάλεια, όχι απλώς εμφάνιση. Ό,τι αφαιρέσεις εδώ, ο διακομιστής το
          μπλοκάρει σε κάθε αίτημα — ακόμη κι αν κάποιος γράψει τη διεύθυνση απευθείας.
          Η αλλαγή ισχύει αμέσως, χωρίς να χρειαστεί ο υπάλληλος να ξανασυνδεθεί.
        </span>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Αναζήτηση ενέργειας (π.χ. «διαγραφή», «τιμολόγ»)"
          className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:outline-none" />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left font-semibold">
                Περιοχή / ενέργεια
              </th>
              {groups.map((g) => (
                <th key={g.id} className="w-32 px-0 py-2.5 text-center font-semibold">
                  <div className="flex flex-col items-center gap-0.5">
                    <button onClick={() => rename(g)} title="Μετονομασία"
                      className="max-w-[7rem] truncate text-slate-700 hover:text-indigo-600">
                      {g.name}
                    </button>
                    <span className="flex items-center gap-2 text-[11px] font-normal text-slate-400">
                      <span className="flex items-center gap-0.5"><Users className="h-3 w-3" />{g.members}</span>
                      {!g.is_system && (
                        <button onClick={() => removeGroup(g)} title="Διαγραφή ομάδας"
                          className="text-slate-300 hover:text-rose-500"><Trash2 className="h-3 w-3" /></button>
                      )}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {areas.map((a) => {
              const isOpen = searching || open.has(a.key);
              const keys = a.permissions.map((p) => p._id);
              return (
                <Fragment key={a.key}>
                  <tr className="bg-slate-50/50">
                    <td className="sticky left-0 z-10 bg-slate-50/50 px-4 py-2">
                      <button
                        onClick={() => setOpen((p) => {
                          const n = new Set(p); n.has(a.key) ? n.delete(a.key) : n.add(a.key); return n;
                        })}
                        className="flex items-center gap-1.5 font-semibold text-slate-700 hover:text-indigo-600">
                        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                        {a.label}
                        <span className="text-[11px] font-normal text-slate-400">({a.permissions.length})</span>
                      </button>
                    </td>
                    {groups.map((g) => {
                      const n = keys.filter((k) => has(g, k)).length;
                      const state: boolean | "some" = n === 0 ? false : n === keys.length ? true : "some";
                      return (
                        <td key={g.id} className="w-32 px-0 py-2">
                          <div className="flex justify-center"><Cell g={g} keys={keys} on={state} /></div>
                        </td>
                      );
                    })}
                  </tr>
                  {isOpen && a.permissions.map((p) => (
                    <tr key={p._id} className={p.sensitive ? "bg-rose-50/30" : undefined}>
                      {/* το sticky κελί χρειάζεται ΔΙΚΟ του αδιαφανές φόντο, αλλιώς φαίνεται
                          από κάτω η στήλη που κυλάει */}
                      <td className={`sticky left-0 z-10 py-1.5 pl-11 pr-4 ${p.sensitive ? "bg-rose-50" : "bg-white"}`}>
                        <span className={p.sensitive ? "text-rose-700" : "text-slate-600"}>
                          {p.label}
                          {p.sensitive && <ShieldAlert className="ml-1 inline h-3 w-3" />}
                        </span>
                      </td>
                      {groups.map((g) => (
                        <td key={g.id} className="w-32 px-0 py-1.5">
                          <div className="flex justify-center">
                            <Cell g={g} keys={[p._id]} on={has(g, p._id)} danger={p.sensitive} />
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {areas.length === 0 && (
              <tr><td colSpan={groups.length + 1} className="px-4 py-8 text-center text-sm text-slate-400">
                Καμία ενέργεια δεν ταιριάζει με «{q}».
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-slate-400">
        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />
        <span>
          Οι κόκκινες γραμμές είναι επικίνδυνες ενέργειες (σύνδεση ως πελάτης, credentials,
          οριστική διαγραφή, κλειδιά διασυνδέσεων, λειτουργίες σε servers). Δεν περιλαμβάνονται
          σε καμία προεπιλεγμένη ομάδα και κάθε χρήση τους καταγράφεται. Τα μέλη κάθε ομάδας
          ορίζονται στο <a href="/admin/staff" className="text-indigo-500 hover:underline">Σύστημα → Χρήστες</a>.
        </span>
      </p>
    </div>
  );
}
