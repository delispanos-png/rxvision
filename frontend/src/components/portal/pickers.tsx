"use client";

import { useEffect, useRef, useState } from "react";
import { patientApi } from "@/lib/patientClient";

// Minimal type for the native BarcodeDetector (not in TS lib types yet).
type BarcodeDetectorLike = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

export type Pharmacy = { tenant_id: string; pharmacy_name?: string; name?: string; distance_km?: number };
export type Medicine = { barcode: string | null; name: string };

// ── Pharmacy picker: linked pharmacies + "find nearby" (browser geolocation) ──
export function PharmacyPicker({ linked, value, onChange }: {
  linked: Pharmacy[]; value: string; onChange: (tenantId: string) => void;
}) {
  const [nearby, setNearby] = useState<Pharmacy[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function findNearby() {
    setErr(""); setBusy(true);
    if (!navigator.geolocation) { setErr("Η τοποθεσία δεν υποστηρίζεται."); setBusy(false); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const d = await patientApi<{ items: Pharmacy[] }>(`/patient/pharmacies/nearby?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`);
        setNearby(d.items);
        if (d.items[0]) onChange(d.items[0].tenant_id);
      } catch { setErr("Αποτυχία εύρεσης φαρμακείων."); } finally { setBusy(false); }
    }, () => { setErr("Δεν δόθηκε άδεια τοποθεσίας."); setBusy(false); });
  }

  const opts = nearby.length ? nearby : linked;
  const label = (p: Pharmacy) => `🏥 ${p.name ?? p.pharmacy_name ?? p.tenant_id}${p.distance_km != null ? ` · ${p.distance_km} km` : ""}`;

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <select value={value} onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 truncate rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
          {opts.length === 0 && <option value="">— Επίλεξε φαρμακείο —</option>}
          {opts.map((p) => <option key={p.tenant_id} value={p.tenant_id}>{label(p)}</option>)}
        </select>
        <button type="button" onClick={findNearby} disabled={busy}
          className="shrink-0 whitespace-nowrap rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700">
          {busy ? "…" : "📍 Κοντινά"}
        </button>
      </div>
      {err && <div className="text-xs text-rose-600">{err}</div>}
    </div>
  );
}

// ── Medicine picker: autocomplete from catalogue + barcode typing + camera scan ──
export function MedicinePicker({ value, onChange }: { value: Medicine | null; onChange: (m: Medicine | null) => void }) {
  const [mode, setMode] = useState<"search" | "barcode">("search");
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<Medicine[]>([]);
  const [code, setCode] = useState("");
  const [scan, setScan] = useState(false);
  const [msg, setMsg] = useState("");

  // debounced catalogue search
  useEffect(() => {
    if (mode !== "search" || q.trim().length < 2) { setOpts([]); return; }
    const id = setTimeout(async () => {
      try { const d = await patientApi<{ items: Medicine[] }>(`/patient/medicines/search?q=${encodeURIComponent(q)}`); setOpts(d.items); } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(id);
  }, [q, mode]);

  async function lookupBarcode(c: string) {
    setMsg("");
    try { const m = await patientApi<Medicine>(`/patient/medicines/by-barcode?code=${encodeURIComponent(c)}`); onChange(m); setMsg(""); }
    catch { setMsg("Δεν βρέθηκε φάρμακο με αυτό το barcode."); }
  }

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
        <span className="font-medium text-emerald-800 dark:text-emerald-300">💊 {value.name}</span>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-slate-500 hover:underline">Αλλαγή</button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1 text-xs">
        <button type="button" onClick={() => setMode("search")} className={`rounded px-2 py-1 ${mode === "search" ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800"}`}>Λίστα</button>
        <button type="button" onClick={() => setMode("barcode")} className={`rounded px-2 py-1 ${mode === "barcode" ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800"}`}>Barcode</button>
        <button type="button" onClick={() => setScan(true)} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">📷 Σάρωση</button>
      </div>

      {mode === "search" && (
        <div className="relative">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Γράψε όνομα φαρμάκου…"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
          {opts.length > 0 && (
            <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {opts.map((m, i) => (
                <button type="button" key={(m.barcode ?? "") + i} onClick={() => { onChange(m); setQ(""); setOpts([]); }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">{m.name}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === "barcode" && (
        <div className="flex gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="Barcode (EAN)"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
          <button type="button" onClick={() => code.trim() && lookupBarcode(code.trim())}
            className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">OK</button>
        </div>
      )}
      {msg && <div className="text-xs text-rose-600">{msg}</div>}

      {scan && <ScanModal onClose={() => setScan(false)} onCode={(c) => { setScan(false); lookupBarcode(c); }} />}
    </div>
  );
}

// ── Camera barcode scanner (native BarcodeDetector; graceful fallback) ──
function ScanModal({ onClose, onCode }: { onClose: () => void; onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    (async () => {
      if (!window.BarcodeDetector) { setErr("Η σάρωση δεν υποστηρίζεται σε αυτή τη συσκευή — πληκτρολόγησε το barcode."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "upc_a"] });
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) { onCode(codes[0].rawValue); return; }
          } catch { /* ignore frame errors */ }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch { setErr("Δεν δόθηκε άδεια κάμερας."); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-sm font-semibold">Σάρωση barcode φαρμάκου</div>
        {err ? <div className="py-6 text-center text-sm text-rose-600">{err}</div>
          : <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />}
        <button type="button" onClick={onClose} className="mt-3 w-full rounded-lg border border-slate-300 py-2 text-sm dark:border-slate-700">Κλείσιμο</button>
      </div>
    </div>
  );
}
