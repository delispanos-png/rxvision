"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Post = { id: string; type: string; title: string; body: string; status: string; updated_at: string };

const LABEL: Record<string, string> = { article: "Άρθρα", news: "Νέα", wiki: "Wiki" };

export default function ContentPage() {
  const params = useParams<{ type: string }>();
  const type = params.type;
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Post | "new" | null>(null);

  const posts = useQuery({ queryKey: ["admin", "posts", type], queryFn: () => adminApi<{ items: Post[] }>(`/admin/posts?type=${type}`), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "posts", type] });

  async function togglePublish(p: Post) {
    await adminApi(`/admin/posts/${p.id}`, { method: "PATCH", body: JSON.stringify({ status: p.status === "published" ? "draft" : "published" }) });
    refresh();
  }
  async function remove(p: Post) {
    if (!confirm(`Διαγραφή «${p.title}»;`)) return;
    await adminApi(`/admin/posts/${p.id}`, { method: "DELETE" });
    refresh();
  }

  const columns: Column<Post>[] = [
    { key: "title", header: "Τίτλος" },
    {
      key: "status", header: "Κατάσταση",
      render: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{r.status === "published" ? "δημοσιευμένο" : "πρόχειρο"}</span>,
    },
    { key: "updated_at", header: "Ενημέρωση", render: (r) => fmtDate(r.updated_at) },
    {
      key: "actions", header: "", align: "right",
      render: (r) => (
        <div className="flex justify-end gap-2">
          <button onClick={() => setEditing(r)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Επεξεργασία</button>
          <button onClick={() => togglePublish(r)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">{r.status === "published" ? "Απόσυρση" : "Δημοσίευση"}</button>
          <button onClick={() => remove(r)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">Διαγραφή</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">{LABEL[type] ?? "Περιεχόμενο"}</h1>
        <button onClick={() => setEditing("new")} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">+ Νέο</button>
      </div>

      {posts.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable columns={columns} rows={posts.data?.items ?? []} rowKey={(r) => r.id} empty="Κανένα περιεχόμενο." />}

      {editing && <PostModal type={type} post={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function PostModal({ type, post, onClose, onDone }: { type: string; post: Post | null; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ title: post?.title ?? "", body: post?.body ?? "", status: post?.status ?? "draft" });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (post) await adminApi(`/admin/posts/${post.id}`, { method: "PATCH", body: JSON.stringify(form) });
      else await adminApi("/admin/posts", { method: "POST", body: JSON.stringify({ type, ...form }) });
      onDone();
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <form onSubmit={submit} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-bold text-slate-900">{post ? "Επεξεργασία" : "Νέο περιεχόμενο"}</h2>
        <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Τίτλος</span>
          <input required className={inp} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label className="mb-3 block text-sm"><span className="mb-1 block text-slate-600">Περιεχόμενο (HTML)</span>
          <textarea rows={8} className={inp} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
        <label className="mb-5 block text-sm"><span className="mb-1 block text-slate-600">Κατάσταση</span>
          <select className={inp} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="draft">Πρόχειρο</option>
            <option value="published">Δημοσιευμένο</option>
          </select></label>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">Άκυρο</button>
          <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? "…" : "Αποθήκευση"}</button>
        </div>
      </form>
    </div>
  );
}
