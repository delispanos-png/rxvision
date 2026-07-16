"use client";

// Δίκτυο φαρμακείων — σε ποια φαρμακεία μπορεί να ΣΥΝΔΕΘΕΙ ένας χρήστης.
// Καλύπτει και τα δύο σενάρια (ίδιο ΑΦΜ ή διαφορετικό): το ΑΦΜ δεν παίζει ρόλο στην πρόσβαση.
// Γράφεται ΜΟΝΟ από εδώ — ένα φαρμακείο δεν πρέπει να μπορεί να δώσει στον εαυτό του πρόσβαση αλλού.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Store, Check, Loader2 } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type NUser = { id: string; email: string; name: string; tenant_id: string; tenant_name: string; afm?: string; is_owner?: boolean; tenant_ids: string[]; extra_names: string[]; auto_names: string[] };
// Σχήμα του /admin/tenants → items: [{id, name, afm, plan, status, …}]
type Tenant = { id: string; name?: string; afm?: string | null };

export default function NetworkPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [ownersOnly, setOwnersOnly] = useState(true);   // η πολλαπλή πρόσβαση αφορά ιδιοκτήτες
  const [edit, setEdit] = useState<NUser | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [saved, setSaved] = useState("");

  const users = useQuery({ queryKey: ["network-users", term, ownersOnly], queryFn: () => adminApi<{ items: NUser[] }>(`/admin/network/users?q=${encodeURIComponent(term)}&owners_only=${ownersOnly}`), retry: false });
  // ΠΡΟΣΟΧΗ: το /admin/tenants επιστρέφει {items: [...]}, ΟΧΙ γυμνό πίνακα.
  const tenants = useQuery({ queryKey: ["admin-tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), staleTime: 300_000, retry: false });

  useEffect(() => { if (edit) setSel(edit.tenant_ids ?? []); }, [edit]);

  const save = useMutation({
    mutationFn: () => adminApi(`/admin/network/users/${edit!.id}`, { method: "PUT", body: JSON.stringify({ tenant_ids: sel }) }),
    onSuccess: () => { setSaved("Αποθηκεύτηκε ✓"); qc.invalidateQueries({ queryKey: ["network-users"] }); setEdit(null); },
  });

  const tid = (t: Tenant) => String(t.id ?? "");
  const tname = (t: Tenant) => t.name || tid(t);
  const list = (tenants.data?.items ?? []).filter((t) => tid(t) && tid(t) !== edit?.tenant_id);
  const toggle = (id: string) => setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  return (
    <div className="max-w-6xl">
      <h1 className="mb-1 text-xl font-bold text-slate-900">Δίκτυο φαρμακείων</h1>
      <p className="mb-3 text-sm text-slate-500">
        Ένα login, επιλογέας φαρμακείου πάνω-πάνω. Η χρέωση παραμένει <b>ανά φαρμακείο</b>.
      </p>
      <div className="mb-5 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-900">
          <b>⚡ Ίδιο ΑΦΜ → αυτόματα.</b> Όποιος έχει ρόλο <b>ιδιοκτήτη</b> βλέπει όλα τα φαρμακεία με το ίδιο ΑΦΜ,
          χωρίς καμία ρύθμιση εδώ. Προϋπόθεση: το φαρμακείο να έχει <b>συμπληρωμένο ΑΦΜ</b>.
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-xs text-indigo-900">
          <b>Διαφορετικά ΑΦΜ → χειροκίνητα εδώ.</b> Δηλώνεις εσύ ποια φαρμακεία ανήκουν στον ίδιο ιδιοκτήτη
          (π.χ. δίκτυο 7 φαρμακείων με ξεχωριστές εταιρείες).
        </div>
      </div>
      {saved && <div className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{saved}</div>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Αναζήτηση χρήστη (email ή όνομα)…"
            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:outline-none" />
        </form>
        <label className="flex shrink-0 items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={ownersOnly} onChange={(e) => setOwnersOnly(e.target.checked)} className="h-4 w-4" />
          Μόνο ιδιοκτήτες
        </label>
      </div>

      {/* Ομαδοποίηση ΑΝΑ ΥΠΟΔΟΜΗ ΠΕΛΑΤΗ — για να φαίνεται με μια ματιά πού ανήκει ο καθένας. */}
      {(() => {
        const items = users.data?.items ?? [];
        if (items.length === 0) {
          return <div className="rounded-xl border border-slate-200 bg-white py-10 text-center text-sm text-slate-400">
            {term ? "Κανένας χρήστης." : ownersOnly ? "Κανένας ιδιοκτήτης." : "Κανένας χρήστης."}
          </div>;
        }
        const groups = new Map<string, { name: string; afm?: string; users: NUser[] }>();
        for (const u of items) {
          const k = u.tenant_id;
          if (!groups.has(k)) groups.set(k, { name: u.tenant_name || u.tenant_id, afm: u.afm, users: [] });
          groups.get(k)!.users.push(u);
        }
        const ordered = [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, "el"));
        return (
          <div className="space-y-3">
            {ordered.map(([k, g]) => (
              <div key={k} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                  <Store className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="font-semibold text-slate-800">{g.name}</span>
                  {g.afm
                    ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">ΑΦΜ {g.afm}</span>
                    : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">χωρίς ΑΦΜ</span>}
                  <span className="ml-auto text-[11px] text-slate-400">{g.users.length} {g.users.length === 1 ? "λογαριασμός" : "λογαριασμοί"}</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {g.users.map((u) => (
                    <div key={u.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <div className="min-w-[180px] flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-800">{u.name || "—"}</span>
                          {u.is_owner
                            ? <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-500">ιδιοκτήτης</span>
                            : <span className="rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700">όχι ιδιοκτήτης</span>}
                        </div>
                        <div className="text-xs text-slate-400">{u.email}</div>
                      </div>
                      <div className="flex min-w-[160px] flex-1 flex-wrap gap-1">
                        {/* ⚡ αυτόματα από ίδιο ΑΦΜ · μπλε = χειροκίνητα (διαφορετικό ΑΦΜ) */}
                        {u.auto_names?.map((n, i) => (
                          <span key={`a${i}`} title="Αυτόματα — ίδιο ΑΦΜ" className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">⚡ {n}</span>
                        ))}
                        {u.extra_names.map((n, i) => (
                          <span key={`e${i}`} title="Χειροκίνητα (διαφορετικό ΑΦΜ)" className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">{n}</span>
                        ))}
                        {u.auto_names?.length === 0 && u.extra_names.length === 0 && <span className="text-xs text-slate-400">καμία επιπλέον πρόσβαση</span>}
                      </div>
                      <button onClick={() => { setSaved(""); setEdit(u); }}
                        className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700">Ρύθμιση</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {edit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setEdit(null)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 font-semibold text-slate-800">Πρόσβαση του «{edit.name || edit.email}»</div>
            <p className="mb-3 text-xs text-slate-500">
              Κύριο φαρμακείο: <b>{edit.tenant_name || edit.tenant_id}</b> (πάντα προσβάσιμο). Διάλεξε ποια <b>επιπλέον</b> φαρμακεία θα βλέπει.
            </p>
            <div className="mb-3 max-h-72 space-y-1 overflow-auto rounded-xl border border-slate-200 p-2">
              {list.map((t) => {
                const id = tid(t); const on = sel.includes(id);
                return (
                  <button key={id} onClick={() => toggle(id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${on ? "bg-indigo-50 text-indigo-800" : "hover:bg-slate-50 text-slate-700"}`}>
                    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300"}`}>{on && <Check className="h-3 w-3" />}</span>
                    <Store className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate">{tname(t)}</span>
                    <span className="shrink-0 text-[10px] text-slate-400">{t.afm ? `ΑΦΜ ${t.afm}` : ""}</span>
                  </button>
                );
              })}
              {list.length === 0 && <p className="py-4 text-center text-xs text-slate-400">Δεν υπάρχουν άλλα φαρμακεία.</p>}
            </div>
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              ⚠️ Ο χρήστης θα έχει <b>τα ίδια δικαιώματα</b> σε κάθε επιλεγμένο φαρμακείο. Κάθε φαρμακείο χρεώνεται ξεχωριστά και πρέπει να έχει ενεργή συνδρομή.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="px-3 py-2 text-sm text-slate-400">Άκυρο</button>
              <button onClick={() => save.mutate()} disabled={save.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
                {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Αποθήκευση
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
