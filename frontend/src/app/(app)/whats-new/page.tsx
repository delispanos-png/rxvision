"use client";

/* «Τι νέο υπάρχει» — ιστορικό εκδόσεων για τον πελάτη.

   ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΑ ΑΠΟ ΤΙΣ ΑΝΑΚΟΙΝΩΣΕΙΣ: εκείνες είναι στοχευμένη πρόσκληση («δοκίμασε αυτό»)
   με κοινό και CTA. Αυτό είναι ιστορικό — τι άλλαξε, πότε, για όλους. Ίδιο εργαλείο για τα δύο
   θα κατέληγε είτε σε σπαμ είτε σε ιστορικό που κανείς δεν ανοίγει. */

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Loader2, MapPin } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Item = { title: string; body?: string; icon?: string | null; where?: string | null };
type Note = { version: string; date?: string | null; title?: string; items: Item[]; is_new: boolean };

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";

export default function WhatsNewPage() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["release-notes"],
    queryFn: () => api<{ items: Note[]; unseen: number }>("/release-notes") });

  // Το άνοιγμα της σελίδας ΕΙΝΑΙ η ανάγνωση — δεν ζητάμε από τον πελάτη να πατήσει «διάβασα».
  useEffect(() => {
    if (!q.data) return;
    api("/release-notes/seen", { method: "POST" })
      .then(() => qc.invalidateQueries({ queryKey: ["release-notes-badge"] }))
      .catch(() => {});
  }, [q.data, qc]);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg">
          <Sparkles className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t("Τι νέο υπάρχει", "What's new")}
          </h1>
          <p className="text-sm text-slate-500">
            {t("Κάθε αλλαγή στο RxVision, με τη σειρά που έγινε.", "Every change in RxVision, in order.")}
          </p>
        </div>
      </header>

      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-slate-400" />}
      {!q.isLoading && !q.data?.items?.length && (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          {t("Δεν υπάρχουν ακόμη σημειώσεις έκδοσης.", "No release notes yet.")}
        </p>
      )}

      <ol className="relative space-y-4 border-l border-slate-200 pl-6 dark:border-slate-700">
        {(q.data?.items || []).map((n) => (
          <li key={n.version} className="relative">
            <span className={`absolute -left-[31px] top-1.5 h-3 w-3 rounded-full ring-4 ring-white dark:ring-slate-950 ${
              n.is_new ? "bg-violet-500" : "bg-slate-300 dark:bg-slate-600"}`} />
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  v{n.version}
                </span>
                <span className="text-xs text-slate-400">{fmt(n.date)}</span>
                {n.is_new && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                    {t("νέο", "new")}
                  </span>
                )}
                {n.title && <span className="font-semibold text-slate-800 dark:text-slate-100">{n.title}</span>}
              </div>
              <ul className="space-y-2">
                {n.items.map((it, i) => (
                  <li key={i} className="text-sm">
                    <div className="font-medium text-slate-800 dark:text-slate-100">
                      {it.icon ? `${it.icon} ` : ""}{it.title}
                    </div>
                    {it.body && <p className="mt-0.5 text-slate-500 dark:text-slate-400">{it.body}</p>}
                    {it.where && (
                      <p className="mt-1 inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        <MapPin className="h-3 w-3" />{it.where}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
