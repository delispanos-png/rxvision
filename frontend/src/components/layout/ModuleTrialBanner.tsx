"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, ChevronDown, ChevronUp } from "lucide-react";

import { api } from "@/lib/apiClient";
import { fmtDate } from "@/lib/formatters";
import { useT } from "@/store/prefStore";
import { NAV_GROUPS } from "./navCatalog";

type Me = {
  modules?: Record<string, "enabled" | "trial" | "locked">;
  module_trials?: Record<string, string>;
};

type Addon = {
  _id: string;
  name?: string;
  trial_started_at?: string | null;
  trial_expires_at?: string | null;
  trial_days?: number | null;
};

/** Ποιο module «ανήκει» στη σελίδα που βλέπω τώρα — από τον ΙΔΙΟ κατάλογο που χτίζει το μενού,
 *  ώστε να μη συντηρούνται δύο χάρτες που θα αποκλίνουν. Μακρύτερο ταίριασμα κερδίζει. */
function moduleOfPath(path: string): string | null {
  const pairs: { href?: string; module?: string | string[] }[] = [];
  for (const g of NAV_GROUPS) {
    for (const n of g.items) {
      pairs.push({ href: n.href, module: n.module });
      for (const c of n.children || []) pairs.push({ href: c.href, module: c.module ?? n.module });
    }
  }
  let bestLen = -1;
  let bestMod: string | null = null;
  for (const p of pairs) {
    if (!p.href || !p.module) continue;
    const base = p.href.split("#")[0];
    if (!base || !path.startsWith(base)) continue;
    if (base.length > bestLen) {
      bestLen = base.length;
      bestMod = Array.isArray(p.module) ? p.module[0] : p.module;
    }
  }
  return bestMod;
}

const daysLeft = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

/**
 * «Δοκιμάζεις <ΟΝΟΜΑ> — λήγει σε X ημέρες.» + κλικ για πλήρη εικόνα.
 *
 * ΓΙΑΤΙ ΟΝΟΜΑΖΕΙ ΤΗ ΔΥΝΑΤΟΤΗΤΑ: σκέτο «Δοκιμαστική περίοδος — λήγει σε 7 ημέρες» δεν λέει
 * ΤΙΠΟΤΑ — ο πελάτης μπορεί να δοκιμάζει τρία πράγματα ταυτόχρονα και δεν ξέρει ποιο χάνει.
 * Με το κλικ ανοίγει ΟΛΕΣ τις ενεργές δοκιμές με «ξεκίνησε / λήγει», ώστε να μην ψάχνει.
 *
 * ΜΟΝΟ σε δοκιμή — ποτέ σε αγορασμένη δυνατότητα (δεν λήγει, και η υπενθύμιση θα ήταν θόρυβος
 * που εκπαιδεύει τον χρήστη να αγνοεί τα μηνύματα).
 */
export function ModuleTrialBanner() {
  const t = useT();
  const path = usePathname() || "";
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"),
                              staleTime: 300_000, retry: false });
  const { data: cat } = useQuery({ queryKey: ["addons"], queryFn: () => api<{ addons: Addon[] }>("/addons"),
                                   staleTime: 300_000, retry: false });

  const mod = moduleOfPath(path);
  if (!mod || !data) return null;
  if (data.modules?.[mod] !== "trial") return null;          // αγορασμένο ή κλειδωμένο → σιωπή
  const iso = data.module_trials?.[mod];
  if (!iso) return null;
  const days = daysLeft(iso);
  if (days < 0) return null;

  const byId = new Map((cat?.addons || []).map((a) => [a._id, a] as const));
  const nameOf = (m: string) => byId.get(m)?.name || m;
  const when = days <= 0 ? t("σήμερα", "today")
    : days === 1 ? t("αύριο", "tomorrow")
    : t(`σε ${days} ημέρες`, `in ${days} days`);

  // ΟΛΕΣ οι δοκιμές που τρέχουν τώρα — όχι μόνο αυτής της σελίδας.
  const all = Object.entries(data.module_trials || {})
    .filter(([m, exp]) => data.modules?.[m] === "trial" && daysLeft(exp) >= 0)
    .sort((a, b) => new Date(a[1]).getTime() - new Date(b[1]).getTime());

  return (
    <div className="mb-3 rounded-2xl border border-violet-200 bg-violet-50 dark:border-violet-900/50 dark:bg-violet-950/20">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
        <Sparkles className="h-4 w-4 shrink-0 text-violet-600" />
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-left text-violet-900 hover:underline dark:text-violet-200">
          <span>
            {t(`Δοκιμάζεις «${nameOf(mod)}» — λήγει ${when}.`,
               `You are trialling “${nameOf(mod)}” — ends ${when}.`)}
          </span>
          {open ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
        </button>
        <Link href="/settings/billing"
          className="ml-auto rounded-lg bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-700">
          {t("Απόκτησέ το", "Get it")}
        </Link>
      </div>

      {open && (
        <div className="border-t border-violet-200 px-4 py-3 dark:border-violet-900/50">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
            {t("Οι δοκιμές σου", "Your trials")}
          </p>
          <ul className="space-y-2">
            {all.map(([m, exp]) => {
              const d = daysLeft(exp);
              const started = byId.get(m)?.trial_started_at;
              return (
                <li key={m} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span className="font-medium text-violet-900 dark:text-violet-100">{nameOf(m)}</span>
                  <span className="text-xs text-violet-700 dark:text-violet-300">
                    {started ? t(`ξεκίνησε ${fmtDate(started)} · `, `started ${fmtDate(started)} · `) : ""}
                    {t(`λήγει ${fmtDate(exp)}`, `ends ${fmtDate(exp)}`)}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    d <= 2 ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200"
                           : "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200"}`}>
                    {d <= 0 ? t("λήγει σήμερα", "ends today")
                      : d === 1 ? t("1 ημέρα", "1 day")
                      : t(`${d} ημέρες`, `${d} days`)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-violet-700 dark:text-violet-300">
            {t("Μόλις λήξει, η δυνατότητα κλειδώνει. Μπορείς να την αποκτήσεις οποιαδήποτε στιγμή από τις Ρυθμίσεις → Χρέωση.",
               "When a trial ends the feature locks. You can get it any time from Settings → Billing.")}
          </p>
        </div>
      )}
    </div>
  );
}
