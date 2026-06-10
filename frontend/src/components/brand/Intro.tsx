"use client";

import { useEffect, useState } from "react";
import { LogoMark } from "@/components/brand/Logo";

/** Cinematic brand intro shown once per browser session before the auth screens.
 *  Click anywhere to skip. Pure CSS animations — no extra deps. */
export function Intro() {
  const [show, setShow] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("rx_intro_seen")) return;
    setShow(true);
    const t1 = setTimeout(() => setLeaving(true), 2600);
    const t2 = setTimeout(() => { sessionStorage.setItem("rx_intro_seen", "1"); setShow(false); }, 3200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setLeaving(true);
    sessionStorage.setItem("rx_intro_seen", "1");
    setTimeout(() => setShow(false), 500);
  };

  const glyphs = ["℞", "+", "◷", "✚", "℞", "•"];

  return (
    <div
      onClick={dismiss}
      role="button"
      tabIndex={0}
      aria-label="Κλείσιμο"
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") dismiss(); }}
      className={`fixed inset-0 z-[200] flex cursor-pointer flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-brand-600 via-violet-600 to-brand-700 transition-opacity duration-500 ${leaving ? "opacity-0" : "opacity-100"}`}
    >
      {/* floating glyphs */}
      {glyphs.map((g, i) => (
        <span key={i} className="pointer-events-none absolute select-none text-white/10"
          style={{
            left: `${[12, 78, 22, 85, 50, 8][i]}%`, top: `${[20, 28, 75, 68, 12, 55][i]}%`,
            fontSize: `${[64, 90, 52, 70, 44, 80][i]}px`,
            animation: `rxFloat ${5 + i}s ease-in-out ${i * 0.4}s infinite`,
          }}>{g}</span>
      ))}

      {/* logo with pulsing ring */}
      <div className="relative">
        <span className="absolute inset-0 -z-10 rounded-[2rem] bg-white/30" style={{ animation: "rxRing 2.2s ease-out infinite" }} />
        <span className="absolute inset-0 -z-10 rounded-[2rem] bg-white/20" style={{ animation: "rxRing 2.2s ease-out .8s infinite" }} />
        <div className="grid h-28 w-28 place-items-center rounded-[2rem] bg-white shadow-2xl" style={{ animation: "rxLogo .9s cubic-bezier(.2,.8,.2,1) both" }}>
          <LogoMark className="h-16 w-16" />
        </div>
      </div>

      <h1 className="mt-7 text-5xl font-extrabold tracking-tight text-white" style={{ animation: "rxUp .7s .25s both" }}>RxVision</h1>
      <p className="mt-2.5 text-lg font-medium text-white/90" style={{ animation: "rxUp .7s .45s both" }}>Έξυπνη ανάλυση φαρμακείου — με μάτια AI</p>

      {/* loading bar + dots */}
      <div className="mt-8 h-1 w-44 overflow-hidden rounded-full bg-white/20" style={{ animation: "rxUp .7s .6s both" }}>
        <div className="h-full rounded-full bg-white" style={{ animation: "rxBar 2.4s ease-in-out forwards" }} />
      </div>
      <div className="mt-4 flex gap-1.5" style={{ animation: "rxUp .7s .75s both" }}>
        {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 rounded-full bg-white" style={{ animation: `rxDot 1.4s ${i * 0.2}s infinite` }} />)}
      </div>

      <span className="absolute bottom-8 text-xs text-white/55">κλικ για παράλειψη</span>
    </div>
  );
}
