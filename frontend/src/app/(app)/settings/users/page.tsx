"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys, ApiError } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { DataTable, type Column } from "@/components/tables/DataTable";

type User = { id: string; email: string; full_name: string; roles: string[]; active: boolean };
type Role = { _id?: string; id?: string; name: string };
type CreateResult = User & { credentials_emailed?: boolean; temporary_password?: string };

export default function UsersSettingsPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("");

  const users = useQuery({
    queryKey: queryKeys.users(),
    queryFn: () => api<{ items: User[] }>(`/users`),
  });
  const roles = useQuery({
    queryKey: queryKeys.roles(),
    queryFn: () => api<{ items: Role[] }>(`/roles`),
  });

  const create = useMutation({
    mutationFn: (body: { email: string; full_name: string; role_ids: string[] }) =>
      api<CreateResult>(`/users`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.users() });
      setEmail("");
      setFullName("");
      setRole("");
      if (res?.temporary_password) {
        alert(
          `Ο χρήστης δημιουργήθηκε.\n\nΠροσωρινός κωδικός (δώσ' τον στον χρήστη — δεν θα ξαναεμφανιστεί):\n${res.temporary_password}`
        );
      } else {
        alert("Ο χρήστης δημιουργήθηκε. Στάλθηκε email με τα στοιχεία πρόσβασης.");
      }
    },
    onError: (e) =>
      alert(
        e instanceof ApiError && (e.problem as any)?.detail?.error === "email_exists"
          ? "Υπάρχει ήδη χρήστης με αυτό το email."
          : e instanceof ApiError
            ? `Σφάλμα (${e.status})`
            : "Αποτυχία δημιουργίας"
      ),
  });

  const columns: Column<User>[] = [
    { key: "full_name", header: "Όνομα" },
    { key: "email", header: "Email" },
    { key: "roles", header: "Ρόλοι", render: (r) => r.roles.join(", ") },
    {
      key: "active",
      header: "Κατάσταση",
      render: (r) => (r.active ? "Ενεργός" : "Ανενεργός"),
    },
  ];

  return (
    <ModuleGuard module="settings">
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Νέος χρήστης</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ email, full_name: fullName, role_ids: role ? [role] : [] });
          }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">Όνομα</span>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-400 focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-400 focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-500">Ρόλος</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-400 focus:outline-none"
            >
              <option value="">—</option>
              {(roles.data?.items ?? []).map((r) => {
                const rid = r._id ?? r.id ?? "";
                return (
                  <option key={rid} value={rid}>
                    {r.name}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {create.isPending ? "Αποθήκευση…" : "Προσθήκη"}
          </button>
        </form>
      </div>

      {users.isLoading ? (
        <div className="text-slate-400">Φόρτωση δεδομένων…</div>
      ) : (
        <DataTable columns={columns} rows={users.data?.items ?? []} rowKey={(r) => r.id} />
      )}
    </ModuleGuard>
  );
}
