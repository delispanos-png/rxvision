"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";

type Notif = {
  sound_repeat_seconds: number;
  escalate_popup_minutes: number;
  auto_cancel_minutes: number;
  auto_cancel_enabled: boolean;
  order_auto_cancel_minutes: number;
  order_auto_cancel_enabled: boolean;
};

const DEFAULTS: Notif = {
  sound_repeat_seconds: 30, escalate_popup_minutes: 3,
  auto_cancel_minutes: 5, auto_cancel_enabled: true,
  order_auto_cancel_minutes: 30, order_auto_cancel_enabled: true,
};

function errMsg(e: unknown, fallback: string) {
  const d = (e as { problem?: { detail?: string } })?.problem?.detail;
  return typeof d === "string" ? d : fallback;
}

export default function NotificationsPage() {
  const { data } = useQuery({ queryKey: ["admin", "notifications"], queryFn: () => adminApi<Notif>("/admin/notifications"), retry: false });
  const [form, setForm] = useState<Notif>(DEFAULTS);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (data) setForm({ ...DEFAULTS, ...data }); }, [data]);
  const set = (k: keyof Notif, v: number | boolean) => setForm((s) => ({ ...s, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(null);
    try {
      await adminApi("/admin/notifications", { method: "PUT", body: JSON.stringify(form) });
      setNotice("Αποθηκεύτηκε ✓");
    } catch (err) { setNotice(errMsg(err, "Σφάλμα αποθήκευσης")); }
    finally { setBusy(false); }
  }

  const Num = ({ label, k, min, max, suffix, help }: { label: string; k: keyof Notif; min: number; max: number; suffix: string; help: string }) => (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <input type="number" min={min} max={max} value={form[k] as number}
          onChange={(e) => set(k, Math.max(min, Math.min(max, Number(e.target.value) || min)))}
          className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
        <span className="text-sm text-slate-500">{suffix}</span>
      </div>
      <span className="mt-1 block text-xs text-slate-400">{help}</span>
    </label>
  );

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-slate-900">Ειδοποιήσεις φαρμακείου</h1>
      <p className="mt-1 text-sm text-slate-500">Καθολικές ρυθμίσεις — ισχύουν για <b>όλους τους συνδρομητές</b> με την ίδια συνθήκη.</p>

      <form onSubmit={save} className="mt-6 space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <Num label="Επανάληψη ήχου" k="sound_repeat_seconds" min={5} max={600} suffix="δευτερόλεπτα"
          help="Κάθε πόσο επαναλαμβάνεται ο ήχος ειδοποίησης όσο υπάρχει αδιαχείριστη εκκρεμότητα." />
        <Num label="Αναδυόμενο παράθυρο (escalation)" k="escalate_popup_minutes" min={1} max={60} suffix="λεπτά"
          help="Μετά από πόσα λεπτά χωρίς διαχείριση εμφανίζεται pop-up στον φαρμακοποιό." />

        <div className="border-t border-slate-100 pt-5">
          <label className="flex items-center gap-2.5">
            <input type="checkbox" checked={form.auto_cancel_enabled} onChange={(e) => set("auto_cancel_enabled", e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
            <span className="text-sm font-medium text-slate-700">Αυτόματη ακύρωση <b>αιτημάτων πελατών</b> αν δεν αποδεχτεί ο φαρμακοποιός</span>
          </label>
          <p className="ml-7 mt-0.5 text-xs text-slate-400">Διαθεσιμότητα, ραντεβού/παραλαβή, ανάθεση συνταγής.</p>
          <div className={`mt-3 ${form.auto_cancel_enabled ? "" : "pointer-events-none opacity-50"}`}>
            <Num label="Όριο αυτόματης ακύρωσης αιτημάτων" k="auto_cancel_minutes" min={1} max={1440} suffix="λεπτά"
              help="Το αίτημα του πελάτη ακυρώνεται αυτόματα και ειδοποιείται, αν δεν γίνει αποδοχή εντός αυτού του χρόνου." />
          </div>
        </div>

        <div className="border-t border-slate-100 pt-5">
          <label className="flex items-center gap-2.5">
            <input type="checkbox" checked={form.order_auto_cancel_enabled} onChange={(e) => set("order_auto_cancel_enabled", e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
            <span className="text-sm font-medium text-slate-700">Αυτόματη ακύρωση <b>παραγγελιών</b> (παραφάρμακα/OTC)</span>
          </label>
          <p className="ml-7 mt-0.5 text-xs text-slate-400">Ξεχωριστό όριο — οι παραγγελίες προϊόντων δεν ακυρώνονται στον ίδιο χρόνο με τα αιτήματα.</p>
          <div className={`mt-3 ${form.order_auto_cancel_enabled ? "" : "pointer-events-none opacity-50"}`}>
            <Num label="Όριο αυτόματης ακύρωσης παραγγελιών" k="order_auto_cancel_minutes" min={1} max={1440} suffix="λεπτά"
              help="Νέα παραγγελία που δεν αποδέχεται ο φαρμακοποιός (δεν περνά σε «ετοιμασία») ακυρώνεται αυτόματα μετά από αυτόν τον χρόνο." />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy}
            className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {busy ? "Αποθήκευση…" : "Αποθήκευση"}
          </button>
          {notice && <span className="text-sm text-slate-600">{notice}</span>}
        </div>
      </form>
    </div>
  );
}
