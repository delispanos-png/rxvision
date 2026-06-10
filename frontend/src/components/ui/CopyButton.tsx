"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/** Small inline copy-to-clipboard button. Stops row-click propagation so it works
 *  inside clickable table rows. Falls back to execCommand on non-secure contexts. */
export function CopyButton({ value, className = "" }: { value?: string | null; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Αντιγράφηκε!" : "Αντιγραφή"}
      aria-label={copied ? "Αντιγράφηκε" : "Αντιγραφή"}
      className={`inline-flex items-center rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800 ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
