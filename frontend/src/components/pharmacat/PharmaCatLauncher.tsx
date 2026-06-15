"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Cat, X } from "lucide-react";
import { useT } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";

const MESSAGES: [string, string][] = [
  ["Θέλεις κάποια ερώτηση από μένα; 🐱", "Got a question for me? 🐱"],
  ["Πώς μπορώ να σε βοηθήσω;", "How can I help you?"],
  ["Ρώτα με για σύμπτωμα ή αλληλεπίδραση!", "Ask me about a symptom or interaction!"],
];

/** Floating PharmaCat launcher for the top bar — animated, with periodic "bubble" invitations.
    Shown only for tenants entitled to the PharmaCat module. */
export function PharmaCatLauncher() {
  const t = useT();
  const router = useRouter();
  const [bubble, setBubble] = useState<[string, string] | null>(null);
  const [wiggle, setWiggle] = useState(false);
  const stop = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (typeof window !== "undefined" && sessionStorage.getItem("pc_bubble_off")) return;
    let i = 0, shown = 0;
    const push = (fn: () => void, ms: number) => { const h = setTimeout(fn, ms); timers.current.push(h); };
    const cycle = () => {
      if (stop.current || shown >= 4) return;
      setBubble(MESSAGES[i % MESSAGES.length]); setWiggle(true);
      i++; shown++;
      push(() => setWiggle(false), 700);
      push(() => { setBubble(null); push(cycle, 26000); }, 7000);
    };
    push(cycle, 4000);
    return () => { timers.current.forEach(clearTimeout); };
  }, []);

  function open() {
    setBubble(null);
    router.push("/pharmacat");
  }
  function dismiss(e: React.MouseEvent) {
    e.stopPropagation();
    stop.current = true;
    setBubble(null);
    timers.current.forEach(clearTimeout);
    if (typeof window !== "undefined") sessionStorage.setItem("pc_bubble_off", "1");
  }

  return (
    <div className="relative flex justify-center">
      <Tooltip label={t("PharmaCat — Κλινικός Βοηθός", "PharmaCat — Clinical Assistant")}>
        <button
          onClick={open}
          aria-label="PharmaCat"
          className="animate-pc-glow relative inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-lg transition hover:scale-105"
        >
          <span className="absolute inset-0 animate-ping rounded-full bg-violet-400 opacity-20" />
          <Cat className={`h-5 w-5 ${wiggle ? "animate-pc-wiggle" : ""}`} />
          <span className="hidden sm:inline">PharmaCat</span>
        </button>
      </Tooltip>

      {bubble && (
        <button
          onClick={open}
          className="animate-pc-pop absolute left-1/2 top-full z-50 mt-3 w-max max-w-[240px] -translate-x-1/2 cursor-pointer rounded-2xl border border-violet-200 bg-white px-3.5 py-2.5 text-left text-xs font-medium text-slate-700 shadow-xl dark:border-violet-800 dark:bg-slate-900 dark:text-slate-200"
        >
          {/* tail */}
          <span className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-violet-200 bg-white dark:border-violet-800 dark:bg-slate-900" />
          <span className="flex items-start gap-1.5">
            <Cat className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />
            <span className="flex-1">{t(bubble[0], bubble[1])}</span>
            <span onClick={dismiss} className="-mr-1 -mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-slate-300 hover:text-slate-500"><X className="h-3 w-3" /></span>
          </span>
        </button>
      )}
    </div>
  );
}
