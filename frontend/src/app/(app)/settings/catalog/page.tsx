"use client";

/* Ενημέρωση καταλόγου — ο φαρμακοποιός διαλέγει ΜΕ ΠΟΙΑ θέλει να ενημερώνεται.

   Η σελίδα λέει ρητά τι ΔΕΝ πειράζουμε. Ένας κατάλογος που αλλάζει μόνος του κάθε βράδυ είναι
   τρομακτικός αν δεν ξέρεις τι ακριβώς αγγίζει — και ο φαρμακοποιός έχει βάλει δικές του τιμές
   και αποθέματα που δεν πρέπει να χαθούν. */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Loader2, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Cfg = { types: string[]; last_sync_at?: string | null;
             last_result?: { added?: number; updated?: number } | null;
             available: { key: string; label: string }[] };

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric",
                                            hour: "2-digit", minute: "2-digit" }) : "—";

export default function CatalogSyncPage() {
  return (
    <ModuleGuard module="catalog_seed">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const t = useT();
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const q = useQuery({ queryKey: ["catalog-sync"], queryFn: () => api<Cfg>("/catalog/sync-settings") });
  useEffect(() => { if (q.data) setSel(q.data.types); }, [q.data]);

  const toggle = (k: string) => {
    setSaved(false);
    setSel((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]));
  };

  async function save() {
    setBusy(true);
    try {
      await api("/catalog/sync-settings", { method: "PUT", body: JSON.stringify({ types: sel }) });
      setSaved(true);
    } catch { appAlert(t("Δεν αποθηκεύτηκε.", "Not saved.")); }
    finally { setBusy(false); }
  }

  async function syncNow() {
    setBusy(true);
    try {
      const r = await api<{ added?: number; updated?: number; skipped?: string }>(
        "/catalog/sync-now", { method: "POST" });
      await appAlert(r.skipped === "no_types"
        ? t("Δεν έχεις διαλέξει κατηγορίες.", "No categories selected.")
        : t(`✓ Νέα: ${r.added ?? 0} · Ενημερώθηκαν: ${r.updated ?? 0}`,
             `✓ New: ${r.added ?? 0} · Updated: ${r.updated ?? 0}`));
      q.refetch();
    } catch { appAlert(t("Η ενημέρωση απέτυχε.", "Update failed.")); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-slate-100">
          <RefreshCw className="h-5 w-5 text-brand-600" />
          {t("Ενημέρωση καταλόγου", "Catalog updates")}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("Κάθε βράδυ σου στέλνουμε ό,τι άλλαξε στη βάση μας, μόνο για όσα διαλέξεις.",
             "Every night we send you what changed in our database, only for what you select.")}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          {t("Θέλω να ενημερώνομαι για:", "Keep me updated on:")}
        </div>
        {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        <div className="space-y-2">
          {(q.data?.available || []).map((a) => (
            <label key={a.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              <input type="checkbox" checked={sel.includes(a.key)} onChange={() => toggle(a.key)} />
              <span className="text-slate-700 dark:text-slate-200">{a.label}</span>
            </label>
          ))}
        </div>
        {!sel.length && (
          <p className="mt-2 text-xs text-slate-400">
            {t("Χωρίς επιλογή δεν γίνεται καμία ενημέρωση.", "With nothing selected, no update runs.")}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button onClick={save} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {saved ? <Check className="h-4 w-4" /> : null}
            {saved ? t("Αποθηκεύτηκε", "Saved") : t("Αποθήκευση", "Save")}
          </button>
          <button onClick={syncNow} disabled={busy || !sel.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("Ενημέρωση τώρα", "Update now")}
          </button>
          <span className="text-xs text-slate-400">
            {t("Τελευταία ενημέρωση:", "Last update:")} {fmt(q.data?.last_sync_at)}
            {q.data?.last_result
              ? t(` · νέα ${q.data.last_result.added ?? 0}, ενημερωμένα ${q.data.last_result.updated ?? 0}`,
                   ` · new ${q.data.last_result.added ?? 0}, updated ${q.data.last_result.updated ?? 0}`)
              : ""}
          </span>
        </div>
      </section>

      {/* Ό,τι δεν αγγίζουμε — γραμμένο ρητά, γιατί αλλιώς κανείς δεν εμπιστεύεται κατάλογο που
          αλλάζει μόνος του κάθε βράδυ. */}
      <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm dark:border-slate-700 dark:bg-slate-800/40">
        <div className="mb-1.5 font-semibold text-slate-700 dark:text-slate-200">
          {t("Τι ΔΕΝ αλλάζουμε ποτέ", "What we never change")}
        </div>
        <ul className="list-inside list-disc space-y-1 text-slate-600 dark:text-slate-300">
          <li>{t("Τα αποθέματά σου.", "Your stock levels.")}</li>
          <li>{t("Ποια είδη έχεις βγάλει προς πώληση και τις εκπτώσεις σου.",
                 "Which items you put on sale and your discounts.")}</li>
          <li>{t("Τιμές που έχεις αλλάξει εσύ. Ενημερώνουμε μόνο όσες τιμές δεν έχεις πειράξει — έτσι περνούν οι κρατικές διατιμήσεις χωρίς να χαθεί καμία δική σου τιμή.",
                 "Prices you changed yourself. We only update prices you have not touched.")}</li>
        </ul>
      </section>
    </div>
  );
}
