"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";

type User = {
  id: string;
  email: string;
  full_name: string;
  roles: string[];
  role_ids?: string[];
  active: boolean;
};
type Role = { _id?: string; id?: string; name: string };
type CreateResult = User & { credentials_emailed?: boolean; temporary_password?: string };
type ResetResult = { credentials_emailed?: boolean; temporary_password?: string };

const roleId = (r: Role) => r._id ?? r.id ?? "";

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const code = (e.problem as any)?.detail?.error;
    if (code === "email_exists") return "Υπάρχει ήδη χρήστης με αυτό το email.";
    if (code === "cannot_delete_self") return "Δεν μπορείτε να διαγράψετε τον εαυτό σας.";
    if (code === "cannot_suspend_self") return "Δεν μπορείτε να αναστείλετε τον εαυτό σας.";
    return `${fallback} (${e.status})`;
  }
  return fallback;
}

export default function UsersSettingsPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("");
  const [editing, setEditing] = useState<User | null>(null);

  const me = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<{ user_id: string }>("/auth/me"), retry: false });
  const users = useQuery({ queryKey: queryKeys.users(), queryFn: () => api<{ items: User[] }>(`/users`) });
  const roles = useQuery({ queryKey: queryKeys.roles(), queryFn: () => api<{ items: Role[] }>(`/roles`) });

  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.users() });

  const create = useMutation({
    mutationFn: (body: { email: string; full_name: string; role_ids: string[] }) =>
      api<CreateResult>(`/users`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (res) => {
      refresh();
      setEmail(""); setFullName(""); setRole("");
      appAlert(
        res?.temporary_password
          ? `Ο χρήστης δημιουργήθηκε.\n\nΠροσωρινός κωδικός (δώσ' τον στον χρήστη — δεν θα ξαναεμφανιστεί):\n${res.temporary_password}`
          : "Ο χρήστης δημιουργήθηκε. Στάλθηκε email με τα στοιχεία πρόσβασης."
      );
    },
    onError: (e) => appAlert(errText(e, "Αποτυχία δημιουργίας")),
  });

  const update = useMutation({
    mutationFn: (v: { id: string; full_name: string; role_ids: string[] }) =>
      api<User>(`/users/${v.id}`, { method: "PATCH", body: JSON.stringify({ full_name: v.full_name, role_ids: v.role_ids }) }),
    onSuccess: () => { refresh(); setEditing(null); },
    onError: (e) => appAlert(errText(e, "Αποτυχία αποθήκευσης")),
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: "active" | "suspended" }) =>
      api<User>(`/users/${v.id}`, { method: "PATCH", body: JSON.stringify({ status: v.status }) }),
    onSuccess: refresh,
    onError: (e) => appAlert(errText(e, "Αποτυχία αλλαγής κατάστασης")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/users/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e) => appAlert(errText(e, "Αποτυχία διαγραφής")),
  });

  const resetPw = useMutation({
    mutationFn: (v: { id: string; password?: string }) =>
      api<ResetResult>(`/users/${v.id}/reset-password`, { method: "POST", body: JSON.stringify(v.password ? { password: v.password } : {}) }),
    onSuccess: (res) =>
      appAlert(
        res?.temporary_password
          ? `Νέος προσωρινός κωδικός (δώσ' τον στον χρήστη — δεν θα ξαναεμφανιστεί):\n${res.temporary_password}`
          : "Ο κωδικός άλλαξε. Στάλθηκε email στον χρήστη."
      ),
    onError: (e) => appAlert(errText(e, "Αποτυχία επαναφοράς κωδικού")),
  });

  async function onReset(u: User) {
    const pw = await appPrompt(
      "Γράψε τον κωδικό που θέλεις (τουλάχιστον 8 χαρακτήρες),\nή άφησέ το ΚΕΝΟ για αυτόματο τυχαίο κωδικό που θα σταλεί με email.",
      { title: `Νέος κωδικός για «${u.email}»`, placeholder: "Νέος κωδικός (ή κενό)", confirmText: "Αλλαγή κωδικού" }
    );
    if (pw === null) return;
    const chosen = pw.trim();
    if (chosen && chosen.length < 8) { appAlert("Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες."); return; }
    resetPw.mutate({ id: u.id, password: chosen || undefined });
  }

  async function onDelete(u: User) {
    if (await appConfirm(`Διαγραφή του χρήστη «${u.email}»;`, { title: "Διαγραφή χρήστη", danger: true, confirmText: "Διαγραφή" }))
      remove.mutate(u.id);
  }

  const columns: Column<User>[] = [
    { key: "full_name", header: "Όνομα" },
    { key: "email", header: "Email" },
    { key: "roles", header: "Ρόλοι", render: (r) => r.roles.join(", ") || "—" },
    { key: "active", header: "Κατάσταση", render: (r) => (r.active ? "Ενεργός" : "Ανενεργός") },
    {
      key: "actions",
      header: "Ενέργειες",
      fullWidthOnMobile: true,
      render: (r) => {
        const self = me.data?.user_id === r.id;
        const btn = "rounded-md border px-2 py-1 text-xs hover:bg-slate-50";
        return (
          <div className="flex flex-wrap gap-1.5">
            <button className={`${btn} border-slate-300`} onClick={() => setEditing(r)}>Επεξεργασία</button>
            <button className={`${btn} border-slate-300`} onClick={() => onReset(r)}>Reset κωδικού</button>
            <button
              className={`${btn} border-slate-300 ${self ? "cursor-not-allowed opacity-40" : ""}`}
              disabled={self}
              onClick={() => setStatus.mutate({ id: r.id, status: r.active ? "suspended" : "active" })}
            >
              {r.active ? "Αναστολή" : "Ενεργοποίηση"}
            </button>
            <button
              className={`${btn} border-rose-200 text-rose-600 hover:bg-rose-50 ${self ? "cursor-not-allowed opacity-40" : ""}`}
              disabled={self}
              onClick={() => onDelete(r)}
            >
              Διαγραφή
            </button>
          </div>
        );
      },
    },
  ];

  const inp = "rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-400 focus:outline-none";

  return (
    <ModuleGuard module="settings">
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Νέος χρήστης</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate({ email, full_name: fullName, role_ids: role ? [role] : [] }); }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">Όνομα</span>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required className={inp} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={inp} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">Ρόλος</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} required className={inp}>
              <option value="">—</option>
              {(roles.data?.items ?? []).map((r) => (
                <option key={roleId(r)} value={roleId(r)}>{r.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={create.isPending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            {create.isPending ? "Αποθήκευση…" : "Προσθήκη"}
          </button>
        </form>
      </div>

      {users.isLoading ? (
        <div className="text-slate-400">Φόρτωση δεδομένων…</div>
      ) : (
        <DataTable columns={columns} rows={users.data?.items ?? []} rowKey={(r) => r.id} />
      )}

      {editing && (
        <EditUserModal
          user={editing}
          roles={roles.data?.items ?? []}
          saving={update.isPending}
          onCancel={() => setEditing(null)}
          onSave={(full_name, role_ids) => update.mutate({ id: editing.id, full_name, role_ids })}
        />
      )}
    </ModuleGuard>
  );
}

function EditUserModal({
  user, roles, saving, onCancel, onSave,
}: {
  user: User;
  roles: Role[];
  saving: boolean;
  onCancel: () => void;
  onSave: (full_name: string, role_ids: string[]) => void;
}) {
  const [name, setName] = useState(user.full_name);
  const [rid, setRid] = useState(user.role_ids?.[0] ?? "");
  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-400 focus:outline-none";

  return (
    <Modal open onClose={onCancel} title="Επεξεργασία χρήστη">
      <p className="mb-4 text-sm text-slate-500">{user.email}</p>
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); onSave(name.trim(), rid ? [rid] : []); }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-slate-600">Όνομα</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required className={inp} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-600">Ρόλος</span>
          <select value={rid} onChange={(e) => setRid(e.target.value)} className={inp}>
            <option value="">— Χωρίς ρόλο —</option>
            {roles.map((r) => (
              <option key={roleId(r)} value={roleId(r)}>{r.name}</option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">Άκυρο</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            {saving ? "Αποθήκευση…" : "Αποθήκευση"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
