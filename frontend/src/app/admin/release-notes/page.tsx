"use client";

/* Διαχείριση «Τι νέο υπάρχει».

   ΚΑΘΕ ΣΗΜΕΙΩΣΗ ΔΗΜΟΣΙΕΥΕΤΑΙ ΜΕ ΤΟ ΧΕΡΙ. Ένα changelog που βγαίνει αυτόματα από commits λέει
   στον πελάτη και τι ΧΑΛΑΣΕ («τώρα διορθώθηκε το Χ») — η πιο γρήγορη διαδρομή για να χάσεις την
   εμπιστοσύνη του. Ο άνθρωπος αποφασίζει τι βλέπει ο πελάτης. */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Eye, EyeOff, Trash2, Plus, Save } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";

type Item = { title: string; body?: string; icon?: string | null };
type Note = { version: string; date?: string; title?: string; items: Item[]; published: boolean };

const fmt = (s?: string) => (s ? new Date(s).toLocaleDateString("el-GR") : "");

export default function ReleaseNotesAdmin() {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Note | null>(null);
  const q = useQuery({ queryKey: ["admin", "release-notes"],
    queryFn: () => adminApi<{ items: Note[] }>("/admin/release-notes") });

  const pub = q.data?.items.filter((n) => n.published).length ?? 0;

  async function togglePublish(n: Note) {
    await adminApi(`/admin/release-notes/${encodeURIComponent(n.version)}/publish?published=${!n.published}`,
      { method: "POST" });
    qc.invalidateQueries({ queryKey: ["admin", "release-notes"] });
  }

  async function save() {
    if (!edit?.version.trim()) { appAlert("Γράψε αριθμό έκδοσης."); return; }
    await adminApi("/admin/release-notes", { method: "PUT", body: JSON.stringify({
      version: edit.version.trim(), title: edit.title || "", published: edit.published,
      items: (edit.items || []).filter((i) => i.title.trim()) }) });
    setEdit(null);
    qc.invalidateQueries({ queryKey: ["admin", "release-notes"] });
  }

  async function remove(n: Note) {
    if (!(await appConfirm(`Διαγραφή της έκδοσης ${n.version};`, { danger: true }))) return;
    await adminApi(`/admin/release-notes/${encodeURIComponent(n.version)}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: ["admin", "release-notes"] });
  }

  return (
    <div className="w-full space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg">
          <Sparkles className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Τι νέο υπάρχει</h1>
          <p className="text-sm text-slate-500">
            {q.data?.items.length ?? 0} εκδόσεις · <b>{pub}</b> δημοσιευμένες στους πελάτες
          </p>
        </div>
        <button onClick={() => setEdit({ version: "", title: "", items: [{ title: "" }], published: false })}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
          <Plus className="h-4 w-4" />Νέα σημείωση
        </button>
      </header>

      {edit && (
        <section className="rounded-2xl border border-indigo-300 bg-indigo-50/50 p-4">
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <label className="text-xs font-medium text-slate-500">Έκδοση
              <input value={edit.version} onChange={(e) => setEdit({ ...edit, version: e.target.value })}
                placeholder="1.47.0" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-medium text-slate-500">Τίτλος (προαιρετικός)
              <input value={edit.title || ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
          </div>
          <div className="mt-3 space-y-2">
            {(edit.items || []).map((it, i) => (
              <div key={i} className="rounded-lg border border-slate-200 bg-white p-2">
                <input value={it.title} placeholder="Τι άλλαξε (μία γραμμή)"
                  onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, k) => k === i ? { ...x, title: e.target.value } : x) })}
                  className="mb-1 block w-full rounded border border-slate-200 px-2 py-1.5 text-sm font-medium" />
                <textarea value={it.body || ""} rows={2} placeholder="Εξήγηση για τον φαρμακοποιό (προαιρετικό)"
                  onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, k) => k === i ? { ...x, body: e.target.value } : x) })}
                  className="block w-full rounded border border-slate-200 px-2 py-1.5 text-sm" />
              </div>
            ))}
            <button onClick={() => setEdit({ ...edit, items: [...(edit.items || []), { title: "" }] })}
              className="text-xs font-medium text-indigo-600 hover:underline">+ γραμμή</button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={edit.published}
                onChange={(e) => setEdit({ ...edit, published: e.target.checked })} />
              Δημοσιευμένο στους πελάτες
            </label>
            <button onClick={save} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
              <Save className="h-4 w-4" />Αποθήκευση
            </button>
            <button onClick={() => setEdit(null)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600">Άκυρο</button>
          </div>
        </section>
      )}

      <div className="space-y-2">
        {(q.data?.items || []).map((n) => (
          <div key={n.version} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">v{n.version}</span>
              <span className="text-xs text-slate-400">{fmt(n.date)}</span>
              {n.title && <span className="text-sm font-medium text-slate-800">{n.title}</span>}
              <span className="text-xs text-slate-400">{n.items?.length ?? 0} γραμμές</span>
              <span className="ml-auto flex items-center gap-1.5">
                <button onClick={() => togglePublish(n)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium ${n.published
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
                  {n.published ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  {n.published ? "Δημοσιευμένο" : "Κρυφό"}
                </button>
                <button onClick={() => setEdit(n)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">Επεξεργασία</button>
                <button onClick={() => remove(n)} className="rounded-lg border border-rose-300 px-2 py-1 text-xs text-rose-600 hover:bg-rose-50">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            {!!n.items?.length && (
              <ul className="mt-1.5 list-inside list-disc text-xs text-slate-500">
                {n.items.slice(0, 3).map((it, i) => <li key={i}>{it.title}</li>)}
                {n.items.length > 3 && <li className="list-none text-slate-400">…και άλλα {n.items.length - 3}</li>}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
