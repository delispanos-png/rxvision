"use client";

/* Ρόλοι & Δικαιώματα — ίδιο μοτίβο με το «Μενού ανά ρόλο»: περιοχές που ανοίγουν, μία στήλη
   ανά ρόλο, ένα κλικ ανά κελί.

   ⚠️ ΜΙΑ ΚΡΙΣΙΜΗ ΔΙΑΦΟΡΑ: το μενού είναι ΕΜΦΑΝΙΣΗ — αυτό ΕΙΝΑΙ ΑΣΦΑΛΕΙΑ. Εδώ δεν κρύβεις
   κουμπιά· δίνεις ή αφαιρείς πραγματική πρόσβαση, και ο server την επιβάλλει σε κάθε αίτημα.
   Γι' αυτό το πλαίσιο πάνω λέει το αντίθετο από εκείνο της άλλης σελίδας. */

import { Fragment, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { ShieldCheck, Lock, Loader2, ChevronRight, Plus, Trash2, Check } from "lucide-react";

type Perm = { _id: string; resource: string; action: string; module?: string | null; label: string; action_label: string };
type Group = { resource: string; label: string; items: Perm[] };
type Role = { _id: string; key: string; name: string; is_system?: boolean; permissions?: string[] };

export default function RolesPage() {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const catalog = useQuery({ queryKey: ["permissions"], queryFn: () => api<{ groups: Group[] }>("/permissions"), retry: false });
  const rolesQ = useQuery({ queryKey: ["roles"], queryFn: () => api<{ items: Role[] }>("/roles"), retry: false });

  const inv = () => { qc.invalidateQueries({ queryKey: ["roles"] }); qc.invalidateQueries({ queryKey: ["users"] }); };
  const save = useMutation({
    mutationFn: (v: { id: string; permissions: string[] }) =>
      api(`/roles/${v.id}`, { method: "PATCH", body: JSON.stringify({ permissions: v.permissions }) }),
    onSuccess: inv,
  });

  if (catalog.isLoading || rolesQ.isLoading) return <div className="grid place-items-center p-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;
  if (!catalog.data || !rolesQ.data) return <p className="p-6 text-sm text-slate-400">{t("Χρειάζεται δικαίωμα διαχείρισης χρηστών.", "Users management permission required.")}</p>;

  const groups = catalog.data.groups;
  // Ιεραρχική σειρά, όχι αλφαβητική: ο Ιδιοκτήτης πρώτος, οι δικές σου ομάδες τελευταίες.
  const ORDER = ["owner", "manager", "pharmacist", "staff"];
  const roles = [...rolesQ.data.items].sort((a, b) => {
    const ia = ORDER.indexOf(a.key), ib = ORDER.indexOf(b.key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name, "el");
  });
  const has = (r: Role, key: string) => (r.permissions ?? []).includes("*") || (r.permissions ?? []).includes(key);
  const locked = (r: Role) => !!r.is_system;

  async function apply(r: Role, keys: string[], on: boolean) {
    const cur = new Set(r.permissions ?? []);
    keys.forEach((k) => (on ? cur.add(k) : cur.delete(k)));
    setBusy(`${r._id}|${keys[0]}`);
    try { await save.mutateAsync({ id: r._id, permissions: [...cur] }); }
    catch (e) {
      const err = (e as { problem?: { detail?: { error?: string } } })?.problem?.detail?.error;
      appAlert(err === "last_admin_role"
        ? t("Δεν γίνεται: πρέπει να μείνει τουλάχιστον ένας ρόλος που μπορεί να διαχειρίζεται χρήστες — αλλιώς κλειδώνεσαι έξω από τον ίδιο σου τον λογαριασμό.",
             "Not allowed: at least one role must keep user management.")
        : t("Η αλλαγή δεν αποθηκεύτηκε.", "The change was not saved."));
    }
    finally { setBusy(null); }
  }

  async function addRole() {
    const name = (await appPrompt(t("Όνομα νέας ομάδας (π.χ. «Ταμείο», «Βοηθός»)", "New group name")))?.trim();
    if (!name) return;
    const key = `custom_${Date.now().toString(36)}`;
    try {
      await api("/roles", { method: "POST", body: JSON.stringify({ key, name, permissions: [] }) });
      inv();
    } catch { appAlert(t("Δεν δημιουργήθηκε η ομάδα.", "Could not create the group.")); }
  }

  async function removeRole(r: Role) {
    if (!(await appConfirm(t(`Διαγραφή της ομάδας «${r.name}»;`, `Delete group «${r.name}»?`), { danger: true, confirmText: t("Διαγραφή", "Delete") }))) return;
    try { await api(`/roles/${r._id}`, { method: "DELETE" }); inv(); }
    catch (e) {
      const d = (e as { problem?: { detail?: { error?: string; users?: number } } })?.problem?.detail;
      appAlert(d?.error === "role_in_use"
        ? t(`Η ομάδα χρησιμοποιείται από ${d.users} χρήστη/ες. Άλλαξέ τους ομάδα πρώτα.`, `In use by ${d?.users} user(s).`)
        : t("Δεν διαγράφηκε.", "Not deleted."));
    }
  }

  const Cell = ({ r, keys, on }: { r: Role; keys: string[]; on: boolean | "some" }) => {
    const k = `${r._id}|${keys[0]}`;
    if (locked(r)) {
      return <span title={t("Σταθερή ομάδα — δεν αλλάζει", "System group — fixed")}
        className={`grid h-7 w-7 place-items-center rounded-lg ${on ? "text-emerald-500" : "text-slate-300"}`}>
        {on ? <Check className="h-4 w-4" strokeWidth={3} /> : <Lock className="h-3.5 w-3.5" />}
      </span>;
    }
    return (
      <button onClick={() => apply(r, keys, on !== true)} disabled={busy === k}
        title={on === true ? t("Έχει πρόσβαση — πάτα για να αφαιρεθεί", "Has access — click to remove")
          : on === "some" ? t("Μερική πρόσβαση — πάτα για όλα", "Partial — click for all")
          : t("Χωρίς πρόσβαση — πάτα για να δοθεί", "No access — click to grant")}
        className={`grid h-7 w-7 place-items-center rounded-lg transition ${
          on === true ? "bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-900/30"
          : on === "some" ? "bg-amber-50 text-amber-600 hover:bg-amber-100 dark:bg-amber-900/30"
          : "bg-slate-100 text-slate-300 hover:bg-slate-200 dark:bg-slate-800"}`}>
        {busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-4 w-4" strokeWidth={3} />}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Ρόλοι & Δικαιώματα", "Roles & Permissions")}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("Φτιάξε ομάδες χειριστών και δώσε στην καθεμία ακριβώς όση πρόσβαση χρειάζεται. Άνοιξε μια περιοχή για να δεις τι περιλαμβάνει.",
               "Create groups of operators and give each exactly the access it needs.")}
          </p>
        </div>
        <button onClick={addRole} className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
          <Plus className="h-4 w-4" />{t("Νέα ομάδα", "New group")}
        </button>
      </header>

      <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {t("Αυτό ΕΙΝΑΙ ασφάλεια — σε αντίθεση με το «Μενού ανά ρόλο» που απλώς καθαρίζει την εμφάνιση. Ό,τι αφαιρέσεις εδώ, ο διακομιστής το μπλοκάρει σε κάθε αίτημα, ακόμη κι αν κάποιος γράψει τη διεύθυνση απευθείας.",
             "This IS security — unlike «Menu per role», which only declutters. What you remove here is enforced by the server on every request.")}
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800/60">
            <tr>
              <th className="px-4 py-2.5 text-left font-semibold">{t("Περιοχή / δικαίωμα", "Area / permission")}</th>
              {roles.map((r) => (
                <th key={r._id} className="w-32 px-0 py-2.5 text-center font-semibold">
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="flex items-center gap-1">
                      {r.is_system && <Lock className="h-3 w-3 text-slate-400" />}{r.name}
                    </span>
                    {!r.is_system && (
                      <button onClick={() => removeRole(r)} title={t("Διαγραφή ομάδας", "Delete group")}
                        className="text-slate-300 hover:text-rose-500"><Trash2 className="h-3 w-3" /></button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {groups.map((g) => {
              const isOpen = open.has(g.resource);
              const keys = g.items.map((i) => i._id);
              return (
                <Fragment key={g.resource}>
                  <tr className="bg-slate-50/50 dark:bg-slate-800/30">
                    <td className="px-4 py-2">
                      <button onClick={() => setOpen((p) => { const n = new Set(p); n.has(g.resource) ? n.delete(g.resource) : n.add(g.resource); return n; })}
                        className="flex items-center gap-1.5 font-semibold text-slate-700 hover:text-brand-600 dark:text-slate-200">
                        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                        {g.label}
                        <span className="text-[11px] font-normal text-slate-400">({g.items.length})</span>
                      </button>
                    </td>
                    {roles.map((r) => {
                      const n = keys.filter((k) => has(r, k)).length;
                      const state: boolean | "some" = n === 0 ? false : n === keys.length ? true : "some";
                      return <td key={r._id} className="w-32 px-0 py-2"><div className="flex justify-center"><Cell r={r} keys={keys} on={state} /></div></td>;
                    })}
                  </tr>
                  {isOpen && g.items.map((p) => (
                    <tr key={p._id}>
                      <td className="py-1.5 pl-12 pr-4 text-slate-600 dark:text-slate-300">
                        {p.label}
                        <span className="ml-1.5 text-[11px] text-slate-400">{p.action_label}</span>
                      </td>
                      {roles.map((r) => (
                        <td key={r._id} className="w-32 px-0 py-1.5"><div className="flex justify-center"><Cell r={r} keys={[p._id]} on={has(r, p._id)} /></div></td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        {t("Οι σταθερές ομάδες (Ιδιοκτήτης, Διαχειριστής, Φαρμακοποιός, Προσωπικό) δεν αλλάζουν — είναι το ασφαλές σημείο επιστροφής. Για δικούς σου συνδυασμούς φτιάξε νέα ομάδα. Πρέπει πάντα να μένει τουλάχιστον μία ομάδα που μπορεί να διαχειρίζεται χρήστες.",
           "System groups are fixed — they are the safe fallback. Create your own group for custom combinations. At least one group must always keep user management.")}
      </p>
    </div>
  );
}
