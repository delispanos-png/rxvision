"use client";

import { useEffect, useState } from "react";

/**
 * Μια ΜΙΚΡΗ γιορτή — καθαρό CSS, χωρίς βιβλιοθήκη, χωρίς ήχο.
 *
 * Παίζει ΣΠΑΝΙΑ και σκόπιμα: όταν αδειάσει η λίστα της ημέρας ή όταν πιαστεί ο στόχος.
 * Αν έπαιζε σε κάθε κλικ θα γινόταν θόρυβος και θα έχανε κάθε νόημα — γι' αυτό ο γονιός
 * την ενεργοποιεί μόνο στη ΜΕΤΑΒΑΣΗ (π.χ. από «έχεις θέματα» σε «κανένα»).
 *
 * Σέβεται το `prefers-reduced-motion`: όποιος έχει ζητήσει λιγότερη κίνηση, δεν βλέπει τίποτα.
 */
const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#f43f5e"];

export function Celebrate({ fire }: { fire: boolean }) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!fire) return;
    if (typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setOn(true);
    const id = window.setTimeout(() => setOn(false), 2200);
    return () => window.clearTimeout(id);
  }, [fire]);

  if (!on) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0 overflow-visible">
      <style>{`
        @keyframes coach-fall {
          0%   { transform: translate3d(0,-10vh,0) rotate(0deg);   opacity: 0; }
          10%  { opacity: 1; }
          100% { transform: translate3d(var(--dx),105vh,0) rotate(var(--rot)); opacity: 0; }
        }
      `}</style>
      {Array.from({ length: 36 }).map((_, i) => {
        const left = (i * 97) % 100;                 // ντετερμινιστική διασπορά, χωρίς random
        const delay = (i % 9) * 70;
        const dx = `${((i * 37) % 60) - 30}px`;
        const rot = `${((i * 53) % 4 + 1) * 180}deg`;
        return (
          <span key={i}
            style={{
              position: "absolute", left: `${left}%`, top: 0,
              width: i % 3 === 0 ? 6 : 8, height: i % 3 === 0 ? 10 : 8,
              borderRadius: i % 2 ? 2 : 999,
              background: COLORS[i % COLORS.length],
              ["--dx" as string]: dx, ["--rot" as string]: rot,
              animation: `coach-fall ${1500 + (i % 5) * 180}ms cubic-bezier(.25,.6,.4,1) ${delay}ms forwards`,
            }} />
        );
      })}
    </div>
  );
}
