"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { HelpCircle, X, Lightbulb, Cog, ListChecks, BookOpen } from "lucide-react";
import { helpFor, manualSlug } from "@/lib/help";
import { useT, usePref } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";

/** Floating "?" button on every circuit → slide-over panel explaining what the page shows
 *  and how it works. Content lives in src/lib/help.ts (mirrored in docs/USER_MANUAL.md). */
export function PageHelp() {
  const pathname = usePathname() || "";
  const [open, setOpen] = useState(false);
  const t = useT();
  const en = usePref((s) => s.locale) === "en";
  const help = helpFor(pathname);
  /* ΜΕΤΑΚΙΝΗΣΙΜΟ (22/10/2026, παρατήρηση Παπαγιαννόπουλου): σε κάποιες οθόνες το «?» έπεφτε πάνω σε
     κουμπί. Σύρε το όπου βολεύει — η θέση θυμάται σε αυτόν τον browser· απλό κλικ = άνοιγμα βοήθειας. */
  const SIZE = 48;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const clamp = (x: number, y: number) => ({
    x: Math.min(Math.max(8, x), window.innerWidth - SIZE - 8),
    y: Math.min(Math.max(8, y), window.innerHeight - SIZE - 8),
  });
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem("rx-help-pos") || "null");
      if (v && typeof v.x === "number" && typeof v.y === "number") setPos(clamp(v.x, v.y));
    } catch { /* χωρίς αποθήκευση → προεπιλεγμένη θέση */ }
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    d.moved = true;
    setPos(clamp(d.ox + dx, d.oy + dy));
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) { setOpen(true); return; }
    try { if (pos) localStorage.setItem("rx-help-pos", JSON.stringify(pos)); } catch { /* ok */ }
  }
  if (!help) return null;

  return (
    <>
      <Tooltip label={t("Βοήθεια — τι βλέπω εδώ; (σύρε το αν σε εμποδίζει)", "Help — what am I looking at? (drag it if it is in the way)")}>
        <button
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
          aria-label={t("Βοήθεια (σύρε για να το μετακινήσεις)", "Help (drag to move)")}
          style={pos ? { left: pos.x, top: pos.y } : undefined}
          className={`fixed z-40 inline-flex h-12 w-12 touch-none cursor-grab items-center justify-center rounded-full bg-brand-600 text-white shadow-lg transition-transform hover:scale-105 hover:bg-brand-700 active:cursor-grabbing ${pos ? "" : "bottom-5 right-5"}`}
        >
          <HelpCircle className="h-6 w-6" />
        </button>
      </Tooltip>

      {open && (
        <div className="fixed inset-0 z-50" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-2xl dark:bg-slate-900"
          >
            <div className="flex items-center justify-between border-b border-slate-200 p-4 dark:border-slate-700">
              <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100">
                <HelpCircle className="h-5 w-5 text-brand-600" /> {en && help.title_en ? help.title_en : help.title}
              </h2>
              <button onClick={() => setOpen(false)} aria-label={t("Κλείσιμο", "Close")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">{en && help.intro_en ? help.intro_en : help.intro}</p>

              {/* ΠΩΣ ΔΟΥΛΕΥΕΙ — ο μηχανισμός. Πρώτο, γιατί χωρίς αυτό τα βήματα είναι παπαγαλία. */}
              {(en && help.logic_en) || help.logic ? (
                <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-900 dark:bg-sky-950/30">
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                    <Cog className="h-3.5 w-3.5" /> {t("Πώς δουλεύει", "How it works")}
                  </h3>
                  <p className="text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                    {en && help.logic_en ? help.logic_en : help.logic}
                  </p>
                </div>
              ) : null}

              {/* ΠΩΣ ΤΟ ΚΑΝΕΙΣ — αριθμημένα βήματα. */}
              {(() => {
                const steps = en && help.how_en?.length ? help.how_en : help.how;
                return steps?.length ? (
                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      <ListChecks className="h-3.5 w-3.5" /> {t("Πώς το κάνεις", "How to do it")}
                    </h3>
                    <ol className="space-y-2">
                      {steps.map((st, i) => (
                        <li key={i} className="flex gap-2.5">
                          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-bold text-white">{i + 1}</span>
                          <span className="text-sm leading-snug text-slate-700 dark:text-slate-300">{st}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null;
              })()}

              {help.what?.length ? (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Τι σημαίνει τι", "What means what")}</h3>
                  <div className="space-y-2">
                    {help.what.map((w, i) => (
                      <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{en && w.label_en ? w.label_en : w.label}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{en && w.desc_en ? w.desc_en : w.desc}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {(() => {
                const tips = en && help.tips_en?.length ? help.tips_en : help.tips;
                return tips?.length ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                    <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                      <Lightbulb className="h-3.5 w-3.5" /> Tips
                    </h3>
                    <ul className="list-disc space-y-1 pl-4 text-xs text-amber-800 dark:text-amber-200">
                      {tips.map((tip, i) => <li key={i}>{tip}</li>)}
                    </ul>
                  </div>
                ) : null;
              })()}
            </div>

            <div className="border-t border-slate-200 p-3 dark:border-slate-700">
              {help.manual ? (
                <Link href={`/manual#${manualSlug(help.manual)}`} onClick={() => setOpen(false)}
                  className="mb-2 flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700">
                  <BookOpen className="h-4 w-4" />
                  {t("Διάβασέ το αναλυτικά στο Εγχειρίδιο", "Read the full guide in the Manual")}
                </Link>
              ) : null}
              <p className="text-center text-[11px] text-slate-400">
                RxVision · {t("Βοήθεια κυκλώματος", "Page help")}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
