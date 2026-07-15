"use client";

// Επιλογέας φαρμακείου — ΜΟΝΟ για χρήστες δικτύου (πρόσβαση σε >1 φαρμακείο).
// Η εναλλαγή ξαναβγάζει token με ΑΛΛΟ `tid` (ένα φαρμακείο ανά token → η απομόνωση δεν σπάει).
// Μετά την αλλαγή κάνουμε πλήρη επαναφόρτωση: όλα τα cached ερωτήματα αφορούν το ΠΡΟΗΓΟΥΜΕΝΟ
// φαρμακείο και θα έδειχναν ξένα δεδομένα μέχρι το επόμενο refetch.
import { useState } from "react";
import { Building2, ChevronDown, Check, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/apiClient";

export type Pharmacy = { tenant_id: string; name: string; primary?: boolean };

export function PharmacySwitcher({ pharmacies, activeId }: { pharmacies: Pharmacy[]; activeId?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  if (!pharmacies || pharmacies.length < 2) return null;   // ένα φαρμακείο → κανένας επιλογέας
  const active = pharmacies.find((p) => p.tenant_id === activeId) ?? pharmacies[0];

  async function pick(p: Pharmacy) {
    if (p.tenant_id === activeId) { setOpen(false); return; }
    setBusy(p.tenant_id); setErr("");
    try {
      const r = await api<{ access_token: string; refresh_token: string }>("/auth/select-tenant", {
        method: "POST", body: JSON.stringify({ tenant_id: p.tenant_id }),
      });
      window.localStorage.setItem("access_token", r.access_token);
      window.localStorage.setItem("refresh_token", r.refresh_token);
      window.location.reload();   // καθαρή αρχή — μηδενίζει κάθε cache του προηγούμενου φαρμακείου
    } catch (e) {
      // 429 seat_limit: οι άδειες μετρούν ΚΑΙ για τον ιδιοκτήτη — πες του ακριβώς τι φταίει,
      // αλλιώς βλέπει ένα αόριστο «απέτυχε» και δεν ξέρει τι να κάνει.
      const prob = (e as ApiError)?.problem as { detail?: { error?: string; seats?: number } } | undefined;
      if (prob?.detail?.error === "seat_limit") {
        setErr(`Δεν μπορείς να συνδεθείς στο «${p.name}» γιατί δεν υπάρχουν διαθέσιμες άδειες — είναι όλες κατειλημμένες${prob.detail.seats ? ` (${prob.detail.seats})` : ""}.`);
      } else {
        setErr("Δεν ήταν δυνατή η αλλαγή φαρμακείου.");
      }
      setBusy("");
    }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className="flex max-w-[9rem] items-center gap-1.5 rounded-lg border border-slate-200 bg-white py-1.5 pl-2 pr-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 sm:max-w-[14rem] sm:text-xs">
        <Building2 className="h-4 w-4 shrink-0 text-brand-500" />
        <span className="min-w-0 flex-1 truncate text-left">{active?.name ?? "—"}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1.5 max-h-[70vh] w-[min(18rem,calc(100vw-1.5rem))] overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-800">
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Τα φαρμακεία μου</div>
            {pharmacies.map((p) => {
              const on = p.tenant_id === activeId;
              return (
                <button key={p.tenant_id} onClick={() => pick(p)} disabled={!!busy}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left disabled:opacity-60 ${on ? "bg-brand-50 dark:bg-brand-950/40" : "hover:bg-slate-50 dark:hover:bg-slate-700/50"}`}>
                  <span className="min-w-0 flex-1">
                    <span className={`block break-words text-[11px] font-semibold leading-snug ${on ? "text-brand-700 dark:text-brand-300" : "text-slate-700 dark:text-slate-200"}`}>{p.name}</span>
                    {p.primary && <span className="text-[10px] text-slate-400">κύριο</span>}
                  </span>
                  {busy === p.tenant_id ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />
                    : on ? <Check className="h-3.5 w-3.5 shrink-0 text-brand-500" /> : null}
                </button>
              );
            })}
            {err && <div className="px-2 py-1 text-[11px] text-rose-600">{err}</div>}
          </div>
        </>
      )}
    </div>
  );
}
