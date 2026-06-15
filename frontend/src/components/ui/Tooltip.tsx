"use client";

import { Children, cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Η ΜΟΝΑΔΙΚΗ φόρμα tooltip/bubble του project: λευκό «μήνυμα» με μαύρα γράμματα,
 * στρογγυλεμένο, με ουρά — portal + position:fixed ώστε να μην κόβεται από overflow.
 *
 * Δεν προσθέτει DOM γύρω από το παιδί (cloneElement) → ασφαλές σε <td>, flex, grid.
 * Χρήση:  <Tooltip label="κείμενο"><button>…</button></Tooltip>
 *         <Tooltip title="Διαγνώσεις" lines={[...]}><span>…</span></Tooltip>
 *         <Tooltip content={<custom/>}><span>…</span></Tooltip>
 */
type Props = {
  children: ReactElement;
  content?: ReactNode; // ελεύθερο περιεχόμενο
  label?: string; // μονή/πολλαπλές γραμμές (whitespace-pre-line)
  lines?: string[]; // λίστα — μία διάγνωση/οδηγία ανά γραμμή
  title?: string; // προαιρετική κεφαλίδα
  className?: string; // override πλάτους
};

export function Tooltip({ children, content, label, lines, title, className }: Props) {
  const [box, setBox] = useState<{ x: number; y: number; flip: boolean } | null>(null);

  const show = (el: Element) => {
    const r = el.getBoundingClientRect();
    const W = 320;
    const flip = window.innerHeight - r.bottom < 180; // λίγος χώρος κάτω → άνοιγμα προς τα πάνω
    setBox({
      x: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
      y: flip ? r.top - 9 : r.bottom + 9,
      flip,
    });
  };

  const has = content != null || (label != null && label !== "") || !!lines?.length;
  const child = Children.only(children) as ReactElement<Record<string, unknown>>;
  const cp = child.props as {
    onMouseEnter?: (e: unknown) => void;
    onMouseLeave?: (e: unknown) => void;
  };
  const trigger = cloneElement(child, {
    onMouseEnter: (e: React.MouseEvent) => {
      cp.onMouseEnter?.(e);
      show(e.currentTarget as Element);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      cp.onMouseLeave?.(e);
      setBox(null);
    },
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {has &&
        box &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: box.x,
              top: box.y,
              transform: box.flip ? "translateY(-100%)" : undefined,
              zIndex: 120,
            }}
            className={`pointer-events-none ${className ?? "w-max max-w-[320px]"}`}
          >
            <div className="relative rounded-2xl border border-slate-200 bg-white p-3 text-[13px] leading-relaxed text-slate-900 shadow-xl">
              <span
                className={`absolute left-5 h-3 w-3 rotate-45 border-slate-200 bg-white ${
                  box.flip ? "-bottom-1.5 border-b border-r" : "-top-1.5 border-l border-t"
                }`}
              />
              {title && <div className="mb-1.5 text-xs font-semibold text-violet-600">{title}</div>}
              {content ??
                (lines ? (
                  <ul className="space-y-1">
                    {lines.map((c, i) => (
                      <li
                        key={i}
                        className="border-b border-slate-100 pb-1 last:border-0 last:pb-0"
                      >
                        {c}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="whitespace-pre-line">{label}</span>
                ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
