"use client";

import { useState } from "react";
import { api } from "@/lib/apiClient";

type ExportFormat = "csv" | "xlsx" | "pdf";

type ExportJob = { id?: string; url?: string; status?: string };

/**
 * Calls an export endpoint with `?format=`. The API returns a job id (202) → we poll
 * `/exports/{id}` for a signed download URL. Polling is stubbed to a single follow-up
 * fetch so the flow is wired end-to-end without backend changes.
 */
export function ExportButton({
  path,
  query = "",
  label = "Εξαγωγή",
}: {
  path: string;
  query?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  async function start(format: ExportFormat) {
    setBusy(format);
    try {
      const sep = (path + query).includes("?") ? "&" : "?";
      const job = await api<ExportJob>(`${path}${query}${sep}format=${format}`, { method: "POST" });

      let url = job.url;
      if (!url && job.id) {
        const done = await api<ExportJob>(`/exports/${job.id}`).catch(() => null);
        url = done?.url;
      }
      if (url && typeof window !== "undefined") {
        window.open(url, "_blank");
      } else {
        alert("Η εξαγωγή ξεκίνησε. Θα ειδοποιηθείτε όταν είναι έτοιμη.");
      }
    } catch {
      alert("Η εξαγωγή απέτυχε.");
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        {busy ? "Εξαγωγή…" : label} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-32 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {(["csv", "xlsx", "pdf"] as ExportFormat[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => start(f)}
              className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
