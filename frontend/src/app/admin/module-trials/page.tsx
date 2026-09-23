"use client";

/* Δοκιμές δυνατοτήτων — ποιος πελάτης δοκιμάζει τι, πότε το πήρε, πότε του λήγει.

   ΓΙΑΤΙ ΥΠΑΡΧΕΙ: οι δοκιμές ΔΥΝΑΤΟΤΗΤΩΝ δεν φαίνονταν πουθενά — μόνο οι δοκιμές ΣΥΝΔΡΟΜΗΣ
   (/admin/lifecycle). Χωρίς αυτή την οθόνη μια δοκιμή έληγε σιωπηλά και ο πελάτης έφευγε. */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { FlaskConical, Mail, Clock, CheckCircle2, XCircle, Settings2, Loader2, Save } from "lucide-react";

type Row = {
  tenant_id: string; tenant_name: string; plan_name?: string | null;
  module: string; module_label: string; icon?: string | null;
  started_at?: string | null; started_exact?: boolean; expires_at?: string | null;
  days_left?: number | null; status: string; status_label: string;
  source: "self" | "platform"; granted_by?: string | null;
  price_monthly?: number | null; price_yearly?: number | null; notified_at?: string | null;
};
type Settings = {
  enabled?: boolean; warn_days?: number[]; notify_on_expiry?: boolean;
  sales_email?: string; sales_phone?: string;
};
type Data = { items: Row[]; counts: Record<string, number>; total: number;
  conversion_rate: number | null; settings: Settings };

const dt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const eur = (c?: number | null) => (c ? `${Math.round(c / 100)} €` : "—");
const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800";

const TABS: [string, string][] = [
  ["all", "Όλες"], ["expiring", "Λήγουν σύντομα"], ["active", "Σε δοκιμή"],
  ["expired", "Έληξαν χωρίς αγορά"], ["converted", "Αγοράστηκαν"],
];

const CHIP: Record<string, string> = {
  expiring: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  active: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  expired: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  converted: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  unknown: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};

