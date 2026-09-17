"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Overview = {
  days: number; campaigns: number; messages: number; people: number;
  came_after: number; live: number; scheduled: number;
};

const TABS = [
  { href: "/communications", el: "Νέο μήνυμα", en: "New message" },
  { href: "/communications/audiences", el: "Ομάδες ανθρώπων", en: "Audiences" },
  { href: "/communications/automations", el: "Αυτόματα μηνύματα", en: "Automations" },
  { href: "/communications/calendar", el: "Ημερολόγιο", en: "Calendar" },
];

/** Το κύκλωμα Επικοινωνίας. Η επισκόπηση είναι ΜΙΑ πρόταση, όχι πίνακας αριθμών: ο φαρμακοποιός
 *  θέλει να ξέρει σε πόσους μίλησε και πόσοι γύρισαν — όχι δέκα δείκτες που δεν συγκρίνει. */
export default function CommsLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  const pathname = usePathname();
  const ov = useQuery({ queryKey: ["comms", "overview"], queryFn: () => api<Overview>("/communications/overview?days=30"), retry: false });
  const o = ov.data;

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-sky-600 text-white shadow-lg"><Megaphone className="h-6 w-6" /></span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Επικοινωνία", "Communications")}</h1>
          <p className="text-sm text-slate-500">{t("Τι είπες στους ανθρώπους σου — και τι απάντησαν.", "What you told your people — and how they replied.")}</p>
        </div>
      </div>

      {o && (o.messages > 0 || o.live > 0 || o.scheduled > 0) && (
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {o.messages > 0 && (
            <>
              {t(`Τον τελευταίο μήνα μίλησες σε `, "In the last month you reached ")}
              <b className="text-slate-900 dark:text-slate-100">{t(`${o.people} ανθρώπους`, `${o.people} people`)}</b>
              {o.came_after > 0 && (
                <>{t(". Οι ", ". ")}<b className="text-emerald-600">{o.came_after}</b>
                  {t(" πέρασαν από το φαρμακείο μετά.", " came to the pharmacy afterwards.")}</>
              )}
              {o.came_after === 0 && "."}
            </>
          )}
          {(o.live > 0 || o.scheduled > 0) && (
            <span className="ml-2 text-slate-500">
              {o.live > 0 && t(`${o.live} σε εξέλιξη. `, `${o.live} sending. `)}
              {o.scheduled > 0 && t(`${o.scheduled} προγραμματισμένα.`, `${o.scheduled} scheduled.`)}
            </span>
          )}
        </div>
      )}

      <nav className="mb-6 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200 dark:border-slate-700">
        {TABS.map((tab) => {
          const active = tab.href === "/communications" ? pathname === tab.href : pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${active ? "border-brand-600 font-semibold text-brand-700 dark:text-brand-400" : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400"}`}>
              {t(tab.el, tab.en)}
            </Link>
          );
        })}
      </nav>
      {children}
    </ModuleGuard>
  );
}
