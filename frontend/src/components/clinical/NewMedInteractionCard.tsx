"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { PlusCircle, Search, X, ShieldAlert } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { InteractionsModal } from "./InteractionsModal";

type Hit = { name: string; substance: string; atc: string | null };

/** «Έλεγχος νέου σκευάσματος (OTC, χωρίς συνταγή)»: autocomplete πάνω στον κατάλογο (εμπορική Ή
 *  δραστική) → κρατά τη ΔΡΑΣΤΙΚΗ → ελέγχει αλληλεπίδραση με την ενεργή αγωγή του ασθενή. */
export function NewMedInteractionCard({ patientId }: { patientId: string }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [showModal, setShowModal] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const id = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(id); }, [q]);
  const search = useQuery({
    queryKey: ["med-search", dq],
    queryFn: () => api<{ items: Hit[] }>(`/pharmacat/medicine-search?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2 && !picked,
  });

  useEffect(() => {
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const pick = (h: Hit) => { setPicked(h); setQ(h.name); setOpen(false); };
  const clear = () => { setPicked(null); setQ(""); };

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900 dark:bg-indigo-950/20">
      <div className="flex items-center gap-2 text-sm font-semibold text-indigo-800 dark:text-indigo-300">
        <PlusCircle className="h-4 w-4" /> {t("Έλεγχος νέου σκευάσματος (χωρίς συνταγή)", "Check a new medicine (OTC, no prescription)")}
      </div>
      <p className="mt-0.5 text-xs text-slate-500">{t("Γράψε εμπορική ονομασία ή δραστική — ελέγχουμε αλληλεπίδραση με την ενεργή αγωγή του ασθενή.", "Type a brand name or active substance — we check it against the patient's active regimen.")}</p>

      <div ref={boxRef} className="relative mt-2">
        <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); setOpen(true); }} onFocus={() => setOpen(true)}
            placeholder={t("π.χ. Depon ή PARACETAMOL", "e.g. Depon or PARACETAMOL")}
            className="w-full bg-transparent text-sm text-slate-800 outline-none dark:text-slate-100" />
          {q && <button onClick={clear} aria-label="clear"><X className="h-4 w-4 text-slate-400 hover:text-slate-600" /></button>}
        </div>
        {open && !picked && dq.length >= 2 && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {search.isLoading ? <div className="px-3 py-2 text-xs text-slate-400">{t("Αναζήτηση…", "Searching…")}</div>
             : !search.data?.items.length ? <div className="px-3 py-2 text-xs text-slate-400">{t("Καμία αντιστοίχιση.", "No matches.")}</div>
             : search.data.items.map((h, i) => (
                <button key={i} onClick={() => pick(h)} className="block w-full border-b border-slate-50 px-3 py-2 text-left last:border-0 hover:bg-indigo-50 dark:border-slate-800 dark:hover:bg-slate-800">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{h.name}</div>
                  <div className="text-[11px] text-slate-500">{h.substance}{h.atc ? ` · ${h.atc}` : ""}</div>
                </button>
              ))}
          </div>
        )}
      </div>

      {picked && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
            {picked.substance}<button onClick={clear} aria-label="remove"><X className="h-3 w-3" /></button>
          </span>
          <button onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
            <ShieldAlert className="h-3.5 w-3.5" /> {t("Έλεγχος αλληλεπίδρασης", "Check interaction")}
          </button>
        </div>
      )}

      {picked && (
        <InteractionsModal open={showModal} onClose={() => setShowModal(false)}
          title={t("Νέο σκεύασμα vs ενεργή αγωγή", "New medicine vs active regimen")}
          endpoint="/pharmacat/interactions/patient"
          body={{ patient_id: patientId, added: [picked.substance] }} />
      )}
    </div>
  );
}
