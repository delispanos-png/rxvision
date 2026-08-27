"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Receipt, Save, X, Zap, ShieldOff } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appConfirm, appAlert } from "@/store/dialogStore";
import { fmtEur, fmtDate } from "@/lib/formatters";

type FeeConfig = {
  enabled: boolean;
  default_cents: number;
  min_order_cents: number;
  cap_pct: number;
  min_charge_cents: number;
  charge_weekday: number; // 0 = Δευτέρα … 6 = Κυριακή
};

type OverviewItem = {
  tenant_id: string;
  name: string;
  fee_cents: number;
  override: number | null;
  exempt: boolean;
  accrued: { count: number; cents: number };
  last_charged_at: string | null;
  last_charged_cents: number | null;
  last_status: string | null;
};

type Overview = { items: OverviewItem[] };

const WEEKDAYS = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο", "Κυριακή"];

// € (string) → integer cents. Empty/invalid → 0.
const eurToCents = (v: string) => Math.round((parseFloat((v || "").replace(",", ".")) || 0) * 100);
// integer cents → € string for editable inputs.
const centsToEur = (c: number) => (c / 100).toFixed(2);

function statusBadge(status: string | null) {
  if (!status) return null;
  const map: Record<string, { cls: string; label: string }> = {
    ok: { cls: "bg-emerald-50 text-emerald-700", label: "Επιτυχής" },
    success: { cls: "bg-emerald-50 text-emerald-700", label: "Επιτυχής" },
    failed: { cls: "bg-rose-50 text-rose-700", label: "Αποτυχία" },
    error: { cls: "bg-rose-50 text-rose-700", label: "Σφάλμα" },
    pending: { cls: "bg-amber-50 text-amber-700", label: "Εκκρεμεί" },
    skipped: { cls: "bg-slate-100 text-slate-600", label: "Παραλείφθηκε" },
  };
  const m = map[status.toLowerCase()] ?? { cls: "bg-slate-100 text-slate-600", label: status };
  return <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>{m.label}</span>;
}

