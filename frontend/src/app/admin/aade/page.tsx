"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Landmark, Save, Loader2, Check } from "lucide-react";

type Integrations = { aade: { username: string | null; configured: boolean } };

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const Badge = ({ ok }: { ok?: boolean }) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{ok ? "Αποθηκευμένο" : "Μη ρυθμισμένο"}</span>;

export default function AadeSettingsPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integrations>("/admin/integrations"), retry: false });
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const save = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({ aade_username: user || null, aade_password: pass || null }) }),
    onSuccess: () => { setPass(""); qc.invalidateQueries({ queryKey: ["integrations"] }); },
  });
  const s = status.data;
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Landmark className="h-6 w-6 text-brand-600" /> ΑΑΔΕ</h1>
        <p className="mt-1 text-sm text-slate-500">Διαπιστευτήρια ΑΑΔΕ (RgWsPublic2) για auto-fill στοιχείων επιχείρησης κατά την εγγραφή. Αποθηκεύονται κρυπτογραφημένα — δεν εμφανίζονται ξανά, δεν μπαίνουν σε git/logs.</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Landmark className="h-4 w-4 text-brand-600" /> ΑΑΔΕ — RgWsPublic2 (VAT lookup) <Badge ok={s?.aade.configured} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Όνομα χρήστη (special account)
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder={s?.aade.username || "username"} className={inp} /></label>
          <label className="text-xs text-slate-500">Κωδικός
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={s?.aade.configured ? "•••• (αποθηκευμένο — κενό = αμετάβλητο)" : "password"} className={inp} /></label>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση
        </button>
      </div>
    </div>
  );
}
