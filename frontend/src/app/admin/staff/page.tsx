"use client";

import { appConfirm, appPrompt } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";

type Group = { id: string; name: string };
type Staff = {
  id: string; email: string; full_name: string; status: string; created_at: string;
  super_admin: boolean; group_ids: string[]; groups: Group[];
};

/** Τα δικαιώματα ζουν ΜΟΝΟ στις ομάδες — εδώ επιλέγεις σε ποιες ανήκει ο χρήστης.
 *  Για να αλλάξεις το τι μπορεί να κάνει μια ομάδα: Σύστημα → Ομάδες & δικαιώματα. */
function GroupPicker({ groups, superAdmin, selected, onSuper, onToggle }: {
  groups: Group[]; superAdmin: boolean; selected: string[];
  onSuper: (v: boolean) => void; onToggle: (id: string) => void;
}) {
  return (
    <div className="mb-4">
      <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" checked={superAdmin} onChange={(e) => onSuper(e.target.checked)} />
        Super Admin (πλήρης πρόσβαση — παρακάμπτει τις ομάδες)
      </label>
      {!superAdmin && (
        <>
          <p className="mb-2 text-xs text-slate-500">
            Ο χρήστης παίρνει την ένωση των δικαιωμάτων από τις ομάδες που θα επιλέξεις.
          </p>
          <div className="grid grid-cols-1 gap-1 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
            {groups.length === 0 && <span className="text-sm text-slate-400">Δεν υπάρχουν ομάδες ακόμη.</span>}
            {groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={selected.includes(g.id)} onChange={() => onToggle(g.id)} />
                {g.name}
              </label>
            ))}
          </div>
          {selected.length === 0 && (
            <p className="mt-2 text-xs text-amber-700">
              ⚠️ Χωρίς ομάδα ο χρήστης συνδέεται αλλά δεν βλέπει τίποτα.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function StaffPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const staff = useQuery({ queryKey: ["admin", "staff"], queryFn: () => adminApi<{ items: Staff[] }>("/admin/staff"), retry: false });
  const groupsQ = useQuery({ queryKey: ["admin", "groups"], queryFn: () => adminApi<{ items: Group[] }>("/admin/groups"), retry: false });
  const groups = groupsQ.data?.items ?? [];
  const rows = staff.data?.items ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "staff"] });

  async function resetPw(s: Staff) {
    const pw = await appPrompt(
      "Γράψε τον κωδικό που θέλεις (τουλάχιστον 8 χαρακτήρες),\nή άφησέ το ΚΕΝΟ για αυτόματο τυχαίο κωδικό.\n\n(Ο χρήστης θα αποσυνδεθεί.)",
      { title: `Νέος κωδικός για «${s.email}»`, placeholder: "Νέος κωδικός (ή κενό)", confirmText: "Αλλαγή κωδικού" }
    );
    if (pw === null) return; // cancelled
    const chosen = pw.trim();
    if (chosen && chosen.length < 8) {
      setNotice("Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.");
      return;
    }
    const r = await adminApi<{ temp_password: string | null }>(
      `/admin/staff/${s.id}/reset-password`,
      { method: "POST", body: JSON.stringify(chosen ? { password: chosen } : {}) }
    );
    setNotice(
      r.temp_password
        ? `Νέος προσωρινός κωδικός για ${s.email}: ${r.temp_password}`
        : `Ο κωδικός για ${s.email} ορίστηκε. (Ο χρήστης αποσυνδέθηκε.)`
    );
    refresh();
  }
  async function sendCreds(s: Staff) {
    if (!(await appConfirm(`Δημιουργία νέου προσωρινού κωδικού για «${s.email}» και αποστολή με email;\n(Ο προηγούμενος κωδικός παύει να ισχύει.)`, { title: "Αποστολή credentials", confirmText: "Δημιουργία & αποστολή" }))) return;
    try {
      const r = await adminApi<{ email: string; temp_password: string; emailed: boolean }>(
        `/admin/staff/${s.id}/send-credentials`, { method: "POST" });
      setNotice(
        r.emailed
          ? `Στάλθηκε email με τα στοιχεία πρόσβασης στο ${r.email}.`
          : `Το email ΔΕΝ στάλθηκε (έλεγξε SMTP). Προσωρινός κωδικός για ${r.email}: ${r.temp_password}`
      );
      refresh();
    } catch (e) { setNotice(e instanceof ApiError ? `Σφάλμα: ${JSON.stringify(e.problem)}` : "Σφάλμα."); }
  }
  async function toggle(s: Staff) {
    const next = s.status === "suspended" ? "active" : "suspended";
    try {
      await adminApi(`/admin/staff/${s.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      refresh();
    } catch (e) { setNotice(e instanceof ApiError ? `Δεν επιτρέπεται: ${JSON.stringify(e.problem)}` : "Σφάλμα."); }
  }
  async function remove(s: Staff) {
    if (!(await appConfirm(`Διαγραφή του «${s.email}»;`, { title: "Διαγραφή", danger: true, confirmText: "Διαγραφή" }))) return;
    try {
      await adminApi(`/admin/staff/${s.id}`, { method: "DELETE" });
      refresh();
    } catch (e) { setNotice(e instanceof ApiError ? `Δεν επιτρέπεται: ${JSON.stringify(e.problem)}` : "Σφάλμα."); }
  }

  const columns: Column<Staff>[] = [
    { key: "full_name", header: "Όνομα" },
    { key: "email", header: "Email" },
    {
      key: "access", header: "Ομάδες",
      render: (r) => r.super_admin
        ? <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">Super Admin</span>
        : r.groups.length
          ? <div className="flex flex-wrap gap-1">
              {r.groups.map((g) => (
                <span key={g.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{g.name}</span>
              ))}
            </div>
          : <span className="text-xs text-amber-600">χωρίς ομάδα</span>,
    },
    {
      key: "status", header: "Κατάσταση",
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
          {r.status}
        </span>
      ),
    },
    { key: "created_at", header: "Δημιουργία", render: (r) => fmtDate(r.created_at) },
    {
      key: "actions", header: "", align: "right", fullWidthOnMobile: true,
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={() => setEditing(r)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Επεξεργασία</button>
          <button onClick={() => resetPw(r)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Reset κωδικού</button>
          <button onClick={() => sendCreds(r)} className="rounded-md border border-brand-300 bg-brand-50 px-2 py-1 text-xs text-brand-700 hover:bg-brand-100">Αποστολή credentials</button>
          <button onClick={() => toggle(r)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">
            {r.status === "suspended" ? "Ενεργοποίηση" : "Αναστολή"}
          </button>
          <button onClick={() => remove(r)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">Διαγραφή</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Χρήστες (CloudOn staff)</h1>
          <p className="mt-1 text-xs text-slate-500">
            Η πρόσβαση ορίζεται από τις <a href="/admin/groups" className="text-indigo-600 hover:underline">ομάδες</a>, όχι ανά άτομο.
          </p>
        </div>
        <button onClick={() => setOpen(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + Προσθήκη χρήστη
        </button>
      </div>

      {notice && (
        <div className="mb-4 flex items-start justify-between rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-4 font-bold">×</button>
        </div>
      )}

      {staff.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable pageSize={20} columns={columns} rows={rows} rowKey={(r) => r.id} />}

      {open && <AddStaffModal groups={groups} onClose={() => setOpen(false)} onDone={(msg) => { setNotice(msg); refresh(); }} />}
      {editing && <EditStaffModal staff={editing} groups={groups} onClose={() => setEditing(null)} onDone={(msg) => { setNotice(msg); refresh(); }} />}
    </div>
  );
}

function EditStaffModal({ staff, groups, onClose, onDone }: { staff: Staff; groups: Group[]; onClose: () => void; onDone: (msg: string | null) => void }) {
  const [form, setForm] = useState({ email: staff.email, full_name: staff.full_name });
  const [superAdmin, setSuperAdmin] = useState(staff.super_admin);
  const [selected, setSelected] = useState<string[]>(staff.group_ids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await adminApi(`/admin/staff/${staff.id}`, { method: "PATCH", body: JSON.stringify({ full_name: form.full_name, email: form.email, super_admin: superAdmin, group_ids: selected }) });
      onDone(`Αποθηκεύτηκε: ${form.email}`); onClose();
    } catch (e) {
      const problem = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail?.error : null;
      setError(problem === "last_super_admin"
        ? "Δεν γίνεται — είναι ο τελευταίος super admin."
        : "Σφάλμα — δοκιμάστε ξανά.");
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Επεξεργασία χρήστη">
      <form onSubmit={submit}>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-slate-600">Όνομα</span>
          <input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        <label className="mb-5 block text-sm">
          <span className="mb-1 block text-slate-600">Email</span>
          <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        <GroupPicker groups={groups} superAdmin={superAdmin} selected={selected} onSuper={setSuperAdmin} onToggle={toggle} />
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

function AddStaffModal({ groups, onClose, onDone }: { groups: Group[]; onClose: () => void; onDone: (msg: string | null) => void }) {
  const [form, setForm] = useState({ email: "", full_name: "", password: "" });
  const [superAdmin, setSuperAdmin] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { email: form.email, full_name: form.full_name, super_admin: superAdmin, group_ids: selected, ...(form.password ? { password: form.password } : {}) };
      const r = await adminApi<{ email: string; temp_password: string | null }>("/admin/staff", { method: "POST", body: JSON.stringify(body) });
      onDone(r.temp_password ? `Δημιουργήθηκε ${r.email}. Προσωρινός κωδικός: ${r.temp_password}` : `Δημιουργήθηκε ${r.email}.`);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? "Σφάλμα — δοκιμάστε ξανά." : "Σφάλμα.");
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Νέος χρήστης CloudOn">
      <form onSubmit={submit}>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-slate-600">Όνομα</span>
          <input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-slate-600">Email</span>
          <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-slate-600">Κωδικός (κενό = αυτόματος)</span>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        <GroupPicker groups={groups} superAdmin={superAdmin} selected={selected} onSuper={setSuperAdmin} onToggle={toggle} />
        {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">Άκυρο</button>
          <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
            {busy ? "…" : "Δημιουργία"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
