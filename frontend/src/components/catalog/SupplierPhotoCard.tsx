"use client";

// Back-office (staff): σύνδεση με B2B προμηθευτή (Profarm) για αυτόματη λήψη φωτογραφιών ανά barcode.
// Off by default — ενεργοποιείται από τον διαχειριστή σε φαρμακεία που συνεργάζονται με τον προμηθευτή.
// ΠΟΤΕ ορατό σε πελάτες. Ο κωδικός αποθηκεύεται κρυπτογραφημένος server-side.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, ChevronDown, Loader2, Check, X } from "lucide-react";
import { api } from "@/lib/apiClient";
import { appAlert, appConfirm } from "@/store/dialogStore";

type Status = { configured: boolean; username: string };

export function SupplierPhotoCard() {
  const [open, setOpen] = useState(false);
  const st = useQuery({ queryKey: ["profarm-status"], queryFn: () => api<Status>("/catalog/supplier/profarm"), retry: false });
  // Live πρόοδος harvest — poll κάθε 5s όσο η κάρτα είναι ανοιχτή (δείχνει και server-side background sync).
  const prog = useQuery({
    queryKey: ["profarm-sync-status"],
    queryFn: () => api<{ attached: number; tried: number; remaining: number }>("/catalog/supplier/profarm/sync-status"),
    enabled: open, refetchInterval: 5000, retry: false,
  });
  // Εισαγωγή ΟΛΟΚΛΗΡΩΝ προϊόντων OTC/παραφαρμάκων (create νέα + update υπάρχοντα)
  const imp = useQuery({
    queryKey: ["profarm-import-status"],
    queryFn: () => api<{ status: string; total: number; pos: number; created: number; enriched: number; photos: number }>("/catalog/supplier/profarm/import-status"),
    enabled: open, refetchInterval: 5000, retry: false,
  });
  const [impBusy, setImpBusy] = useState(false);
  async function startImport() {
    setImpBusy(true);
    try { await api("/catalog/supplier/profarm/import", { method: "POST" }); await imp.refetch(); }
    catch { await appAlert("Αποτυχία εκκίνησης εισαγωγής."); }
    setImpBusy(false);
  }
  async function resetImport() {
    if (!(await appConfirm("Μηδενισμός της εισαγωγής; (η ουρά χάνεται — τα ήδη εισαγμένα προϊόντα μένουν)", { danger: true, confirmText: "Μηδενισμός" }))) return;
    setImpBusy(true);
    try { await api("/catalog/supplier/profarm/import", { method: "DELETE" }); await imp.refetch(); }
    finally { setImpBusy(false); }
  }
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState("");
  const configured = st.data?.configured;

  async function save() {
    setBusy("save");
    try { await api("/catalog/supplier/profarm", { method: "POST", body: JSON.stringify({ username: user || st.data?.username || "", password: pass }) }); setPass(""); await st.refetch(); }
    catch { await appAlert("Αποτυχία αποθήκευσης."); }
    setBusy("");
  }
  async function test() {
    setBusy("test");
    try { const r = await api<{ ok: boolean }>("/catalog/supplier/profarm/test", { method: "POST" }); await appAlert(r.ok ? "✓ Επιτυχής σύνδεση στο Profarm." : "✗ Αποτυχία σύνδεσης — έλεγξε τα στοιχεία."); }
    catch { await appAlert("Σφάλμα ελέγχου."); }
    setBusy("");
  }
  async function remove() {
    setBusy("del");
    try { await api("/catalog/supplier/profarm", { method: "DELETE" }); await st.refetch(); }
    finally { setBusy(""); }
  }

  const [sync, setSync] = useState<{ running: boolean; attached: number; matched: number; remaining: number }>({ running: false, attached: 0, matched: 0, remaining: 0 });
  async function runSync() {
    setSync({ running: true, attached: 0, matched: 0, remaining: 0 });
    let att = 0, mat = 0;
    for (let i = 0; i < 2000; i++) {   // ασφαλές πλαφόν επαναλήψεων
      let r: { ok: boolean; processed: number; matched: number; attached: number; remaining: number; error?: string };
      try { r = await api("/catalog/supplier/profarm/sync", { method: "POST" }); }
      catch { break; }
      if (!r.ok) { await appAlert("Σφάλμα συγχρονισμού: " + (r.error || "")); break; }
      att += r.attached; mat += r.matched;
      setSync({ running: true, attached: att, matched: mat, remaining: r.remaining });
      if (r.remaining <= 0 || r.processed === 0) break;
    }
    setSync((s) => ({ ...s, running: false }));
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <Camera className="h-5 w-5 text-indigo-500" />
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Φωτογραφίες από προμηθευτή (Profarm)</span>
        {configured && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700"><Check className="h-3 w-3" /> συνδεδεμένο</span>}
        <ChevronDown className={`ml-auto h-4 w-4 text-slate-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 p-4 dark:border-slate-800">
          <p className="text-xs text-slate-500">Σύνδεση με τον λογαριασμό σου στο B2B του προμηθευτή. Αντιστοιχίζουμε τα είδη με το <b>barcode</b> και κατεβάζουμε την επίσημη φωτογραφία — μόνο όπου το barcode ταιριάζει ακριβώς. Ο κωδικός αποθηκεύεται κρυπτογραφημένος.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-slate-500">Όνομα χρήστη Profarm
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder={st.data?.username || "username"} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
            <label className="text-xs text-slate-500">Κωδικός {configured && <span className="text-slate-400">(κενό = αμετάβλητος)</span>}
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" /></label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={save} disabled={!!busy || (!user && !st.data?.username)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} Αποθήκευση</button>
            <button onClick={test} disabled={!!busy || !configured} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300">{busy === "test" && <Loader2 className="h-4 w-4 animate-spin" />} Έλεγχος σύνδεσης</button>
            {configured && <button onClick={remove} disabled={!!busy} className="ml-auto inline-flex items-center gap-1 text-xs text-rose-500 hover:underline"><X className="h-3.5 w-3.5" /> Αφαίρεση</button>}
          </div>
          {configured && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
              {(() => {
                const tried = prog.data?.tried ?? 0, remaining = prog.data?.remaining ?? 0, attached = prog.data?.attached ?? 0;
                const total = tried + remaining;
                const pct = total > 0 ? Math.round((tried / total) * 100) : (attached > 0 ? 100 : 0);
                const active = sync.running || (prog.isFetching && remaining > 0);
                return (
                  <div className="mb-2">
                    <div className="mb-1 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                      <span className="inline-flex items-center gap-1.5">{active && <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />} Πρόοδος: <b>{pct}%</b> {remaining > 0 ? `(απομένουν ${remaining})` : "— ολοκληρώθηκε"}</span>
                      <span>📷 <b className="text-emerald-600">{attached}</b> φωτο</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-indigo-100 dark:bg-slate-800"><div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} /></div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{tried.toLocaleString("el-GR")} από {total.toLocaleString("el-GR")} είδη ελέγχθηκαν</div>
                  </div>
                );
              })()}
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={runSync} disabled={sync.running} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {sync.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} {sync.running ? "Συγχρονισμός…" : "Συγχρονισμός φωτογραφιών"}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">Ψάχνει κάθε είδος χωρίς φωτο με το barcode του στο Profarm — μόνο ακριβή ταιριάσματα. Η μπάρα ενημερώνεται αυτόματα (τρέχει και στο παρασκήνιο).</p>
            </div>
          )}

          {configured && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
              <div className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">📦 Εισαγωγή προϊόντων OTC & παραφαρμάκων</div>
              <p className="mb-2 text-[11px] text-slate-400">Φέρνει ΟΛΟΚΛΗΡΑ τα προϊόντα (φωτο, περιγραφή, barcode, ΦΠΑ, προτεινόμενη λιανική, χονδρική) από τις κατηγορίες OTC/παραφαρμάκων. <b>Νέα → δημιουργούνται· υπάρχοντα → ενημερώνονται.</b> Εισάγονται ανενεργά «προς πώληση» (τα ενεργοποιείς εσύ).</p>
              {(() => {
                const s = imp.data; const st = s?.status || "idle";
                const total = s?.total ?? 0, pos = s?.pos ?? 0;
                const pct = st === "done" ? 100 : (total > 0 ? Math.round((pos / total) * 100) : 0);
                const label = st === "enumerating" ? "Καταγραφή προϊόντων…" : st === "importing" ? `Εισαγωγή ${pos}/${total}` : st === "done" ? "Ολοκληρώθηκε ✓" : "Έτοιμο για εκκίνηση";
                const active = st === "importing" || st === "enumerating";
                return (
                  <>
                    {st !== "idle" && (
                      <div className="mb-2">
                        <div className="mb-1 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                          <span className="inline-flex items-center gap-1.5">{active && <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />}{label}</span>
                          <span>✚<b className="text-emerald-600">{s?.created ?? 0}</b> νέα · ↻{s?.enriched ?? 0} · 📷{s?.photos ?? 0}</span>
                        </div>
                        <div className="h-2.5 overflow-hidden rounded-full bg-emerald-100 dark:bg-slate-800"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${st === "enumerating" ? 12 : pct}%` }} /></div>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button onClick={startImport} disabled={impBusy || active} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{(impBusy || active) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} {active ? "Σε εξέλιξη…" : st === "done" ? "Επανεκκίνηση" : "Έναρξη εισαγωγής"}</button>
                      {st !== "idle" && <button onClick={resetImport} disabled={impBusy} className="text-xs text-rose-500 hover:underline">Μηδενισμός</button>}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
