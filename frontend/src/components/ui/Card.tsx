"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rx-card ${className}`}>{children}</div>;
}

/** Card with a header row (title + optional right-side action).
 *  Pass `collapsible` to make the header toggle the body; `defaultOpen={false}` starts closed. */
export function PanelCard({
  title,
  action,
  className = "",
  bodyClassName = "",
  children,
  collapsible = false,
  defaultOpen = true,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const showBody = !collapsible || open;
  return (
    <div className={`rx-card ${className}`}>
      {(title || action) && (
        <div className={`flex items-center justify-between px-5 pt-5 ${showBody ? "" : "pb-5"}`}>
          {collapsible ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-2 text-left"
              aria-expanded={open}
            >
              <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "" : "-rotate-90"}`} />
              <h3 className="text-[15px] font-semibold text-slate-800 dark:text-slate-200">{title}</h3>
            </button>
          ) : (
            <h3 className="text-[15px] font-semibold text-slate-800 dark:text-slate-200">{title}</h3>
          )}
          {action}
        </div>
      )}
      {showBody && <div className={`p-5 ${bodyClassName}`}>{children}</div>}
    </div>
  );
}
