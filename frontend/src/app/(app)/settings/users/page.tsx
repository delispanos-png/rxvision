"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

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

type Translate = (el: string, en: string) => string;

function errText(e: unknown, fallback: string, t: Translate): string {
  if (e instanceof ApiError) {
    const code = (e.problem as any)?.detail?.error;
    if (code === "email_exists") return t("Υπάρχει ήδη χρήστης με αυτό το email.", "A user with this email already exists.");
    if (code === "cannot_delete_self") return t("Δεν μπορείτε να διαγράψετε τον εαυτό σας.", "You cannot delete yourself.");
    if (code === "cannot_suspend_self") return t("Δεν μπορείτε να αναστείλετε τον εαυτό σας.", "You cannot suspend yourself.");
    return `${fallback} (${e.status})`;
  }
  return fallback;
}

export default function UsersSettingsPage() {
  const t = useT();
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
          ? t(
              `Ο χρήστης δημιουργήθηκε.\n\nΠροσωρινός κωδικός (δώσ' τον στον χρήστη — δεν θα ξαναεμφανιστεί):\n${res.temporary_password}`,
              `User created.\n\nTemporary password (give it to the user — it won't be shown again):\n${res.temporary_password}`
            )
          : t("Ο χρήστης δημιουργήθηκε. Στάλθηκε email με τα στοιχεία πρόσβασης.", "User created. An email with the access credentials was sent.")
      );
    },
    onError: (e) => appAlert(errText(e, t("Αποτυχία δημιουργίας", "Creation failed"), t)),
  });

  const update = useMutation({
    mutationFn: (v: { id: string; full_name: string; role_ids: string[] }) =>
      api<User>(`/users/${v.id}`, { method: "PATCH", body: JSON.stringify({ full_name: v.full_name, role_ids: v.role_ids }) }),
    onSuccess: () => { refresh(); setEditing(null); },
    onError: (e) => appAlert(errText(e, t("Αποτυχία αποθήκευσης", "Save failed"), t)),
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: "active" | "suspended" }) =>
      api<User>(`/users/${v.id}`, { method: "PATCH", body: JSON.stringify({ status: v.status }) }),
    onSuccess: refresh,
    onError: (e) => appAlert(errText(e, t("Αποτυχία αλλαγής κατάστασης", "Status change failed"), t)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/users/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e) => appAlert(errText(e, t("Αποτυχία διαγραφής", "Delete failed"), t)),
  });

  const resetPw = useMutation({
    mutationFn: (v: { id: string; password?: string }) =>
      api<ResetResult>(`/users/${v.id}/reset-password`, { method: "POST", body: JSON.stringify(v.password ? { password: v.password } : {}) }),
    onSuccess: (res) =>
      appAlert(
        res?.temporary_password
          ? t(
              `Νέος προσωρινός κωδικός (δώσ' τον στον χρήστη — δεν θα ξαναεμφανιστεί):\n${res.temporary_password}`,
              `New temporary password (give it to the user — it won't be shown again):\n${res.temporary_password}`
            )
          : t("Ο κωδικός άλλαξε. Στάλθηκε email στον χρήστη.", "Password changed. An email was sent to the user.")
      ),
    onError: (e) => appAlert(errText(e, t("Αποτυχία επαναφοράς κωδικού", "Password reset failed"), t)),
  });

  async function onReset(u: User) {
    const pw = await appPrompt(
      t(
        "Γράψε τον κωδικό που θέλεις (τουλάχιστον 8 χαρακτήρες),\nή άφησέ το ΚΕΝΟ για αυτόματο τυχαίο κωδικό που θα σταλεί με email.",
        "Type the password you want (at least 8 characters),\nor leave it EMPTY for an automatic random password sent by email."
      ),
      { title: t(`Νέος κωδικός για «${u.email}»`, `New password for "${u.email}"`), placeholder: t("Νέος κωδικός (ή κενό)", "New password (or empty)"), confirmText: t("Αλλαγή κωδικού", "Change password") }
    );
    if (pw === null) return;
    const chosen = pw.trim();
    if (chosen && chosen.length < 8) { appAlert(t("Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.", "The password must be at least 8 characters.")); return; }
    resetPw.mutate({ id: u.id, password: chosen || undefined });
  }

  async function onDelete(u: User) {
    if (await appConfirm(t(`Διαγραφή του χρήστη «${u.email}»;`, `Delete user "${u.email}"?`), { title: t("Διαγραφή χρήστη", "Delete user"), danger: true, confirmText: t("Διαγραφή", "Delete") }))
      remove.mutate(u.id);
  }

  const columns: Column<User>[] = [
    { key: "full_name", header: t("Όνομα", "Name") },
    { key: "email", header: "Email" },
    { key: "roles", header: t("Ρόλοι", "Roles"), render: (r) => r.roles.join(", ") || "—" },
    { key: "active", header: t("Κατάσταση", "Status"), render: (r) => (r.active ? t("Ενεργός", "Active") : t("Ανενεργός", "Inactive")) },
    {
      key: "actions",
      header: t("Ενέργειες", "Actions"),
      fullWidthOnMobile: true,
      render: (r) => {
        const self = me.data?.user_id === r.id;
        const btn = "rounded-md border px-2 py-1 text-xs hover:bg-slate-50";
        return (
          <div className="flex flex-wrap gap-1.5">
            <button className={`${btn} border-slate-300`} onClick={() => setEditing(r)}>{t("Επεξεργασία", "Edit")}</button>
            <button className={`${btn} border-slate-300`} onClick={() => onReset(r)}>{t("Reset κωδικού", "Reset password")}</button>
            <button
              className={`${btn} border-slate-300 ${self ? "cursor-not-allowed opacity-40" : ""}`}
              disabled={self}
              onClick={() => setStatus.mutate({ id: r.id, status: r.active ? "suspended" : "active" })}
            >
              {r.active ? t("Αναστολή", "Suspend") : t("Ενεργοποίηση", "Activate")}
            </button>
            <button
              className={`${btn} border-rose-200 text-rose-600 hover:bg-rose-50 ${self ? "cursor-not-allowed opacity-40" : ""}`}
              disabled={self}
              onClick={() => onDelete(r)}
            >
              {t("Διαγραφή", "Delete")}
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
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("Νέος χρήστης", "New user")}</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate({ email, full_name: fullName, role_ids: role ? [role] : [] }); }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">{t("Όνομα", "Name")}</span>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required className={inp} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={inp} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">{t("Ρόλος", "Role")}</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} required className={inp}>
              <option value="">—</option>
              {(roles.data?.items ?? []).map((r) => (
                <option key={roleId(r)} value={roleId(r)}>{r.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={create.isPending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            {create.isPending ? t("Αποθήκευση…", "Saving…") : t("Προσθήκη", "Add")}
          </button>
        </form>
      </div>

      {users.isLoading ? (
        <div className="text-slate-400">{t("Φόρτωση δεδομένων…", "Loading data…")}</div>
      ) : (
        <DataTable pageSize={20} columns={columns} rows={users.data?.items ?? []} rowKey={(r) => r.id} />
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
  const t = useT();
  const [name, setName] = useState(user.full_name);
  const [rid, setRid] = useState(user.role_ids?.[0] ?? "");
  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-400 focus:outline-none";

  return (
    <Modal open onClose={onCancel} title={t("Επεξεργασία χρήστη", "Edit user")}>
      <p className="mb-4 text-sm text-slate-500">{user.email}</p>
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); onSave(name.trim(), rid ? [rid] : []); }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-slate-600">{t("Όνομα", "Name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required className={inp} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-600">{t("Ρόλος", "Role")}</span>
          <select value={rid} onChange={(e) => setRid(e.target.value)} className={inp}>
            <option value="">{t("— Χωρίς ρόλο —", "— No role —")}</option>
            {roles.map((r) => (
              <option key={roleId(r)} value={roleId(r)}>{r.name}</option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">{t("Άκυρο", "Cancel")}</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            {saving ? t("Αποθήκευση…", "Saving…") : t("Αποθήκευση", "Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
