"use client";

/* Adminpanel → καρτέλα ΚΥΠΡΙΑΚΟΥ φαρμακείου: σύνδεση με την PharmacyOne (αντί της «Διασύνδεσης ΗΔΥΚΑ»).
   Το Client Id είναι ΜΥΣΤΙΚΟ: γράφεται εδώ (μόνο εγγραφή → Vault), δεν εμφανίζεται ποτέ ξανά —
   μόνο τα 4 τελευταία ψηφία για αναγνώριση. Backend: api/v1/routers/admin.py (pharmacyone_*). */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { fmtDateTime, fmtNum } from "@/lib/formatters";

type St = { configured: boolean; hint: string | null; enabled?: boolean; last_ok_at?: string | null; last_run_at?: string | null;
  running_since?: string | null;
  last_result?: { ok?: boolean; fetched?: number; imported?: number; updated?: number; duplicates?: number; failed?: number; error?: string; full?: boolean } };

const ERR: Record<string, string> = {
  unauthorized: "Λείπει ή είναι λάθος το κλειδί εφαρμογής PharmacyOne (adminpanel → Κατάλογος ειδών Κύπρου).",
  bad_client_id: "Το Client Id δεν έχει σωστή μορφή.", unknown_client_id: "Η PharmacyOne δεν γνωρίζει αυτό το Client Id.",
  network: "Δεν απαντά η PharmacyOne (δίκτυο).", server: "Σφάλμα στην PharmacyOne — δοκίμασε αργότερα.",
  not_configured: "Δεν έχει οριστεί Client Id.", bad_request: "Η PharmacyOne απέρριψε το αίτημα.",
};

export function PharmacyOneBox({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const base = `/admin/tenants/${encodeURIComponent(tenantId)}/pharmacyone`;
  const q = useQuery({ queryKey: ["admin", "pharmacyone", tenantId], queryFn: () => adminApi<St>(base), refetchInterval: 30_000 });
  const [cid, setCid] = useState("");
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const reload = () => qc.invalidateQueries({ queryKey: ["admin", "pharmacyone", tenantId] });

  async function save(body: object) {
    setBusy(true);
    try { await adminApi(base, { method: "PUT", body: JSON.stringify(body) }); setCid(""); reload(); }
    catch { appAlert("Δεν αποθηκεύτηκε — το Client Id είναι 24 χαρακτήρες (0-9, a-f)."); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try {
      const r = await adminApi<{ ok: boolean; error?: string; pharmacy?: { name?: string; company?: string; branch?: string }; executions_total?: number }>(`${base}/test`, { method: "POST" });
      appAlert(r.ok ? `✓ Συνδέθηκε: ${[r.pharmacy?.name, r.pharmacy?.company, r.pharmacy?.branch].filter(Boolean).join(" · ") || "—"} · ${fmtNum(r.executions_total ?? 0)} εκτελέσεις στην PharmacyOne.`
        : `✖ ${ERR[r.error || ""] || r.error}`);
    } finally { setBusy(false); }
  }
  async function sync(full: boolean) {
    if (full && !(await appConfirm("Πλήρης λήψη ΟΛΟΥ του ιστορικού; Ό,τι υπάρχει ήδη δεν διπλασιάζεται."))) return;
    await adminApi(`${base}/sync?full=${full}`, { method: "POST" });
    appAlert("Ξεκίνησε στο παρασκήνιο. Το αποτέλεσμα φαίνεται εδώ σε λίγα λεπτά.");
    reload();
  }
  const r = d?.last_result;
  const btn = "rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50";
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-sm">
      <div className="mb-1 font-medium text-slate-700">PharmacyOne (λήψη εκτελέσεων ΓεΣΥ)</div>
      {!d ? <div className="text-slate-400">…</div> : (
        <div className="space-y-2 text-slate-600">
          <div>Client Id: {d.configured ? <code className="text-xs">{d.hint}</code> : <span className="text-slate-400">δεν έχει οριστεί</span>}
            {d.configured && <> · {d.enabled ? <span className="text-emerald-700">ενεργή λήψη (κάθε ώρα)</span> : <span className="text-amber-700">ανενεργή</span>}</>}</div>
          <div className="flex gap-2">
            <input value={cid} onChange={(e) => setCid(e.target.value)} placeholder={d.configured ? "νέο Client Id (αντικατάσταση)" : "Client Id (24 χαρακτήρες)"}
              autoComplete="off" spellCheck={false} className="w-64 rounded-lg border border-slate-300 px-2 py-1 font-mono text-xs" />
            <button disabled={busy || cid.trim().length !== 24} onClick={() => save({ client_id: cid.trim() })} className={btn}>Αποθήκευση</button>
          </div>
          {d.configured && (
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} onClick={test} className={btn}>Δοκιμή σύνδεσης</button>
              <button disabled={busy} onClick={() => save({ enabled: !d.enabled })} className={btn}>{d.enabled ? "Απενεργοποίηση" : "Ενεργοποίηση"}</button>
              <button disabled={busy || !!d.running_since} onClick={() => sync(false)} className={btn}>Συγχρονισμός τώρα</button>
              <button disabled={busy || !!d.running_since} onClick={() => sync(true)} className={btn}>Όλο το ιστορικό</button>
              <button disabled={busy} onClick={async () => { if (await appConfirm("Αφαίρεση του Client Id; Η αυτόματη λήψη σταματά.", { danger: true })) save({ client_id: "" }); }}
                className={`${btn} text-rose-700`}>Αφαίρεση</button>
            </div>
          )}
          {d.running_since && <div className="text-xs text-indigo-700">⏳ Λήψη σε εξέλιξη από {fmtDateTime(d.running_since)}</div>}
          {r && d.last_run_at && (
            <div className={`text-xs ${r.ok === false ? "text-rose-700" : "text-slate-500"}`}>
              Τελευταία: {fmtDateTime(d.last_run_at)} · {r.ok === false ? `✖ ${ERR[r.error || ""] || r.error}`
                : `${fmtNum(r.fetched ?? 0)} ήρθαν · ${fmtNum(r.imported ?? 0)} νέες · ${fmtNum(r.updated ?? 0)} ενημερώθηκαν · ${fmtNum(r.duplicates ?? 0)} υπήρχαν${r.failed ? ` · ${fmtNum(r.failed)} απορρίφθηκαν` : ""}${r.full ? " (πλήρης)" : ""}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