export default function EshopFeesPage() {
  const qc = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ["admin", "eshop-fees", "config"],
    queryFn: () => adminApi<FeeConfig>("/admin/eshop-fees/config"),
    retry: false,
  });
  const { data: overview } = useQuery({
    queryKey: ["admin", "eshop-fees", "overview"],
    queryFn: () => adminApi<Overview>("/admin/eshop-fees/overview"),
    retry: false,
  });

  // ---- Global config form state ----
  const [enabled, setEnabled] = useState(true);
  const [defaultEur, setDefaultEur] = useState("0.00");
  const [minOrderEur, setMinOrderEur] = useState("0.00");
  const [capPct, setCapPct] = useState("0");
  const [minEur, setMinEur] = useState("0.00");
  const [weekday, setWeekday] = useState(0);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (!config) return;
    setEnabled(config.enabled);
    setDefaultEur(centsToEur(config.default_cents));
    setMinOrderEur(centsToEur(config.min_order_cents));
    setCapPct(String(config.cap_pct));
    setMinEur(centsToEur(config.min_charge_cents));
    setWeekday(config.charge_weekday);
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: (body: Partial<FeeConfig>) =>
      adminApi<FeeConfig>("/admin/eshop-fees/config", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "eshop-fees", "config"] });
      qc.invalidateQueries({ queryKey: ["admin", "eshop-fees", "overview"] });
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 4000);
    },
    onError: () => appAlert("Αποτυχία αποθήκευσης ρυθμίσεων."),
  });

  const saveTenant = useMutation({
    mutationFn: ({ tenantId, body }: { tenantId: string; body: { fee_cents?: number; exempt?: boolean } }) =>
      adminApi(`/admin/eshop-fees/tenant/${encodeURIComponent(tenantId)}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "eshop-fees", "overview"] }),
    onError: () => appAlert("Αποτυχία αποθήκευσης."),
  });

  const chargeTenant = useMutation({
    mutationFn: (tenantId: string) =>
      adminApi<{ ok: boolean; count: number; gross_cents: number; error?: string }>(
        `/admin/eshop-fees/tenant/${encodeURIComponent(tenantId)}/charge`,
        { method: "POST" }
      ),
    onSuccess: async (r) => {
      qc.invalidateQueries({ queryKey: ["admin", "eshop-fees", "overview"] });
      if (r.ok) {
        await appAlert(`✓ Χρεώθηκαν ${r.count} παραγγελίες — σύνολο ${fmtEur(r.gross_cents)}.`, { title: "Χρέωση προμηθειών" });
      } else {
        await appAlert(`Η χρέωση απέτυχε.${r.error ? `\n${r.error}` : ""}`, { title: "Χρέωση προμηθειών" });
      }
    },
    onError: () => appAlert("Αποτυχία χρέωσης."),
  });

  return (
    <div className="w-full">
      {/* Header */}
      <div className="mb-1 flex items-center gap-2">
        <Receipt className="h-5 w-5 text-brand-600" />
        <h1 className="text-xl font-bold text-slate-900">Προμήθειες συναλλαγής e-shop</h1>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Πάγια προμήθεια ανά e-shop παραγγελία. Συσσωρεύεται ανά φαρμακείο και χρεώνεται <b>εβδομαδιαία</b> στην
        κάρτα του φαρμακείου.
      </p>

      {/* Global config */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-700">Καθολικές ρυθμίσεις</h2>
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ${
              enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${enabled ? "bg-emerald-500" : "bg-slate-400"}`} />
            {enabled ? "Ενεργό" : "Ανενεργό"}
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-400">Προεπιλογή / παραγγελία (€)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={defaultEur}
              onChange={(e) => setDefaultEur(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-400">Ελάχιστη αξία παραγγελίας (€)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={minOrderEur}
              onChange={(e) => setMinOrderEur(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-slate-400">
              Κάτω απ&apos; αυτή την αξία → καμία χρέωση (μικρές παραγγελίες δωρεάν).
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-400">Πλαφόν % αξίας</span>
            <input
              type="number"
              step="1"
              min="0"
              max="100"
              value={capPct}
              onChange={(e) => setCapPct(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-slate-400">
              Το φ δεν ξεπερνά αυτό το % της αξίας (0 = χωρίς πλαφόν). Π.χ. 10% → παραγγελία 3€ χρεώνεται max 0,30€.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-400">Ελάχιστο εβδ. χρέωσης / κατώφλι (€)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={minEur}
              onChange={(e) => setMinEur(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-slate-400">
              Κάτω απ&apos; αυτό το ποσό → μεταφορά (roll-over) στην επόμενη εβδομάδα.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-slate-400">Ημέρα χρέωσης</span>
            <select
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={i} value={i}>{d}</option>
              ))}
            </select>
          </label>
        </div>

        {savedNotice && (
          <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">✓ Οι ρυθμίσεις αποθηκεύτηκαν.</div>
        )}

        <div className="mt-4">
          <button
            onClick={() =>
              saveConfig.mutate({
                enabled,
                default_cents: eurToCents(defaultEur),
                min_order_cents: eurToCents(minOrderEur),
                cap_pct: Math.max(0, Math.min(100, Math.round(parseFloat(capPct) || 0))),
                min_charge_cents: eurToCents(minEur),
                charge_weekday: weekday,
              })
            }
            disabled={saveConfig.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <Save className="h-4 w-4" /> {saveConfig.isPending ? "Αποθήκευση…" : "Αποθήκευση"}
          </button>
        </div>
      </div>

      {/* Per-tenant table */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Ανά φαρμακείο</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase text-slate-400">
                <th className="px-4 py-2.5">Φαρμακείο</th>
                <th className="px-4 py-2.5">Προμήθεια / παραγγελία</th>
                <th className="px-4 py-2.5">Εξαίρεση</th>
                <th className="px-4 py-2.5">Δεδουλευμένα</th>
                <th className="px-4 py-2.5">Τελευταία χρέωση</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {(overview?.items ?? []).map((it) => (
                <TenantRow
                  key={it.tenant_id}
                  it={it}
                  defaultCents={config?.default_cents ?? 0}
                  saving={saveTenant.isPending}
                  charging={chargeTenant.isPending}
                  onSetFee={(cents) => saveTenant.mutate({ tenantId: it.tenant_id, body: { fee_cents: cents } })}
                  onToggleExempt={(exempt) => saveTenant.mutate({ tenantId: it.tenant_id, body: { exempt } })}
                  onCharge={async () => {
                    if (
                      await appConfirm(
                        `Χρέωση τώρα των δεδουλευμένων προμηθειών του «${it.name}»;\n${it.accrued.count} παραγγελίες · ${fmtEur(it.accrued.cents)} στην κάρτα του φαρμακείου.`,
                        { title: "Χρέωση προμηθειών", confirmText: "Χρέωσε τώρα" }
                      )
                    ) {
                      chargeTenant.mutate(it.tenant_id);
                    }
                  }}
                />
              ))}
              {overview && overview.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400">Δεν υπάρχουν φαρμακεία.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TenantRow({
  it,
  defaultCents,
  saving,
  charging,
  onSetFee,
  onToggleExempt,
  onCharge,
}: {
  it: OverviewItem;
  defaultCents: number;
  saving: boolean;
  charging: boolean;
  onSetFee: (cents: number) => void;
  onToggleExempt: (exempt: boolean) => void;
  onCharge: () => void;
}) {
  const [feeDraft, setFeeDraft] = useState<string>(it.override != null ? centsToEur(it.override) : "");

  useEffect(() => {
    setFeeDraft(it.override != null ? centsToEur(it.override) : "");
  }, [it.override]);

  const commitFee = () => {
    const trimmed = feeDraft.trim();
    if (trimmed === "") {
      // empty draft → leave as default (no-op unless clearing an existing override)
      if (it.override != null) onSetFee(-1);
      return;
    }
    const cents = eurToCents(trimmed);
    if (cents !== it.override) onSetFee(cents);
  };

  return (
    <tr className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
      <td className="px-4 py-3 font-medium text-slate-800">
        {it.name}
        {it.exempt && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            <ShieldOff className="h-3 w-3" /> Εξαίρεση
          </span>
        )}
      </td>

      {/* Fee per order */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <input
              type="number"
              step="0.01"
              min="0"
              value={feeDraft}
              placeholder={`προεπιλογή (${centsToEur(defaultCents)})`}
              onChange={(e) => setFeeDraft(e.target.value)}
              onBlur={commitFee}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              disabled={saving || it.exempt}
              className="w-36 rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">€</span>
          </div>
          {it.override != null && !it.exempt && (
            <button
              type="button"
              title="Επαναφορά στην προεπιλογή"
              onClick={() => onSetFee(-1)}
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </td>

      {/* Exempt toggle */}
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={() => onToggleExempt(!it.exempt)}
          disabled={saving}
          className={`inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${it.exempt ? "bg-emerald-500" : "bg-slate-300"}`}
          title={it.exempt ? "Εξαιρεμένο — κλικ για επαναφορά χρέωσης" : "Χρεώνεται — κλικ για εξαίρεση"}
        >
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${it.exempt ? "translate-x-[22px]" : "translate-x-0.5"}`} />
        </button>
      </td>

      {/* Accrued */}
      <td className="px-4 py-3 text-slate-700">
        {it.accrued.count > 0 ? (
          <span>
            <b>{it.accrued.count}</b> παραγγ. · {fmtEur(it.accrued.cents)}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>

      {/* Last charge */}
      <td className="px-4 py-3 text-slate-700">
        {it.last_charged_at ? (
          <span className="whitespace-nowrap">
            {fmtDate(it.last_charged_at)}
            {it.last_charged_cents != null && <span className="text-slate-500"> · {fmtEur(it.last_charged_cents)}</span>}
            {statusBadge(it.last_status)}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>

      {/* Charge now */}
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={onCharge}
          disabled={charging || it.exempt || it.accrued.cents <= 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          <Zap className="h-4 w-4" /> Χρέωσε τώρα
        </button>
      </td>
    </tr>
  );
}
