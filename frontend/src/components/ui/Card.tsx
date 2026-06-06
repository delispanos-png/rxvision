import type { ReactNode } from "react";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rx-card ${className}`}>{children}</div>;
}

/** Card with a header row (title + optional right-side action). */
export function PanelCard({
  title,
  action,
  className = "",
  bodyClassName = "",
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rx-card ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between px-5 pt-5">
          <h3 className="text-[15px] font-semibold text-slate-800">{title}</h3>
          {action}
        </div>
      )}
      <div className={`p-5 ${bodyClassName}`}>{children}</div>
    </div>
  );
}
