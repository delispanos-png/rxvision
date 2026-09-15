"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Compass, AlertTriangle, Info, ArrowRight } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Note = { kind: string; tone: "warn" | "info"; text: string; money_cents?: number | null; href?: string };
type Brief = { found: boolean; name?: string | null; notes?: Note[] };
type Me = { modules?: Record<string, string> };

/**
 * Ο Σύμβουλος ΤΗ ΣΤΙΓΜΗ που ο πελάτης είναι μπροστά σου.
 *
 * Η καθημερινή λίστα είναι αναδρομική: διαβάζεις το πρωί ότι κάποιος έφυγε με μισή συνταγή και
 * μετά πρέπει να τον κυνηγήσεις στο τηλέφωνο. Εδώ κλείνει το θέμα χωρίς κυνηγητό — αρκεί να το
 * δεις όσο μιλάς μαζί του. Γι' αυτό η λωρίδα είναι ΜΙΚΡΗ και διαβάζεται σε τρία δευτερόλεπτα.
 *
 * Εμφανίζεται μόνο με ενεργό το module `daily_coach` ΚΑΙ μόνο αν υπάρχει κάτι να ειπωθεί.
 */
export function CoachStrip({ patientId }: { patientId?: string | null }) {
  const t = useT();
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false, staleTime: 300_000 });
  const on = ["enabled", "trial"].includes(me.data?.modules?.daily_coach ?? "");
  const q = useQuery({
    queryKey: ["coach-brief", patientId],
    queryFn: () => api<Brief>(`/coach/patient/${encodeURIComponent(patientId!)}`),
    enabled: !!patientId && on,
    staleTime: 60_000,
  });

  const notes = q.data?.notes ?? [];
  if (!on || !patientId || !notes.length) return null;

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
      <div className="flex items-center gap-2">
        <Compass className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        <h3 className="text-sm font-bold text-indigo-900 dark:text-indigo-200">
          {t("Ο Σύμβουλος σού θυμίζει", "Your advisor reminds you")}
        </h3>
        <Link href="/coach" className="ml-auto text-[11px] font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
          {t("Όλα τα θέματα", "All findings")}
        </Link>
      </div>
      <ul className="mt-2.5 space-y-2">
        {notes.map((n, i) => (
          <li key={n.kind + i} className="flex items-start gap-2 text-sm leading-relaxed text-slate-800 dark:text-slate-200">
            {n.tone === "warn"
              ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              : <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />}
            <span>
              {n.text}
              {n.href && (
                <Link href={n.href} className="ml-1.5 inline-flex items-center gap-0.5 font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                  {t("άνοιγμα", "open")}<ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
