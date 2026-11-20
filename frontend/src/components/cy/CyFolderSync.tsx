"use client";

/* Κύπρος: αυτόματη εισαγωγή XML από τον τοπικό φάκελο, όσο το RxVision είναι ανοιχτό.
   Ζει στο κέλυφος της εφαρμογής (όχι μόνο στη σελίδα Εισαγωγής): ο φαρμακοποιός δουλεύει σε άλλες
   οθόνες και τα αρχεία μπαίνουν μόνα τους. Μετά από επανεκκίνηση του browser χρειάζεται ΕΝΑ κλικ
   άδειας (κανόνας ασφαλείας του browser) → μικρή μπάρα κάτω δεξιά. Λογική: lib/cyFolder.ts. */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSync } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { folderState, folderSupported, resumeFolder, scanFolder, SCAN_EVERY_MS } from "@/lib/cyFolder";
import { useT } from "@/store/prefStore";

export function CyFolderSync() {
  const t = useT();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<{ country?: string; tenant_id?: string }>("/auth/me"), retry: false });
  const tid = me?.country === "CY" ? me.tenant_id : undefined;
  const [needsClick, setNeedsClick] = useState<string | null>(null);   // όνομα φακέλου που θέλει άδεια
  const busy = useRef(false);

  useEffect(() => {
    if (!tid || !folderSupported()) return;
    let stop = false;
    const tick = async () => {
      if (busy.current) return;
      const st = await folderState(tid).catch(() => null);
      if (stop) return;
      if (!st) { setNeedsClick(null); return; }
      if (st.perm !== "granted") { setNeedsClick(st.name); return; }
      setNeedsClick(null);
      busy.current = true;
      try {
        const r = await scanFolder(tid);
        if (r?.imported) qc.invalidateQueries({ queryKey: ["cy"] });
        window.dispatchEvent(new Event("cy-folder-scanned"));
      } catch { /* δίκτυο/διακοπή: ξαναδοκιμάζει στην επόμενη σάρωση */ }
      finally { busy.current = false; }
    };
    tick();
    const id = window.setInterval(tick, SCAN_EVERY_MS);
    window.addEventListener("cy-folder-changed", tick);
    return () => { stop = true; window.clearInterval(id); window.removeEventListener("cy-folder-changed", tick); };
  }, [tid, qc]);

  if (!tid || !needsClick) return null;
  return (
    <button onClick={async () => { if (await resumeFolder(tid)) { setNeedsClick(null); window.dispatchEvent(new Event("cy-folder-changed")); } }}
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-indigo-700">
      <FolderSync className="h-4 w-4" />
      {t(`Συνέχισε την αυτόματη εισαγωγή από «${needsClick}»`, `Resume automatic import from «${needsClick}»`)}
    </button>
  );
}
