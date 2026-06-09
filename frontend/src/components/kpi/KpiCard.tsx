import type { LucideIcon } from "lucide-react";

type Accent = "indigo" | "green" | "amber" | "orange" | "sky" | "rose" | "violet";

const ACCENT: Record<Accent, string> = {
  indigo: "bg-brand-50 text-brand-600",
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  orange: "bg-orange-50 text-orange-600",
  sky: "bg-sky-50 text-sky-600",
  rose: "bg-rose-50 text-rose-600",
  violet: "bg-violet-50 text-violet-600",
};

/** KPI card — big value + colored icon square (Noeton-style). */
export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent = "indigo",
  trend,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  accent?: Accent;
  trend?: number;
  onClick?: () => void;
}) {
  return (
    <div
      className={`rx-card p-5 ${onClick ? "cursor-pointer transition hover:shadow-lg hover:ring-1 hover:ring-brand-200" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="rx-label">{label}</div>
          <div className="mt-2 flex items-baseline gap-2">
            <div className="truncate text-xl font-bold leading-none text-slate-900 sm:text-[26px]">{value}</div>
            {trend !== undefined && (
              <span className={`text-xs font-semibold ${trend >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {trend >= 0 ? "▲" : "▼"} {Math.abs(trend).toFixed(1)}%
              </span>
            )}
          </div>
          {sub && <div className="mt-1.5 text-xs text-slate-400">{sub}</div>}
        </div>
        {Icon && (
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${ACCENT[accent]}`}>
            <Icon className="h-5 w-5" strokeWidth={2} />
          </span>
        )}
      </div>
    </div>
  );
}
