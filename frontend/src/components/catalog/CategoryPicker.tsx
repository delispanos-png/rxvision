"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

export type Cat = { id: string; name: string; parent_id: string | null; level: number; image_id?: string | null; icon?: string | null };
export type CatValue = { cat1_id?: string | null; cat2_id?: string | null; cat3_id?: string | null };

export function useCategoryTree() {
  return useQuery({ queryKey: ["catalog-cat-tree"], queryFn: () => api<{ items: Cat[] }>("/catalog/category-tree"), staleTime: 60_000, retry: false });
}

/** Πλήρες μονοπάτι κατηγορίας από ids → «Κατ1 › Κατ2 › Κατ3» (για badges/λίστες). */
export function catPath(cats: Cat[], v: CatValue): string {
  const byId = new Map(cats.map((c) => [c.id, c.name]));
  return [v.cat1_id, v.cat2_id, v.cat3_id].map((id) => id && byId.get(id)).filter(Boolean).join(" › ");
}

const NEW = "__new__";

export function CategoryPicker({ value, onChange }: { value: CatValue; onChange: (v: Required<CatValue>) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useCategoryTree();
  const cats = data?.items ?? [];
  const options = (level: number, parent: string | null) =>
    cats.filter((c) => c.level === level && (level === 1 ? true : c.parent_id === parent));

  const setLevel = (level: 1 | 2 | 3, id: string) => {
    const v: Required<CatValue> = { cat1_id: value.cat1_id ?? null, cat2_id: value.cat2_id ?? null, cat3_id: value.cat3_id ?? null };
    if (level === 1) { v.cat1_id = id || null; v.cat2_id = null; v.cat3_id = null; }
    if (level === 2) { v.cat2_id = id || null; v.cat3_id = null; }
    if (level === 3) { v.cat3_id = id || null; }
    onChange(v);
  };

  async function pick(level: 1 | 2 | 3, val: string) {
    if (val !== NEW) { setLevel(level, val); return; }
    const parent = level === 1 ? null : level === 2 ? (value.cat1_id ?? null) : (value.cat2_id ?? null);
    const name = await appPrompt(t(`Νέα κατηγορία επιπέδου ${level}`, `New level-${level} category`), { placeholder: t("Όνομα κατηγορίας", "Category name") });
    if (!name || !name.trim()) return;
    const r = await api<{ ok: boolean; id?: string }>("/catalog/category", { method: "POST", body: JSON.stringify({ name: name.trim(), parent_id: parent }) });
    await qc.invalidateQueries({ queryKey: ["catalog-cat-tree"] });
    if (r.id) setLevel(level, r.id);
  }

  const Sel = ({ level, cur, parent, label, disabled }: { level: 1 | 2 | 3; cur: string | null | undefined; parent: string | null; label: string; disabled?: boolean }) => (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-slate-500">{label}{level === 1 && <span className="text-rose-500"> *</span>}</span>
      <select value={cur || ""} disabled={disabled} onChange={(e) => pick(level, e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:disabled:bg-slate-800">
        <option value="">{disabled ? t("(επίλεξε πρώτα την πάνω)", "(pick the level above first)") : `— ${label} —`}</option>
        {options(level, parent).map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name}</option>)}
        {!disabled && <option value={NEW}>+ {t("Νέα κατηγορία…", "New category…")}</option>}
      </select>
    </label>
  );

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Sel level={1} cur={value.cat1_id} parent={null} label={t("Κατηγορία 1", "Category 1")} />
      <Sel level={2} cur={value.cat2_id} parent={value.cat1_id ?? null} label={t("Κατηγορία 2", "Category 2")} disabled={!value.cat1_id} />
      <Sel level={3} cur={value.cat3_id} parent={value.cat2_id ?? null} label={t("Κατηγορία 3", "Category 3")} disabled={!value.cat2_id} />
    </div>
  );
}
