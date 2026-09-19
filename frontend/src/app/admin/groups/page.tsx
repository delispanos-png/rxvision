"use client";

import { appConfirm } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { Modal } from "@/components/ui/Modal";
import { ShieldAlert, Users } from "lucide-react";

type Perm = { _id: string; section: string; label: string; sensitive: boolean };
type CatalogSection = { key: string; label: string; permissions: Perm[] };
type Catalog = { sections: CatalogSection[]; sensitive: string[] };
type Group = {
  id: string; key: string | null; name: string; description: string;
  permissions: string[]; is_system: boolean; members: number;
};

/** Επιλογή δικαιωμάτων ανά ενότητα. Τα επικίνδυνα σημαίνονται κόκκινα και δεν
 *  μπαίνουν ποτέ με το «όλα τα read» — πρέπει να τικαριστούν ένα-ένα. */
function PermissionPicker({ catalog, selected, onChange }: {
  catalog: Catalog; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [openSection, setOpenSection] = useState<string | null>(catalog.sections[0]?.key ?? null);
  const has = (k: string) => selected.includes(k);
  const toggle = (k: string) =>
    onChange(has(k) ? selected.filter((x) => x !== k) : [...selected, k]);

  function setSectionReads(s: CatalogSection, on: boolean) {
    const reads = s.permissions.filter((p) => p._id.endsWith(":read") && !p.sensitive).map((p) => p._id);
    onChange(on ? Array.from(new Set([...selected, ...reads])) : selected.filter((x) => !reads.includes(x)));
  }
  function clearSection(s: CatalogSection) {
    const keys = s.permissions.map((p) => p._id);
    onChange(selected.filter((x) => !keys.includes(x)));
  }

  return (
    <div className="rounded-lg border border-slate-200">
      {catalog.sections.map((s) => {
        const chosen = s.permissions.filter((p) => has(p._id)).length;
        const danger = s.permissions.filter((p) => has(p._id) && p.sensitive).length;
        const isOpen = openSection === s.key;
        return (
          <div key={s.key} className="border-b border-slate-100 last:border-b-0">
            <button type="button" onClick={() => setOpenSection(isOpen ? null : s.key)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50">
              <span className="font-medium text-slate-700">{s.label}</span>
              <span className="flex items-center gap-2 text-xs text-slate-500">
                {danger > 0 && (
                  <span className="flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-red-600">
                    <ShieldAlert className="h-3 w-3" />{danger}
                  </span>
                )}
                <span>{chosen}/{s.permissions.length}</span>
                <span className="text-slate-400">{isOpen ? "▾" : "▸"}</span>
              </span>
            </button>
            {isOpen && (
              <div className="bg-slate-50/60 px-3 pb-3">
                <div className="mb-2 flex gap-2">
                  <button type="button" onClick={() => setSectionReads(s, true)}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100">
                    Όλα τα «ανάγνωση»
                  </button>
                  <button type="button" onClick={() => clearSection(s)}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100">
                    Καθαρισμός
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {s.permissions.map((p) => (
                    <label key={p._id}
                      className={`flex items-start gap-2 rounded px-1 py-0.5 text-sm ${p.sensitive ? "text-red-700" : "text-slate-600"}`}>
                      <input type="checkbox" className="mt-1" checked={has(p._id)} onChange={() => toggle(p._id)} />
                      <span>
                        {p.label}
                        {p.sensitive && <ShieldAlert className="ml-1 inline h-3 w-3" />}
                        <span className="block font-mono text-[10px] text-slate-400">{p._id}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function GroupsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Group | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const groupsQ = useQuery({ queryKey: ["admin", "groups"], queryFn: () => adminApi<{ items: Group[] }>("/admin/groups"), retry: false });
  const catalogQ = useQuery({ queryKey: ["admin", "permissions"], queryFn: () => adminApi<Catalog>("/admin/permissions"), retry: false });
  const groups = groupsQ.data?.items ?? [];
  const catalog = catalogQ.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "groups"] });

  async function remove(g: Group) {
    if (!(await appConfirm(`Διαγραφή της ομάδας «${g.name}»;`, { title: "Διαγραφή ομάδας", danger: true, confirmText: "Διαγραφή" }))) return;
    try {
      await adminApi(`/admin/groups/${g.id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: { error?: string; members?: number } })?.detail : null;
      setNotice(d?.error === "group_in_use"
        ? `Η ομάδα «${g.name}» έχει ${d.members} μέλη. Βγάλ' τα πρώτα από την ομάδα.`
        : "Σφάλμα κατά τη διαγραφή.");
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Ομάδες & δικαιώματα</h1>
          <p className="mt-1 text-xs text-slate-500">
            Τα δικαιώματα ορίζονται εδώ, ανά ενέργεια. Οι <a href="/admin/staff" className="text-indigo-600 hover:underline">χρήστες</a> παίρνουν ομάδες.
          </p>
        </div>
        <button onClick={() => setCreating(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + Νέα ομάδα
        </button>
      </div>

      {notice && (
        <div className="mb-4 flex items-start justify-between rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-4 font-bold">×</button>
        </div>
      )}

      {groupsQ.isLoading || catalogQ.isLoading ? (
        <div className="text-slate-400">Φόρτωση…</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => {
            const danger = catalog ? g.permissions.filter((p) => catalog.sensitive.includes(p)).length : 0;
            return (
              <div key={g.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h2 className="font-semibold text-slate-900">{g.name}</h2>
                  {g.is_system && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">προεπιλεγμένη</span>}
                </div>
                <p className="mb-3 text-xs text-slate-500">{g.description || "—"}</p>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700">{g.permissions.length} δικαιώματα</span>
                  <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                    <Users className="h-3 w-3" />{g.members}
                  </span>
                  {danger > 0 && (
                    <span className="flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-red-600">
                      <ShieldAlert className="h-3 w-3" />{danger} επικίνδυνα
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditing(g)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Επεξεργασία</button>
                  <button onClick={() => remove(g)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">Διαγραφή</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {catalog && creating && (
        <GroupModal catalog={catalog} onClose={() => setCreating(false)}
          onDone={(m) => { setNotice(m); refresh(); }} />
      )}
      {catalog && editing && (
        <GroupModal catalog={catalog} group={editing} onClose={() => setEditing(null)}
          onDone={(m) => { setNotice(m); refresh(); }} />
      )}
    </div>
  );
}

function GroupModal({ catalog, group, onClose, onDone }: {
  catalog: Catalog; group?: Group; onClose: () => void; onDone: (msg: string | null) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [perms, setPerms] = useState<string[]>(group?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dangerous = perms.filter((p) => catalog.sensitive.includes(p));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (dangerous.length) {
      const ok = await appConfirm(
        `Η ομάδα «${name}» θα έχει ${dangerous.length} επικίνδυνα δικαιώματα:\n\n${dangerous.join("\n")}\n\nΚάθε χρήση τους καταγράφεται στο αρχείο ενεργειών.`,
        { title: "Επιβεβαίωση επικίνδυνων δικαιωμάτων", danger: true, confirmText: "Ναι, αποθήκευση" });
      if (!ok) return;
    }
    setBusy(true); setError(null);
    try {
      const body = JSON.stringify({ name, description, permissions: perms });
      if (group) await adminApi(`/admin/groups/${group.id}`, { method: "PATCH", body });
      else await adminApi("/admin/groups", { method: "POST", body });
      onDone(`Αποθηκεύτηκε η ομάδα «${name}».`); onClose();
    } catch (e) {
      const d = e instanceof ApiError ? (e.problem as { detail?: string })?.detail : null;
      setError(d === "name_in_use" ? "Υπάρχει ήδη ομάδα με αυτό το όνομα." : "Σφάλμα — δοκιμάστε ξανά.");
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={group ? `Ομάδα «${group.name}»` : "Νέα ομάδα"}>
      <form onSubmit={submit}>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-slate-600">Όνομα</span>
          <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-slate-600">Περιγραφή</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Τι δουλειά κάνει αυτή η ομάδα"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>

        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium text-slate-700">Δικαιώματα</span>
          <span className="text-xs text-slate-500">{perms.length} επιλεγμένα</span>
        </div>
        <div className="mb-4 max-h-80 overflow-y-auto">
          <PermissionPicker catalog={catalog} selected={perms} onChange={setPerms} />
        </div>

        {group?.is_system && (
          <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Προεπιλεγμένη ομάδα. Μόλις την αλλάξεις, οι μελλοντικές αναβαθμίσεις δεν θα ξαναγράψουν την επιλογή σου.
          </p>
        )}
        {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">Άκυρο</button>
          <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
            {busy ? "…" : "Αποθήκευση"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
