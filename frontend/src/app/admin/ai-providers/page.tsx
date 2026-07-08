"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Bot, Save, Loader2, Check } from "lucide-react";

type Integrations = {
  anthropic?: { api_key_set: boolean; enabled: boolean; model: string; admin_model: string };
  drugbank?: { api_key_set: boolean; enabled: boolean; region: string };
};

const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";
const Badge = ({ ok }: { ok?: boolean }) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{ok ? "Αποθηκευμένο" : "Μη ρυθμισμένο"}</span>;

export default function AiProvidersPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integrations>("/admin/integrations"), retry: false });

  const [antKey, setAntKey] = useState("");
  const [antEnabled, setAntEnabled] = useState(true);
  const [antModel, setAntModel] = useState("claude-opus-4-8");
  const [antAdminModel, setAntAdminModel] = useState("claude-opus-4-8");
  const [dbKey, setDbKey] = useState("");
  const [dbEnabled, setDbEnabled] = useState(true);
  const [dbRegion, setDbRegion] = useState("eu");
  useEffect(() => {
    if (status.data?.anthropic) {
      setAntEnabled(status.data.anthropic.enabled ?? true);
      setAntModel(status.data.anthropic.model || "claude-opus-4-8");
      setAntAdminModel(status.data.anthropic.admin_model || "claude-opus-4-8");
    }
    if (status.data?.drugbank) {
      setDbEnabled(status.data.drugbank.enabled ?? true);
      setDbRegion(status.data.drugbank.region || "eu");
    }
  }, [status.data]);

  const save = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({
      anthropic_api_key: antKey || null, anthropic_enabled: antEnabled, anthropic_model: antModel || null,
      anthropic_admin_model: antAdminModel || null,
      drugbank_api_key: dbKey || null, drugbank_enabled: dbEnabled, drugbank_region: dbRegion || null,
    }) }),
    onSuccess: () => { setAntKey(""); setDbKey(""); qc.invalidateQueries({ queryKey: ["integrations"] }); },
  });

  const s = status.data;
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Bot className="h-6 w-6 text-brand-600" /> AI Providers</h1>
        <p className="mt-1 text-sm text-slate-500">Κλειδιά AI: <b>Anthropic</b> (PharmaCat) & <b>DrugBank</b> (αλληλεπιδράσεις). Κρυπτογραφημένα — δεν εμφανίζονται ξανά.</p>
      </div>

      {/* Anthropic / PharmaCat */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Bot className="h-4 w-4 text-brand-600" /> PharmaCat — Anthropic (Claude) <Badge ok={s?.anthropic?.api_key_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500 sm:col-span-2">Anthropic API key
            <input type="password" value={antKey} onChange={(e) => setAntKey(e.target.value)} placeholder={s?.anthropic?.api_key_set ? "•••• (αποθηκευμένο — κενό = αμετάβλητο)" : "sk-ant-..."} className={inp} /></label>
          <label className="text-xs text-slate-500">Μοντέλο φαρμακοποιού
            <select value={antModel} onChange={(e) => setAntModel(e.target.value)} className={inp}>
              <option value="claude-opus-4-8">Opus 4.8 — κορυφαίο</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 — ισορροπία</option>
              <option value="claude-haiku-4-5">Haiku 4.5 — οικονομικό</option>
            </select></label>
          <label className="text-xs text-slate-500">Μοντέλο διορθώσεων / admin
            <select value={antAdminModel} onChange={(e) => setAntAdminModel(e.target.value)} className={inp}>
              <option value="claude-opus-4-8">Opus 4.8 — κορυφαίο</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 — ισορροπία</option>
              <option value="claude-haiku-4-5">Haiku 4.5 — οικονομικό</option>
            </select></label>
          <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-slate-600 sm:col-span-2">
            <input type="checkbox" checked={antEnabled} onChange={(e) => setAntEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Ενεργή υπηρεσία {!antEnabled && <span className="text-rose-500">(απενεργοποιημένη για όλους)</span>}
          </label>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Τροφοδοτεί το <b>PharmaCat Clinical Assistant</b>. Cache: επαναλαμβανόμενες ερωτήσεις = δωρεάν. Όριο: 50 νέες/φαρμακείο/ημέρα.</p>
      </div>

      {/* DrugBank */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Bot className="h-4 w-4 text-orange-500" /> DrugBank — Αλληλεπιδράσεις φαρμάκων <Badge ok={s?.drugbank?.api_key_set} /></h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-slate-500 sm:col-span-2">DrugBank API key
            <input type="password" value={dbKey} onChange={(e) => setDbKey(e.target.value)} placeholder={s?.drugbank?.api_key_set ? "•••• (αποθηκευμένο — κενό = αμετάβλητο)" : "DrugBank production key…"} className={inp} /></label>
          <label className="text-xs text-slate-500">Περιοχή (region)
            <select value={dbRegion} onChange={(e) => setDbRegion(e.target.value)} className={inp}>
              <option value="eu">EU (Ευρώπη)</option><option value="us">US</option><option value="canada">Canada</option>
            </select></label>
          <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-slate-600">
            <input type="checkbox" checked={dbEnabled} onChange={(e) => setDbEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Ενεργό {!dbEnabled && <span className="text-rose-500">(ανενεργό)</span>}
          </label>
        </div>
        <p className="mt-3 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-700">Curated κλινική βάση για drug-drug interactions. Με κλειδί → έλεγχος μέσω DrugBank (AI fallback). Χωρίς κλειδί → interim μέσω PharmaCat AI.</p>
      </div>

      <button onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση κλειδιών AI
      </button>
    </div>
  );
}