export default function ModuleTrialsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("all");
  const [showCfg, setShowCfg] = useState(false);
  const [cfg, setCfg] = useState<Settings | null>(null);

  // Χωρίς αυτό, όποιος ΔΕΝ έχει το δικαίωμα αποστολής θα έπαιρνε 403 → ο adminClient τον πετάει
  // στο login. Κρύβουμε λοιπόν ό,τι δεν του επιτρέπεται, αντί να τον βγάζουμε έξω.
  const { data: me } = useQuery<{ super_admin: boolean; permissions: string[] }>({
    queryKey: ["admin", "me"],
    queryFn: () => adminApi("/platform/auth/me"),
    staleTime: 5 * 60_000,
  });
  const canNotify = !me || me.super_admin || me.permissions?.includes("*")
    || me.permissions?.includes("subscriptions:notifications");

  const { data, isLoading } = useQuery<Data>({
    queryKey: ["admin", "module-trials", tab],
    queryFn: () => adminApi<Data>(`/admin/module-trials${tab === "all" ? "" : `?status=${tab}`}`),
  });

  const notify = useMutation({
    mutationFn: (r: Row) => adminApi<{ ok: boolean; email?: string }>("/admin/module-trials/notify", {
      method: "POST", body: JSON.stringify({ tenant_id: r.tenant_id, module: r.module }),
    }),
    onSuccess: (res) => {
      appAlert(`Το email στάλθηκε στο ${res.email}.`, { title: "Εστάλη" });
      qc.invalidateQueries({ queryKey: ["admin", "module-trials"] });
    },
    onError: (e: unknown) => {
      const detail = e instanceof ApiError ? (e.problem as { detail?: { error?: string } })?.detail : undefined;
      appAlert(detail?.error === "no_email"
        ? "Ο πελάτης δεν έχει email χρέωσης — συμπλήρωσέ το στην καρτέλα του."
        : "Η αποστολή απέτυχε. Έλεγξε τις ρυθμίσεις SMTP.", { title: "Σφάλμα" });
    },
  });

  const saveCfg = useMutation({
    mutationFn: (v: Settings) => adminApi<Settings>("/admin/module-trials/settings", {
      method: "PUT", body: JSON.stringify(v),
    }),
    onSuccess: () => {
      appAlert("Οι ρυθμίσεις αποθηκεύτηκαν.", { title: "Έτοιμο" });
      setShowCfg(false);
      qc.invalidateQueries({ queryKey: ["admin", "module-trials"] });
    },
  });

  const rows = data?.items ?? [];
  const c = data?.counts ?? {};
  const s = cfg ?? data?.settings ?? {};

  const send = async (r: Row) => {
    const ok = await appConfirm(
      `Να σταλεί ενημέρωση αγοράς στο «${r.tenant_name}» για τη δυνατότητα «${r.module_label}»;`,
      { title: "Ενημέρωση αγοράς" });
    if (ok) notify.mutate(r);
  };

  return (
    <div className="w-full space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FlaskConical className="h-5 w-5 text-indigo-600" /> Δοκιμές δυνατοτήτων
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Ποιος δοκιμάζει τι, πότε του λήγει και αν το αγόρασε. Η ενημέρωση αγοράς φεύγει αυτόματα
            {s.warn_days?.length ? ` ${s.warn_days.join(" και ")} ημέρες πριν τη λήξη` : ""}.
          </p>
        </div>
        {canNotify && <button onClick={() => { setCfg(data?.settings ?? {}); setShowCfg((v) => !v); }}
          className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">
          <Settings2 className="h-4 w-4" /> Ρυθμίσεις ειδοποίησης
        </button>}
      </header>

      {showCfg && canNotify && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Ημέρες πριν τη λήξη</span>
              <input className={inp} defaultValue={(s.warn_days ?? []).join(", ")}
                onChange={(e) => setCfg({ ...s, warn_days: e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n)) })} />
              <span className="mt-1 block text-xs text-slate-500">Χωρισμένες με κόμμα, π.χ. 7, 3, 1</span>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Email πωλήσεων</span>
              <input className={inp} defaultValue={s.sales_email ?? ""}
                onChange={(e) => setCfg({ ...s, sales_email: e.target.value })} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Τηλέφωνο πωλήσεων</span>
              <input className={inp} defaultValue={s.sales_phone ?? ""}
                onChange={(e) => setCfg({ ...s, sales_phone: e.target.value })} />
            </label>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" defaultChecked={s.enabled !== false}
                  onChange={(e) => setCfg({ ...s, enabled: e.target.checked })} />
                Αυτόματη αποστολή ενεργή
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" defaultChecked={s.notify_on_expiry !== false}
                  onChange={(e) => setCfg({ ...s, notify_on_expiry: e.target.checked })} />
                Και την ημέρα που λήγει
              </label>
            </div>
          </div>
          <button onClick={() => saveCfg.mutate(s)} disabled={saveCfg.isPending}
            className="mt-4 flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {saveCfg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Αποθήκευση
          </button>
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<Clock className="h-4 w-4" />} label="Λήγουν σύντομα" value={c.expiring ?? 0} tone="amber" />
        <Kpi icon={<FlaskConical className="h-4 w-4" />} label="Σε δοκιμή" value={c.active ?? 0} tone="sky" />
        <Kpi icon={<XCircle className="h-4 w-4" />} label="Έληξαν χωρίς αγορά" value={c.expired ?? 0} tone="rose" />
        <Kpi icon={<CheckCircle2 className="h-4 w-4" />} label="Μετατροπή δοκιμής σε αγορά"
          value={data?.conversion_rate == null ? "—" : `${data.conversion_rate}%`} tone="emerald" />
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-full px-3 py-1.5 text-sm ${tab === k
              ? "bg-indigo-600 text-white"
              : "border border-slate-300 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"}`}>
            {label}{k !== "all" && c[k] ? ` (${c[k]})` : ""}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-800">
            <tr>
              <th className="px-4 py-3">Φαρμακείο</th>
              <th className="px-4 py-3">Δυνατότητα</th>
              <th className="px-4 py-3">Ξεκίνησε</th>
              <th className="px-4 py-3">Λήγει</th>
              <th className="px-4 py-3">Κατάσταση</th>
              <th className="px-4 py-3">Τιμή</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Φόρτωση…</td></tr>}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Καμία δοκιμή σε αυτή την κατηγορία.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.tenant_id}:${r.module}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="px-4 py-3">
                  <a href={`/admin/subscribers/${r.tenant_id}`} className="font-medium text-indigo-600 hover:underline">
                    {r.tenant_name}
                  </a>
                  {r.plan_name && <div className="text-xs text-slate-500">{r.plan_name}</div>}
                </td>
                <td className="px-4 py-3">
                  {r.icon} {r.module_label}
                  <div className="text-xs text-slate-500">
                    {r.source === "platform" ? `παραχώρηση${r.granted_by ? ` · ${r.granted_by}` : ""}` : "αυτοεξυπηρέτηση"}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {dt(r.started_at)}
                  {!r.started_exact && <span className="ml-1 text-xs text-slate-400" title="Δεν καταγραφόταν η έναρξη τότε">κατά προσέγγιση</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {dt(r.expires_at)}
                  {r.days_left != null && r.status !== "converted" && (
                    <div className="text-xs text-slate-500">
                      {r.days_left >= 0 ? `σε ${r.days_left} ημ.` : `πριν ${Math.abs(r.days_left)} ημ.`}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs font-medium ${CHIP[r.status] ?? CHIP.unknown}`}>
                    {r.status_label}
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600 dark:text-slate-300">
                  {eur(r.price_monthly)}{r.price_monthly ? "/μ" : ""}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.status !== "converted" && canNotify && (
                    <button onClick={() => send(r)} disabled={notify.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700">
                      <Mail className="h-3.5 w-3.5" /> Ενημέρωση αγοράς
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone: string }) {
  const tones: Record<string, string> = {
    amber: "text-amber-600 dark:text-amber-400", sky: "text-sky-600 dark:text-sky-400",
    rose: "text-rose-600 dark:text-rose-400", emerald: "text-emerald-600 dark:text-emerald-400",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className={`flex items-center gap-2 text-xs font-medium ${tones[tone]}`}>{icon} {label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
