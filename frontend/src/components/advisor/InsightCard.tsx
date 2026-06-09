"use client";

import Link from "next/link";
import {
  TrendingDown, TrendingUp, Percent, Wallet, AlertTriangle, Stethoscope,
  CalendarClock, Tag, Users, PackageSearch, ArrowRight, Lightbulb,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "trending-down": TrendingDown, "trending-up": TrendingUp, percent: Percent, wallet: Wallet,
  "alert-triangle": AlertTriangle, stethoscope: Stethoscope, "calendar-clock": CalendarClock,
  tag: Tag, users: Users, "package-search": PackageSearch,
};

const SEV: Record<string, { ring: string; chip: string; icon: string; label: string }> = {
  critical: { ring: "border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/40", chip: "bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300", icon: "text-rose-600 dark:text-rose-400", label: "Κρίσιμο" },
  warning: { ring: "border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/30", chip: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", icon: "text-amber-600 dark:text-amber-400", label: "Προσοχή" },
  opportunity: { ring: "border-brand-200 bg-brand-50/50 dark:border-brand-800/50 dark:bg-brand-950/40", chip: "bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300", icon: "text-brand-600 dark:text-brand-400", label: "Ευκαιρία" },
  info: { ring: "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900", chip: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300", icon: "text-slate-500 dark:text-slate-400", label: "Πληροφορία" },
  positive: { ring: "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/30", chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", icon: "text-emerald-600 dark:text-emerald-400", label: "Θετικό" },
};

export type Insight = {
  severity: string; icon: string; title: string; detail: string;
  metric?: string | null; cta?: { label: string; href: string } | null;
};

export function InsightCard({ ins }: { ins: Insight }) {
  const s = SEV[ins.severity] ?? SEV.info;
  const Icon = ICONS[ins.icon] ?? Lightbulb;
  return (
    <div className={`rounded-2xl border p-4 shadow-card ${s.ring}`}>
      <div className="flex items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white ${s.icon}`}>
          <Icon className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.chip}`}>{s.label}</span>
            {ins.metric && <span className="text-base font-bold text-slate-900">{ins.metric}</span>}
          </div>
          <h3 className="mt-1.5 text-sm font-semibold text-slate-800">{ins.title}</h3>
          <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{ins.detail}</p>
          {ins.cta && (
            <Link href={ins.cta.href} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              {ins.cta.label} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
