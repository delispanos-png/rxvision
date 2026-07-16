"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network, Store } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Mode = "network" | "single";
type PortalMode = { mode: Mode };

const OPTIONS: { value: Mode; icon: typeof Network; title: string; desc: string }[] = [
  {
    value: "network",
    icon: Network,
    title: "Δίκτυο φαρμακείων",
    desc: "Ο πελάτης βλέπει ΟΛΑ τα φαρμακεία του δικτύου: κατάλογος «Φαρμακεία», εναλλαγή φαρμακείου από πάνω, και ερωτήματα διαθεσιμότητας / ραντεβού σε οποιοδήποτε φαρμακείο.",
  },
  {
    value: "single",
    icon: Store,
    title: "Μεμονωμένο φαρμακείο",
    desc: "Ο πελάτης «κλειδώνεται» στο φαρμακείο που τον ενέγραψε. Κρύβονται: ο κατάλογος δικτύου, ο επιλογέας εναλλαγής, και η διαθεσιμότητα / ραντεβού αφορούν μόνο το δικό του φαρμακείο.",
  },
];

export default function PortalModePage() {
  const { data } = useQuery({ queryKey: ["admin", "portal-mode"], queryFn: () => adminApi<PortalMode>("/admin/portal-mode"), retry: false });
  const [mode, setMode] = useState<Mode>("network");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (data) setMode(data.mode); }, [data]);

  async function save(next: Mode) {
    setBusy(true); setNotice(null);
    const prev = mode;
    setMode(next);
    try {
      await adminApi("/admin/portal-mode", { method: "PUT", body: JSON.stringify({ mode: next }) });
      setNotice("Αποθηκεύτηκε ✓");
    } catch {
      setMode(prev);
      setNotice("Σφάλμα αποθήκευσης");
    } finally { setBusy(false); }
  }

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-xl font-bold text-slate-900">Πύλη Πελατών (my.rxvision)</h1>
      <p className="mb-6 text-sm text-slate-500">Καθολικός τρόπος λειτουργίας της πύλης πελατών για όλη την πλατφόρμα.</p>
      {notice && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}

      <div className="space-y-3">
        {OPTIONS.map((o) => {
          const active = mode === o.value;
          return (
            <button key={o.value} onClick={() => !active && save(o.value)} disabled={busy}
              className={`flex w-full items-start gap-4 rounded-xl border p-5 text-left transition disabled:opacity-60 ${active ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
              <span className={`mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg ${active ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}>
                <o.icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900">{o.title}</span>
                  {active && <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-bold text-white">Ενεργό</span>}
                </span>
                <span className="mt-1 block text-sm text-slate-600">{o.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-5 text-xs text-slate-400">Η αλλαγή εφαρμόζεται άμεσα· οι πελάτες τη βλέπουν στο επόμενο άνοιγμα/ανανέωση της πύλης.</p>
    </div>
  );
}
